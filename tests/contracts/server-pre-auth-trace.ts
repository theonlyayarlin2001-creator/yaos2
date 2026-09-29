// Regression test for INV-SEC-01 / INV-OBS-02 / Phase 1.2 fix.
//
// Pre-authentication request paths must not call recordVaultTrace, because
// that function reaches the per-room Durable Object and persists a storage
// entry per call. Issue #40 (Cloudflare DO request explosion) was traced to
// rejection paths in server/src/index.ts and server/src/routes/syncSocket.ts
// emitting trace writes for every unauthorized/unclaimed/misconfigured
// request. The current contract is that these paths log via console.warn
// only; no DO contact, no storage write, no DO wake-up.
//
// This test enforces the contract by static analysis: it parses the two
// rejection functions and asserts no recordVaultTrace call exists inside
// them. If a future change re-introduces a pre-auth DO trace write, this
// test fails and the regression is caught at CI time, before another
// quota-burning deploy hits production.

import { readSource, suite } from "../harness.ts";

// Repo-root-relative, resolved by the harness: these paths no longer have to
// know how deep under tests/ this suite happens to live.
const indexPath = "server/src/index.ts";
const authPath = "server/src/routes/auth.ts";
const syncSocketPath = "server/src/routes/syncSocket.ts";

const s = suite("server-pre-auth-trace");

/**
 * Extract the body of a top-level `function name(...) {...}` declaration.
 * Returns the substring between the matching outer braces, or null.
 */
function extractFunctionBody(source: string, functionName: string): string | null {
	const declRe = new RegExp(`function\\s+${functionName}\\s*\\(`);
	const declMatch = declRe.exec(source);
	if (!declMatch) return null;

	let i = source.indexOf("{", declMatch.index);
	if (i < 0) return null;

	let depth = 0;
	const start = i;
	for (; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(start + 1, i);
			}
		}
	}
	return null;
}

s.section("Test 1: rejectUnauthorizedVaultRequest (auth.ts) contains no recordVaultTrace calls");
{
	// rejectUnauthorizedVaultRequest was moved to auth.ts (Obsidian-free, no DO deps)
	// so it can be imported and tested directly in runtime tests (FU-4).
	const source = readSource(authPath);
	const body = extractFunctionBody(source, "rejectUnauthorizedVaultRequest");
	s.check(body !== null, "rejectUnauthorizedVaultRequest declaration is parseable in auth.ts");
	s.check(
		body !== null && !/recordVaultTrace\s*\(/.test(body),
		"rejectUnauthorizedVaultRequest body does not call recordVaultTrace (INV-SEC-01)",
	);
}

s.section("Test 1b: rejectAndLogUnauthorizedVaultRequest (index.ts) logs but does not trace");
{
	const source = readSource(indexPath);
	const body = extractFunctionBody(source, "rejectAndLogUnauthorizedVaultRequest");
	s.check(body !== null, "rejectAndLogUnauthorizedVaultRequest declaration is parseable in index.ts");
	s.check(
		body !== null && !/recordVaultTrace\s*\(/.test(body),
		"rejectAndLogUnauthorizedVaultRequest body does not call recordVaultTrace (INV-SEC-01)",
	);
}

s.section("Test 2: handleSyncSocketRoute has no recordVaultTrace calls at all");
{
	const source = readSource(syncSocketPath);
	const body = extractFunctionBody(source, "handleSyncSocketRoute");
	s.check(body !== null, "handleSyncSocketRoute declaration is parseable");

	// Issue #40 Phase 2 fix: ALL WebSocket admission events (ws-connected,
	// ws-rejected) were moved to console-only logging.  The function must
	// contain zero recordVaultTrace calls.  A reconnect storm must not
	// produce a YAOS_SYNC trace write on every socket open/reject.
	//
	// Historical note: the function previously called recordVaultTrace for
	// ws-connected (every successful connect) and ws-rejected (post-auth
	// schema-skew).  Both were removed in the issue #40 amplification fix.
	s.check(
		body !== null && !/recordVaultTrace\s*\(/.test(body),
		"handleSyncSocketRoute body contains no recordVaultTrace calls (INV-SEC-01, INV-OBS-02)",
	);

	// Redundantly verify the pre-auth slice specifically — belt-and-suspenders.
	const preAuthSlice = body?.split(/if\s*\(\s*!\s*clientSchema\s*\)/)[0] ?? "";
	s.check(
		preAuthSlice.length > 0,
		"pre-auth slice is non-empty (split landed at the post-auth boundary)",
	);
	s.check(
		!/recordVaultTrace\s*\(/.test(preAuthSlice),
		"pre-auth socket rejection branches do not call recordVaultTrace (INV-SEC-01)",
	);
}

s.section("Test 3: rejection paths still produce log output (telemetry retained)");
{
	// Logging lives in rejectAndLogUnauthorizedVaultRequest (index.ts wrapper)
	const indexSource = readSource(indexPath);
	const indexBody = extractFunctionBody(indexSource, "rejectAndLogUnauthorizedVaultRequest");
	s.check(
		indexBody !== null && /logVaultRejection\s*\(/.test(indexBody),
		"rejectAndLogUnauthorizedVaultRequest emits structured log via logVaultRejection",
	);

	const socketSource = readSource(syncSocketPath);
	const socketBody = extractFunctionBody(socketSource, "handleSyncSocketRoute");
	s.check(
		socketBody !== null && /logSocketRejection\s*\(/.test(socketBody),
		"handleSyncSocketRoute emits structured log via logSocketRejection",
	);
}

s.section("Test 4: log helpers use console.warn (worker logs), not DO storage");
{
	const indexSource = readSource(indexPath);
	const indexHelper = extractFunctionBody(indexSource, "logVaultRejection");
	s.check(indexHelper !== null, "logVaultRejection declaration is parseable");
	s.check(
		indexHelper !== null && /console\.warn\s*\(/.test(indexHelper),
		"logVaultRejection writes via console.warn",
	);
	s.check(
		indexHelper !== null && !/recordVaultTrace|getServerByName|stub\.fetch/.test(indexHelper),
		"logVaultRejection does not contact the Durable Object",
	);

	const socketSource = readSource(syncSocketPath);
	const socketHelper = extractFunctionBody(socketSource, "logSocketRejection");
	s.check(socketHelper !== null, "logSocketRejection declaration is parseable");
	s.check(
		socketHelper !== null && /console\.warn\s*\(/.test(socketHelper),
		"logSocketRejection writes via console.warn",
	);
	s.check(
		socketHelper !== null && !/recordVaultTrace|getServerByName|stub\.fetch/.test(socketHelper),
		"logSocketRejection does not contact the Durable Object",
	);
}
await s.done();
