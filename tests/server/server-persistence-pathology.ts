/**
 * Regression tests for Issue #24 — server persistence pathology.
 *
 * These tests reproduce the exact failure shape from the reporter's diagnostics:
 * server durable state frozen near-empty while clients have rich local CRDT state.
 *
 * Test categories:
 *   1. Large refill from near-empty server (the core pathology)
 *   2. Append-failure checkpoint fallback (death spiral breaker)
 *   3. Persistence health / degraded state tracking
 */

import { webcrypto } from "node:crypto";

// Node 20+ (this repo's engines.node floor) already exposes a global `crypto`,
// so this only fires on an older runtime.  It goes through defineProperty
// rather than assignment because @types/node and @cloudflare/workers-types
// declare mutually unassignable `Crypto` types — they disagree on
// `subtle.generateKey`'s Ed25519 overload — so no assignment could typecheck.
// The disagreement is between two .d.ts files, not about the value: node's
// webcrypto is a real Web Crypto implementation, and defineProperty is how a
// global polyfill is installed anyway.
if (typeof globalThis.crypto === "undefined") {
	Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

import * as Y from "yjs";
import { SqlDocStore } from "../../server/src/sqlDocStore";
import { FakeDurableObjectStorage } from "../mocks/sqlStorage";
import { suite } from "../harness.ts";

const s = suite("server-persistence-pathology");

// ── Store construction ───────────────────────────────────────────────────────

/**
 * A store over the given fake DO SQLite storage.  Tests that simulate an
 * eviction build a new store over the *same* storage, which is what a cold
 * Durable Object does.
 */
function makeStore(storage: FakeDurableObjectStorage): SqlDocStore {
	return new SqlDocStore(storage);
}

// ── YAOS vault schema helpers ────────────────────────────────────────────────

type FileMeta = { path: string; deleted?: boolean };

interface VaultDoc {
	doc: Y.Doc;
	pathToId: Y.Map<string>;
	idToText: Y.Map<Y.Text>;
	meta: Y.Map<FileMeta>;
	sys: Y.Map<unknown>;
}

function makeVaultDoc(): VaultDoc {
	const doc = new Y.Doc();
	return {
		doc,
		pathToId: doc.getMap<string>("pathToId"),
		idToText: doc.getMap<Y.Text>("idToText"),
		meta: doc.getMap<FileMeta>("meta"),
		sys: doc.getMap<unknown>("sys"),
	};
}

function writeFile(vault: VaultDoc, path: string, content: string, fileId: string): void {
	vault.doc.transact(() => {
		vault.pathToId.set(path, fileId);
		const text = new Y.Text();
		text.insert(0, content);
		vault.idToText.set(fileId, text);
		vault.meta.set(fileId, { path, deleted: false });
	}, "disk-sync");
}

function activePaths(vault: VaultDoc): string[] {
	const paths: string[] = [];
	vault.pathToId.forEach((_, path) => {
		const fileId = vault.pathToId.get(path);
		if (!fileId) return;
		const m = vault.meta.get(fileId);
		if (!m?.deleted) paths.push(path);
	});
	return paths.sort();
}

function readFileContent(vault: VaultDoc, path: string): string | null {
	const fileId = vault.pathToId.get(path);
	if (!fileId) return null;
	const ytext = vault.idToText.get(fileId);
	if (!ytext) return null;
	return ytext.toString();
}

/**
 * Populate a vault with N files of the given content size.
 */
function populateVault(vault: VaultDoc, fileCount: number, contentSizeBytes: number): void {
	vault.sys.set("schemaVersion", 8);
	vault.sys.set("initialized", true);
	for (let i = 0; i < fileCount; i++) {
		const path = `folder-${Math.floor(i / 50)}/note-${i}.md`;
		const fileId = `file-${String(i).padStart(5, "0")}`;
		// Generate repeatable content of desired size
		let content = `# Note ${i}\n\n`;
		while (content.length < contentSizeBytes) {
			content += `Line ${content.length}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`;
		}
		content = content.slice(0, contentSizeBytes);
		writeFile(vault, path, content, fileId);
	}
}

/**
 * Simulate the server onSave path: compute delta from last persisted SV,
 * append to journal, return stats. This mirrors VaultSyncServer.onSave() +
 * enqueueSave() logic — including the escalation PersistenceCoordinator makes
 * when the store refuses a delta larger than one journal row can hold.
 */
function simulateServerSave(
	serverDoc: Y.Doc,
	store: SqlDocStore,
	lastPersistedSV: Uint8Array | null,
): {
	journalStats: { entryCount: number; totalBytes: number };
	method: "skipped" | "append" | "checkpoint";
	/** Bytes the save made durable, wherever they landed. */
	persistedBytes: number;
	newSV: Uint8Array;
} {
	const currentSV = Y.encodeStateVector(serverDoc);
	const delta = lastPersistedSV
		? Y.encodeStateAsUpdate(serverDoc, lastPersistedSV)
		: Y.encodeStateAsUpdate(serverDoc);
	if (delta.byteLength === 0) {
		return {
			journalStats: store.getJournalStats(),
			method: "skipped",
			persistedBytes: store.getSnapshotBytes(),
			newSV: currentSV,
		};
	}
	const appended = store.appendUpdate(delta);
	if (appended === null) {
		// The delta exceeds the per-row BLOB limit.  A journal append cannot
		// carry it, so the save must land as a checkpoint instead — refusing is
		// not an option, that is the pathology this file exists to catch.
		const full = Y.encodeStateAsUpdate(serverDoc);
		store.rewriteCheckpoint(full, currentSV);
		return {
			journalStats: store.getJournalStats(),
			method: "checkpoint",
			persistedBytes: full.byteLength,
			newSV: currentSV,
		};
	}
	return { journalStats: appended, method: "append", persistedBytes: appended.totalBytes, newSV: currentSV };
}

/**
 * Cold-start from store: load persisted state, reconstruct server doc,
 * then create a fresh client doc via simulated initial provider sync.
 */
function coldStartFromStore(store: SqlDocStore): VaultDoc {
	const state = store.loadState();
	const serverDoc = new Y.Doc();
	if (state.snapshot) Y.applyUpdate(serverDoc, state.snapshot);
	for (const u of state.journalUpdates) Y.applyUpdate(serverDoc, u);
	const device = makeVaultDoc();
	Y.applyUpdate(device.doc, Y.encodeStateAsUpdate(serverDoc));
	return device;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: Large refill from near-empty server — 700 tiny files
// ═══════════════════════════════════════════════════════════════════════════════

s.section("Test 1: large refill from near-empty server (700 tiny files)");
{
	const storage = new FakeDurableObjectStorage();
	const store = makeStore(storage);

	// Phase 1: Create near-empty server state (schema/sentinel only)
	const sentinelDoc = new Y.Doc();
	sentinelDoc.getMap("sys").set("schemaVersion", 8);
	const sentinelDelta = Y.encodeStateAsUpdate(sentinelDoc);
	store.appendUpdate(sentinelDelta);

	sentinelDoc.getMap("sys").set("initialized", true);
	const sentinelSV = Y.encodeStateVector(sentinelDoc);
	const sentinelDelta2 = Y.encodeStateAsUpdate(sentinelDoc, sentinelSV);
	// Only append if non-empty (initialized set produces a small delta)
	if (sentinelDelta2.byteLength > 0) {
		store.appendUpdate(sentinelDelta2);
	}

	const stats0 = store.getJournalStats();
	s.check(stats0.entryCount <= 2, `initial journal has <= 2 entries (got ${stats0.entryCount})`);

	// Phase 2: Client A has a full vault (700 files)
	const clientA = makeVaultDoc();
	populateVault(clientA, 700, 50); // 50 bytes per file

	// Phase 3: Simulate client A syncing to server — large delta
	const serverDoc = new Y.Doc();
	// Load existing persisted state into server doc
	const state = store.loadState();
	if (state.snapshot) Y.applyUpdate(serverDoc, state.snapshot);
	for (const u of state.journalUpdates) Y.applyUpdate(serverDoc, u);
	const loadedSV = Y.encodeStateVector(serverDoc);

	// Client sends its state to server (initial provider sync)
	const clientDelta = Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc));
	Y.applyUpdate(serverDoc, clientDelta);

	// Server onSave: delta from loaded SV
	const result = simulateServerSave(serverDoc, store, loadedSV);
	s.check(result.journalStats.entryCount > stats0.entryCount, "journal entry count increased after large refill");
	s.check(result.journalStats.totalBytes > 1000, `journal bytes reflect vault data (got ${result.journalStats.totalBytes})`);

	// Phase 4: Cold-start Device B from store
	const deviceB = coldStartFromStore(store);
	const bPaths = activePaths(deviceB);
	s.check(bPaths.length === 700, `Device B has all 700 files (got ${bPaths.length})`);
	s.check(readFileContent(deviceB, "folder-0/note-0.md") !== null, "Device B can read file content");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: Large refill — 700 files × 2KB content
// ═══════════════════════════════════════════════════════════════════════════════

s.section("Test 2: large refill from near-empty server (700 × 2KB files)");
{
	const storage = new FakeDurableObjectStorage();
	const store = makeStore(storage);

	// Near-empty server
	const sentinelDoc = new Y.Doc();
	sentinelDoc.getMap("sys").set("schemaVersion", 8);
	sentinelDoc.getMap("sys").set("initialized", true);
	store.appendUpdate(Y.encodeStateAsUpdate(sentinelDoc));

	const loadedSV = Y.encodeStateVector(sentinelDoc);

	// Client A with 700 × 2KB files
	const clientA = makeVaultDoc();
	populateVault(clientA, 700, 2048);

	// Sync to server
	const serverDoc = new Y.Doc();
	Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(sentinelDoc));
	const clientDelta = Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc));
	Y.applyUpdate(serverDoc, clientDelta);

	const result = simulateServerSave(serverDoc, store, loadedSV);
	s.check(result.journalStats.totalBytes > 100_000, `large vault persisted (${result.journalStats.totalBytes} bytes)`);

	// Cold-start Device B
	const deviceB = coldStartFromStore(store);
	const bPaths = activePaths(deviceB);
	s.check(bPaths.length === 700, `Device B has all 700 files (got ${bPaths.length})`);

	// Spot-check content
	const content = readFileContent(deviceB, "folder-5/note-250.md");
	s.check(content !== null && content.startsWith("# Note 250"), "Device B has correct file content");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: Large refill — 700 files × 20KB content (stress test)
// ═══════════════════════════════════════════════════════════════════════════════

s.section("Test 3: large refill from near-empty server (700 × 20KB files)");
{
	const storage = new FakeDurableObjectStorage();
	const store = makeStore(storage);

	// Near-empty server
	const sentinelDoc = new Y.Doc();
	sentinelDoc.getMap("sys").set("schemaVersion", 8);
	sentinelDoc.getMap("sys").set("initialized", true);
	store.appendUpdate(Y.encodeStateAsUpdate(sentinelDoc));

	const loadedSV = Y.encodeStateVector(sentinelDoc);

	// Client A with 700 × 20KB files
	const clientA = makeVaultDoc();
	populateVault(clientA, 700, 20_480);

	// Sync to server
	const serverDoc = new Y.Doc();
	Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(sentinelDoc));
	const clientDelta = Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc));
	Y.applyUpdate(serverDoc, clientDelta);

	const result = simulateServerSave(serverDoc, store, loadedSV);
	s.check(result.persistedBytes > 1_000_000, `large vault persisted (${result.persistedBytes} bytes)`);
	s.check(result.method === "checkpoint", `a vault-sized delta escalates to a checkpoint (got ${result.method})`);

	// Cold-start Device B
	const deviceB = coldStartFromStore(store);
	const bPaths = activePaths(deviceB);
	s.check(bPaths.length === 700, `Device B has all 700 files (got ${bPaths.length})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4: Exact reporter pathology — 2 entries / 103 bytes, then refill
// ═══════════════════════════════════════════════════════════════════════════════

s.section("Test 4: exact reporter pathology — near-empty journal then full vault refill");
{
	const storage = new FakeDurableObjectStorage();
	const store = makeStore(storage);

	// Create exactly the reporter's state: 2 tiny journal entries
	const setupDoc = new Y.Doc();
	setupDoc.getMap("sys").set("schemaVersion", 8);
	const sv1 = Y.encodeStateVector(setupDoc);
	const delta1 = Y.encodeStateAsUpdate(setupDoc);
	store.appendUpdate(delta1);

	setupDoc.getMap("sys").set("initialized", true);
	const delta2 = Y.encodeStateAsUpdate(setupDoc, sv1);
	store.appendUpdate(delta2);

	const stats0 = store.getJournalStats();
	s.check(stats0.entryCount === 2, `reporter-like journal: ${stats0.entryCount} entries`);
	s.check(stats0.totalBytes < 200, `reporter-like journal: ${stats0.totalBytes} bytes`);

	// Simulate DO cold-load
	const serverDoc = new Y.Doc();
	const state = store.loadState();
	if (state.snapshot) Y.applyUpdate(serverDoc, state.snapshot);
	for (const u of state.journalUpdates) Y.applyUpdate(serverDoc, u);
	const loadedSV = Y.encodeStateVector(serverDoc);

	// Client with 666 files connects and syncs
	const clientA = makeVaultDoc();
	populateVault(clientA, 666, 500);

	const clientDelta = Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc));
	Y.applyUpdate(serverDoc, clientDelta);

	// Server save (the critical moment — this is what failed for the reporter)
	const result = simulateServerSave(serverDoc, store, loadedSV);
	s.check(result.journalStats.entryCount === 3, `journal has 3 entries after refill (got ${result.journalStats.entryCount})`);

	// Simulate DO eviction and cold-load by Device B
	const deviceB = coldStartFromStore(store);
	const bPaths = activePaths(deviceB);
	s.check(bPaths.length === 666, `Device B has all 666 files (got ${bPaths.length})`);

	// Verify Device B gets specific files
	s.check(readFileContent(deviceB, "folder-0/note-0.md") !== null, "Device B has first file");
	s.check(readFileContent(deviceB, "folder-13/note-665.md") !== null, "Device B has last file");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: appendUpdate failure does not corrupt journal
// ═══════════════════════════════════════════════════════════════════════════════

s.section("Test 5: appendUpdate failure leaves journal intact");
{
	const storage = new FakeDurableObjectStorage();
	const store = makeStore(storage);

	// Write one small entry
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);
	store.appendUpdate(Y.encodeStateAsUpdate(doc));

	const statsBeforeFail = store.getJournalStats();
	s.check(statsBeforeFail.entryCount === 1, "journal has 1 entry before failure");

	// Make the next put fail
	storage.sql.failWritesAfterBytes = 0;
	storage.sql.resetBytesWritten();

	// Try to append a large update — should throw
	doc.getText("t").insert(0, "x".repeat(10_000));
	const delta = Y.encodeStateAsUpdate(doc);
	let threw = false;
	try {
		store.appendUpdate(delta);
	} catch {
		threw = true;
	}
	s.check(threw, "appendUpdate throws on storage failure");

	// The journal must be unchanged: SqlDocStore advances its counters only
	// after the INSERT returns, and a rejected write never reaches the table.
	storage.sql.failWritesAfterBytes = Infinity;
	const statsAfterFail = store.getJournalStats();
	s.check(
		statsAfterFail.entryCount === statsBeforeFail.entryCount,
		`journal entry count unchanged after the failed append (got ${statsAfterFail.entryCount})`,
	);
	s.check(storage.sql.journalTruth().entryCount === 1, "storage still holds exactly the one durable entry");
	s.check(threw, "storage failure was not silently swallowed");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7: Multiple DO lifecycles with near-empty server (simulates 80+ loads)
// ═══════════════════════════════════════════════════════════════════════════════

s.section("Test 7: repeated DO lifecycle — save persists across evictions");
{
	const storage = new FakeDurableObjectStorage();

	// Phase 1: First DO lifecycle — seed sentinel
	{
		const store = makeStore(storage);
		const doc = new Y.Doc();
		doc.getMap("sys").set("schemaVersion", 8);
		doc.getMap("sys").set("initialized", true);
		store.appendUpdate(Y.encodeStateAsUpdate(doc));
	}

	// Phase 2: Second DO lifecycle — client with 500 files syncs
	{
		const store = makeStore(storage);
		const state = store.loadState();
		const serverDoc = new Y.Doc();
		if (state.snapshot) Y.applyUpdate(serverDoc, state.snapshot);
		for (const u of state.journalUpdates) Y.applyUpdate(serverDoc, u);
		const loadedSV = Y.encodeStateVector(serverDoc);

		// Client syncs 500 files
		const client = makeVaultDoc();
		populateVault(client, 500, 200);
		const delta = Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(serverDoc));
		Y.applyUpdate(serverDoc, delta);

		// Server save
		simulateServerSave(serverDoc, store, loadedSV);
	}

	// Phase 3: Third DO lifecycle (simulated eviction + cold-load)
	// Device B opens alone — should see all 500 files
	{
		const store = makeStore(storage);
		const deviceB = coldStartFromStore(store);
		const bPaths = activePaths(deviceB);
		s.check(bPaths.length === 500, `after eviction cycle, Device B has 500 files (got ${bPaths.length})`);
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 9: appendUpdate fails, checkpoint fallback succeeds
// ═══════════════════════════════════════════════════════════════════════════════

s.section("Test 9: appendUpdate fails, checkpoint fallback succeeds");
{
	// The write threshold fails the append, then is lifted so the checkpoint can succeed.
	const storage = new FakeDurableObjectStorage();
	const store = makeStore(storage);

	// Write initial sentinel
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);
	store.appendUpdate(Y.encodeStateAsUpdate(doc));

	// Now make append fail for any non-trivial write
	storage.sql.failWritesAfterBytes = 500;
	storage.sql.resetBytesWritten();

	// Add real content that will exceed the threshold
	// Capture SV BEFORE mutation
	const svBefore = Y.encodeStateVector(doc);
	doc.getText("t").insert(0, "x".repeat(10_000));
	const delta = Y.encodeStateAsUpdate(doc, svBefore);

	// Try append — should fail
	let appendFailed = false;
	try {
		store.appendUpdate(delta);
	} catch {
		appendFailed = true;
	}
	s.check(appendFailed, "appendUpdate fails when storage threshold exceeded");
	s.check(storage.sql.writeFailures > 0, "storage recorded put failures");

	// Reset storage for checkpoint (which will succeed)
	storage.sql.failWritesAfterBytes = Infinity;
	storage.sql.resetBytesWritten();

	// Checkpoint should succeed
	let checkpointSucceeded = false;
	try {
		store.rewriteCheckpoint(
			Y.encodeStateAsUpdate(doc),
			Y.encodeStateVector(doc),
		);
		checkpointSucceeded = true;
	} catch {
		checkpointSucceeded = false;
	}
	s.check(checkpointSucceeded, "checkpoint fallback succeeds after append failure");

	// Cold-load should have the full content
	const reloaded = store.loadState();
	const restoredDoc = new Y.Doc();
	if (reloaded.snapshot) Y.applyUpdate(restoredDoc, reloaded.snapshot);
	for (const u of reloaded.journalUpdates) Y.applyUpdate(restoredDoc, u);

	s.check(
		restoredDoc.getText("t").toString() === "x".repeat(10_000),
		"checkpoint contains full content after fallback",
	);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 10: appendUpdate fails, checkpoint fallback also fails
// ═══════════════════════════════════════════════════════════════════════════════

s.section("Test 10: appendUpdate fails, checkpoint fallback also fails");
{
	const storage = new FakeDurableObjectStorage();
	const store = makeStore(storage);

	// Write initial sentinel
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);
	store.appendUpdate(Y.encodeStateAsUpdate(doc));
	const initialStats = store.getJournalStats();

	// Make ALL puts fail
	storage.sql.failWritesAfterBytes = 0;
	storage.sql.resetBytesWritten();

	// Add real content
	doc.getText("t").insert(0, "x".repeat(10_000));

	// Try append — should fail
	let appendFailed = false;
	try {
		store.appendUpdate(Y.encodeStateAsUpdate(doc));
	} catch {
		appendFailed = true;
	}
	s.check(appendFailed, "appendUpdate fails");

	// Try checkpoint — should also fail
	let checkpointFailed = false;
	try {
		store.rewriteCheckpoint(
			Y.encodeStateAsUpdate(doc),
			Y.encodeStateVector(doc),
		);
	} catch {
		checkpointFailed = true;
	}
	s.check(checkpointFailed, "checkpoint also fails when storage is completely broken");

	// Re-enable storage and verify original state is intact.  The failed
	// checkpoint deleted the journal before its INSERT threw, so this only holds
	// if the transaction rolled back — which is the contract under test.
	storage.sql.failWritesAfterBytes = Infinity;
	const afterStats = store.getJournalStats();
	s.check(
		afterStats.entryCount === initialStats.entryCount,
		"journal unchanged after failed saves",
	);
	const reopened = makeStore(storage).loadState();
	s.check(
		reopened.journalStats.entryCount === initialStats.entryCount,
		`a cold load still finds the pre-failure journal (got ${reopened.journalStats.entryCount})`,
	);
}

// ── Test 11: tombstone non-resurrection during authoritative reconcile ───────

s.section("Test 11: tombstoned stale disk file is not resurrected during authoritative reconcile");
{
	// Import the actual production function
	const { classifyDiskPathForReconcile } = await import("../../src/sync/vaultSync.js");

	const testPath = "FolderB/Untitled.md";

	// Test 1: Tombstoned path → tombstone-conflict
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			false,  // crdtHasPath
			true,   // isTombstoned
			"authoritative",
		);
		s.check(result.action === "tombstone-conflict", "tombstoned path returns tombstone-conflict");
		s.check(result.conflict !== undefined, "conflict object is returned");
		s.check(result.conflict!.path === testPath, "conflict path matches");
		s.check(result.conflict!.action === "preserved-local-only", "conflict action correct");
		s.check(result.conflict!.reason === "disk-present-at-tombstoned-path", "conflict reason correct");
	}

	// Test 2: Already in CRDT → skip-in-crdt
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			true,   // crdtHasPath
			false,  // isTombstoned
			"authoritative",
		);
		s.check(result.action === "skip-in-crdt", "path in CRDT returns skip-in-crdt");
		s.check(result.conflict === undefined, "no conflict for skip-in-crdt");
	}

	// Test 3: Not in CRDT, not tombstoned, authoritative → seed-to-crdt
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			false,  // crdtHasPath
			false,  // isTombstoned
			"authoritative",
		);
		s.check(result.action === "seed-to-crdt", "new path in authoritative returns seed-to-crdt");
	}

	// Test 4: Not in CRDT, not tombstoned, conservative → untracked
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			false,  // crdtHasPath
			false,  // isTombstoned
			"conservative",
		);
		s.check(result.action === "untracked", "new path in conservative returns untracked");
	}

	// Test 5: Tombstoned takes precedence over authoritative mode
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			false,  // crdtHasPath
			true,   // isTombstoned
			"authoritative",
		);
		s.check(result.action === "tombstone-conflict", "tombstone takes precedence in authoritative");
	}

	// Test 6: crdtHasPath takes precedence over tombstone
	// (This shouldn't normally happen, but test the priority)
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			true,   // crdtHasPath
			true,   // isTombstoned (inconsistent state)
			"authoritative",
		);
		s.check(result.action === "skip-in-crdt", "crdtHasPath takes precedence over tombstone");
	}
}

// ── Test 12: PersistenceCoordinator — append fails, checkpoint fallback succeeds ───────

s.section("Test 12: PersistenceCoordinator — append fails, checkpoint fallback succeeds");
{
	const { PersistenceCoordinator, CHECKPOINT_FALLBACK_AFTER_FAILURES } = await import(
		"../../server/src/persistenceCoordinator.js"
	);

	// Create a mock DocStore that fails append but succeeds checkpoint
	let appendCallCount = 0;
	let checkpointCallCount = 0;
	const mockStore = {
		async appendUpdate(_update: Uint8Array) {
			appendCallCount++;
			throw new Error("SIMULATED_APPEND_FAILURE");
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {
			checkpointCallCount++;
			// Success
		},
		async getJournalStats() {
			return { entryCount: 0, totalBytes: 0 };
		},
	};

	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);

	const coordinator = new PersistenceCoordinator(doc, mockStore as never);

	// First save — append fails, not enough failures for fallback yet
	doc.getText("t").insert(0, "content1");
	const result1 = await coordinator.enqueueSave();
	s.check(!result1.success, "first save fails");
	s.check(result1.method === "append", "first save tried append");
	s.check(coordinator.health.status === "degraded", "status is degraded after failure");
	s.check(coordinator.health.consecutiveSaveFailures === 1, "consecutive failures = 1");
	s.check(coordinator.health.pendingPersistence === true, "pendingPersistence stays true after failure");

	// Second save — append fails, triggers immediate checkpoint fallback
	doc.getText("t").insert(0, "content2");
	const result2 = await coordinator.enqueueSave();

	// After CHECKPOINT_FALLBACK_AFTER_FAILURES (2) failures, immediate fallback should succeed
	s.check(result2.success, "second save succeeds via immediate fallback");
	s.check(
		result2.method === "immediate-fallback",
		`second save used immediate fallback (got ${result2.method})`,
	);
	s.check(coordinator.health.status === "healthy", "status is healthy after fallback success");
	s.check(coordinator.health.consecutiveSaveFailures === 0, "consecutive failures reset");
	s.check(coordinator.health.checkpointFallbackCount >= 1, "checkpoint fallback count incremented");

	// Verify lastPersistedStateVector advanced
	const psv = coordinator.getLastPersistedStateVector();
	s.check(psv !== null, "lastPersistedStateVector is set after successful save");

	// Verify call counts
	s.check(appendCallCount === 2, `appendUpdate called twice (got ${appendCallCount})`);
	s.check(checkpointCallCount === 1, `rewriteCheckpoint called once (got ${checkpointCallCount})`);
}

// ── Test 13: PersistenceCoordinator — append + checkpoint both fail ───────

s.section("Test 13: PersistenceCoordinator — append + checkpoint both fail");
{
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator.js");

	// Create a mock DocStore that fails everything
	const mockStore = {
		async appendUpdate(_update: Uint8Array) {
			throw new Error("SIMULATED_APPEND_FAILURE");
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {
			throw new Error("SIMULATED_CHECKPOINT_FAILURE");
		},
		async getJournalStats() {
			return { entryCount: 0, totalBytes: 0 };
		},
	};

	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);

	const coordinator = new PersistenceCoordinator(doc, mockStore as never);

	// Capture initial state
	const initialPsv = coordinator.getLastPersistedStateVector();
	s.check(initialPsv === null, "initial lastPersistedStateVector is null");

	// First save — fails
	doc.getText("t").insert(0, "content1");
	const result1 = await coordinator.enqueueSave();
	s.check(!result1.success, "first save fails");

	// Second save — fails, triggers fallback which also fails
	doc.getText("t").insert(0, "content2");
	const result2 = await coordinator.enqueueSave();
	s.check(!result2.success, "second save fails");
	s.check(result2.method === "immediate-fallback", "second save tried immediate fallback");

	// CRITICAL INVARIANT: lastPersistedStateVector must NOT advance on failure
	const finalPsv = coordinator.getLastPersistedStateVector();
	s.check(finalPsv === null, "lastPersistedStateVector did NOT advance after total failure");

	// Status must be degraded
	s.check(coordinator.health.status === "degraded", "status is degraded");
	s.check(coordinator.health.pendingPersistence === true, "pendingPersistence is true after failure");
	s.check(coordinator.health.consecutiveSaveFailures >= 2, "consecutive failures tracked");
}

// ── Test 14: PersistenceCoordinator — queued saves use fresh state vectors ───────

s.section("Test 14: PersistenceCoordinator — queued saves cannot regress lastPersistedStateVector");
{
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator.js");

	let savedUpdates: Uint8Array[] = [];
	// The store contract has two write paths and a coordinator is free to choose
	// either, so a mock that only records appends cannot tell "persisted via
	// checkpoint" from "lost".  Record both and rebuild the way a cold load does.
	let savedCheckpoint: Uint8Array | null = null;
	const mockStore = {
		async appendUpdate(update: Uint8Array) {
			savedUpdates.push(update);
			return { entryCount: savedUpdates.length, totalBytes: update.byteLength };
		},
		async rewriteCheckpoint(update: Uint8Array, _sv?: Uint8Array) {
			savedCheckpoint = update;
			savedUpdates = [];
		},
		async getJournalStats() {
			return { entryCount: savedUpdates.length, totalBytes: 0 };
		},
	};

	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);

	const coordinator = new PersistenceCoordinator(doc, mockStore as never);

	// Queue multiple saves quickly
	doc.getText("t").insert(0, "A");
	const p1 = coordinator.enqueueSave();

	doc.getText("t").insert(0, "B");
	const p2 = coordinator.enqueueSave();

	doc.getText("t").insert(0, "C");
	const p3 = coordinator.enqueueSave();

	// Wait for all to complete
	const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

	// All should succeed
	s.check(r1.success, "first queued save succeeded");
	s.check(r2.success, "second queued save succeeded");
	s.check(r3.success, "third queued save succeeded");

	// Final state vector should reflect all changes
	const finalPsv = coordinator.getLastPersistedStateVector();
	s.check(finalPsv !== null, "final lastPersistedStateVector is set");

	// Cold load should have all content
	const coldDoc = new Y.Doc();
	if (savedCheckpoint) Y.applyUpdate(coldDoc, savedCheckpoint);
	for (const update of savedUpdates) {
		Y.applyUpdate(coldDoc, update);
	}
	const content = coldDoc.getText("t").toJSON();
	s.check(content.includes("A"), "cold load has content A");
	s.check(content.includes("B"), "cold load has content B");
	s.check(content.includes("C"), "cold load has content C");
}

// ── Test 14b: entry pressure coalesces instead of rewriting the snapshot ────

s.section("Test 14b: PersistenceCoordinator — entry pressure coalesces, byte pressure checkpoints");
{
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator.js");

	let journal: Uint8Array[] = [];
	let checkpoints = 0;
	let coalesces = 0;
	let snapshotBytes = 4000;
	const store = {
		appendUpdate(u: Uint8Array) {
			journal.push(u);
			return { entryCount: journal.length, totalBytes: journal.reduce((a, b) => a + b.byteLength, 0) };
		},
		rewriteCheckpoint(u: Uint8Array) { checkpoints++; journal = []; snapshotBytes = u.byteLength; },
		getJournalStats() {
			return { entryCount: journal.length, totalBytes: journal.reduce((a, b) => a + b.byteLength, 0) };
		},
		getSnapshotBytes() { return snapshotBytes; },
		coalesceJournal() {
			coalesces++;
			const merged = Y.mergeUpdates(journal);
			journal = [merged];
			return { status: "ok" as const, stats: { entryCount: 1, totalBytes: merged.byteLength } };
		},
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(doc, store as never, undefined, {
		journalCompactMaxEntries: 5,
		journalCompactMaxBytes: 1024,
		journalCompactAmplificationBound: 4,
	});
	// Establish a baseline so saves take the append path rather than seeding.
	coordinator.setInitialStateVector(Y.encodeStateVector(doc));

	for (let i = 0; i < 30; i++) {
		doc.getText("t").insert(0, "x");
		await coordinator.enqueueSave();
	}

	s.check(coalesces > 0, `entry pressure coalesced (got ${coalesces})`);
	s.check(checkpoints === 0, `entry pressure did NOT rewrite the snapshot (got ${checkpoints})`);
	s.check(coordinator.health.coalesceCount === coalesces, "coalesce count surfaced in health");

	coordinator.dispose(); doc.destroy();
}

s.section("Test 14b2: PersistenceCoordinator — the byte arm scales with the snapshot");
{
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator.js");

	let journal: Uint8Array[] = [];
	let checkpoints = 0;
	let coalesces = 0;
	// Small enough that snapshotBytes/4 clears the absolute floor, so the
	// relative arm is the one under test rather than the fixed 1MB default.
	const snapshotBytes = 400;
	const store = {
		appendUpdate(u: Uint8Array) {
			journal.push(u);
			return { entryCount: journal.length, totalBytes: journal.reduce((a, b) => a + b.byteLength, 0) };
		},
		rewriteCheckpoint() { checkpoints++; journal = []; },
		getJournalStats() {
			return { entryCount: journal.length, totalBytes: journal.reduce((a, b) => a + b.byteLength, 0) };
		},
		getSnapshotBytes() { return snapshotBytes; },
		coalesceJournal() {
			coalesces++;
			const merged = Y.mergeUpdates(journal);
			journal = [merged];
			return { status: "ok" as const, stats: { entryCount: 1, totalBytes: merged.byteLength } };
		},
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(doc, store as never, undefined, {
		journalCompactMaxEntries: 1000,   // keep the entry arm out of the way
		journalCompactMaxBytes: 16,       // floor below snapshotBytes/4 = 100
		journalCompactAmplificationBound: 4,
	});
	coordinator.setInitialStateVector(Y.encodeStateVector(doc));

	for (let i = 0; i < 40 && checkpoints === 0; i++) {
		doc.getText("t").insert(0, "abcdefghij");
		await coordinator.enqueueSave();
	}

	s.check(checkpoints === 1, `journal past snapshotBytes/4 triggers a checkpoint (got ${checkpoints})`);
	s.check(coalesces === 0, `the entry arm stayed out of it (got ${coalesces})`);

	coordinator.dispose(); doc.destroy();
}

// ── Test 14c: a failed append does not drop the buffered updates ─────────────

s.section("Test 14c: PersistenceCoordinator — failed append retains updates for retry");
{
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator.js");

	let checkpoint: Uint8Array | null = null;
	let journal: Uint8Array[] = [];
	let failNext = false;
	const store = {
		appendUpdate(u: Uint8Array) {
			if (failNext) throw new Error("simulated append failure");
			journal.push(u);
			return { entryCount: journal.length, totalBytes: 0 };
		},
		rewriteCheckpoint(u: Uint8Array) { checkpoint = u; journal = []; },
		getJournalStats() { return { entryCount: journal.length, totalBytes: 0 }; },
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(doc, store as never, undefined, {
		// Keep failures from escalating to a checkpoint, so the retry has to be
		// the append path replaying the very bytes the failure could have lost.
		checkpointFallbackAfterFailures: 99,
	});
	doc.getText("t").insert(0, "seed");
	await coordinator.enqueueSave();          // seeds the checkpoint baseline

	failNext = true;
	doc.getText("t").insert(0, "LOST?");
	const failed = await coordinator.enqueueSave();
	s.check(!failed.success, "append failure reported");

	failNext = false;
	doc.getText("t").insert(0, "later-");
	const retried = await coordinator.enqueueSave();
	s.check(retried.success, "retry succeeds");

	const cold = new Y.Doc();
	if (checkpoint) Y.applyUpdate(cold, checkpoint);
	for (const u of journal) Y.applyUpdate(cold, u);
	const text = cold.getText("t").toJSON();
	s.check(text.includes("LOST?"), `content from the failed save survives (got ${JSON.stringify(text)})`);
	s.check(text.includes("later-"), "content from the retry is present");
	s.check(text === doc.getText("t").toJSON(), "cold load matches the live document exactly");

	coordinator.dispose(); doc.destroy(); cold.destroy();
}

// ── Test 14d: delete-only changes travel through the update stream ───────────

s.section("Test 14d: PersistenceCoordinator — delete-only change reaches storage");
{
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator.js");

	let checkpoint: Uint8Array | null = null;
	let journal: Uint8Array[] = [];
	const store = {
		appendUpdate(u: Uint8Array) { journal.push(u); return { entryCount: journal.length, totalBytes: 0 }; },
		rewriteCheckpoint(u: Uint8Array) { checkpoint = u; journal = []; },
		getJournalStats() { return { entryCount: journal.length, totalBytes: 0 }; },
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(doc, store as never);
	doc.getText("t").insert(0, "delete me entirely");
	await coordinator.enqueueSave();

	// A deletion leaves the state vector byte-identical: it is recorded in the
	// delete set, which the state vector does not describe.  The update event
	// still fires, so the stream must carry it.
	const svBefore = Buffer.from(Y.encodeStateVector(doc)).toString("hex");
	doc.getText("t").delete(0, doc.getText("t").length);
	const svAfter = Buffer.from(Y.encodeStateVector(doc)).toString("hex");
	s.check(svBefore === svAfter, "state vector unchanged by the deletion (precondition)");

	const result = await coordinator.enqueueSave();
	s.check(result.success && result.method !== "skipped", `delete-only save was written (got ${result.method})`);

	const cold = new Y.Doc();
	if (checkpoint) Y.applyUpdate(cold, checkpoint);
	for (const u of journal) Y.applyUpdate(cold, u);
	s.check(cold.getText("t").toJSON() === "", `deletion survives a cold load (got ${JSON.stringify(cold.getText("t").toJSON())})`);

	coordinator.dispose(); doc.destroy(); cold.destroy();
}

// ── Test 15: PersistenceCoordinator — pendingPersistence tracks degraded state ───────

s.section("Test 15: PersistenceCoordinator — pendingPersistence stays true when degraded");
{
	const { PersistenceCoordinator } = await import("../../server/src/persistenceCoordinator.js");

	// Mock store that fails once then succeeds
	let shouldFail = true;
	const mockStore = {
		async appendUpdate(_update: Uint8Array) {
			if (shouldFail) {
				throw new Error("SIMULATED_FAILURE");
			}
			return { entryCount: 1, totalBytes: 100 };
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {
			if (shouldFail) {
				throw new Error("SIMULATED_CHECKPOINT_FAILURE");
			}
		},
		async getJournalStats() {
			return { entryCount: 1, totalBytes: 100 };
		},
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(doc, mockStore as never);

	// Initial state
	s.check(coordinator.health.pendingPersistence === false, "initially no pending persistence");
	s.check(coordinator.health.queuedSaveCount === 0, "initially no queued saves");

	// Make a change and try to save — will fail
	doc.getText("t").insert(0, "content");
	const result1 = await coordinator.enqueueSave();
	s.check(!result1.success, "save fails");

	// After failed save with empty queue, pendingPersistence must stay true
	s.check(coordinator.health.queuedSaveCount === 0, "queue is empty after save completes");
	s.check(coordinator.health.status === "degraded", "status is degraded");
	s.check(
		coordinator.health.pendingPersistence === true,
		"pendingPersistence stays true when degraded (queue empty but state unpersisted)",
	);

	// Fix the store and save again
	shouldFail = false;
	const result2 = await coordinator.enqueueSave();
	s.check(result2.success, "retry succeeds");

	// Now pendingPersistence should be false
	s.check(coordinator.health.status === "healthy", "status is healthy");
	s.check(coordinator.health.pendingPersistence === false, "pendingPersistence is false when healthy and queue empty");
}
await s.done();
