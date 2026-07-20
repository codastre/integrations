'use strict';

// UserPromptSubmit hook for the live "search mode".
// When a mode is active it (1) stamps a per-turn, per-session run marker so the
// receipt / auto-fallback can scope to this question, and (2) injects an
// instruction telling the model which search class to use.
//   codastre / grep → strict A/B: use only that class, then print the receipt.
//   auto            → codastre-first with a disciplined, explained fallback.
// No mode → silent no-op (normal behavior).

const path = require('path');
const { codastreConfigured, readMode, writeRunMarker, readStdinJson } = require('./lib');

const INSTRUCTIONS = {
	codastre:
		'CODASTRE-ONLY search mode is ON (live A/B benchmark). For any code search this turn, use ONLY ' +
		'the Codastre QUERY/GRAPH tools plus Read of files they name — Grep/Glob/rg/find are hard-blocked. ',
	grep:
		'CODASTRE-FREE search mode is ON (live A/B benchmark). For any code search this turn, use ONLY ' +
		'Grep/Glob and Bash search (grep/rg/find) plus Read — the Codastre QUERY/GRAPH tools are hard-blocked. ',
	auto:
		'CODASTRE-FIRST (auto) search mode is ON. For any code search this turn, reach for a Codastre ' +
		'QUERY/GRAPH call first. You MAY fall back to Grep/Glob/rg/find — but only after that Codastre ' +
		'attempt, and only for a real fallback trigger: retrieval errored or is unavailable, the query is a ' +
		'genuinely literal string that returned nothing, the target is an uncommitted/unindexed file, or the ' +
		'ranking stayed flat after one reshape. When you do fall back, say in one clause why. ',
};

function receiptStep(sessionId) {
	// $CLAUDE_PLUGIN_ROOT is only set in the env of hook subprocesses the harness
	// invokes directly (per hooks.json) — not in the shell the model's own Bash
	// tool calls run in. Resolve the absolute path here so the instruction we
	// inject is runnable verbatim regardless of which shell executes it. Pass the
	// session id so the receipt reads this session's marker, not a concurrent one's.
	const receiptPath = path.join(__dirname, 'receipt.js');
	const arg = sessionId ? ` "${sessionId}"` : '';
	return (
		'After you finish answering, run this once and show its output verbatim under a "Token receipt" heading, ' +
		`so the user can compare cost across modes: \`node "${receiptPath}"${arg}\`. ` +
		'Do not estimate the tokens yourself — the script reads the exact logged sizes for this question.'
	);
}

async function main() {
	if (!codastreConfigured()) return;
	const mode = readMode();
	if (!mode) return;

	const data = await readStdinJson();
	const sessionId = (data && data.session_id) || '';
	// Fresh marker each turn: resets the per-turn Codastre outcome that auto mode
	// reads and gives the receipt a start boundary. Keyed per session.
	writeRunMarker(sessionId, { session_id: sessionId, started_at: new Date().toISOString(), mode });

	// auto is the standing daily config — no per-turn receipt (that would be noise);
	// the strict A/B modes end with a receipt so the two runs can be compared.
	const context = mode === 'auto' ? INSTRUCTIONS.auto : INSTRUCTIONS[mode] + receiptStep(sessionId);

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'UserPromptSubmit',
				additionalContext: context,
			},
		})
	);
}

main();
