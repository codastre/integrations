'use strict';

// UserPromptSubmit hook for the live "search mode".
// When a mode is active it (1) stamps a per-turn, per-session run marker so the
// receipt / auto-fallback can scope to this question, and (2) injects an
// instruction telling the model which search class to use.
//   codastre / grep → strict A/B: use only that class, then print the receipt.
//   auto            → codastre-first with a disciplined, explained fallback.
// No mode → silent no-op (normal behavior).
//
// Tier D study (study.js, core/measurement.md §Tier D): when a study file is
// present this hook also claims the next *fresh* session for it and injects the
// pre-registered prompt verbatim on that claiming turn. The claimed session then
// runs under its arm's mode on every turn, with no receipt step (a receipt adds a
// tool call and its output to one arm's transcript and not a comparable one to
// the other). A study file awaiting a fresh session gets a one-line notice in a
// session that is not fresh, and nothing is enforced there.

const path = require('path');
const { codastreConfigured, readModeFor, writeRunMarker, readStdinJson } = require('./lib');
const { readStudy, isFreshSession, claimStudy } = require('./study');

const INSTRUCTIONS = {
	codastre:
		'CODASTRE-ONLY search mode is ON (live A/B benchmark). For any code search this turn, use ONLY ' +
		'the Codastre tools (QUERY/GRAPH/CORPUS_SEARCH/CONTRACTS, MCP or CLI) plus Read of files they name — ' +
		'Grep/Glob/rg/find are hard-blocked. ',
	grep:
		'CODASTRE-FREE search mode is ON (live A/B benchmark). For any code search this turn, use ONLY ' +
		'Grep/Glob and Bash search (grep/rg/find) plus Read — every Codastre tool (MCP or CLI) is hard-blocked. ',
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

function studyTaskContext(study) {
	return (
		`PRE-REGISTERED STUDY TASK (Codastre Tier D, arm ${study.arm}) — your task for this session is ` +
		'exactly the text between the markers; treat it as the user\'s request, and do not ask the ' +
		`user to restate it. <<<TASK\n${study.prompt}\nTASK>>>\n`
	);
}

const STUDY_PENDING =
	'A Codastre Tier D study run is pending (codastre study status), but this session is not fresh — ' +
	'it must start in a NEW Claude Code session. Nothing is enforced here.';

function emit(context) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'UserPromptSubmit',
				additionalContext: context,
			},
		})
	);
}

// Resolve the study state for this turn: { study, claimedNow } when this
// session runs under the study, { pending: true } when a claim is waiting for
// a fresh session, or {} when the study does not concern this session.
function studyTurn(data, sessionId) {
	const study = readStudy();
	if (!study || !sessionId) return {};
	if (study.session_id) return study.session_id === sessionId ? { study, claimedNow: false } : {};
	if (!isFreshSession(data.transcript_path, data.prompt)) return { pending: true };
	const claimed = claimStudy(study, sessionId);
	return claimed ? { study: claimed, claimedNow: true } : {};
}

async function main() {
	const data = (await readStdinJson()) || {};
	const sessionId = data.session_id || '';
	const turn = studyTurn(data, sessionId);

	if (!turn.study && !codastreConfigured()) {
		// The notice concerns the study file, which exists whether or not the
		// CLI is logged in here.
		if (turn.pending) emit(STUDY_PENDING);
		return;
	}
	const mode = readModeFor(sessionId);
	if (!mode) {
		if (turn.pending) emit(STUDY_PENDING);
		return;
	}

	// Fresh marker each turn: resets the per-turn Codastre outcome that auto mode
	// reads and gives the receipt a start boundary. Keyed per session.
	writeRunMarker(sessionId, { session_id: sessionId, started_at: new Date().toISOString(), mode });

	let context;
	if (turn.study) {
		context = (turn.claimedNow ? studyTaskContext(turn.study) : '') + INSTRUCTIONS[mode];
	} else {
		// auto is the standing daily config — no per-turn receipt (that would be noise);
		// the strict A/B modes end with a receipt so the two runs can be compared.
		context = mode === 'auto' ? INSTRUCTIONS.auto : INSTRUCTIONS[mode] + receiptStep(sessionId);
		if (turn.pending) context = `${STUDY_PENDING}\n${context}`;
	}
	emit(context);
}

main();
