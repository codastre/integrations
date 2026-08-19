'use strict';

// PreToolUse enforcement for the live "search mode" (/codastre:mode).
//   mode = codastre → block text search (Grep/Glob/Bash-search); allow QUERY/GRAPH
//   mode = grep     → block Codastre on both planes (QUERY/GRAPH and the
//                     `codastre query|graph` CLI); allow text search
//   mode = auto     → QUERY/GRAPH always allowed; text search allowed only AFTER
//                     a Codastre attempt this turn (or immediately if Codastre
//                     errored) — codastre-first with a disciplined fallback
//   mode = off      → no-op (the advisory nudge hooks still run)
// codastre/grep are strict A/B measurement tools (hard deny). auto is the
// recommended standing config: it soft-denies the first text search so the
// agent tries Codastre once, then lets the fallback through.

const {
	codastreConfigured,
	readMode,
	readStdinJson,
	isBashSearch,
	codastreCliCall,
	CODASTRE_TOOL,
	readRunMarker,
} = require('./lib');

function classOf(toolName, toolInput) {
	if (CODASTRE_TOOL.test(toolName)) return 'codastre';
	if (toolName === 'Grep' || toolName === 'Glob') return 'text-search';
	if (toolName === 'Bash') {
		const command = toolInput.command || '';
		// The CLI plane is Codastre, and it is tested FIRST: `codastre query …`
		// piped into grep would otherwise read as a text search and be blocked in
		// the very mode that asks for Codastre.
		if (codastreCliCall(command)) return 'codastre';
		if (isBashSearch(command)) return 'text-search';
	}
	return null;
}

function deny(reason) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'deny',
				permissionDecisionReason: reason,
			},
		})
	);
}

async function main() {
	if (!codastreConfigured()) return;
	const mode = readMode();
	if (!mode) return; // off → let the normal nudge hooks handle it

	const data = await readStdinJson();
	if (!data || !data.tool_name) return;
	const cls = classOf(data.tool_name, data.tool_input || {});
	if (!cls) return;

	if (mode === 'codastre' && cls === 'text-search') {
		deny(
			'Codastre-only mode is ON (/codastre:mode). Text search is blocked for this A/B run — ' +
				'use the Codastre QUERY tool (conceptual/identifier search) or GRAPH (relationships) instead. ' +
				'For everyday use where a literal Grep is sometimes legitimately needed, `/codastre:mode auto` ' +
				'allows text search after one Codastre attempt. ' +
				'Switch with `/codastre:mode grep` or turn it off with `/codastre:mode off`.'
		);
	} else if (mode === 'grep' && cls === 'codastre') {
		deny(
			'Codastre-free mode is ON (/codastre:mode). Codastre is blocked for this A/B run on BOTH planes — ' +
				'the QUERY/GRAPH MCP tools and the `codastre query` / `codastre graph` CLI. ' +
				'Answer with Grep/Glob and Bash search (grep/rg/find) plus Read. ' +
				'Switch with `/codastre:mode codastre` or turn it off with `/codastre:mode off`.'
		);
	} else if (mode === 'auto' && cls === 'text-search') {
		const marker = readRunMarker(data.session_id || '');
		// Fail open: if a Codastre call errored this turn, let text search through.
		if (marker && marker.codastre_failed) return;
		// Allow once a Codastre attempt has been logged this turn.
		if (marker && (marker.codastre_calls || 0) > 0) return;
		// Otherwise, nudge Codastre-first — but softly, and re-running the exact
		// search after one QUERY attempt (or a failure) will pass.
		deny(
			'Codastre-first (auto) mode is ON (/codastre:mode auto). Try one Codastre retrieval call first — ' +
				'the QUERY/GRAPH tool, or `codastre query|graph --format agent` on the CLI plane; either counts. ' +
				'If it fails or is unavailable, returns nothing on a genuinely literal string, the target is an ' +
				'uncommitted/unindexed file, or the ranking stays flat after one reshape — re-run this exact ' +
				'search and it will be allowed (say briefly why you fell back). Turn it off with `/codastre:mode off`.'
		);
	}
}

main();
