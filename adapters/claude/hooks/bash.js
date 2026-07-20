'use strict';

const { codastreConfigured, isBashSearch, readStdinJson } = require('./lib');

if (!codastreConfigured()) process.exit(0);

const REMINDER =
	'Consider the Codastre QUERY tool before shell text search: for conceptual or identifier searches it returns ~10 ranked snippets instead of raw match dumps, with better relevance and far fewer tokens. Shell search remains right for literal strings, unindexed files, or when Codastre is unavailable.';

async function main() {
	const inputData = await readStdinJson();
	if (!inputData) return;

	const command = (inputData.tool_input && inputData.tool_input.command) || '';
	if (!command || !isBashSearch(command)) return;

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: REMINDER },
		})
	);
}

main();
