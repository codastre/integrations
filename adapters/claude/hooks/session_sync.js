'use strict';

// SessionStart background sync (search-effectiveness plan, Phase C).
//
// The first query of a session is the one most likely to hit a stale overlay:
// the HEAD watcher (`codastre serve`) only syncs on a ref change it sees while
// running, so commits made between sessions are not in the index yet. Kicking
// off one `codastre sync --once` when the session starts gives the overlay a
// head start. It is fire-and-forget — detached, output discarded, never
// awaited — so the hook returns at once and a slow or failing sync can never
// delay or break the session. The CLI's own eager sync on `codastre query`
// remains the backstop.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Is dir inside a git checkout? Walks up for a `.git` entry (a directory, or a
// file for worktrees and submodules) — the same rule the CLI's findGitRoot uses,
// without spawning git on the session's critical path.
function inGitCheckout(dir) {
	let cur = path.resolve(dir || process.cwd());
	for (;;) {
		if (fs.existsSync(path.join(cur, '.git'))) return true;
		const parent = path.dirname(cur);
		if (parent === cur) return false;
		cur = parent;
	}
}

// Start `codastre sync --once` in the background for cwd. Returns whether a
// sync was started. Opt out with CODASTRE_SESSION_SYNC=0.
function startSessionSync(cwd, { cli, env = process.env, spawnFn = spawn } = {}) {
	if (env.CODASTRE_SESSION_SYNC === '0') return false;
	if (!cli || !inGitCheckout(cwd)) return false;
	try {
		const child = spawnFn(cli, ['sync', '--once'], {
			cwd: cwd || process.cwd(),
			detached: true,
			stdio: 'ignore',
			env,
		});
		if (child && typeof child.on === 'function') child.on('error', () => {});
		if (child && typeof child.unref === 'function') child.unref();
		return true;
	} catch {
		return false; // never let a sync problem surface in the session
	}
}

module.exports = { inGitCheckout, startSessionSync };
