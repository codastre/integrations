'use strict';

// Run with: node --test adapters/claude/hooks/test/
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..');
const PROMPT = 'SECRET-STUDY-PROMPT: explain how token refresh works across services';
const SHA = crypto.createHash('sha256').update(PROMPT, 'utf8').digest('hex');

function sandbox(study) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codastre-study-'));
	const env = {
		...process.env,
		HOME: dir,
		CODASTRE_STUDY_FILE: path.join(dir, 'study.json'),
		CODASTRE_STUDY_LOG: path.join(dir, 'study-sessions.jsonl'),
		CODASTRE_SESSION_EVENTS_LOG: path.join(dir, 'session-events.jsonl'),
		CODASTRE_TOKEN_LOG: path.join(dir, 'tokens.jsonl'),
		CODASTRE_SEARCH_MODE_FILE: path.join(dir, 'search-mode'),
		CODASTRE_SERVER: '',
		CODASTRE_API_KEY: '',
	};
	delete env.CODASTRE_SEARCH_MODE;
	delete env.CODASTRE_TRACK_TOKENS;
	if (study) {
		fs.writeFileSync(
			env.CODASTRE_STUDY_FILE,
			JSON.stringify({
				version: 1,
				assignment_id: '11111111-1111-4111-8111-111111111111',
				study: 'auth-flow-q4',
				task: 'token-refresh',
				arm: 'no_tool',
				mode: 'grep',
				arm_order: 1,
				prompt: PROMPT,
				prompt_sha256: SHA,
				written_at: new Date().toISOString(),
				session_id: null,
				claimed_at: null,
				...study,
			})
		);
	}
	return { dir, env };
}

function run(hook, payload, env) {
	const res = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
		input: JSON.stringify(payload),
		env,
		encoding: 'utf8',
	});
	assert.strictEqual(res.status, 0, res.stderr);
	return res.stdout ? JSON.parse(res.stdout) : null;
}

function prompt(env, sessionId, extra = {}) {
	const out = run('mode_prompt.js', { session_id: sessionId, prompt: 'go', ...extra }, env);
	return out && out.hookSpecificOutput.additionalContext;
}

function readStudy(env) {
	return JSON.parse(fs.readFileSync(env.CODASTRE_STUDY_FILE, 'utf8'));
}

test('a fresh session claims the study and gets the prompt verbatim', () => {
	const { env } = sandbox({});
	const ctx = prompt(env, 's1', { transcript_path: path.join(env.HOME, 'missing.jsonl') });
	assert.ok(ctx.includes(`<<<TASK\n${PROMPT}\nTASK>>>`));
	assert.ok(ctx.includes('PRE-REGISTERED STUDY TASK (Codastre Tier D, arm no_tool)'));
	assert.ok(ctx.includes('CODASTRE-FREE'));
	assert.ok(!ctx.includes('receipt'), 'no receipt step on study turns');
	const study = readStudy(env);
	assert.strictEqual(study.session_id, 's1');
	assert.ok(study.claimed_at);
	assert.strictEqual(fs.statSync(env.CODASTRE_STUDY_FILE).mode & 0o777, 0o600);
});

test('the claim is logged with ids and hash only, never the prompt', () => {
	const { env } = sandbox({});
	prompt(env, 's1');
	const text = fs.readFileSync(env.CODASTRE_STUDY_LOG, 'utf8');
	assert.ok(!text.includes('SECRET-STUDY-PROMPT'));
	const lines = text.trim().split('\n').map((l) => JSON.parse(l));
	assert.strictEqual(lines.length, 1);
	assert.deepStrictEqual(Object.keys(lines[0]).sort(), [
		'arm',
		'assignment_id',
		'event',
		'prompt_sha256',
		'session_id',
		'ts',
	]);
	assert.strictEqual(lines[0].event, 'study_claim');
	assert.strictEqual(lines[0].prompt_sha256, SHA);
});

test('the prompt is injected once; later turns get the arm instruction only', () => {
	const { env } = sandbox({});
	prompt(env, 's1');
	const ctx = prompt(env, 's1');
	assert.ok(!ctx.includes(PROMPT));
	assert.ok(ctx.includes('CODASTRE-FREE'));
	assert.ok(!ctx.includes('receipt'));
	assert.strictEqual(fs.readFileSync(env.CODASTRE_STUDY_LOG, 'utf8').trim().split('\n').length, 1);
});

test('a session with an earlier prompt does not claim; it gets the pending notice', () => {
	const { env } = sandbox({});
	const transcript = path.join(env.HOME, 't.jsonl');
	fs.writeFileSync(
		transcript,
		JSON.stringify({ type: 'user', message: { role: 'user', content: 'earlier question' } }) + '\n'
	);
	const ctx = prompt(env, 's1', { transcript_path: transcript });
	assert.ok(ctx.includes('study run is pending'));
	assert.ok(!ctx.includes(PROMPT));
	assert.strictEqual(readStudy(env).session_id, null);
	assert.ok(!fs.existsSync(env.CODASTRE_STUDY_LOG));
});

test('the current prompt already in the transcript still counts as fresh', () => {
	const { env } = sandbox({});
	const transcript = path.join(env.HOME, 't.jsonl');
	fs.writeFileSync(
		transcript,
		JSON.stringify({ type: 'user', isMeta: true, message: { content: 'caveat' } }) +
			'\n' +
			JSON.stringify({ type: 'user', message: { content: 'go' } }) +
			'\n'
	);
	assert.ok(prompt(env, 's1', { transcript_path: transcript }).includes(PROMPT));
});

test('another session is unaffected by a claimed study', () => {
	const { env } = sandbox({ session_id: 's1', claimed_at: new Date().toISOString() });
	assert.strictEqual(prompt(env, 's2'), null);
});

test('no_tool arm blocks Codastre on both planes in the claimed session only', () => {
	const { env } = sandbox({ session_id: 's1', claimed_at: new Date().toISOString() });
	const mcp = { tool_name: 'mcp__codastre__QUERY', tool_input: { query_text: 'x' } };
	const cli = { tool_name: 'Bash', tool_input: { command: 'codastre query "token refresh" --top-k 6' } };
	for (const call of [mcp, cli]) {
		const out = run('mode.js', { session_id: 's1', ...call }, env);
		assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
		assert.strictEqual(run('mode.js', { session_id: 's2', ...call }, env), null);
	}
	const grep = { tool_name: 'Grep', tool_input: { pattern: 'refresh' } };
	assert.strictEqual(run('mode.js', { session_id: 's1', ...grep }, env), null);
});

test('the study arm overrides a standing search mode', () => {
	const { env } = sandbox({ session_id: 's1', claimed_at: new Date().toISOString() });
	const out = run(
		'mode.js',
		{ session_id: 's1', tool_name: 'mcp__codastre__QUERY', tool_input: {} },
		{ ...env, CODASTRE_SEARCH_MODE: 'codastre' }
	);
	assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('a tool-arm study session counts reads, like any active mode', () => {
	const { env } = sandbox({ session_id: 's1', arm: 'tool', mode: 'auto' });
	run('track.js', { session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: 'abc' }, env);
	run('track.js', { session_id: 's2', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: 'abc' }, env);
	const lines = fs.readFileSync(env.CODASTRE_TOKEN_LOG, 'utf8').trim().split('\n');
	assert.strictEqual(lines.length, 1);
	assert.strictEqual(JSON.parse(lines[0]).session_id, 's1');
});

test('an invalid study file is ignored', () => {
	const { env } = sandbox({ mode: 'everything', session_id: 's1' });
	assert.strictEqual(prompt(env, 's1'), null);
});
