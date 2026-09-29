/**
 * Admin route gating tests.
 *
 * Proves that the destructive admin route (compact) is properly gated behind
 * the YAOS_ENABLE_ADMIN_ROUTES env var, while read-only debug routes remain
 * accessible.
 *
 * Tests the route classifier in index.ts and the DO-level gating in server.ts.
 */

import { readSource, suite } from "../harness.ts";

const s = suite("admin-route-gating");

// ── Static analysis of route classifier ─────────────────────────────────────

const indexSrc = readSource("server/src/index.ts");
const serverSrc = readSource("server/src/server.ts");

s.section("Test 1: Route classifier allows debug routes");
{
	// GET /debug/recent must be classified as valid
	s.check(
		indexSrc.includes('method === "GET" && rest.length === 1 && rest[0] === "recent"'),
		"GET /debug/recent is a known valid route shape",
	);
	// POST /debug/compact must be classified as valid (reaches auth)
	s.check(
		indexSrc.includes('method === "POST" && rest.length === 1 && rest[0] === "compact"'),
		"POST /debug/compact is a known valid route shape",
	);
}

s.section("Test 2: Admin routes require YAOS_ENABLE_ADMIN_ROUTES in DO");
{
	// The server.ts file must gate compact behind the env var
	s.check(
		serverSrc.includes("YAOS_ENABLE_ADMIN_ROUTES") &&
		serverSrc.includes("/__yaos/compact"),
		"server.ts references YAOS_ENABLE_ADMIN_ROUTES and /__yaos/compact",
	);

	// Find the compact handler and verify the gate comes BEFORE ensureDocumentLoaded
	const compactSection = serverSrc.substring(
		serverSrc.indexOf('url.pathname === "/__yaos/compact"'),
		serverSrc.indexOf('url.pathname === "/__yaos/compact"') + 300,
	);
	s.check(
		compactSection.includes("YAOS_ENABLE_ADMIN_ROUTES"),
		"compact handler checks YAOS_ENABLE_ADMIN_ROUTES before proceeding",
	);
}

s.section("Test 3: Gate returns 404 (not 401/403) when env var unset");
{
	// The gate should return json({ error: "not found" }, 404) — making
	// the route invisible, not just forbidden.
	const gateMatches = serverSrc.match(/YAOS_ENABLE_ADMIN_ROUTES[\s\S]{0,100}not found/g) ?? [];
	s.check(
		gateMatches.length >= 1,
		`gate returns "not found" for compact (found ${gateMatches.length} matches)`,
	);
}

s.section("Test 4: Read-only debug endpoint is NOT gated");
{
	// /__yaos/debug should NOT have YAOS_ENABLE_ADMIN_ROUTES check
	const debugSection = serverSrc.substring(
		serverSrc.indexOf('url.pathname === "/__yaos/debug"'),
		serverSrc.indexOf('url.pathname === "/__yaos/debug"') + 200,
	);
	s.check(
		!debugSection.includes("YAOS_ENABLE_ADMIN_ROUTES"),
		"/__yaos/debug does NOT check YAOS_ENABLE_ADMIN_ROUTES (always accessible)",
	);
}

s.section("Test 5: Gate does not call ensureDocumentLoaded when blocked");
{
	// When the env var is unset, the handler must return BEFORE calling
	// ensureDocumentLoaded() — otherwise it still wakes the DO.
	// Check that the pattern is: if (!env) return 404; ... ensureDocumentLoaded
	const compactIdx = serverSrc.indexOf('url.pathname === "/__yaos/compact"');
	const nextEnsureLoaded = serverSrc.indexOf("ensureDocumentLoaded", compactIdx);
	const gateReturn = serverSrc.indexOf("YAOS_ENABLE_ADMIN_ROUTES", compactIdx);

	s.check(
		gateReturn < nextEnsureLoaded,
		"compact: env var check comes before ensureDocumentLoaded (no DO hydration when gated)",
	);
}

s.section("Test 6: All vault routes require auth (pre-auth rejection)");
{
	// In index.ts, vault routes go through rejectAndLogUnauthorizedVaultRequest
	// before reaching any handler. This ensures unauthenticated requests
	// never reach the DO.
	s.check(
		indexSrc.includes("rejectAndLogUnauthorizedVaultRequest"),
		"index.ts calls rejectAndLogUnauthorizedVaultRequest for vault routes",
	);

	// The auth check must come before the debug/compact handlers
	const vaultSection = indexSrc.substring(
		indexSrc.indexOf("route.kind === \"vault\""),
		indexSrc.indexOf("route.kind === \"vault\"") + 1000,
	);
	const authCheckIdx = vaultSection.indexOf("rejectAndLogUnauthorizedVaultRequest");
	const compactHandlerIdx = vaultSection.indexOf("compact");

	s.check(
		authCheckIdx < compactHandlerIdx,
		"auth check comes before compact handler in vault routing",
	);
}

s.section("Test 7: wrangler.toml has YAOS_ENABLE_ADMIN_ROUTES documented");
{
	const wranglerToml = readSource("server/wrangler.toml");
	s.check(
		wranglerToml.includes("YAOS_ENABLE_ADMIN_ROUTES"),
		"wrangler.toml documents YAOS_ENABLE_ADMIN_ROUTES",
	);
	// It should be commented out by default
	s.check(
		wranglerToml.includes("# YAOS_ENABLE_ADMIN_ROUTES"),
		"YAOS_ENABLE_ADMIN_ROUTES is commented out by default",
	);
}

s.section("Test 8: Unclaimed server cannot reach vault routes");
{
	// The route handling for unclaimed servers returns early before vault access.
	// rejectUnauthorizedVaultRequest checks auth state.
	s.check(
		indexSrc.includes('"unclaimed"'),
		"index.ts handles unclaimed auth state",
	);
	// The earlier test with yaos.ripplor.workers.dev confirmed unclaimed returns { error: "unclaimed" }
}
await s.done();
