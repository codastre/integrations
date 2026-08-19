'use strict';

// SessionStart / SubagentStart / PreToolUse context injection.
// SessionStart is also where the plugin self-diagnoses: if its own CLI (which
// backs the MCP server via `codastre serve`) is missing, it says so and how to
// install — the plugin being installed signals intent, so this is help, not nag.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { codastreConfigured, cliInstalled, cliCapabilities, readStdinJson } = require('./lib');

const hookEventName = process.argv[2];

const AWARENESS =
	'You have access to the Codastre code-retrieval tools: QUERY (ranked hybrid semantic + lexical search across every indexed repo, snippets inline) and GRAPH (cross-repo relationships: calls, imports, extends/implements, Kafka, HTTP, shared packages). Prefer QUERY over Grep/Glob/rg/find for conceptual and identifier searches, and GRAPH for callers/callees, impact analysis, and cross-service tracing — one shaped call returns a handful of ranked hits instead of pages of raw matches. Keep Grep/Glob for literal strings, unindexed files, or when QUERY is unavailable. The codastre-search and codastre-graph-navigation skills carry the details (phrasing, scoping, the one-call stop rule) — load them when a search or structural question comes up.';

const INSTALL_HINT =
	'SETUP NOTICE — proactively tell the user (concisely, once): the Codastre Claude Code plugin is installed, but its `codastre` CLI is not on your PATH. The plugin runs its MCP server via `codastre serve`, so QUERY/GRAPH will not work until the CLI is installed. To fix: install the codastre CLI and put it on your PATH (see your Codastre onboarding or https://codastre.com; or build the Go CLI from the repo\'s `cli/` directory and symlink it into a PATH dir such as `~/.local/bin`), then run `codastre login` and restart Claude Code. Verify with `/codastre:status` or `codastre doctor`.';

const LOGIN_HINT =
	'SETUP NOTICE — proactively tell the user (concisely, once): the `codastre` CLI is installed but not authenticated. Run `codastre login [--server URL]` to store an API key, then `/codastre:status` to verify. Until then the Codastre QUERY/GRAPH tools will fail.';

// Which plane this session should reach the format ladder on, resolved locally so
// the model never spends a call probing it. Claude Code prefers
// `structuredContent` when both representations are present, and `format:
// "agent"` deliberately puts the payload only in `content[0].text` — so over MCP
// the rendering is discarded and the model sees a fixed summary. The rendering is
// still reachable through the CLI, but only on a binary new enough to have the
// flags. See core/retrieval-playbook.md 2c.
function planeLine() {
	const caps = cliCapabilities();
	if (!caps || !caps.available) return '';
	const version = caps.version && caps.version !== 'unknown' ? ` (${caps.version})` : '';

	if (caps.hydrate && caps.agentFormat) {
		return (
			' FORMAT LADDER — USE THE CLI PLANE: this client discards an MCP `agent` rendering (it prefers ' +
			'`structuredContent`, where that rung carries only a fixed summary), so do not ask QUERY/GRAPH for ' +
			`format="agent" — it returns no results. The installed codastre CLI${version} can render and hydrate, ` +
			'so take the cheap rung through Bash instead: `codastre query "<code vocabulary>" --top-k 6 ' +
			'[--language X] [--path-prefix P] --format agent --snippets` and `codastre graph <seed> --direction ' +
			'<inbound|outbound|both> --format agent`. Measured against MCP verbose on one pinned result set: ' +
			'−32% tokens with bodies on, −79% for locations-only. Two traps: **the CLI defaults bodies OFF**, so ' +
			'pass --snippets for ordinary "where is X / what does X do" and omit it only when the ranking is the ' +
			'answer; and run inside the repo checkout (or pass --repo-url/--repo-path) so paths resolve and ' +
			'bodies hydrate. Stay on the QUERY/GRAPH tools when Bash is unavailable, for REGISTER, or when you ' +
			'need the raw JSON envelope.'
		);
	}
	return (
		' FORMAT LADDER — MCP `verbose` ONLY: this client discards an MCP `agent` rendering, and the installed ' +
		`codastre CLI${version} predates the CLI plane's \`--format agent\` / \`--snippets\` (both added in ` +
		'v0.14.0), so neither plane can deliver the cheap rung. Use format="verbose" on QUERY/GRAPH and do not ' +
		'attempt format="agent". Tell the user ONCE, in one line, that updating the codastre CLI would cut ' +
		'roughly a third of the tokens per hydrated retrieval call — and let them choose how to update it ' +
		'(do not guess a package name or run an installer).'
	);
}

const PRETOOL_NUDGE =
	'Consider the Codastre QUERY tool before Grep/Glob for this search: for conceptual or identifier searches it returns ~10 ranked snippets instead of raw match dumps, with better relevance and far fewer tokens. Grep/Glob remain right for literal strings, unindexed files, or when Codastre is unavailable.';

function emit(context) {
	process.stdout.write(
		JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })
	);
}

// The session already knows its own target repo — the cwd's git origin. Passing
// it converts most searches from noisy-federated to scoped, the cheapest
// precision win on a mixed tenant. Cheap, local, best-effort.
function autoScopeLine(cwd) {
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
			cwd: cwd || process.cwd(),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 2000,
		}).trim();
		if (!url) return '';
		return (
			` This project is \`${url}\`; pass \`repo_url=${url}\` to QUERY/GRAPH by default for questions ` +
			'about this codebase, and go federated (omit it) only for genuinely cross-repo questions.'
		);
	} catch {
		return ''; // not a git repo / no origin / git missing — stay federated
	}
}

// Nudge-once-per-session: repeating the same "prefer QUERY" paragraph before
// every Grep is context spam. Throttle to the first Grep/Glob per session.
function nudgeMarkerPath(sessionId) {
	const id = String(sessionId || '').replace(/[^A-Za-z0-9_.-]/g, '') || 'default';
	return path.join(os.tmpdir(), `codastre-nudge.${id}`);
}

function alreadyNudged(sessionId) {
	const p = nudgeMarkerPath(sessionId);
	try {
		fs.accessSync(p);
		return true;
	} catch {
		try {
			fs.writeFileSync(p, '1');
		} catch {
			// If we can't write the marker, fall back to nudging (never suppress).
		}
		return false;
	}
}

async function main() {
	const installed = cliInstalled();
	const configured = codastreConfigured();

	if (hookEventName === 'SessionStart') {
		const data = await readStdinJson();
		// Speak even when unconfigured, but only to guide setup (install > login > ready).
		if (!installed) emit(INSTALL_HINT);
		else if (!configured) emit(LOGIN_HINT);
		else emit(AWARENESS + autoScopeLine(data && data.cwd) + planeLine());
	} else if (hookEventName === 'SubagentStart') {
		// Subagents get awareness only when the tools actually work — never a setup nag.
		if (installed && configured) {
			const data = await readStdinJson();
			emit(AWARENESS + autoScopeLine(data && data.cwd) + planeLine());
		}
	} else if (hookEventName === 'PreToolUse') {
		// Only nudge toward QUERY when it can actually serve the request, and only
		// once per session so it doesn't spam a legitimate run of literal Greps.
		if (installed && configured) {
			const data = await readStdinJson();
			if (!alreadyNudged(data && data.session_id)) emit(PRETOOL_NUDGE);
		}
	}
}

main();
