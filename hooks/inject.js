'use strict';

const { codastreConfigured } = require('./lib');

if (!codastreConfigured()) process.exit(0);

const hookEventName = process.argv[2];

const AWARENESS =
	'You have access to the Codastre code-retrieval tools: QUERY (hybrid semantic + lexical search returning ranked, snippet-hydrated results across every indexed repo) and GRAPH (cross-repo relationship graph: calls, imports, extends/implements, Kafka producer/consumer, HTTP, shared packages). Prefer QUERY over Grep/Glob/rg/find for conceptual searches ("where is X handled", "code that does Y") and for identifier lookups, and prefer GRAPH for callers/callees, impact analysis, and cross-service tracing — they return a handful of ranked, relevant results instead of pages of raw matches, saving context tokens. Use Grep/Glob for literal string matches, uncommitted/unindexed files, or as a fallback when QUERY returns RETRIEVAL_UNAVAILABLE.';

const hookMessages = {
	SessionStart: AWARENESS,
	SubagentStart: AWARENESS,
	PreToolUse:
		'Consider the Codastre QUERY tool before Grep/Glob for this search: for conceptual or identifier searches it returns ~10 ranked snippets instead of raw match dumps, with better relevance and far fewer tokens. Grep/Glob remain right for literal strings, unindexed files, or when Codastre is unavailable.',
};

if (!hookMessages[hookEventName]) process.exit(0);

process.stdout.write(
	JSON.stringify({
		hookSpecificOutput: { hookEventName, additionalContext: hookMessages[hookEventName] },
	})
);
