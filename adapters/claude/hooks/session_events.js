'use strict';

// Session events: PreCompact / PostCompact / PostToolUseFailure.
//
// Appends one counters-only record per event to the session events log
// (~/.config/codastre/session-events.jsonl, CODASTRE_SESSION_EVENTS_LOG
// overrides), which `codastre collect` folds into per-session counters:
//
//   {"ts","session_id","event":"compact","phase":"pre"|"post","trigger":"auto"|"manual"|"unknown"}
//   {"ts","session_id","event":"tool_failure","tool","class","error_type"}
//
// Always on, and local only. A compaction is the session running out of
// context room -- the headroom cost of a bloated context made concrete -- and
// unlike everything in the transcript it cannot be recovered later: it is
// recorded only if a hook was listening when it happened.
//
// What is deliberately NOT recorded: the compaction summary or instructions,
// the tool's input or output, the error message, the cwd. `error_type` is a
// bounded token or `other`, never free text.
//
// PostToolUseFailure on a Codastre call in `auto` mode also marks the run
// marker failed -- the first-party failure signal, so the fallback gate no
// longer depends solely on regex-matching error strings out of a response
// (track.js keeps that path for failures the harness reports as successes).

const {
	readStdinJson,
	readModeFor,
	sessionEventsLogPath,
	toolClass,
	appendJsonl,
	recordCodastreOutcome,
} = require('./lib');

const LOG_MAX_BYTES =
	Number(process.env.CODASTRE_SESSION_EVENTS_LOG_MAX_BYTES) || 5 * 1024 * 1024;

const TRIGGERS = new Set(['auto', 'manual']);
const ERROR_TYPE = /^[a-z0-9_]{1,40}$/;

function compactTrigger(data) {
	const raw = String(data.trigger || data.triggered_by || '').toLowerCase();
	return TRIGGERS.has(raw) ? raw : 'unknown';
}

function errorType(data) {
	const raw = String(data.error_type || '').toLowerCase();
	return ERROR_TYPE.test(raw) ? raw : 'other';
}

// Build the record for an event, or null for events this hook does not own.
function buildRecord(eventName, data) {
	const base = { ts: new Date().toISOString(), session_id: String(data.session_id || '') };
	switch (eventName) {
		case 'PreCompact':
		case 'PostCompact':
			return {
				...base,
				event: 'compact',
				phase: eventName === 'PreCompact' ? 'pre' : 'post',
				trigger: compactTrigger(data),
			};
		case 'PostToolUseFailure':
			return {
				...base,
				event: 'tool_failure',
				tool: String(data.tool_name || ''),
				class: toolClass(data.tool_name, data.tool_input || {}),
				error_type: errorType(data),
			};
		default:
			return null;
	}
}

async function main() {
	const data = (await readStdinJson()) || {};
	const eventName = data.hook_event_name || process.argv[2] || '';
	const record = buildRecord(eventName, data);
	if (!record) return;

	appendJsonl(sessionEventsLogPath(), record, LOG_MAX_BYTES);

	if (record.event === 'tool_failure' && record.class === 'codastre' && readModeFor(record.session_id) === 'auto') {
		recordCodastreOutcome(record.session_id, true);
	}
}

if (require.main === module) {
	main().catch(() => {
		// Never fail the hook.
	});
}

module.exports = { buildRecord };
