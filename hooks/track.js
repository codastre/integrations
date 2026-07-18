'use strict';

// Opt-in PostToolUse logger for search-related token usage.
// Enable with CODASTRE_TRACK_TOKENS=1; appends one JSONL record per search
// tool call to ~/.config/codastre/claude-token-log.jsonl (CODASTRE_TOKEN_LOG
// overrides). Read it back with /codastre:tokens.

const fs = require('fs');
const path = require('path');
const { trackingEnabled, tokenLogPath, readStdinJson, estTokens } = require('./lib');

if (!trackingEnabled()) process.exit(0);

const CODASTRE_TOOL = /codastre.*__(QUERY|GRAPH|REGISTER|SYNC)$/i;
const BASH_SEARCH =
	/(?:^|[|;&(]\s*)(?:grep|rg|ag|ack|fd|findstr)\b|(?:^|[|;&(]\s*)find\s+\S+.*-name\b/i;

// Returns {class, detail} for tools we account for, else null.
function classify(toolName, toolInput) {
	if (CODASTRE_TOOL.test(toolName)) {
		return { class: 'codastre', detail: toolInput.query_text || toolInput.chunk_or_symbol || '' };
	}
	if (toolName === 'Grep' || toolName === 'Glob') {
		return { class: 'text-search', detail: toolInput.pattern || '' };
	}
	if (toolName === 'Bash') {
		const command = toolInput.command || '';
		if (!BASH_SEARCH.test(command)) return null;
		return { class: 'text-search', detail: command.slice(0, 200) };
	}
	return null;
}

async function main() {
	const data = await readStdinJson();
	if (!data || !data.tool_name) return;

	const toolInput = data.tool_input || {};
	const entry = classify(data.tool_name, toolInput);
	if (!entry) return;

	const responseText =
		typeof data.tool_response === 'string'
			? data.tool_response
			: JSON.stringify(data.tool_response || '');

	const record = {
		ts: new Date().toISOString(),
		session_id: data.session_id || '',
		cwd: data.cwd || '',
		tool: data.tool_name,
		class: entry.class,
		detail: entry.detail,
		out_tokens: estTokens(responseText),
	};

	try {
		const logPath = tokenLogPath();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
	} catch {
		// Never fail the tool call over logging.
	}
}

main();
