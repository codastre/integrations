'use strict';

// Prints the token receipt for the current question in the live A/B mode.
// Reads the JSONL token log written by track.js, keeps records at/after the
// run marker stamped by mode_prompt.js (scoped to this turn + session), and
// groups estimated result tokens by class. Deterministic — no model estimation.
// Run by the model at the end of a turn (mode_prompt.js instructs it to,
// passing the session id as argv[2]).

const fs = require('fs');
const path = require('path');
const { readMode, tokenLogPath, runMarkerPath, readRunMarker } = require('./lib');

// The session id is passed by mode_prompt.js's injected command. If absent
// (e.g. the model dropped the arg), fall back to the most recently written
// bench-run.*.json — almost always this turn's marker.
function resolveMarker(sessionId) {
	if (sessionId) return readRunMarker(sessionId);
	try {
		const dir = path.dirname(runMarkerPath(''));
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.startsWith('bench-run.') && f.endsWith('.json'))
			.map((f) => {
				const full = path.join(dir, f);
				return { full, mtime: fs.statSync(full).mtimeMs };
			})
			.sort((a, b) => b.mtime - a.mtime);
		if (!files.length) return null;
		return JSON.parse(fs.readFileSync(files[0].full, 'utf8'));
	} catch {
		return null;
	}
}

function loadRecords(sinceIso, sessionId) {
	let text = '';
	try {
		text = fs.readFileSync(tokenLogPath(), 'utf8');
	} catch {
		return [];
	}
	const out = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		if (sinceIso && r.ts && r.ts < sinceIso) continue;
		if (sessionId && r.session_id && r.session_id !== sessionId) continue;
		out.push(r);
	}
	return out;
}

const LABEL = { codastre: 'Codastre (QUERY/GRAPH)', 'text-search': 'Text search (grep/glob)', read: 'File reads' };

function main() {
	const sessionId = (process.argv[2] || '').trim();
	const mode = readMode();
	const marker = resolveMarker(sessionId);
	const records = loadRecords(
		marker && marker.started_at,
		(marker && marker.session_id) || sessionId
	);

	const modeName =
		mode === 'codastre'
			? 'Codastre-only'
			: mode === 'grep'
			? 'Codastre-free (text search)'
			: mode === 'auto'
			? 'Codastre-first (auto)'
			: 'off';
	const modeLine = `mode: ${modeName}`;
	if (records.length === 0) {
		console.log(`${modeLine}\nNo search/read tool calls were logged for this question.`);
		return;
	}

	const groups = {};
	let total = 0;
	for (const r of records) {
		const cls = r.class || 'other';
		groups[cls] = groups[cls] || { calls: 0, tokens: 0 };
		groups[cls].calls += 1;
		groups[cls].tokens += r.out_tokens || 0;
		total += r.out_tokens || 0;
	}

	const rows = Object.keys(groups)
		.sort((a, b) => groups[b].tokens - groups[a].tokens)
		.map((cls) => {
			const g = groups[cls];
			return `  ${(LABEL[cls] || cls).padEnd(26)} ${String(g.calls).padStart(3)} calls   ~${g.tokens.toLocaleString()} tok`;
		});

	console.log(
		[
			modeLine,
			...rows,
			`  ${'TOTAL'.padEnd(26)} ${String(records.length).padStart(3)} calls   ~${total.toLocaleString()} tok`,
			'(result-size estimate, ~4 chars/token; reasoning tokens not included)',
		].join('\n')
	);
}

main();
