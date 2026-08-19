'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

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
// Which rungs the installed binary can actually reach on the CLI plane, resolved
// by asking it rather than by parsing a version string (a source build reports
// `dev`, and the flags are the thing that matters):
//
//   hydrate     `codastre query --snippets` — bodies read from a local checkout
//   agentFormat `--format agent` — the text rendering
//
// Both landed in v0.14.0; <= v0.13.1 has neither. This is what lets a session
// know its plane without the model spending a probe call: see
// core/retrieval-playbook.md 2c. Cached per binary (path + mtime + size) so
// SubagentStart doesn't re-exec it for every subagent, and every failure mode
// degrades to "unknown", never to a wrong claim.
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
		`codastre-cli-caps.${Buffer.from(bin + stamp).toString('base64url').slice(-40)}.json`
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
	const version = (String(run(['version']) || '').match(/v?\d+\.\d+\.\d+\S*/) || [''])[0];
	const caps = {
		available: true,
		version: version || 'unknown',
		hydrate: /--snippets\b/.test(help),
		agentFormat: /--format[^\n]*\bagent\b/.test(help),
	};
	try {
		fs.writeFileSync(cache, JSON.stringify(caps));
	} catch {
		// Cache is an optimisation; a failed write just re-probes next session.
	}
	return caps;
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

// The renderer's header is the first line of stdout -- but the CLI plane writes
// a `target: …` scope line to stderr, and a Bash tool result carries the two
// streams merged, so the header can arrive on line 2 or 3. Scan the first few
// lines rather than anchoring at the very start; a JSON envelope is a single
// line beginning with `{`, so nothing else in this class can match.
function hasAgentHeader(text) {
	return String(text || '')
		.trim()
		.split('\n', 3)
		.some((line) => AGENT_RENDERING.test(line.trim()));
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

// --- Search-tool classification (shared regex) ------------------------------
// One source of truth for "this Bash command is a text search", imported by
// mode.js (enforcement), track.js (accounting), and bash.js (nudge) so the
// three can never drift apart. Matches:
//   - grep/rg/ag/ack/fd/findstr at a command boundary (start, after |;&(, or
//     inside $(…)/backtick command substitution);
//   - `git grep` anywhere;
//   - `xargs … grep` (grep reached via xargs, not at a boundary);
//   - `find … -name` with the path argument optional (GNU `find -name x`).
const BASH_SEARCH = new RegExp(
	[
		'(?:^|[|;&(`]\\s*)(?:grep|rg|ag|ack|fd|findstr)\\b',
		'\\bgit\\s+grep\\b',
		'\\bxargs\\b[^|;&]*\\bgrep\\b',
		'(?:^|[|;&(`]\\s*)find\\s+[^|;&]*-name\\b',
	].join('|'),
	'i'
);

function isBashSearch(command) {
	return BASH_SEARCH.test(String(command || ''));
}

// Tool-name matcher for Codastre MCP calls under either namespace.
const CODASTRE_TOOL = /codastre.*__(QUERY|GRAPH|REGISTER|SYNC)$/i;

// --- The CLI plane ----------------------------------------------------------
// `codastre query` / `codastre graph` run through Bash are Codastre retrieval
// calls that happen not to be MCP calls, and until the MCP `agent` rung
// survives a structuredContent-preferring client they are the *recommended*
// way to reach the format ladder (see core/retrieval-playbook.md §2c). Three
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
const CODASTRE_CLI = /(?:^|[|;&(`]\s*)(?:[^\s|;&()`]*[\/\\])?codastre(?:\.exe)?\s+(query|graph)\b/i;

// Returns 'query' | 'graph' for a Codastre CLI retrieval command, else null.
function codastreCliCall(command) {
	const m = CODASTRE_CLI.exec(String(command || ''));
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
	trackingEnabled,
	tokenLogPath,
	readStdinJson,
	estTokens,
	tokenBasis,
	requestedRung,
	BYTES_PER_TOKEN,
	BASH_SEARCH,
	isBashSearch,
	CODASTRE_TOOL,
	CODASTRE_CLI,
	codastreCliCall,
	cliRung,
	hasAgentHeader,
	modeFilePath,
	readMode,
	runMarkerPath,
	readRunMarker,
	writeRunMarker,
};
