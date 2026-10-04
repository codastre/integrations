'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { hasSearch, hasRead } = require('./shell');

// Codastre is considered configured when the CLI has persisted config
// (`codastre login` writes ~/.config/codastre/config.json) or the server /
// API key is supplied via environment. No key → every hook is a silent no-op
// so the plugin never nags in environments where Codastre isn't set up.
function codastreConfigured() {
	if (process.env.CODASTRE_SERVER || process.env.CODASTRE_API_KEY) return true;
	try {
		fs.accessSync(path.join(os.homedir(), '.config', 'codastre', 'config.json'));
		return true;
	} catch {
		return false;
	}
}

// True when the `codastre` CLI binary is resolvable on PATH. Distinct from
// codastreConfigured() (which checks login/config): the plugin's MCP server is
// launched as `codastre serve`, so a missing binary means the tools never load
// at all — worth detecting so the plugin can suggest installing it.
// On Windows the binary may be `codastre.exe`, `codastre.cmd`, `codastre.bat`,
// etc.; honor PATHEXT so a shim installed as `codastre.cmd` is still found.
function resolveCli() {
	const names =
		process.platform === 'win32'
			? ['codastre'].concat(
					(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
						.split(path.delimiter)
						.filter(Boolean)
						.map((ext) => 'codastre' + ext.toLowerCase())
			  )
			: ['codastre'];
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		if (!dir) continue;
		for (const bin of names) {
			const full = path.join(dir, bin);
			try {
				fs.accessSync(full, fs.constants.X_OK);
				return full;
			} catch {
				// keep scanning
			}
		}
	}
	return null;
}

function cliInstalled() {
	return resolveCli() !== null;
}

// --- CLI-plane capability -----------------------------------------------------
// What the installed binary can actually do, resolved by asking it rather than
// by trusting a version string wherever a flag or subcommand can be grepped for
// (a source build reports `dev`, and the flags are the thing that matters):
//
//   hydrate     `codastre query --snippets` — bodies read from a local checkout (v0.14.0)
//   agentFormat `--format agent` — the text rendering (v0.14.0)
//   corpora     `codastre corpora` — corpus ranking, CORPUS_SEARCH's CLI face (v0.15.0)
//   contracts   `codastre contracts` — cross-repo boundaries and orphans (v0.17.0)
//   mcpAgent    MCP `format: "agent"` survives a structuredContent-preferring
//               client: the rendering rides in both representations (v0.18.0).
//               The one capability with no flag to grep for, so it is read off
//               the version — and an unparsable version (`dev`, a bare commit)
//               leaves it false, i.e. the older, safe guidance.
//   stacks      `--stacks` on query/corpora — stack-scoped retrieval (v0.18.1)
//   client      the `--client` root flag — plugin attribution (v0.19.0). Gates
//               every `--client` the plugin tells the model to pass: an older
//               binary rejects an unknown root flag, which would turn an
//               attribution nicety into a failed search.
//
// This is what lets a session know its plane without the model spending a probe
// call: see core/retrieval-playbook.md 2c. Cached per binary (path + mtime +
// size) so SubagentStart doesn't re-exec it for every subagent, and every failure
// mode degrades to "unknown", never to a wrong claim. CAPS_SCHEMA is in the cache
// key so a cache written by an older plugin (without the newer fields) is never
// read back as "the binary can't".
const CAPS_SCHEMA = 2;

// Parses `0.19.1` / `v0.19.1` / `0.19.1-rc1`; anything else is null.
function parseVersion(v) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True only when `v` parses and is >= `min`. Unparsable → false (never a guess).
function versionAtLeast(v, min) {
	const a = parseVersion(v);
	const b = parseVersion(min);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return true;
}

function cliCapabilities() {
	const bin = resolveCli();
	if (!bin) return { available: false };

	let stamp = '';
	try {
		const st = fs.statSync(bin);
		stamp = `${st.mtimeMs}-${st.size}`;
	} catch {
		return { available: false };
	}
	const cache = path.join(
		os.tmpdir(),
		`codastre-cli-caps.v${CAPS_SCHEMA}.${Buffer.from(bin + stamp).toString('base64url').slice(-40)}.json`
	);
	try {
		return JSON.parse(fs.readFileSync(cache, 'utf8'));
	} catch {
		// not cached yet — probe below
	}

	const { execFileSync } = require('child_process');
	const run = (args) => {
		try {
			return execFileSync(bin, args, {
				encoding: 'utf8',
				timeout: 5000,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			// `--help` exits 0, but a stray non-zero exit still carries usable output.
			return (err && (err.stdout || err.stderr)) || '';
		}
	};

	const help = String(run(['query', '--help']) || '');
	if (!help) return { available: false };
	const rootHelp = String(run(['--help']) || '');
	const version = (String(run(['version']) || '').match(/v?\d+\.\d+\.\d+\S*/) || [''])[0];
	// A subcommand is present when the root help lists it at the start of an
	// indented line (cobra's "Available Commands" layout).
	const hasCommand = (name) => new RegExp(`^\\s+${name}\\s`, 'm').test(rootHelp);
	const caps = {
		schema: CAPS_SCHEMA,
		available: true,
		version: version || 'unknown',
		hydrate: /--snippets\b/.test(help),
		agentFormat: /--format[^\n]*\bagent\b/.test(help),
		corpora: hasCommand('corpora'),
		contracts: hasCommand('contracts'),
		mcpAgent: versionAtLeast(version, '0.18.0'),
		stacks: /--stacks\b/.test(help),
		client: /--client\b/.test(rootHelp),
	};
	try {
		fs.writeFileSync(cache, JSON.stringify(caps));
	} catch {
		// Cache is an optimisation; a failed write just re-probes next session.
	}
	return caps;
}

// --- Plugin identity ----------------------------------------------------------
// The plugin's own version, read from its manifest so the `--client` attribution
// the hooks inject can never drift from what `/plugin` installed. The manifest is
// one level up from hooks/ in both layouts (vendored here, and upstream's
// adapters/claude/), so no env var is needed — $CLAUDE_PLUGIN_ROOT isn't set in
// every context this module is required from anyway.
function pluginVersion() {
	try {
		const manifest = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
		const v = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
		return typeof v === 'string' && v ? v : 'unknown';
	} catch {
		return 'unknown';
	}
}

const CLIENT_TYPE = 'claude-code-plugin';

function clientId() {
	return `${CLIENT_TYPE}/${pluginVersion()}`;
}

// ` --client claude-code-plugin/<v>` when the installed CLI accepts the flag,
// else '' — see `client` in cliCapabilities.
function clientFlag(caps) {
	return caps && caps.client ? ` --client ${clientId()}` : '';
}

// Token tracking is opt-in: CODASTRE_TRACK_TOKENS=1.
function trackingEnabled() {
	return process.env.CODASTRE_TRACK_TOKENS === '1';
}

// JSONL log destination; override with CODASTRE_TOKEN_LOG.
function tokenLogPath() {
	return (
		process.env.CODASTRE_TOKEN_LOG ||
		path.join(os.homedir(), '.config', 'codastre', 'claude-token-log.jsonl')
	);
}

function readStdinJson() {
	return new Promise((resolve) => {
		let input = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => (input += chunk));
		process.stdin.on('end', () => {
			try {
				resolve(JSON.parse(input));
			} catch {
				resolve(null);
			}
		});
	});
}

// Bytes per token, by payload shape. See core/measurement.md, "Token
// estimation". The prose default of 4 is wrong for everything Codastre emits,
// and wrong *unevenly*, which is what matters: it understated tokens by 25-37%
// and understated JSON worst, so it flattered the expensive format in exactly
// the comparison this log exists to support.
//
// Measured with cl100k_base over eight deployed responses -- two repos plus a
// federated run, top_k 5 to 20, bodies on and off:
//
//   json   JSON envelope (verbose/compact)   2.38 - 2.69   pooled 2.53
//   agent  the format:"agent" text rendering 2.48 - 3.48   pooled 3.33
//
// `text` is 4 and is NOT from that sample: grep output, file reads and prose
// were never measured. It is the old prose default carried forward so those
// records keep an estimate at all -- report it as unmeasured, and never quote it
// beside the other two as if it had the same standing.
//
// Two caveats the "~" in every consumer's output stands for: this counts UTF-16
// characters, not bytes, so a payload with non-ASCII source reads slightly low;
// and within a shape the spread is corpus-dependent (repeated long path prefixes
// merge well and push the ratio up), so any single figure is worth +/-20%.
const BYTES_PER_TOKEN = { json: 2.5, agent: 3.0, text: 4 };

function estTokens(text, basis) {
	if (!text) return 0;
	const divisor = BYTES_PER_TOKEN[basis] || BYTES_PER_TOKEN.text;
	return Math.ceil(String(text).length / divisor);
}

// tokenBasis picks which ratio above applies to one tool result.
//
// Only Codastre results can be json/agent; everything else is `text`. The agent
// rendering is detected by the header its renderer always writes first
// ("codastre · N hits …" / "codastre · graph · N edge(s) …"), checked on the MCP
// content block *before* the response is stringified -- stringifying first would
// wrap every response in JSON braces and misclassify the whole class as json.
const AGENT_RENDERING = /^codastre\s+·\s/;
// `codastre contracts --format agent` is the one renderer that opens with its
// scope line instead ("scope: N repo(s) visible · …") — READ THE SCOPE LINE
// FIRST is the point of that report, so the header is the scope.
const CONTRACTS_RENDERING = /^scope:\s+\d+\s+repo\(s\)\s+visible\b/;

// The renderer's header is the first line of stdout -- but the CLI plane writes
// a `target: …` scope line to stderr, and a Bash tool result carries the two
// streams merged, so the header can arrive on line 2 or 3. Scan the first few
// lines rather than anchoring at the very start; a JSON envelope is a single
// line beginning with `{`, so nothing else in this class can match.
function hasAgentHeader(text) {
	return String(text || '')
		.trim()
		.split('\n', 3)
		.some((line) => AGENT_RENDERING.test(line.trim()) || CONTRACTS_RENDERING.test(line.trim()));
}

function tokenBasis(cls, response) {
	if (cls !== 'codastre') return 'text';
	if (typeof response === 'string') {
		return hasAgentHeader(response) ? 'agent' : 'json';
	}
	if (response && typeof response === 'object') {
		// A spec-shaped MCP result: the rendering lives in content[0].text, and
		// structuredContent.format names the rung outright when present.
		const sc = response.structuredContent;
		if (sc && sc.format === 'agent') return 'agent';
		const block = Array.isArray(response.content) ? response.content[0] : null;
		if (block && typeof block.text === 'string' && hasAgentHeader(block.text)) {
			return 'agent';
		}
		// A Bash tool result: {stdout, stderr} rather than MCP content blocks.
		if (typeof response.stdout === 'string' || typeof response.stderr === 'string') {
			return hasAgentHeader(String(response.stdout || '') + '\n' + String(response.stderr || ''))
				? 'agent'
				: 'json';
		}
	}
	return 'json';
}

// requestedRung records which rung of the format ladder the CALL was for, which
// is not the same question as tokenBasis's "which ratio fits these bytes" -- and
// conflating them loses information the log is asked for.
//
// The case that forced them apart: a client that prefers structuredContent over
// content shows the model only the fixed summary of an `agent` response. Those
// bytes are genuinely JSON-shaped, so tokenBasis is right to say `json` -- but
// the call was an agent-rung call, and recording it as `json` makes an
// agent-rung attempt indistinguishable from a verbose one. That is exactly the
// breakdown /codastre:tokens promises, and the pattern worth spotting: a run of
// agent-rung calls at ~40 tokens each is the rendering being swallowed, not a
// spectacular saving.
//
// Read from the response first (what the server/proxy actually did) and fall
// back to the request (what was asked for, when the response doesn't say).
function requestedRung(cls, toolInput, response) {
	if (cls !== 'codastre') return undefined;
	if (response && typeof response === 'object') {
		const sc = response.structuredContent;
		if (sc && typeof sc.format === 'string') return sc.format;
		if (typeof response.format === 'string') return response.format;
	}
	const asked = toolInput && toolInput.format;
	return typeof asked === 'string' ? asked : undefined;
}

// --- Bash classification ----------------------------------------------------
// One source of truth for what a Bash command is, imported by mode.js
// (enforcement), track.js (accounting), and bash.js (nudge) so the three can
// never drift apart. The structure lives in shell.js; the rules:
//   - text search: grep/rg/ag/ack/fd/findstr heading a pipeline (start, after
//     ;&|| ( or inside $(…)/backticks), or downstream of a stage that reads the
//     repo (`cat f | grep x`, `git ls-files | grep _test`) — but not filtering
//     another program's output (`git log | grep fix`, `codastre doctor | rg
//     auth`); `git grep` and `xargs … grep` anywhere; `find … -name`;
//   - read: a pipeline headed by a file viewer (cat/head/tail/nl/…) naming a
//     file, or `sed -n` (never `sed -i`), with no redirect into a file — what
//     the Read tool would have done. Search wins when a command does both.
function isBashSearch(command) {
	return hasSearch(maskQuoted(command));
}

function isBashRead(command) {
	return hasRead(maskQuoted(command));
}

// --- Quote masking ----------------------------------------------------------
// The regexes above look for a command at a boundary, so a quoted *argument*
// that merely mentions one — `git commit -m "fix (grep|rg) handling"`, an
// `echo "; rg"`, a Python heredoc — used to classify as a text search (and,
// in auto mode, got the commit blocked). maskQuoted blanks quoted text and
// heredoc bodies before matching, keeping what the shell actually executes:
//   - `$(…)` / backtick substitutions inside double quotes;
//   - the string handed to a shell (`sh|bash|zsh|dash|ksh … -c '…'`, `eval '…'`);
//   - a heredoc whose consumer is a shell (`bash <<EOF`).
// The result is only ever matched, never run, so it also normalises the
// shell's own command separators the regexes don't list: an unquoted newline
// becomes `;` (a multi-line command's second line is a command too), and so do
// the quotes around a string a shell will run.
// Mirrored byte for byte by cli/internal/transcript/quotes.go in the codastre
// repo (the transcript collector); change both, with the same test table.
const SHELL_RUNNER = /(?:^|[\s|;&(`])(?:(?:ba|z|da|k)?sh|eval)(?:\s+-[A-Za-z]+)*\s+$/;
const HEREDOC = /^<<-?[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function blank(text) {
	return ' '.repeat(text.length);
}

// Index of the quote closing the one at `open`, or s.length if unterminated.
// Inside double quotes a `"` within `$(…)` or backticks belongs to the
// substitution, not to the string.
function closingQuote(s, open) {
	if (s[open] === "'") {
		const end = s.indexOf("'", open + 1);
		return end < 0 ? s.length : end;
	}
	let depth = 0;
	let tick = false;
	for (let i = open + 1; i < s.length; i++) {
		const c = s[i];
		if (c === '\\') { i++; continue; }
		if (c === '`') tick = !tick;
		else if (c === '$' && s[i + 1] === '(') { depth++; i++; }
		else if (c === ')' && depth > 0) depth--;
		else if (c === '"' && depth === 0 && !tick) return i;
	}
	return s.length;
}

// Blanks a double-quoted body except its command substitutions.
function maskDouble(body) {
	let out = '';
	let depth = 0;
	let tick = false;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === '`') { tick = !tick; out += c; continue; }
		if (c === '$' && body[i + 1] === '(') { depth++; out += '$('; i++; continue; }
		if (c === ')' && depth > 0) { depth--; out += c; continue; }
		out += depth > 0 || tick ? c : ' ';
	}
	return out;
}

// Whether the command a heredoc feeds (the first word of its segment) is a shell.
function feedsShell(before) {
	const segment = before.split(/[|;&\n(]/).pop().trim();
	const word = segment.split(/\s+/)[0] || '';
	return SHELLS.has(word.split('/').pop());
}

function maskQuoted(command) {
	const s = String(command || '');
	let out = '';
	const heredocs = [];
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		if (c === '\\') {
			out += s.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === "'" || c === '"') {
			const end = closingQuote(s, i);
			const body = s.slice(i + 1, end);
			const tail = end < s.length ? 1 : 0;
			if (SHELL_RUNNER.test(s.slice(0, i))) {
				out += ';' + body.replace(/\n/g, ';') + (tail ? ';' : '');
			} else {
				out += c + (c === '"' ? maskDouble(body) : blank(body)) + (tail ? c : '');
			}
			i = end + 1;
			continue;
		}
		if (c === '<' && s.startsWith('<<', i) && !s.startsWith('<<<', i)) {
			const m = HEREDOC.exec(s.slice(i));
			if (m) {
				heredocs.push({ delim: m[1] || m[2] || m[3], keep: feedsShell(s.slice(0, i)) });
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		if (c === '\n') {
			out += ';';
			i++;
			// Heredoc bodies follow the line that opened them, in order; each
			// runs to a line that is exactly its delimiter (leading tabs
			// allowed, for <<-).
			for (const h of heredocs.splice(0)) {
				while (i < s.length) {
					let lineEnd = s.indexOf('\n', i);
					if (lineEnd < 0) lineEnd = s.length;
					const line = s.slice(i, lineEnd);
					const sep = lineEnd < s.length ? ';' : '';
					i = lineEnd + 1;
					if (line.replace(/^\t+/, '').trimEnd() === h.delim) {
						out += line + sep;
						break;
					}
					out += (h.keep ? line : blank(line)) + sep;
				}
			}
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

// Tool-name matcher for Codastre MCP calls under either namespace.
// CORPUS_SEARCH (v0.15.0) and CONTRACTS (v0.17.0) are retrieval calls too: they
// must count as the Codastre attempt `auto` mode waits for, be blocked in
// Codastre-free mode, and show up in the receipt.
const CODASTRE_TOOL = /codastre.*__(QUERY|GRAPH|CORPUS_SEARCH|CONTRACTS|REGISTER|SYNC)$/i;

// --- The CLI plane ----------------------------------------------------------
// `codastre query|graph|corpora|contracts` run through Bash are Codastre retrieval
// calls that happen not to be MCP calls. They are the cheapest way to reach the
// format ladder with bodies on, and on a pre-v0.18.0 CLI the only way a
// structuredContent-preferring client sees the `agent` rung at all (see
// core/retrieval-playbook.md §2c). Three
// things follow, and all three were wrong while this regex didn't exist:
//   - they must never be classified as text search. `codastre query … | grep x`
//     matches BASH_SEARCH, so Codastre-only mode would have blocked the very
//     call it exists to encourage;
//   - Codastre-free mode must block them, or the A/B leaks Codastre into the
//     text-search arm through a plane the hook wasn't watching;
//   - `auto` mode must count them as the Codastre attempt that unlocks a
//     text-search fallback, and the receipt must count their tokens — a
//     recommendation whose cost is invisible can't be measured.
// Matches an optional path prefix (`~/go/bin/codastre`, `./codastre`) and the
// Windows `.exe`, at a command boundary, so a pipeline stage counts too.
const CODASTRE_CLI = /(?:^|[|;&(`]\s*)(?:[^\s|;&()`]*[\/\\])?codastre(?:\.exe)?\s+(query|graph|corpora|corpus|contracts)\b/i;

// Returns 'query' | 'graph' | 'corpora' | 'corpus' | 'contracts' for a Codastre
// CLI retrieval command, else null (`corpus` is the CLI's alias for `corpora`).
function codastreCliCall(command) {
	const m = CODASTRE_CLI.exec(maskQuoted(command));
	return m ? m[1].toLowerCase() : null;
}

// Which rung a CLI call asked for, in the same vocabulary as the MCP `format`
// argument: `--format agent` → agent, `--json` / `--format json` → verbose
// (the CLI's raw envelope is the verbose payload), plain human output → human.
// Recorded so a plane-mixed log still groups by rung.
function cliRung(command) {
	const cmd = String(command || '');
	const m = /--format[=\s]+(agent|json|human)\b/i.exec(cmd);
	if (m) return m[1].toLowerCase() === 'json' ? 'verbose' : m[1].toLowerCase();
	if (/(?:^|\s)--json\b/.test(cmd)) return 'verbose';
	return 'human';
}

// --- Live A/B "search mode" -------------------------------------------------
// The user toggles a mode with /codastre:mode. While a mode is active the
// PreToolUse hook constrains which search class may run, so the same question
// can be answered Codastre-only vs text-search-only (strict A/B), or Codastre-
// first with a disciplined fallback (`auto`, the recommended standing config).
// State is a one-word file so any hook/command can read it without IPC.
function modeFilePath() {
	return (
		process.env.CODASTRE_SEARCH_MODE_FILE ||
		path.join(os.homedir(), '.config', 'codastre', 'search-mode')
	);
}

// A forgotten `/codastre:mode codastre` should not keep hard-blocking Grep in
// every future session forever. The mode file auto-expires after this window
// (based on last-write time); re-run `/codastre:mode …` to refresh it.
const MODE_TTL_MS =
	(Number(process.env.CODASTRE_SEARCH_MODE_TTL_HOURS) || 8) * 60 * 60 * 1000;

function normalizeMode(raw) {
	const v = String(raw || '').trim().toLowerCase();
	return v === 'codastre' || v === 'grep' || v === 'auto' ? v : null;
}

// Returns 'codastre' | 'grep' | 'auto' | null (off/unset/invalid/expired).
// CODASTRE_SEARCH_MODE (env) overrides the file and never expires — intended
// for scripted/CI runs and tests.
function readMode() {
	const env = process.env.CODASTRE_SEARCH_MODE;
	if (env !== undefined) return normalizeMode(env);
	const p = modeFilePath();
	try {
		const st = fs.statSync(p);
		if (Date.now() - st.mtimeMs > MODE_TTL_MS) return null; // stale → treat as off
	} catch {
		return null; // no file → off
	}
	return normalizeMode(safeRead(p));
}

// The effective mode for one session. A Tier D study session (the one the
// study file was claimed by) runs under its arm's mode, overriding
// /codastre:mode and CODASTRE_SEARCH_MODE: the arm is the experiment, and a
// leftover standing mode must not leak into it. Every other session gets
// readMode(). This is the only place the override is applied, so enforcement
// (mode.js), tracking (track.js), failure marking (session_events.js) and the
// per-turn instruction (mode_prompt.js) agree about which arm a session is in.
function readModeFor(sessionId) {
	const studyMode = normalizeMode(require('./study').studyModeFor(sessionId));
	return studyMode || readMode();
}

// Per-turn run marker, keyed by session so two concurrent sessions never
// clobber each other's marker (which would misattribute a receipt to the wrong
// session's data). mode_prompt.js stamps it at turn start; track.js annotates
// it with the turn's Codastre outcome; receipt.js reads it back.
function runMarkerPath(sessionId) {
	const id = String(sessionId || '').replace(/[^A-Za-z0-9_.-]/g, '') || 'default';
	return path.join(os.homedir(), '.config', 'codastre', `bench-run.${id}.json`);
}

function readRunMarker(sessionId) {
	try {
		return JSON.parse(fs.readFileSync(runMarkerPath(sessionId), 'utf8'));
	} catch {
		return null;
	}
}

function writeRunMarker(sessionId, marker) {
	try {
		const p = runMarkerPath(sessionId);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(marker));
	} catch {
		// Non-fatal: the receipt just falls back to a wider window.
	}
}

// Annotate the per-session run marker with one Codastre call and whether it
// failed. `auto` mode's PreToolUse gate reads it to allow a text-search
// fallback only after a Codastre attempt (immediately, if that attempt failed).
// Shared by track.js (PostToolUse, CODASTRE_ERROR regex over the response) and
// session_events.js (PostToolUseFailure, the first-party failure signal).
function recordCodastreOutcome(sessionId, failed) {
	const marker = readRunMarker(sessionId) || {};
	marker.codastre_calls = (marker.codastre_calls || 0) + 1;
	if (failed) marker.codastre_failed = true;
	writeRunMarker(sessionId, marker);
}

// --- Session events log --------------------------------------------------------
// Compaction and tool-failure events, read back by `codastre collect`. Unlike
// the token log this is always on: it holds counters and enums only (session
// id, event, phase/trigger, tool name, class, a sanitised error type) -- never
// a prompt, a path, a tool input or output, or an error message -- and it never
// leaves the machine. It is always on because, unlike the transcript, a
// compaction cannot be recovered after the fact: the signal exists only if a
// hook was listening when it happened.
function sessionEventsLogPath() {
	return (
		process.env.CODASTRE_SESSION_EVENTS_LOG ||
		path.join(os.homedir(), '.config', 'codastre', 'session-events.jsonl')
	);
}

// Tool class in the shared vocabulary: codastre | text-search | read | other.
// Same precedence as track.js and mode.js: a `codastre query … | grep` shell
// pipeline is a Codastre call, not a grep.
function toolClass(toolName, toolInput) {
	const name = String(toolName || '');
	if (CODASTRE_TOOL.test(name)) return 'codastre';
	if (name === 'Grep' || name === 'Glob') return 'text-search';
	if (name === 'Bash') {
		const command = String((toolInput && toolInput.command) || '');
		if (codastreCliCall(command)) return 'codastre';
		if (isBashSearch(command)) return 'text-search';
		if (isBashRead(command)) return 'read';
		return 'other';
	}
	if (name === 'Read' || name === 'NotebookRead') return 'read';
	return 'other';
}

// Append one JSON record, rotating to a single `.1` backup past maxBytes.
// Never throws: a hook must not fail the session over bookkeeping.
function appendJsonl(logPath, record, maxBytes) {
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		try {
			if (fs.statSync(logPath).size > maxBytes) fs.renameSync(logPath, logPath + '.1');
		} catch {
			// no file yet, or rename raced -- nothing to rotate.
		}
		fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
	} catch {
		// Non-fatal by design.
	}
}

function safeRead(p) {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch {
		return '';
	}
}

module.exports = {
	codastreConfigured,
	resolveCli,
	cliInstalled,
	cliCapabilities,
	parseVersion,
	versionAtLeast,
	pluginVersion,
	clientId,
	clientFlag,
	trackingEnabled,
	tokenLogPath,
	readStdinJson,
	estTokens,
	tokenBasis,
	requestedRung,
	BYTES_PER_TOKEN,
	isBashSearch,
	isBashRead,
	maskQuoted,
	CODASTRE_TOOL,
	CODASTRE_CLI,
	codastreCliCall,
	cliRung,
	hasAgentHeader,
	modeFilePath,
	readMode,
	readModeFor,
	runMarkerPath,
	readRunMarker,
	writeRunMarker,
	recordCodastreOutcome,
	sessionEventsLogPath,
	toolClass,
	appendJsonl,
};
