'use strict';

// --- Pipeline structure of a (masked) shell command -------------------------
// Mirrored by cli/internal/transcript/pipeline.go in the codastre repo; the
// two share bash-classify-fixtures.json, so change both together.
//
// Input is maskQuoted() output: quoted bodies are blanked, so every separator
// left is one the shell acts on. A command splits into lists (at ; & && || (
// ) ` and newlines) and each list into pipeline stages (at a single |). A
// grep is a code search only where it reads the repo: at the head of a
// pipeline, or downstream of a stage that reads files. `security … | rg -c x`
// or `git log | grep fix` filters a program's output — not a search Codastre
// could have answered — and used to count as one.

const SEARCH_TOOLS = new Set(['grep', 'rg', 'ag', 'ack', 'fd', 'findstr']);

// Pipeline heads whose output is repo content or file names, so a grep fed
// by them is still searching the repo.
const CONTENT_SOURCES = new Set([
	'cat', 'bat', 'tac', 'nl', 'head', 'tail', 'less', 'more',
	'sed', 'awk', 'cut', 'ls', 'tree', 'find', 'fd',
]);
const GIT_CONTENT = new Set(['ls-files', 'ls-tree', 'show', 'diff', 'cat-file', 'blame']);

// File viewers: a pipeline head that prints a file is a read (as the Read
// tool would be), provided it names one and writes nowhere.
const READERS = new Set(['cat', 'bat', 'tac', 'nl', 'head', 'tail', 'less', 'more']);

// Words that precede the command a stage runs without being it.
const PREFIXES = new Set([
	'!', '{', '}', 'if', 'then', 'else', 'elif', 'while', 'until', 'do',
	'time', 'sudo', 'command', 'exec', 'nohup', 'env',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// pipelines(masked) → [[stage, …], …]: each stage is its argv-like word list,
// starting at the command it runs. Empty stages are dropped.
function pipelines(masked) {
	// `>&`, `&>` and `|&` are redirections, not list separators.
	const s = String(masked || '')
		.replace(/>&/g, '>@')
		.replace(/&>/g, '@>')
		.replace(/\|&/g, '|');
	const lists = [];
	let stages = [];
	let cur = '';
	const endStage = () => {
		const words = commandWords(cur);
		if (words.length) stages.push(words);
		cur = '';
	};
	const endList = () => {
		endStage();
		if (stages.length) lists.push(stages);
		stages = [];
	};
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '\\') {
			cur += s.slice(i, i + 2);
			i++;
		} else if (c === '|' && s[i + 1] === '|') {
			endList();
			i++;
		} else if (c === '|') {
			endStage();
		} else if (';&()`\n'.includes(c)) {
			endList();
		} else {
			cur += c;
		}
	}
	endList();
	return lists;
}

function commandWords(stage) {
	const words = stage.trim().split(/\s+/).filter(Boolean);
	while (words.length && (PREFIXES.has(words[0]) || ASSIGNMENT.test(words[0]))) words.shift();
	if (words.length) words[0] = words[0].split(/[\\/]/).pop().toLowerCase();
	return words;
}

function readsRepo(head) {
	const [name, sub] = head;
	return CONTENT_SOURCES.has(name) || (name === 'git' && GIT_CONTENT.has(sub));
}

function isSearchStage(words, index, head) {
	const name = words[0];
	const text = words.join(' ');
	if (SEARCH_TOOLS.has(name)) return index === 0 || readsRepo(head);
	if (/\bgit\s+grep\b/i.test(text)) return true;
	if (name === 'xargs') return /\bgrep\b/i.test(text);
	if (name === 'find') return /-name\b/.test(text);
	return false;
}

function hasSearch(masked) {
	return pipelines(masked).some((stages) =>
		stages.some((words, i) => isSearchStage(words, i, stages[0]))
	);
}

// A redirect that writes a file (not /dev/null, not a descriptor duplicate).
function writesFile(words) {
	const text = words.join(' ');
	const re = />>?\s*(\S*)/g;
	let m;
	while ((m = re.exec(text))) {
		const target = m[1];
		if (target !== '/dev/null' && !target.startsWith('@')) return true;
	}
	return false;
}

function isReadHead(words) {
	if (writesFile(words) || words.some((w) => w.startsWith('<<'))) return false;
	const operands = words.slice(1).filter((w) => !/^[-<>@]/.test(w) && !/^\d*>/.test(w));
	if (READERS.has(words[0])) return operands.length > 0;
	if (words[0] === 'sed') {
		const flags = words.slice(1).filter((w) => w.startsWith('-'));
		const quiet = flags.some((f) => /^-[A-Za-z]*n[A-Za-z]*$/.test(f));
		const inPlace = flags.some((f) => /^-[A-Za-z]*i/.test(f) || f.startsWith('--in-place'));
		return quiet && !inPlace;
	}
	return false;
}

function hasRead(masked) {
	return pipelines(masked).some((stages) => isReadHead(stages[0]));
}

module.exports = { pipelines, hasSearch, hasRead };
