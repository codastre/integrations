'use strict';

// Run with: node --test adapters/claude/hooks/test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'session_events.js');
const SECRET = 'SECRET-PROMPT-TEXT /Users/dev/private/path.go';

function runHook(payload, env = {}, argv = []) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codastre-se-'));
	const log = path.join(dir, 'session-events.jsonl');
	const res = spawnSync(process.execPath, [HOOK, ...argv], {
		input: JSON.stringify(payload),
		env: {
			...process.env,
			HOME: dir,
			CODASTRE_SESSION_EVENTS_LOG: log,
			CODASTRE_SEARCH_MODE: '',
			...env,
		},
		encoding: 'utf8',
	});
	const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
	const records = text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l)) : [];
	return { res, records, text, dir };
}

test('PreCompact records phase pre with the trigger', () => {
	const { res, records } = runHook({
		hook_event_name: 'PreCompact',
		session_id: 's1',
		trigger: 'auto',
		custom_instructions: SECRET,
	});
	assert.strictEqual(res.status, 0);
	assert.strictEqual(records.length, 1);
	const r = records[0];
	assert.deepStrictEqual(Object.keys(r).sort(), ['event', 'phase', 'session_id', 'trigger', 'ts']);
	assert.strictEqual(r.event, 'compact');
	assert.strictEqual(r.phase, 'pre');
	assert.strictEqual(r.trigger, 'auto');
	assert.strictEqual(r.session_id, 's1');
});

test('PostCompact reads triggered_by and falls back to unknown', () => {
	assert.strictEqual(
		runHook({ hook_event_name: 'PostCompact', session_id: 's', triggered_by: 'manual' }).records[0]
			.trigger,
		'manual'
	);
	const r = runHook({ hook_event_name: 'PostCompact', session_id: 's', trigger: 'weird' }).records[0];
	assert.strictEqual(r.phase, 'post');
	assert.strictEqual(r.trigger, 'unknown');
});

test('event name falls back to argv', () => {
	const { records } = runHook({ session_id: 's', trigger: 'auto' }, {}, ['PreCompact']);
	assert.strictEqual(records[0].phase, 'pre');
});

test('PostToolUseFailure keeps no content and sanitises error_type', () => {
	const { records, text } = runHook({
		hook_event_name: 'PostToolUseFailure',
		session_id: 's',
		cwd: '/Users/dev/private',
		tool_name: 'Bash',
		tool_input: { command: `rg "${SECRET}" src/` },
		tool_response: SECRET,
		error: SECRET,
		error_type: 'Timeout Exceeded: ' + SECRET,
	});
	assert.strictEqual(records.length, 1);
	const r = records[0];
	assert.deepStrictEqual(Object.keys(r).sort(), ['class', 'error_type', 'event', 'session_id', 'tool', 'ts']);
	assert.strictEqual(r.class, 'text-search');
	assert.strictEqual(r.error_type, 'other');
	assert.ok(!text.includes('SECRET'), 'no content may reach the log');
	assert.ok(!text.includes('/Users/dev'), 'no path may reach the log');
});

test('bounded error_type passes through; codastre tools classify', () => {
	const r = runHook({
		hook_event_name: 'PostToolUseFailure',
		session_id: 's',
		tool_name: 'mcp__codastre__QUERY',
		error_type: 'timeout',
	}).records[0];
	assert.strictEqual(r.class, 'codastre');
	assert.strictEqual(r.error_type, 'timeout');
});

test('codastre failure in auto mode marks the run marker failed', () => {
	const { dir } = runHook(
		{ hook_event_name: 'PostToolUseFailure', session_id: 'sess-9', tool_name: 'mcp__codastre__GRAPH' },
		{ CODASTRE_SEARCH_MODE: 'auto' }
	);
	const marker = JSON.parse(
		fs.readFileSync(path.join(dir, '.config', 'codastre', 'bench-run.sess-9.json'), 'utf8')
	);
	assert.strictEqual(marker.codastre_failed, true);
	assert.strictEqual(marker.codastre_calls, 1);
});

test('no run marker outside auto mode', () => {
	const { dir } = runHook({
		hook_event_name: 'PostToolUseFailure',
		session_id: 'sess-9',
		tool_name: 'mcp__codastre__GRAPH',
	});
	assert.ok(!fs.existsSync(path.join(dir, '.config', 'codastre', 'bench-run.sess-9.json')));
});

test('unknown events and garbage stdin are silent no-ops', () => {
	assert.strictEqual(runHook({ hook_event_name: 'Stop', session_id: 's' }).records.length, 0);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codastre-se-'));
	const log = path.join(dir, 'l.jsonl');
	const res = spawnSync(process.execPath, [HOOK], {
		input: 'not json',
		env: { ...process.env, HOME: dir, CODASTRE_SESSION_EVENTS_LOG: log },
	});
	assert.strictEqual(res.status, 0);
	assert.ok(!fs.existsSync(log));
});

test('log rotates past the size cap', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codastre-se-'));
	const log = path.join(dir, 'l.jsonl');
	fs.writeFileSync(log, 'x'.repeat(200));
	spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 's', trigger: 'auto' }),
		env: {
			...process.env,
			HOME: dir,
			CODASTRE_SESSION_EVENTS_LOG: log,
			CODASTRE_SESSION_EVENTS_LOG_MAX_BYTES: '100',
		},
	});
	assert.ok(fs.existsSync(log + '.1'));
	assert.strictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
});
