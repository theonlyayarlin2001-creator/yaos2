#!/usr/bin/env node
/**
 * Regression coverage for scripts/guard-schema-version.mjs.
 *
 * The server schema pin is a release compatibility contract:
 * SERVER_SCHEMA_VERSION must equal the plugin's SCHEMA_VERSION, because
 * admission is an equality test. This test runs the real guard against
 * otherwise-valid temporary fixtures that (1) omit server/src/version.ts
 * entirely and (2) pin a version other than the plugin's, proving the guard
 * fails closed in both cases.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot, suite, withTempDir } from "../harness.ts";

const s = suite("schema-version-guard");

const guardPath = resolve(repoRoot(), "scripts/guard-schema-version.mjs");

/** Populate `dir` with a minimal plugin-side schema pin. */
function makeFixture(dir: string) {
	mkdirSync(join(dir, "src/sync"), { recursive: true });
	writeFileSync(join(dir, "src/sync/schema.ts"), "export const SCHEMA_VERSION = 3;\n");
	writeFileSync(
		join(dir, "src/sync/vaultSync.ts"),
		'import { SCHEMA_VERSION } from "./schema";\nvoid SCHEMA_VERSION;\n',
	);
}

function runGuard(cwd: string) {
	return spawnSync(process.execPath, [guardPath], { cwd, encoding: "utf8" });
}

s.section("Test 1: missing server schema contract fails closed");
await withTempDir("yaos-schema-version-guard-", (fixtureDir) => {
	makeFixture(fixtureDir);
	const result = runGuard(fixtureDir);

	s.check(result.status === 1, "guard exits non-zero when server/src/version.ts is absent");
	s.check(
		result.stderr.includes("FAIL: server/src/version.ts is missing"),
		"guard reports the missing server schema contract",
	);
	s.check(
		result.stderr.includes("FAIL: 1 schema-version guard violation(s)."),
		"guard emits its aggregate failure summary",
	);
	s.check(
		!result.stdout.includes("PASS: schema version guard — all checks passed."),
		"guard never reports a missing server contract as a successful validation",
	);
});

s.section("Test 2: a server pin below the plugin schema fails closed");
await withTempDir("yaos-schema-version-guard-", (fixtureDir) => {
	makeFixture(fixtureDir);
	mkdirSync(join(fixtureDir, "server/src"), { recursive: true });
	writeFileSync(
		join(fixtureDir, "server/src/version.ts"),
		"export const SERVER_SCHEMA_VERSION = 1;\n",
	);

	const result = runGuard(fixtureDir);

	s.check(result.status === 1, "guard exits non-zero when the server pins a different schema version");
	s.check(
		result.stderr.includes("must pin the plugin's schema version"),
		"guard reports the mismatched pin as a violation",
	);
});

s.section("Test 3: SERVER_SCHEMA_VERSION === plugin schema passes");
await withTempDir("yaos-schema-version-guard-", (fixtureDir) => {
	makeFixture(fixtureDir);
	mkdirSync(join(fixtureDir, "server/src"), { recursive: true });
	writeFileSync(
		join(fixtureDir, "server/src/version.ts"),
		"export const SERVER_SCHEMA_VERSION = 3;\n",
	);

	const result = runGuard(fixtureDir);

	s.check(result.status === 0, "guard accepts a single pinned schema version");
	s.check(
		result.stdout.includes("PASS: schema version guard — all checks passed."),
		"guard reports overall success for a correctly pinned server",
	);
});
await s.done();
