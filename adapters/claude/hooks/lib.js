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
function cliInstalled() {
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
			try {
				fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
				return true;
			} catch {
				// keep scanning
			}
		}
	}
	return false;
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

// ~4 chars per token is a stable cross-model approximation for code/text;
// good enough for relative comparisons (the point of the log).
function estTokens(text) {
	if (!text) return 0;
	return Math.ceil(String(text).length / 4);
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
	cliInstalled,
	trackingEnabled,
	tokenLogPath,
	readStdinJson,
	estTokens,
	BASH_SEARCH,
	isBashSearch,
	CODASTRE_TOOL,
	modeFilePath,
	readMode,
	runMarkerPath,
	readRunMarker,
	writeRunMarker,
};
