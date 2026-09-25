'use strict';

// Tier D paired study (core/measurement.md §Tier D) -- the client half.
//
// `codastre study start <slug>` asks the server for an assignment (arm, pair,
// pre-registered prompt) and writes the study file. The UserPromptSubmit hook
// then claims the next *fresh* Claude Code session for it, injects the prompt
// verbatim, and from then on that one session runs under the arm's search
// mode: `no_tool` → `grep` (Codastre blocked on both planes), `tool` → the
// study's tool-arm mode. Other sessions on the machine are unaffected.
//
// Files (see codastre/docs/plans/m3.5-plane4-study-contract.md §4):
//   study file  $CODASTRE_STUDY_FILE | ~/.config/codastre/study.json  (0600)
//   study log   $CODASTRE_STUDY_LOG  | ~/.config/codastre/study-sessions.jsonl
//
// The log carries ids and a hash only -- never the prompt. `codastre collect`
// reads it to tag the claimed session's upload with its assignment.
//
// No dependency on lib.js at load time: lib.js requires this module for
// readModeFor(), so the one lib helper used here is required lazily.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STUDY_MODES = new Set(['auto', 'codastre', 'grep']);
const STUDY_LOG_MAX_BYTES = 5 * 1024 * 1024;
// A fresh session's transcript is a few KB at its first prompt. Anything larger
// has history, so it is not fresh -- and it is never read in full to find out.
const FRESH_MAX_BYTES = 1024 * 1024;

function configDir() {
	return path.join(os.homedir(), '.config', 'codastre');
}

function studyFilePath() {
	return process.env.CODASTRE_STUDY_FILE || path.join(configDir(), 'study.json');
}

function studyLogPath() {
	return process.env.CODASTRE_STUDY_LOG || path.join(configDir(), 'study-sessions.jsonl');
}

// The study file, or null when absent or unusable. A file without a valid
// mode, assignment and prompt hash is treated as absent rather than guessed.
function readStudy() {
	let study;
	try {
		study = JSON.parse(fs.readFileSync(studyFilePath(), 'utf8'));
	} catch {
		return null;
	}
	if (!study || typeof study !== 'object') return null;
	if (!STUDY_MODES.has(study.mode)) return null;
	if (!study.assignment_id || !/^[0-9a-f]{64}$/.test(String(study.prompt_sha256 || ''))) {
		return null;
	}
	return study;
}

function userPromptText(record) {
	const content = record && record.message && record.message.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		// A tool_result is a user-role record but not a prompt.
		if (content.some((c) => c && c.type === 'tool_result')) return null;
		return content
			.filter((c) => c && c.type === 'text')
			.map((c) => c.text || '')
			.join('');
	}
	return '';
}

// Fresh = the transcript is absent, or holds no user prompt other than (at
// most) the one being submitted now -- the harness may already have written
// it by the time the hook runs. Meta records (command caveats) and tool
// results are not prompts.
function isFreshSession(transcriptPath, currentPrompt) {
	if (!transcriptPath) return true;
	let st;
	try {
		st = fs.statSync(transcriptPath);
	} catch {
		return true;
	}
	if (st.size > FRESH_MAX_BYTES) return false;
	let text;
	try {
		text = fs.readFileSync(transcriptPath, 'utf8');
	} catch {
		return false;
	}
	const prompts = [];
	for (const line of text.split('\n')) {
		if (!line.includes('"user"')) continue;
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (!rec || rec.type !== 'user' || rec.isMeta) continue;
		const t = userPromptText(rec);
		if (t !== null) prompts.push(t);
	}
	if (prompts.length === 0) return true;
	return prompts.length === 1 && prompts[0].trim() === String(currentPrompt || '').trim();
}

function writeStudyAtomic(study) {
	const p = studyFilePath();
	const tmp = `${p}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(study, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, p);
}

// Claim the study for sessionId. Returns the claimed study, or null when the
// write failed or a concurrent session won the race.
function claimStudy(study, sessionId) {
	const claimed = { ...study, session_id: sessionId, claimed_at: new Date().toISOString() };
	try {
		writeStudyAtomic(claimed);
	} catch {
		return null;
	}
	const now = readStudy();
	if (!now || now.session_id !== sessionId) return null;
	const { appendJsonl } = require('./lib');
	appendJsonl(
		studyLogPath(),
		{
			ts: claimed.claimed_at,
			session_id: sessionId,
			event: 'study_claim',
			assignment_id: String(study.assignment_id),
			arm: String(study.arm || ''),
			prompt_sha256: String(study.prompt_sha256),
		},
		STUDY_LOG_MAX_BYTES
	);
	return now;
}

// The arm's search mode when `sessionId` is the claimed study session, else null.
function studyModeFor(sessionId) {
	if (!sessionId) return null;
	const study = readStudy();
	if (!study || !study.session_id || study.session_id !== sessionId) return null;
	return study.mode;
}

module.exports = {
	studyFilePath,
	studyLogPath,
	readStudy,
	isFreshSession,
	claimStudy,
	studyModeFor,
};
