// Regression test for issue #40: DO subrequest amplification fix.
//
// Static source-analysis checks that enforce the seven invariants listed in
// the issue #40 / ca0dad2 post-mortem.  A companion runtime test is in
// tests/server/server-route-classification-runtime.ts.
//
// These tests fail loudly if a future change re-introduces any of the
// amplification patterns:
//
//   1. syncSocket.ts must not call recordVaultTrace at all (ws admission events
//      are console-only; a reconnect storm must not burn YAOS_SYNC writes).
//   2. index.ts must classify routes before calling getAuthStateCached.
//   3. auth.ts must have a TTL cache around getStoredServerConfig.
//   4. server.ts must bypass ensureDocumentLoaded for /cdn-cgi/partyserver/.
//   5. server.ts must NOT call ensureDocumentLoaded in /__yaos/debug.

import { readSource, suite } from "../harness.ts";

// Repo-root-relative, resolved by the harness: these paths no longer have to
// know how deep under tests/ this suite happens to live.
const syncSocketPath = "server/src/routes/syncSocket.ts";
const indexPath = "server/src/index.ts";
const authPath = "server/src/routes/auth.ts";
const serverPath = "server/src/server.ts";

const s = suite("server-do-amplification");

// ── Test 1: syncSocket.ts has no recordVaultTrace calls ───────────────────────
s.section("Test 1: syncSocket.ts has no recordVaultTrace calls (WebSocket admission is console-only)");
{
	const source = readSource(syncSocketPath);

	s.check(
		!/recordVaultTrace\s*\(/.test(source),
		"syncSocket.ts contains no recordVaultTrace() calls",
	);
	s.check(
		!source.includes('"ws-connected"'),
		"syncSocket.ts does not trace 'ws-connected' string (not persisted to YAOS_SYNC)",
	);
	s.check(
		!/import.*recordVaultTrace/.test(source),
		"syncSocket.ts does not import recordVaultTrace",
	);
	// ws-rejected events should also be console-only (schema-skew loops)
	s.check(
		!source.includes('"ws-rejected"') || !/recordVaultTrace/.test(source),
		"ws-rejected event is not passed to recordVaultTrace",
	);
}

// ── Test 2: index.ts classifies routes before auth ────────────────────────────
s.section("Test 2: index.ts classifies routes before auth (unknown paths 404 without DO access)");
{
	const source = readSource(indexPath);

	s.check(
		/function\s+classifyWorkerRoute\s*\(/.test(source),
		"classifyWorkerRoute function is defined in index.ts",
	);
	s.check(
		/WorkerRoute/.test(source),
		"WorkerRoute type is defined in index.ts",
	);
	s.check(
		!source.includes("await getAuthState(env)"),
		"index.ts no longer calls uncached getAuthState(env) in the fetch handler",
	);
	s.check(
		source.includes("getAuthStateCached("),
		"index.ts calls getAuthStateCached instead of getAuthState",
	);
	// Vault resource whitelist must be present
	s.check(
		/VALID_VAULT_RESOURCES/.test(source),
		"index.ts defines VALID_VAULT_RESOURCES whitelist",
	);
	s.check(
		/VALID_VAULT_RESOURCES\.has\(/.test(source),
		"classifyWorkerRoute uses VALID_VAULT_RESOURCES.has() to reject unknown resources",
	);
	// The four known resources must be in the whitelist
	const whitelistText = source.match(/VALID_VAULT_RESOURCES\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
	s.check(whitelistText.includes('"auth"'), "VALID_VAULT_RESOURCES includes auth");
	s.check(whitelistText.includes('"debug"'), "VALID_VAULT_RESOURCES includes debug");
	s.check(whitelistText.includes('"blobs"'), "VALID_VAULT_RESOURCES includes blobs");
	s.check(whitelistText.includes('"snapshots"'), "VALID_VAULT_RESOURCES includes snapshots");

	// Full route-shape validator must exist
	s.check(
		/function\s+isKnownVaultRouteShape\s*\(/.test(source),
		"isKnownVaultRouteShape function is defined in index.ts",
	);
	s.check(
		/isKnownVaultRouteShape\s*\(/.test(source.slice(source.indexOf("function classifyWorkerRoute"))),
		"classifyWorkerRoute calls isKnownVaultRouteShape",
	);

	// parseSyncPath MUST be called before parseVaultPath in the classifier.
	// If the order were reversed, /vault/sync/:id would be misread as a vault
	// route and rejected by the resource whitelist as not-found.
	const classifyBody = source.slice(source.indexOf("function classifyWorkerRoute"));
	const syncPos = classifyBody.indexOf("parseSyncPath(");
	const vaultPos = classifyBody.indexOf("parseVaultPath(");
	s.check(
		syncPos !== -1 && vaultPos !== -1 && syncPos < vaultPos,
		"parseSyncPath() is called before parseVaultPath() in classifyWorkerRoute (sync ordering invariant)",
	);

	// Verify not-found short-circuit appears BEFORE the getAuthStateCached call
	// in the worker fetch handler body.
	const fetchStart = source.indexOf("async fetch(req:");
	s.check(fetchStart !== -1, "fetch handler is found in index.ts");
	if (fetchStart !== -1) {
		const afterFetch = source.slice(fetchStart);
		const notFoundPos = afterFetch.indexOf('route.kind === "not-found"');
		const authCachedPos = afterFetch.indexOf("getAuthStateCached(");
		s.check(
			notFoundPos !== -1 && authCachedPos !== -1 && notFoundPos < authCachedPos,
			"not-found check (no DO access) appears before getAuthStateCached call in fetch handler",
		);
	}
}

// ── Test 3: auth.ts has TTL cache ─────────────────────────────────────────────
s.section("Test 3: auth.ts has TTL cache for YAOS_CONFIG fetches");
{
	const source = readSource(authPath);

	s.check(
		/AUTH_CONFIG_CACHE_TTL_MS/.test(source),
		"auth.ts defines AUTH_CONFIG_CACHE_TTL_MS",
	);
	s.check(
		/cachedConfig/.test(source),
		"auth.ts has a cachedConfig module-level variable",
	);
	s.check(
		/getStoredServerConfigCached/.test(source),
		"auth.ts exports getStoredServerConfigCached",
	);
	s.check(
		/invalidateStoredServerConfigCache/.test(source),
		"auth.ts exports invalidateStoredServerConfigCache",
	);
	s.check(
		/getAuthStateCached/.test(source),
		"auth.ts exports getAuthStateCached",
	);
	// Ensure handleClaimRoute calls invalidateStoredServerConfigCache
	s.check(
		/handleClaimRoute[\s\S]*?invalidateStoredServerConfigCache/.test(source),
		"handleClaimRoute calls invalidateStoredServerConfigCache after successful claim",
	);
	// Ensure handleUpdateMetadataRoute calls invalidateStoredServerConfigCache
	s.check(
		/handleUpdateMetadataRoute[\s\S]*?invalidateStoredServerConfigCache/.test(source),
		"handleUpdateMetadataRoute calls invalidateStoredServerConfigCache after successful update",
	);
}

// ── Test 4: server.ts bypasses ensureDocumentLoaded for PartyServer routes ────
s.section("Test 4: server.ts bypasses ensureDocumentLoaded for /cdn-cgi/partyserver/");
{
	const source = readSource(serverPath);

	s.check(
		source.includes("/cdn-cgi/partyserver/"),
		"server.ts checks for /cdn-cgi/partyserver/ paths",
	);

	// The bypass must appear before the final catch-all ensureDocumentLoaded
	const partyserverVarPos = source.indexOf("isPartyServerInternal");
	const lastEnsurePos = source.lastIndexOf("await this.ensureDocumentLoaded()");
	s.check(
		partyserverVarPos !== -1 && lastEnsurePos !== -1 && partyserverVarPos < lastEnsurePos,
		"PartyServer internal route bypass appears before the ensureDocumentLoaded catch-all",
	);

	// The bypass must return super.fetch without ensureDocumentLoaded
	// Use multiline-safe pattern ([\s\S] to cross newlines)
	const bypassBlock = source.slice(partyserverVarPos, partyserverVarPos + 400);
	s.check(
		/isPartyServerInternal[\s\S]{0,150}isWebSocketUpgrade[\s\S]{0,100}return super\.fetch/.test(bypassBlock),
		"non-WebSocket PartyServer internal routes call super.fetch without ensureDocumentLoaded",
	);
}

// ── Test 5: /__yaos/debug does not call ensureDocumentLoaded ──────────────────
s.section("Test 5: /__yaos/debug does not call ensureDocumentLoaded (cheap debug path)");
{
	const source = readSource(serverPath);

	// Find the /__yaos/debug handler and check its body
	const debugMarker = source.indexOf('"/__yaos/debug"');
	s.check(debugMarker !== -1, "/__yaos/debug handler is present in server.ts");

	if (debugMarker !== -1) {
		// Extract the if-block body by brace matching
		let braceStart = source.indexOf("{", debugMarker);
		let debugBody = null;
		if (braceStart !== -1) {
			let depth = 0;
			for (let i = braceStart; i < source.length; i++) {
				if (source[i] === "{") depth++;
				else if (source[i] === "}") {
					depth--;
					if (depth === 0) {
						debugBody = source.slice(braceStart + 1, i);
						break;
					}
				}
			}
		}
		s.check(debugBody !== null, "/__yaos/debug handler body is parseable");
		s.check(
			// Check for actual call pattern, not just the identifier (which
			// appears in comments explaining the absence of the call).
			debugBody !== null && !/await\s+this\.ensureDocumentLoaded\s*\(\s*\)/.test(debugBody),
			"/__yaos/debug does not call ensureDocumentLoaded (no cold-start checkpoint load on debug poll)",
		);
		// The cheap path should still return trace entries
		s.check(
			debugBody !== null && debugBody.includes("listRecentTraceEntries"),
			"/__yaos/debug still reads trace entries from storage",
		);
	}
}

// ── Test 6: route-bucket logging is present and not_found is sampled ──────────
s.section("Test 6: index.ts has route-bucket logging with not_found sampling");
{
	const source = readSource(indexPath);

	s.check(
		/function\s+routeBucket\s*\(/.test(source),
		"routeBucket function is defined in index.ts",
	);
	s.check(
		/function\s+logWorkerRequest\s*\(/.test(source),
		"logWorkerRequest function is defined in index.ts",
	);
	s.check(
		/console\.debug/.test(source),
		"logWorkerRequest uses review-compliant structured debug output",
	);
	// not_found must be sampled (not logged unconditionally)
	s.check(
		/not-found.*Math\.random|Math\.random.*not-found/.test(source.replace(/\s+/g, " ")),
		"logWorkerRequest samples not_found routes (not unconditional logging)",
	);
	// Raw vault IDs must not appear in the log payload
	s.check(
		!/logWorkerRequest\s*\(\s*\{[^}]*vaultId/.test(source),
		"logWorkerRequest call sites do not include raw vaultId in the log payload",
	);
}

// ── Test 7: AuthStateCached type exists with required config ──────────────────
s.section("Test 7: AuthStateCached type has required config for claim/unclaimed modes");
{
	const typesPath = "server/src/routes/types.ts";
	const source = readSource(typesPath);

	s.check(
		/AuthStateCached/.test(source),
		"types.ts defines AuthStateCached",
	);
	// In AuthStateCached, config must be required (not optional) for claim/unclaimed
	// The type definition should have `config: StoredServerConfig` (no ?)
	const cachedTypePos = source.indexOf("export type AuthStateCached");
	s.check(cachedTypePos !== -1, "AuthStateCached is found in types.ts");
	if (cachedTypePos !== -1) {
		// Grab the type definition block (large enough to cover all three variants)
		const typeBlock = source.slice(cachedTypePos, cachedTypePos + 400);
		// Should NOT have "config?" (optional) in the cached type
		s.check(
			!/config\?:/.test(typeBlock),
			"AuthStateCached claim/unclaimed variants have required config (no config?)",
		);
		// Should have "config: StoredServerConfig" (required)
		s.check(
			/config:\s*StoredServerConfig/.test(typeBlock),
			"AuthStateCached has required config: StoredServerConfig",
		);
	}
}
await s.done();
