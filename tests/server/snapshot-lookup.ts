/**
 * Unit tests for the O(1) snapshot lookup optimization.
 *
 * Covers:
 *   - dayFromSnapshotId: valid input, timezone boundary (UTC), malformed inputs
 *   - getSnapshotPayload: exact R2 operation counts, hit/miss combinations,
 *     malformed/invalid snapshot IDs
 *   - listSnapshots: still uses bucket.list (unchanged)
 */

import {
	dayFromSnapshotId,
	getSnapshotPayload,
	listSnapshots,
	type SnapshotIndex,
} from "../../server/src/snapshot";
import { FakeR2Bucket } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const s = suite("snapshot-lookup");

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
	s.check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/**
 * The two keys `getSnapshotPayload` fetches for a snapshot.
 *
 * The day segment comes from the product's own `dayFromSnapshotId`, the same
 * way `makeIndex` below derives it, so seeding a bucket does not restate the
 * schema — only the two file names, which the key-schema section at the bottom
 * of this file asserts literally.
 */
function payloadKeys(vaultId: string, snapshotId: string): { index: string; crdt: string } {
	const day = dayFromSnapshotId(snapshotId) ?? "1970-01-01";
	const prefix = `v1/${vaultId}/snapshots/${day}/${snapshotId}`;
	return { index: `${prefix}/index.json`, crdt: `${prefix}/crdt.bin.gz` };
}

/** UTF-8 bytes, for seeding a bucket with a JSON or text object. */
function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/**
 * A bucket whose `list` is a tripwire.
 *
 * `getSnapshotPayload` must reach a snapshot by direct key, never by scanning,
 * so in the sections below that exercise a *valid* snapshotId any list call is
 * a bug rather than a number to assert on.
 */
class NoListR2Bucket extends FakeR2Bucket {
	override list(): never {
		throw new Error("list must not be called");
	}
}

/**
 * Build a minimal SnapshotIndex for use in test fixtures.
 * The `day` and `snapshotId` are derived from the provided timestamp so the
 * index is consistent with what `getSnapshotPayload` would write.
 */
function makeIndex(snapshotId: string, vaultId: string): SnapshotIndex {
	const day = dayFromSnapshotId(snapshotId) ?? "1970-01-01";
	return {
		snapshotId,
		vaultId,
		createdAt: new Date().toISOString(),
		day,
		schemaVersion: 1,
		markdownFileCount: 0,
		blobFileCount: 0,
		crdtSizeBytes: 4,
		crdtRawSizeBytes: 8,
		referencedBlobHashes: [],
	};
}

/** Returns a valid snapshotId whose timestamp maps to the given UTC day. */
function snapshotIdForDate(utcDate: Date): string {
	const ts = utcDate.getTime().toString(36);
	return `${ts}-abcd1234`;
}

// ---------------------------------------------------------------------------
// dayFromSnapshotId tests
// ---------------------------------------------------------------------------

s.section("dayFromSnapshotId: valid snapshotId derives correct day");
{
	const knownDate = new Date("2026-05-27T14:30:00.000Z");
	const id = snapshotIdForDate(knownDate);
	assertEqual(dayFromSnapshotId(id), "2026-05-27", "derives 2026-05-27 from known timestamp");
}

s.section("dayFromSnapshotId: UTC midnight stays on the same day");
{
	// 2026-05-27T00:00:00.000Z should yield "2026-05-27", not "2026-05-26".
	const utcMidnight = new Date("2026-05-27T00:00:00.000Z");
	const id = snapshotIdForDate(utcMidnight);
	assertEqual(dayFromSnapshotId(id), "2026-05-27", "UTC midnight resolves to same day");

	// One millisecond before midnight: still the prior day.
	const beforeMidnight = new Date("2026-05-26T23:59:59.999Z");
	const id2 = snapshotIdForDate(beforeMidnight);
	assertEqual(dayFromSnapshotId(id2), "2026-05-26", "one ms before UTC midnight is prior day");
}

s.section("dayFromSnapshotId: round-trip matches today()");
{
	// Generate a snapshotId the same way generateSnapshotId() does.
	const now = Date.now();
	const ts = now.toString(36);
	const id = `${ts}-deadbeef`;
	const expected = new Date(now).toISOString().slice(0, 10);
	assertEqual(dayFromSnapshotId(id), expected, "round-trip matches UTC date at creation time");
}

s.section("dayFromSnapshotId: empty string returns null");
{
	assertEqual(dayFromSnapshotId(""), null, "empty string → null");
}

s.section("dayFromSnapshotId: missing hyphen returns null");
{
	assertEqual(dayFromSnapshotId("lkjhgfdsa"), null, "no hyphen → null");
	assertEqual(dayFromSnapshotId("-suffix"), null, "hyphen at index 0 → null (no prefix)");
}

s.section("dayFromSnapshotId: non-base36 prefix returns null");
{
	// Symbols that are not alphanumeric force the regex to fail.
	assertEqual(dayFromSnapshotId("!@#$-abcdef01"), null, "symbol prefix → null");
	// Uppercase letters do NOT match [0-9a-z]+ — they are rejected by the
	// regex, not by parseInt case-insensitivity.  No bucket I/O is attempted.
	assertEqual(dayFromSnapshotId("UPPER-abcdef01"), null, "uppercase prefix → null (rejected by regex before parseInt)");
	// Partial-valid: prefix starts valid but contains an invalid char.
	assertEqual(dayFromSnapshotId("abc!def-abcdef01"), null, "mixed-valid prefix with symbol → null");
}

s.section("dayFromSnapshotId: zero timestamp returns null");
{
	// parseInt("0", 36) === 0, which is not a valid creation time.
	assertEqual(dayFromSnapshotId("0-abcdef01"), null, "ts=0 → null");
}

s.section("dayFromSnapshotId: negative timestamp returns null");
{
	// "-1-abcdef01" has an empty prefix (hyphen at index 0), so the regex
	// fails before any numeric parsing.
	s.check(dayFromSnapshotId("-1-abcdef01") === null, "leading hyphen (negative-looking) → null");
}

s.section("dayFromSnapshotId: empty suffix returns null");
{
	// Regex requires [0-9a-f]{8,} after the hyphen.
	assertEqual(dayFromSnapshotId("lkjhgfdsa-"), null, "hyphen with empty suffix → null");
	assertEqual(dayFromSnapshotId("lkjhgfdsa-abc"), null, "suffix shorter than 8 hex chars → null");
	assertEqual(dayFromSnapshotId("lkjhgfdsa-abcdef0"), null, "suffix with 7 hex chars → null");
	// Exactly 8 is the minimum; this should be valid.
	const id8 = `${Date.now().toString(36)}-abcdef01`;
	s.check(dayFromSnapshotId(id8) !== null, "suffix with exactly 8 hex chars → valid");
}

s.section("dayFromSnapshotId: uppercase suffix hex returns null");
{
	// Suffix must be lowercase hex [0-9a-f]; uppercase letters fail the regex.
	assertEqual(dayFromSnapshotId("lkjhgfdsa-ABCDEF01"), null, "uppercase hex suffix → null");
}

s.section("dayFromSnapshotId: overflowing timestamp returns null");
{
	// A very long lowercase base-36 string produces a value > Number.MAX_SAFE_INTEGER.
	// 36^11 ≈ 1.3e17 > MAX_SAFE_INTEGER (9e15).  Use 14 'z' chars to be safe.
	const overflowId = "zzzzzzzzzzzzzz-abcdef01"; // 14 z's: way beyond MAX_SAFE_INTEGER
	assertEqual(dayFromSnapshotId(overflowId), null, "overflowing base-36 timestamp → null");
}

// ---------------------------------------------------------------------------
// getSnapshotPayload: operation count tests
// ---------------------------------------------------------------------------

s.section("getSnapshotPayload: exactly 2 bucket.get() calls, 0 list calls");
{
	const vaultId = "vault-op-count";
	const snapshotId = snapshotIdForDate(new Date("2026-05-27T10:00:00.000Z"));
	const index = makeIndex(snapshotId, vaultId);
	const keys = payloadKeys(vaultId, snapshotId);

	const bucket = new FakeR2Bucket({
		objects: new Map([
			[keys.index, bytes(JSON.stringify(index))],
			[keys.crdt, bytes("compressed-bytes")],
		]),
	});

	const result = await getSnapshotPayload(vaultId, snapshotId, bucket);

	s.check(result !== null, "result is not null for valid snapshot");
	assertEqual(bucket.gets.length, 2, "exactly 2 bucket.get() calls");
	assertEqual(bucket.listCalls, 0, "zero bucket.list() calls");
}

// ---------------------------------------------------------------------------
// getSnapshotPayload: hit / miss combinations
// ---------------------------------------------------------------------------

s.section("getSnapshotPayload: returns correct index and payload");
{
	const vaultId = "vault-hit";
	const snapshotId = snapshotIdForDate(new Date("2026-01-15T08:00:00.000Z"));
	const index = makeIndex(snapshotId, vaultId);
	const payloadBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip magic bytes
	const keys = payloadKeys(vaultId, snapshotId);

	const bucket = new NoListR2Bucket({
		objects: new Map([
			[keys.index, bytes(JSON.stringify(index))],
			[keys.crdt, payloadBytes],
		]),
	});

	const result = await getSnapshotPayload(vaultId, snapshotId, bucket);

	s.check(result !== null, "result is not null");
	assertEqual(result?.index.snapshotId, snapshotId, "index.snapshotId matches");
	assertEqual(result?.index.vaultId, vaultId, "index.vaultId matches");
	s.check(result?.payload instanceof Uint8Array, "payload is Uint8Array");
}

s.section("getSnapshotPayload: missing index.json returns null");
{
	const vaultId = "vault-miss-index";
	const snapshotId = snapshotIdForDate(new Date("2026-03-01T00:00:00.000Z"));

	// index.json missing: only the payload key is seeded.
	const bucket = new NoListR2Bucket({
		objects: new Map([[payloadKeys(vaultId, snapshotId).crdt, bytes("payload")]]),
	});

	const result = await getSnapshotPayload(vaultId, snapshotId, bucket);

	s.check(result === null, "null when index.json is absent");
	assertEqual(bucket.gets.length, 2, "still fetches both keys in parallel before checking");
}

s.section("getSnapshotPayload: missing crdt.bin.gz returns null");
{
	const vaultId = "vault-miss-payload";
	const snapshotId = snapshotIdForDate(new Date("2026-04-10T06:00:00.000Z"));
	const index = makeIndex(snapshotId, vaultId);

	// crdt.bin.gz missing: only the index key is seeded.
	const bucket = new NoListR2Bucket({
		objects: new Map([[payloadKeys(vaultId, snapshotId).index, bytes(JSON.stringify(index))]]),
	});

	const result = await getSnapshotPayload(vaultId, snapshotId, bucket);

	s.check(result === null, "null when crdt.bin.gz is absent");
	assertEqual(bucket.gets.length, 2, "still fetches both keys in parallel before checking");
}

// ---------------------------------------------------------------------------
// getSnapshotPayload: malformed / invalid snapshotId — no bucket I/O
// ---------------------------------------------------------------------------

s.section("getSnapshotPayload: invalid base36 timestamp does not list bucket");
{
	const bucket = new FakeR2Bucket();

	await getSnapshotPayload("vault", "0-abcdef01", bucket); // ts=0 → null, no list
	assertEqual(bucket.listCalls, 0, "zero list calls for ts=0 snapshotId");

	await getSnapshotPayload("vault", "", bucket); // empty → null, no list
	assertEqual(bucket.listCalls, 0, "zero list calls for empty snapshotId");
}

// ---------------------------------------------------------------------------
// getSnapshotPayload: malformed / invalid snapshotId — no bucket I/O
// ---------------------------------------------------------------------------

s.section("getSnapshotPayload: uppercase prefix performs no bucket I/O");
{
	const bucket = new FakeR2Bucket();

	const result = await getSnapshotPayload("vault", "UPPER-abcdef01", bucket);
	s.check(result === null, "uppercase prefix → null");
	assertEqual(bucket.gets.length, 0, "uppercase prefix: 0 bucket.get() calls");
	assertEqual(bucket.listCalls, 0, "uppercase prefix: 0 bucket.list() calls");
}

s.section("getSnapshotPayload: malformed snapshotId performs no bucket I/O");
{
	const cases: [string, string][] = [
		["", "empty string"],
		["-abcdef01", "leading hyphen / empty prefix"],
		["abc-", "empty suffix"],
		["abc-ABCDEF01", "uppercase hex suffix"],
		["abc!-abcdef01", "symbol in prefix"],
		["abc-abc", "suffix too short (3 chars)"],
	];
	for (const [id, label] of cases) {
		const bucket = new FakeR2Bucket();
		const result = await getSnapshotPayload("vault", id, bucket);
		s.check(result === null, `${label} → null`);
		assertEqual(bucket.gets.length, 0, `${label}: 0 bucket.get() calls`);
		assertEqual(bucket.listCalls, 0, `${label}: 0 bucket.list() calls`);
	}
}

// ---------------------------------------------------------------------------
// Payload key schema: lock that crdt.bin.gz is fetched, not configured
// ---------------------------------------------------------------------------

s.section("getSnapshotPayload: fetches exactly index.json and crdt.bin.gz keys");
{
	const vaultId = "vault-key-shape";
	const snapshotId = snapshotIdForDate(new Date("2026-06-01T09:00:00.000Z"));
	const expectedDay = "2026-06-01";
	const index = makeIndex(snapshotId, vaultId);
	const keys = payloadKeys(vaultId, snapshotId);

	const bucket = new NoListR2Bucket({
		objects: new Map([
			[keys.index, bytes(JSON.stringify(index))],
			[keys.crdt, bytes("payload")],
		]),
	});

	await getSnapshotPayload(vaultId, snapshotId, bucket);

	// `bucket.gets` records what the product asked for, not what was seeded, so
	// these three assertions still pin the key schema itself.
	assertEqual(bucket.gets.length, 2, "exactly 2 keys fetched");
	s.check(
		bucket.gets.some((k) => k === `v1/${vaultId}/snapshots/${expectedDay}/${snapshotId}/index.json`),
		"index.json key has correct full path",
	);
	s.check(
		bucket.gets.some((k) => k === `v1/${vaultId}/snapshots/${expectedDay}/${snapshotId}/crdt.bin.gz`),
		"crdt.bin.gz key has correct full path (schema-fixed; not derived from index)",
	);
}

// ---------------------------------------------------------------------------
// listSnapshots: still uses bucket.list (unchanged)
// ---------------------------------------------------------------------------

s.section("listSnapshots: still calls bucket.list (unchanged contract)");
{
	const bucket = new FakeR2Bucket();

	await listSnapshots("vault-list-test", bucket);
	s.check(bucket.listCalls >= 1, "listSnapshots still calls bucket.list at least once");
}
await s.done();
