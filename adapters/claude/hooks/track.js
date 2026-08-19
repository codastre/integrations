'use strict';

// Opt-in PostToolUse logger for search-related token usage.
// Enable with CODASTRE_TRACK_TOKENS=1; appends one JSONL record per search
// tool call to ~/.config/codastre/claude-token-log.jsonl (CODASTRE_TOKEN_LOG
// overrides). Read it back with /codastre:tokens.
//
// It also, while a live A/B/auto mode is active, annotates the per-session run
// marker with the turn's Codastre outcome (calls made, whether one failed) so
// `auto` mode can allow a text-search fallback only after a Codastre attempt.
//
// Codastre calls arrive on two planes and both are logged, tagged `plane`:
// `mcp` (the QUERY/GRAPH tools) and `cli` (`codastre query|graph` through Bash,
// which is the recommended plane while the MCP `agent` rung is swallowed by a
// structuredContent-preferring client).

const fs = require('fs');
const path = require('path');
const {
	trackingEnabled,
	readMode,
	tokenLogPath,
	readStdinJson,
	estTokens,
	tokenBasis,
	requestedRung,
	isBashSearch,
	codastreCliCall,
	cliRung,
	CODASTRE_TOOL,
	readRunMarker,
	writeRunMarker,
} = require('./lib');

// Log when the user opted into tracking, OR when a live mode is active
// (the receipt / auto-fallback need data either way). Otherwise no-op.
const MODE = readMode();
if (!trackingEnabled() && !MODE) process.exit(0);

// Rotate the log once it gets large so it doesn't grow unbounded. Keeps a
// single .1 backup (last window is enough for the receipt / audit).
const LOG_MAX_BYTES = Number(process.env.CODASTRE_TOKEN_LOG_MAX_BYTES) || 5 * 1024 * 1024;

// Data-plane failures that should let `auto` mode fall through to text search
// immediately (the fallback the README promises, made mechanical).
// The CLI plane adds its own: an out-of-date binary rejects `--snippets` /
// `--format agent` as an unknown flag, and a missing binary never runs at all.
// Both must count as a Codastre failure, or `auto` mode traps a user with an old
// CLI between a blocked grep and a call that cannot succeed.
const CODASTRE_ERROR =
	/RETRIEVAL_UNAVAILABLE|REPO_NOT_INDEXED|"error"|no API key|unknown (?:flag|command|shorthand)|command not found|not logged in/i;

// Returns {class, detail} for tools we account for, else null.
// While a mode is active we also count Read calls, so a grep workflow's
// follow-up file reads (which it needs and Codastre's snippets often avoid) are
// attributed rather than hidden — otherwise the comparison understates grep.
function classify(toolName, toolInput) {
	if (CODASTRE_TOOL.test(toolName)) {
		return {
			class: 'codastre',
			plane: 'mcp',
			detail: toolInput.query_text || toolInput.chunk_or_symbol || toolInput.topic || '',
		};
	}
	if (toolName === 'Grep' || toolName === 'Glob') {
		return { class: 'text-search', detail: toolInput.pattern || '' };
	}
	if (toolName === 'Bash') {
		const command = toolInput.command || '';
		// CLI plane first — same ordering as mode.js, for the same reason: a
		// `codastre query … | grep` pipeline is a Codastre call, not a grep. Left
		// unaccounted, the plane the playbook now recommends would be free in every
		// receipt while the MCP calls it replaced were charged in full.
		const cli = codastreCliCall(command);
		if (cli) {
			return { class: 'codastre', plane: 'cli', detail: command.slice(0, 200) };
		}
		if (!isBashSearch(command)) return null;
		return { class: 'text-search', detail: command.slice(0, 200) };
	}
	if (MODE && toolName === 'Read') {
		return { class: 'read', detail: toolInput.file_path || '' };
	}
	return null;
}

function rotateIfLarge(logPath) {
	try {
		if (fs.statSync(logPath).size > LOG_MAX_BYTES) {
			fs.renameSync(logPath, logPath + '.1');
		}
	} catch {
		// no file yet, or rename raced — either way, nothing to rotate.
	}
}

// In `auto` mode, record the turn's Codastre outcome on the run marker so
// mode.js can allow a text-search fallback only after a Codastre attempt (or
// immediately if Codastre errored). Keyed per session — no cross-talk.
function recordCodastreOutcome(sessionId, failed) {
	const marker = readRunMarker(sessionId) || {};
	marker.codastre_calls = (marker.codastre_calls || 0) + 1;
	if (failed) marker.codastre_failed = true;
	writeRunMarker(sessionId, marker);
}

async function main() {
	const data = await readStdinJson();
	if (!data || !data.tool_name) return;

	const toolInput = data.tool_input || {};
	const entry = classify(data.tool_name, toolInput);
	if (!entry) return;

	const responseText =
		typeof data.tool_response === 'string'
			? data.tool_response
			: JSON.stringify(data.tool_response || '');

	// Which rung the call was for -- a different question from which ratio fits
	// its bytes. See requestedRung in lib.js. On the CLI plane the rung is in the
	// command line, not in a tool argument.
	const rung =
		entry.plane === 'cli'
			? cliRung(toolInput.command || '')
			: requestedRung(entry.class, toolInput, data.tool_response);

	// Classify on the raw response, not on responseText: stringifying wraps every
	// MCP result in JSON braces, which would read an agent rendering as an
	// envelope and re-introduce the bias the two ratios exist to remove.
	//
	// The CLI plane has a third shape the two measured ratios don't cover: default
	// `human` output is neither a JSON envelope nor the agent rendering, so it gets
	// the unmeasured `text` ratio rather than being silently priced as JSON. The
	// rendering is still confirmed from the output itself (`hasAgentHeader` via
	// tokenBasis) instead of trusted from the flag, so an old binary that rejected
	// `--format agent` isn't recorded as if it had rendered one.
	const basis =
		entry.plane === 'cli'
			? tokenBasis(entry.class, data.tool_response) === 'agent'
				? 'agent'
				: rung === 'verbose'
				? 'json'
				: 'text'
			: tokenBasis(entry.class, data.tool_response);

	if (MODE === 'auto' && entry.class === 'codastre') {
		recordCodastreOutcome(data.session_id || '', CODASTRE_ERROR.test(responseText));
	}

	const record = {
		ts: new Date().toISOString(),
		session_id: data.session_id || '',
		cwd: data.cwd || '',
		tool: data.tool_name,
		class: entry.class,
		...(entry.plane ? { plane: entry.plane } : {}),
		detail: entry.detail,
		out_tokens: estTokens(responseText, basis),
		tok_basis: basis,
		...(rung ? { rung } : {}),
	};

	try {
		const logPath = tokenLogPath();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		rotateIfLarge(logPath);
		fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
	} catch {
		// Never fail the tool call over logging.
	}
}

main();
