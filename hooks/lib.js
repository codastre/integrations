'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Codastre is considered configured when the CLI has persisted config
// (`codastre login` writes ~/.config/codastre/config.json) or the server /
// API key is supplied via environment. No key → every hook is a silent no-op
// so the plugin never nags in environments where Codastre isn't set up.
function codastreConfigured() {
	if (process.env.CODASTRE_SERVER || process.env.CODASTRE_API_KEY) return true;
	try {
		fs.accessSync(path.join(os.homedir(), '.config', 'codastre', 'config.json'));
		return true;
	} catch {
		return false;
	}
}

// Token tracking is opt-in: CODASTRE_TRACK_TOKENS=1.
function trackingEnabled() {
	return process.env.CODASTRE_TRACK_TOKENS === '1';
}

// JSONL log destination; override with CODASTRE_TOKEN_LOG.
function tokenLogPath() {
	return (
		process.env.CODASTRE_TOKEN_LOG ||
		path.join(os.homedir(), '.config', 'codastre', 'claude-token-log.jsonl')
	);
}

function readStdinJson() {
	return new Promise((resolve) => {
		let input = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => (input += chunk));
		process.stdin.on('end', () => {
			try {
				resolve(JSON.parse(input));
			} catch {
				resolve(null);
			}
		});
	});
}

// ~4 chars per token is a stable cross-model approximation for code/text;
// good enough for relative comparisons (the point of the log).
function estTokens(text) {
	if (!text) return 0;
	return Math.ceil(String(text).length / 4);
}

module.exports = { codastreConfigured, trackingEnabled, tokenLogPath, readStdinJson, estTokens };
