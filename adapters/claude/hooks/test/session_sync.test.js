'use strict';

// Run with: node --test adapters/claude/hooks/test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { inGitCheckout, startSessionSync } = require('../session_sync');

function checkout() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codastre-ss-'));
	fs.mkdirSync(path.join(dir, '.git'));
	const sub = path.join(dir, 'a', 'b');
	fs.mkdirSync(sub, { recursive: true });
	return { dir, sub };
}

function fakeSpawn() {
	const calls = [];
	const fn = (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		return { on() {}, unref() { calls[calls.length - 1].unrefed = true; } };
	};
	return { fn, calls };
}

test('inGitCheckout walks up to a .git entry', () => {
	const { dir, sub } = checkout();
	assert.strictEqual(inGitCheckout(sub), true);
	assert.strictEqual(inGitCheckout(dir), true);
	assert.strictEqual(inGitCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'codastre-nogit-'))), false);
});

test('a .git file (worktree) counts as a checkout', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codastre-wt-'));
	fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere\n');
	assert.strictEqual(inGitCheckout(dir), true);
});

test('starts a detached, unref-ed `sync --once` in the checkout', () => {
	const { sub } = checkout();
	const { fn, calls } = fakeSpawn();
	assert.strictEqual(startSessionSync(sub, { cli: '/bin/codastre', env: {}, spawnFn: fn }), true);
	assert.strictEqual(calls.length, 1);
	const [c] = calls;
	assert.strictEqual(c.cmd, '/bin/codastre');
	assert.deepStrictEqual(c.args, ['sync', '--once', '--dedup']);
	assert.strictEqual(c.opts.cwd, sub);
	assert.strictEqual(c.opts.detached, true);
	assert.strictEqual(c.opts.stdio, 'ignore');
	assert.strictEqual(c.unrefed, true);
});

test('does nothing without a CLI, outside a checkout, or when opted out', () => {
	const { sub } = checkout();
	const { fn, calls } = fakeSpawn();
	assert.strictEqual(startSessionSync(sub, { cli: null, env: {}, spawnFn: fn }), false);
	const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'codastre-nogit-'));
	assert.strictEqual(startSessionSync(nogit, { cli: '/bin/codastre', env: {}, spawnFn: fn }), false);
	assert.strictEqual(
		startSessionSync(sub, { cli: '/bin/codastre', env: { CODASTRE_SESSION_SYNC: '0' }, spawnFn: fn }),
		false
	);
	assert.strictEqual(calls.length, 0);
});

test('a spawn that throws is swallowed', () => {
	const { sub } = checkout();
	const boom = () => {
		throw new Error('ENOENT');
	};
	assert.strictEqual(startSessionSync(sub, { cli: '/bin/codastre', env: {}, spawnFn: boom }), false);
});

test('runs on startup/resume (or no source), not on clear/compact', () => {
	const { sub } = checkout();
	const { fn, calls } = fakeSpawn();
	const opts = (source) => ({ cli: '/bin/codastre', env: {}, spawnFn: fn, source });
	assert.strictEqual(startSessionSync(sub, opts('startup')), true);
	assert.strictEqual(startSessionSync(sub, opts('resume')), true);
	assert.strictEqual(startSessionSync(sub, opts(undefined)), true);
	assert.strictEqual(startSessionSync(sub, opts('clear')), false);
	assert.strictEqual(startSessionSync(sub, opts('compact')), false);
	assert.strictEqual(calls.length, 3);
});

