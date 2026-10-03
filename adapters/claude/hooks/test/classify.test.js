'use strict';

// Run with: node --test adapters/claude/hooks/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { codastreCliCall, isBashSearch, maskQuoted } = require('../lib');
const { cases } = require('./bash-classify-fixtures.json');

// The same precedence toolClass/mode.js apply: the CLI plane first.
function classify(command) {
	if (codastreCliCall(command)) return 'codastre';
	if (isBashSearch(command)) return 'text-search';
	return 'other';
}

for (const { command, class: want } of cases) {
	test(`classifies ${JSON.stringify(command)} as ${want}`, () => {
		assert.strictEqual(classify(command), want);
	});
}

test('maskQuoted blanks quoted arguments and keeps what the shell runs', () => {
	assert.strictEqual(maskQuoted(`git commit -m "a (grep)"`), `git commit -m "${' '.repeat(8)}"`);
	assert.strictEqual(maskQuoted(`echo '$(rg x)'`), `echo '${' '.repeat(7)}'`);
	assert.strictEqual(maskQuoted(`echo "$(rg x)"`), `echo "$(rg x)"`);
	assert.strictEqual(maskQuoted(`bash -c 'rg x'`), `bash -c ;rg x;`);
	assert.strictEqual(maskQuoted(`cd a\nrg x`), `cd a;rg x`);
});
