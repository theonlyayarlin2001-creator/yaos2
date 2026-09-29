#!/usr/bin/env node
/**
 * guard-schema-version.mjs
 *
 * Prevents the SCHEMA_VERSION regression where the P1 refactor reverted
 * the schema v3 implementation: src/sync/schema.ts was deleted, and
 * vaultSync.ts re-inlined SCHEMA_VERSION = 2 directly.
 *
 * Checks:
 *   1. src/sync/schema.ts exists (not deleted by a future refactor)
 *   2. src/sync/vaultSync.ts imports SCHEMA_VERSION from "./schema"
 *      (not re-inlined as a literal)
 *   3. No "export const SCHEMA_VERSION = " literal in vaultSync.ts
 *   4. SCHEMA_VERSION in schema.ts is the expected value
 *   5. server/src/version.ts exists (a missing server contract is a hard
 *      failure, never a warning — it is the only place the admitted schema
 *      version is declared to clients)
 *   6. server/src/version.ts pins the plugin's schema version:
 *      SERVER_SCHEMA_VERSION === plugin SCHEMA_VERSION. There is no
 *      supported range.
 */

import { readFileSync, existsSync } from "node:fs";

const EXPECTED_SCHEMA_VERSION = 3;
let failures = 0;

function fail(msg) {
	console.error("FAIL:", msg);
	failures++;
}

function pass(msg) {
	console.log("PASS:", msg);
}

// 1. schema.ts must exist
if (!existsSync("src/sync/schema.ts")) {
	fail("src/sync/schema.ts is missing — SCHEMA_VERSION constant was deleted. Restore from git.");
} else {
	pass("src/sync/schema.ts exists");

	// 4. SCHEMA_VERSION value must be correct
	const schemaContent = readFileSync("src/sync/schema.ts", "utf8");
	const match = schemaContent.match(/export const SCHEMA_VERSION\s*=\s*(\d+)/);
	if (!match) {
		fail("src/sync/schema.ts does not export SCHEMA_VERSION");
	} else {
		const actual = Number(match[1]);
		if (actual !== EXPECTED_SCHEMA_VERSION) {
			fail(`src/sync/schema.ts has SCHEMA_VERSION = ${actual}, expected ${EXPECTED_SCHEMA_VERSION}`);
		} else {
			pass(`src/sync/schema.ts: SCHEMA_VERSION = ${actual}`);
		}
	}
}

// 2 & 3. vaultSync.ts must import from "./schema", not inline the constant
if (!existsSync("src/sync/vaultSync.ts")) {
	fail("src/sync/vaultSync.ts is missing");
} else {
	const vaultContent = readFileSync("src/sync/vaultSync.ts", "utf8");

	// Must have the import from schema
	if (!vaultContent.includes('from "./schema"') && !vaultContent.includes("from './schema'")) {
		fail('src/sync/vaultSync.ts does not import from "./schema" — SCHEMA_VERSION may be inlined');
	} else {
		pass('src/sync/vaultSync.ts imports from "./schema"');
	}

	// Must NOT have an inline literal
	if (/export const SCHEMA_VERSION\s*=\s*\d/.test(vaultContent)) {
		fail("src/sync/vaultSync.ts contains an inlined 'export const SCHEMA_VERSION = N' — remove it and import from ./schema instead");
	} else {
		pass("src/sync/vaultSync.ts has no inlined SCHEMA_VERSION literal");
	}
}

// 5 & 6. The server must pin exactly the plugin's schema version.
if (!existsSync("server/src/version.ts")) {
	fail("server/src/version.ts is missing — server schema compatibility cannot be validated. Restore it.");
} else {
	const serverContent = readFileSync("server/src/version.ts", "utf8");
	const pinMatch = serverContent.match(/SERVER_SCHEMA_VERSION\s*=\s*(\d+)/);

	if (!pinMatch) {
		fail("server/src/version.ts is missing SERVER_SCHEMA_VERSION");
	} else {
		const pinned = Number(pinMatch[1]);
		if (pinned !== EXPECTED_SCHEMA_VERSION) {
			fail(
				`server/src/version.ts must pin the plugin's schema version: ` +
				`SERVER_SCHEMA_VERSION = ${pinned}, expected ${EXPECTED_SCHEMA_VERSION}`,
			);
		} else {
			pass(`server/src/version.ts pins schema v${EXPECTED_SCHEMA_VERSION} (SERVER_SCHEMA_VERSION === plugin SCHEMA_VERSION)`);
		}
	}
}

if (failures > 0) {
	console.error(`\nFAIL: ${failures} schema-version guard violation(s).`);
	console.error("  SCHEMA_VERSION must be in src/sync/schema.ts, imported into vaultSync.ts,");
	console.error("  and server/src/version.ts must pin that same single version as SERVER_SCHEMA_VERSION.");
	process.exit(1);
} else {
	console.log("\nPASS: schema version guard — all checks passed.");
}
