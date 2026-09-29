/**
 * Tests for the tombstone body reaper.
 *
 * The reaper deletes the Y.Text body of a tombstoned file once the tombstone is
 * older than a grace period, while preserving the tombstone itself.  These
 * tests pin the safety rules, because the failure mode is destroying content a
 * user still wants:
 *
 *   - active files are never touched
 *   - tombstones are never removed (resurrection stays blocked)
 *   - a tombstone with no usable timestamp is never reaped (unknown age)
 *   - the grace window is respected
 *   - reaping converges with a peer that edited the file offline
 *   - reaping is idempotent and free on a clean document
 */

import * as Y from "yjs";
import {
	reapTombstonedBodies,
	TOMBSTONE_REAP_ORIGIN,
	TOMBSTONE_REAP_GRACE_MS,
} from "../../server/src/tombstoneReaper";
import type { DocStoreCoalesceResult } from "../../server/src/persistenceCoordinator.ts";
import { suite } from "../harness.ts";

const s = suite("tombstone-reaper");

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/**
 * `DocStore.coalesceJournal` over an in-memory journal: merge every entry into
 * one, as the SQL store does.  The coordinator only reaches this above its
 * entry-count threshold, which none of the fakes below get near, but DocStore
 * requires the member so a fake without it is not a DocStore at all.
 */
function coalesceEntries(journal: Uint8Array[]): DocStoreCoalesceResult {
	if (journal.length <= 1) {
		const totalBytes = journal.reduce((sum, entry) => sum + entry.byteLength, 0);
		return { status: "noop", stats: { entryCount: journal.length, totalBytes } };
	}
	const merged = Y.mergeUpdates(journal);
	journal.length = 0;
	journal.push(merged);
	return { status: "ok", stats: { entryCount: 1, totalBytes: merged.byteLength } };
}

interface FileSpec {
	id: string;
	path: string;
	chars: number;
	/** undefined = active; number = tombstoned at that timestamp */
	deletedAt?: number;
	/** legacy tombstone with no timestamp */
	legacyDeleted?: boolean;
	/** write metadata as a nested Y.Map (schema v3) instead of flat JSON (v2) */
	nested?: boolean;
	/** also write a pathToId entry */
	legacyPathMap?: boolean;
}

function buildVault(specs: FileSpec[], schemaVersion: number | null = 2): Y.Doc {
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	const pathToId = doc.getMap<string>("pathToId");

	doc.transact(() => {
		if (schemaVersion !== null) doc.getMap("sys").set("schemaVersion", schemaVersion);
		for (const spec of specs) {
			const body = new Y.Text();
			idToText.set(spec.id, body);
			if (spec.chars > 0) body.insert(0, "x".repeat(spec.chars));

			const tombstoned = spec.deletedAt !== undefined || spec.legacyDeleted === true;
			if (spec.nested) {
				const entry = new Y.Map();
				entry.set("path", spec.path);
				if (spec.deletedAt !== undefined) entry.set("deletedAt", spec.deletedAt);
				else if (spec.legacyDeleted) entry.set("deleted", true);
				else entry.set("mtime", NOW);
				meta.set(spec.id, entry);
			} else if (spec.deletedAt !== undefined) {
				meta.set(spec.id, { path: spec.path, deletedAt: spec.deletedAt });
			} else if (spec.legacyDeleted) {
				meta.set(spec.id, { path: spec.path, deleted: true });
			} else {
				meta.set(spec.id, { path: spec.path, mtime: NOW });
			}

			if (spec.legacyPathMap && !tombstoned) pathToId.set(spec.path, spec.id);
		}
	});
	return doc;
}

const bodyOf = (doc: Y.Doc, id: string): string | null =>
	doc.getMap<Y.Text>("idToText").get(id)?.toString() ?? null;

const encodedBytes = (doc: Y.Doc): number => Y.encodeStateAsUpdate(doc).byteLength;

// ---------------------------------------------------------------------------

s.section("Test 1: old tombstones reaped, active files untouched");
{
	const doc = buildVault([
		{ id: "active", path: "keep.md", chars: 50_000, legacyPathMap: true },
		{ id: "old", path: "gone.md", chars: 50_000, deletedAt: NOW - 40 * DAY },
	]);
	const before = encodedBytes(doc);

	const result = reapTombstonedBodies(doc, { now: NOW });

	s.check(result.reaped === 1, `reaped exactly one body (got ${result.reaped})`);
	s.check(result.charsFreed === 50_000, `reported chars freed (got ${result.charsFreed})`);
	s.check(bodyOf(doc, "old") === null, "tombstoned body is gone");
	s.check(bodyOf(doc, "active")?.length === 50_000, "active body is intact");
	s.check(doc.getMap("meta").has("old"), "tombstone metadata preserved");
	s.check(encodedBytes(doc) < before * 0.55, `encoded size roughly halved (${before} -> ${encodedBytes(doc)})`);
	doc.destroy();
}

s.section("Test 2: grace window is respected");
{
	const doc = buildVault([
		{ id: "young", path: "recent.md", chars: 10_000, deletedAt: NOW - 5 * DAY },
		{ id: "old", path: "ancient.md", chars: 10_000, deletedAt: NOW - 60 * DAY },
	]);

	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(result.withinGrace === 1, `young tombstone held back (withinGrace=${result.withinGrace})`);
	s.check(result.reaped === 1, `old tombstone reaped (reaped=${result.reaped})`);
	s.check(bodyOf(doc, "young")?.length === 10_000, "young body retained");
	s.check(bodyOf(doc, "old") === null, "old body reaped");

	// Same document, later: the previously-young tombstone becomes eligible.
	const later = reapTombstonedBodies(doc, { now: NOW + 40 * DAY });
	s.check(later.reaped === 1, "young body reaped once it ages past the grace window");
	s.check(bodyOf(doc, "young") === null, "formerly-young body now gone");
	doc.destroy();
}

s.section("Test 3: default grace is 30 days");
{
	const doc = buildVault([
		{ id: "d29", path: "a.md", chars: 1_000, deletedAt: NOW - 29 * DAY },
		{ id: "d31", path: "b.md", chars: 1_000, deletedAt: NOW - 31 * DAY },
	]);
	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(TOMBSTONE_REAP_GRACE_MS === 30 * DAY, "grace constant is 30 days");
	s.check(bodyOf(doc, "d29") !== null, "29-day-old tombstone retained");
	s.check(bodyOf(doc, "d31") === null, "31-day-old tombstone reaped");
	s.check(result.reaped === 1 && result.withinGrace === 1, "counts match the boundary");
	doc.destroy();
}

s.section("Test 4: unknown-age tombstones are never reaped");
{
	const doc = buildVault([
		{ id: "legacy", path: "legacy.md", chars: 20_000, legacyDeleted: true },
		{ id: "legacyNested", path: "legacy2.md", chars: 20_000, legacyDeleted: true, nested: true },
	]);
	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(result.tombstones === 2, "both entries recognised as tombstones");
	s.check(result.unknownAge === 2, `both skipped for unknown age (got ${result.unknownAge})`);
	s.check(result.reaped === 0, "nothing reaped");
	s.check(bodyOf(doc, "legacy")?.length === 20_000, "flat legacy body retained");
	s.check(bodyOf(doc, "legacyNested")?.length === 20_000, "nested legacy body retained");
	doc.destroy();
}

s.section("Test 5: nested (schema v3) metadata is handled");
{
	const doc = buildVault([
		{ id: "nestedOld", path: "n1.md", chars: 30_000, deletedAt: NOW - 90 * DAY, nested: true },
		{ id: "nestedActive", path: "n2.md", chars: 30_000, nested: true, legacyPathMap: true },
	]);
	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(result.reaped === 1, `nested tombstone reaped (got ${result.reaped})`);
	s.check(bodyOf(doc, "nestedOld") === null, "nested tombstoned body gone");
	s.check(bodyOf(doc, "nestedActive")?.length === 30_000, "nested active body intact");
	s.check(doc.getMap("meta").get("nestedOld") instanceof Y.Map, "nested tombstone still a Y.Map");
	doc.destroy();
}

s.section("Test 6a: legacy path model — a stale pathToId entry vetoes a reap");
{
	// Under the legacy model getFileId() consults pathToId FIRST, so an entry
	// pointing at a tombstoned id still authorises that id and must veto.
	const doc = buildVault([{ id: "conflict", path: "c.md", chars: 5_000, deletedAt: NOW - 99 * DAY }], null);
	doc.transact(() => { doc.getMap<string>("pathToId").set("c.md", "conflict"); });

	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(result.conflicted === 1, `conflict detected (got ${result.conflicted})`);
	s.check(result.reaped === 0, "nothing reaped while pathToId still authorises the id");
	s.check(bodyOf(doc, "conflict")?.length === 5_000, "body preserved");
	doc.destroy();
}

s.section("Test 6b: v2 path model — dormant pathToId drift does NOT veto");
{
	// Under v2 the client resolves from meta alone and no longer writes
	// pathToId, so leftover entries are dead weight and must not pin a body.
	// A real vault had 14 of 46 tombstones blocked by exactly this.
	const doc = buildVault([{ id: "drift", path: "d.md", chars: 5_000, deletedAt: NOW - 99 * DAY }], 2);
	doc.transact(() => { doc.getMap<string>("pathToId").set("d.md", "drift"); });

	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(result.conflicted === 0, `no conflict under v2 (got ${result.conflicted})`);
	s.check(result.reaped === 1, `body reaped despite stale pathToId (got ${result.reaped})`);
	s.check(bodyOf(doc, "drift") === null, "body reclaimed");
	s.check(doc.getMap("meta").has("drift"), "tombstone still preserved");
	doc.destroy();
}

s.section("Test 6c: an active meta entry always vetoes, in any model");
{
	for (const schema of [null, 2]) {
		const doc = buildVault([{ id: "live", path: "l.md", chars: 3_000 }], schema);
		// Same id also carries a tombstone claim? Impossible for one key, so
		// assert the simpler invariant: an active entry is never a candidate.
		const result = reapTombstonedBodies(doc, { now: NOW });
		s.check(result.reaped === 0, `active file untouched (schema=${String(schema)})`);
		s.check(bodyOf(doc, "live")?.length === 3_000, `active body intact (schema=${String(schema)})`);
		doc.destroy();
	}
}

s.section("Test 7: budget caps a pass and reports the remainder");
{
	const specs: FileSpec[] = [];
	for (let i = 0; i < 10; i++) {
		specs.push({ id: `t${i}`, path: `t${i}.md`, chars: 1_000, deletedAt: NOW - 60 * DAY });
	}
	const doc = buildVault(specs);

	const first = reapTombstonedBodies(doc, { now: NOW, maxPerRun: 4 });
	s.check(first.reaped === 4, `first pass respected the budget (got ${first.reaped})`);
	s.check(first.remaining === 6, `remainder reported (got ${first.remaining})`);

	const second = reapTombstonedBodies(doc, { now: NOW, maxPerRun: 4 });
	s.check(second.reaped === 4, "second pass continues");
	const third = reapTombstonedBodies(doc, { now: NOW, maxPerRun: 4 });
	s.check(third.reaped === 2 && third.remaining === 0, "third pass finishes");

	const fourth = reapTombstonedBodies(doc, { now: NOW, maxPerRun: 4 });
	s.check(fourth.reaped === 0, "idempotent once everything is reaped");
	doc.destroy();
}

s.section("Test 8: reaping uses a tagged origin and one transaction");
{
	const doc = buildVault([
		{ id: "a", path: "a.md", chars: 1_000, deletedAt: NOW - 60 * DAY },
		{ id: "b", path: "b.md", chars: 1_000, deletedAt: NOW - 60 * DAY },
	]);
	const origins: unknown[] = [];
	doc.on("update", (_update: Uint8Array, origin: unknown) => { origins.push(origin); });

	reapTombstonedBodies(doc, { now: NOW });
	s.check(origins.length === 1, `single update emitted (got ${origins.length})`);
	s.check(origins[0] === TOMBSTONE_REAP_ORIGIN, `origin is tagged (got ${String(origins[0])})`);
	doc.destroy();
}

s.section("Test 9: a clean document costs nothing");
{
	const doc = buildVault([{ id: "active", path: "a.md", chars: 1_000, legacyPathMap: true }]);
	let updates = 0;
	doc.on("update", () => { updates++; });

	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(result.reaped === 0, "nothing to reap");
	s.check(updates === 0, "no transaction performed, so no update emitted");
	doc.destroy();
}

s.section("Test 10: reaping converges with a peer that edited offline");
{
	const server = buildVault([{ id: "f", path: "f.md", chars: 200, deletedAt: NOW - 60 * DAY }]);
	const device = new Y.Doc();
	Y.applyUpdate(device, Y.encodeStateAsUpdate(server));

	// The offline device edits the body it still has, unaware it will be reaped.
	device.transact(() => {
		device.getMap<Y.Text>("idToText").get("f")?.insert(0, "offline edit ");
	});
	const deviceUpdate = Y.encodeStateAsUpdate(device, Y.encodeStateVector(server));

	const result = reapTombstonedBodies(server, { now: NOW });
	s.check(result.reaped === 1, "server reaped the body");
	const serverUpdate = Y.encodeStateAsUpdate(server, Y.encodeStateVector(device));

	Y.applyUpdate(server, deviceUpdate);
	Y.applyUpdate(device, serverUpdate);

	const a = Y.encodeStateAsUpdate(server);
	const b = Y.encodeStateAsUpdate(device);
	s.check(Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0, "both peers converge byte-identically");
	s.check(!server.getMap("idToText").has("f"), "body stays gone on the server");
	s.check(!device.getMap("idToText").has("f"), "body is gone on the device too — no resurrection");
	s.check(server.getMap("meta").has("f"), "tombstone survives convergence");
	server.destroy();
	device.destroy();
}

s.section("Test 11: reclamation survives an encode/decode round trip");
{
	const doc = buildVault([{ id: "f", path: "f.md", chars: 100_000, deletedAt: NOW - 60 * DAY }]);
	const before = encodedBytes(doc);
	reapTombstonedBodies(doc, { now: NOW });
	const after = encodedBytes(doc);

	const reloaded = new Y.Doc();
	Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
	s.check(after < before / 10, `reap collapsed the body (${before} -> ${after})`);
	s.check(encodedBytes(reloaded) === after, "reloaded document is the same size");
	s.check(!reloaded.getMap("idToText").has("f"), "body still absent after reload");
	s.check(reloaded.getMap("meta").has("f"), "tombstone still present after reload");
	doc.destroy();
	reloaded.destroy();
}

s.section("Test 12: a reap is persisted, because it is a deletion-only change");
{
	// The reason this integration matters: a reap changes nothing about the
	// state vector, so the old save gate skipped it and the bodies came back on
	// the next cold load.  Wire the reaper to the real coordinator and prove the
	// reclamation reaches storage.
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator");

	const doc = buildVault([
		{ id: "keep", path: "keep.md", chars: 20_000, legacyPathMap: true },
		{ id: "old", path: "old.md", chars: 80_000, deletedAt: NOW - 60 * DAY },
	]);

	const journal: Uint8Array[] = [];
	let snapshot: Uint8Array | null = null;
	const store = {
		appendUpdate(update: Uint8Array) {
			journal.push(update.slice());
			return { entryCount: journal.length, totalBytes: journal.reduce((s, e) => s + e.byteLength, 0) };
		},
		rewriteCheckpoint(update: Uint8Array) { snapshot = update.slice(); journal.length = 0; },
		getJournalStats() {
			return { entryCount: journal.length, totalBytes: journal.reduce((s, e) => s + e.byteLength, 0) };
		},
		coalesceJournal() { return coalesceEntries(journal); },
	};

	const coordinator = new PersistenceCoordinator(doc, store);
	// Establish the pre-reap state as persisted, exactly as a cold load would.
	await coordinator.enqueueSave();
	coordinator.setInitialStateVector(Y.encodeStateVector(doc));

	const svBefore = Buffer.from(Y.encodeStateVector(doc)).toString("hex");
	const result = reapTombstonedBodies(doc, { now: NOW });
	const svAfter = Buffer.from(Y.encodeStateVector(doc)).toString("hex");

	s.check(result.reaped === 1, `reaped the old body (got ${result.reaped})`);
	s.check(svBefore === svAfter, "state vector unchanged by the reap (precondition)");

	const save = await coordinator.enqueueSave();
	s.check(save.success, "the reap was saved");
	s.check(save.method !== "skipped", `the reap was NOT skipped (method=${save.method})`);

	// Replay storage the way VaultSyncServer's cold load does.
	const reloaded = new Y.Doc();
	if (snapshot) Y.applyUpdate(reloaded, snapshot);
	for (const entry of journal) Y.applyUpdate(reloaded, entry);

	s.check(!reloaded.getMap("idToText").has("old"), "reaped body did NOT resurrect on reload");
	s.check(reloaded.getMap("meta").has("old"), "tombstone survived the reload");
	s.check(
		(reloaded.getMap<Y.Text>("idToText").get("keep")?.length ?? 0) === 20_000,
		"active file survived the reload intact",
	);

	coordinator.dispose();
	doc.destroy();
	reloaded.destroy();
}

s.section("Test 13: a forced checkpoint stops storage replaying reaped content");
{
	// The property that matters is NOT "the live doc shrank" — it is "a cold
	// load never re-materialises the reaped bodies".  A journal is replayed
	// verbatim, so appending the removal is not enough: the entries that
	// inserted the content must stop being replayed.
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator");

	const build = () => {
		const doc = buildVault([
			{ id: "keep", path: "keep.md", chars: 10_000, legacyPathMap: true },
			{ id: "old", path: "old.md", chars: 400_000, deletedAt: NOW - 60 * DAY },
		]);
		const journal: Uint8Array[] = [];
		let snapshot: Uint8Array | null = null;
		const store = {
			appendUpdate(u: Uint8Array) {
				journal.push(u.slice());
				return { entryCount: journal.length, totalBytes: journal.reduce((s, e) => s + e.byteLength, 0) };
			},
			rewriteCheckpoint(u: Uint8Array) { snapshot = u.slice(); journal.length = 0; },
			getJournalStats() {
				return { entryCount: journal.length, totalBytes: journal.reduce((s, e) => s + e.byteLength, 0) };
			},
			coalesceJournal() { return coalesceEntries(journal); },
		};
		return { doc, store, journal, peek: () => ({ snapshot, journal }) };
	};

	// Largest single update that a cold load must hold while replaying storage.
	const worstReplayEntry = (snapshot: Uint8Array | null, journal: Uint8Array[]): number =>
		Math.max(snapshot ? snapshot.byteLength : 0, ...journal.map((e) => e.byteLength), 0);

	// (a) append-only: the insert stays in the journal forever
	{
		const { doc, store, peek } = build();
		const c = new PersistenceCoordinator(doc, store);
		await c.enqueueSave();
		c.setInitialStateVector(Y.encodeStateVector(doc));
		reapTombstonedBodies(doc, { now: NOW });
		await c.enqueueSave();

		const { snapshot, journal } = peek();
		const worst = worstReplayEntry(snapshot, journal);
		s.check(worst > 300_000, `append-only storage still replays the big body (worst entry ${worst} bytes)`);

		const reloaded = new Y.Doc();
		if (snapshot) Y.applyUpdate(reloaded, snapshot);
		for (const e of journal) Y.applyUpdate(reloaded, e);
		s.check(!reloaded.getMap("idToText").has("old"), "settles to the reaped state either way");
		c.dispose(); doc.destroy(); reloaded.destroy();
	}

	// (b) forced checkpoint: storage no longer contains the body at all
	{
		const { doc, store, peek } = build();
		const c = new PersistenceCoordinator(doc, store);
		await c.enqueueSave();
		c.setInitialStateVector(Y.encodeStateVector(doc));
		const result = reapTombstonedBodies(doc, { now: NOW });
		s.check(result.reaped === 1, "reaped the body");
		const save = await c.forceCheckpoint("tombstone-reap");
		s.check(save.success, "forced checkpoint succeeded");
		s.check(save.method === "checkpoint-fallback", `used the checkpoint path (got ${save.method})`);

		const { snapshot, journal } = peek();
		s.check(journal.length === 0, `journal cleared (got ${journal.length} entries)`);
		const worst = worstReplayEntry(snapshot, journal);
		s.check(worst < 60_000, `storage no longer replays the big body (worst entry ${worst} bytes)`);

		const reloaded = new Y.Doc();
		if (snapshot) Y.applyUpdate(reloaded, snapshot);
		s.check(!reloaded.getMap("idToText").has("old"), "reaped body absent after reload");
		s.check(reloaded.getMap("meta").has("old"), "tombstone survives");
		s.check((reloaded.getMap<Y.Text>("idToText").get("keep")?.length ?? 0) === 10_000, "active file intact");
		c.dispose(); doc.destroy(); reloaded.destroy();
	}
}

s.section("Test 14: forceCheckpoint leaves the document clean and retries on failure");
{
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator");
	const doc = buildVault([{ id: "a", path: "a.md", chars: 1_000, legacyPathMap: true }]);
	let fail = false;
	const journal: Uint8Array[] = [];
	let snapshot: Uint8Array | null = null;
	const store = {
		appendUpdate(u: Uint8Array) { journal.push(u.slice()); return { entryCount: journal.length, totalBytes: 0 }; },
		rewriteCheckpoint(u: Uint8Array) {
			if (fail) throw new Error("checkpoint failed (injected)");
			snapshot = u.slice(); journal.length = 0;
		},
		getJournalStats() { return { entryCount: journal.length, totalBytes: 0 }; },
		coalesceJournal() { return coalesceEntries(journal); },
	};
	const c = new PersistenceCoordinator(doc, store);
	await c.enqueueSave();

	fail = true;
	const bad = await c.forceCheckpoint("tombstone-reap");
	s.check(!bad.success, "failure surfaces");
	s.check(c.health.dirty, "document left dirty so the next save retries");

	fail = false;
	const good = await c.forceCheckpoint("tombstone-reap");
	s.check(good.success, "retry succeeds");
	s.check(!c.health.dirty, "clean after a successful checkpoint");
	s.check(snapshot !== null, "snapshot written");
	c.dispose(); doc.destroy();
}

s.section("Test 15: skip reasons overlap instead of hiding each other");
{
	// The regression this pins cost a wrong inference on a live vault.  The
	// counters used to partition, so the conflict check returned before the age
	// checks ran: a tombstone that was BOTH still referenced AND inside the
	// grace window was reported only as `conflicted`.  Reading that as "blocked
	// only by a stale reference" implied removing the reference would free the
	// body.  It would not have — the body was also too young.
	const doc = buildVault([
		{ id: "both", path: "b.md", chars: 5_000, deletedAt: NOW - 5 * DAY },   // young
		{ id: "onlyYoung", path: "y.md", chars: 5_000, deletedAt: NOW - 5 * DAY },
		{ id: "onlyRef", path: "r.md", chars: 5_000, deletedAt: NOW - 60 * DAY },
		{ id: "neither", path: "n.md", chars: 5_000, deletedAt: NOW - 60 * DAY },
	], null); // legacy, so pathToId references count
	doc.transact(() => {
		const pathToId = doc.getMap<string>("pathToId");
		pathToId.set("b.md", "both");      // young AND referenced
		pathToId.set("r.md", "onlyRef");   // old but referenced
	});

	const result = reapTombstonedBodies(doc, { now: NOW });

	s.check(result.tombstones === 4, `four tombstones (got ${result.tombstones})`);
	s.check(result.withBody === 4, `all four still hold a body (got ${result.withBody})`);
	s.check(result.conflicted === 2, `both referenced ones counted (got ${result.conflicted})`);
	s.check(result.withinGrace === 2, `both young ones counted (got ${result.withinGrace})`);
	s.check(result.reaped === 1, `only the unblocked one reaped (got ${result.reaped})`);
	s.check(bodyOf(doc, "neither") === null, "the unblocked body is gone");
	s.check(bodyOf(doc, "both") !== null, "the doubly-blocked body is kept");

	// The point: the counters overlap, so they exceed the candidate pool.  A
	// partition would have reported conflicted 2 / withinGrace 1 and silently
	// lost the fact that "both" was young as well.
	s.check(
		result.conflicted + result.withinGrace + result.unknownAge > result.withBody - result.reaped,
		"skip reasons overlap rather than partitioning the pool",
	);
	doc.destroy();
}

s.section("Test 16: already-reaped tombstones are reported, not silently ignored");
{
	const doc = buildVault([
		{ id: "gone", path: "g.md", chars: 1_000, deletedAt: NOW - 60 * DAY },
		{ id: "stays", path: "s.md", chars: 1_000, deletedAt: NOW - 60 * DAY },
	]);
	const first = reapTombstonedBodies(doc, { now: NOW });
	s.check(first.reaped === 2 && first.alreadyReaped === 0, "first pass reaps both");

	const second = reapTombstonedBodies(doc, { now: NOW });
	s.check(second.tombstones === 2, "tombstones still counted after reaping");
	s.check(second.alreadyReaped === 2, `both reported as already reaped (got ${second.alreadyReaped})`);
	s.check(second.withBody === 0, "no bodies remain in the candidate pool");
	s.check(second.reaped === 0, "idempotent");
	doc.destroy();
}
await s.done();
