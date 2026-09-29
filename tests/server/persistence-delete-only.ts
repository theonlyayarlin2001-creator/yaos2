/**
 * Regression tests: deletion-only changes MUST be persisted.
 *
 * A Yjs state vector is a map of client -> highest clock.  It describes
 * INSERTS.  Deletions live in the delete set, which the state vector does not
 * describe at all, so "select all, delete" on a 50MB document leaves the state
 * vector byte-identical.
 *
 * PersistenceCoordinator used to gate saves on state-vector equality:
 *
 *     if (baseStateVector && equalBytes(baseStateVector, currentStateVector)) {
 *         return { success: true, method: "skipped" };   // <-- claims success
 *     }
 *
 * That treated every deletion-only change as a no-op, skipped the write, and
 * reported success.  The document then resurrected from storage on the next
 * cold load.  Saves are now gated on a dirty flag driven by the Y.Doc "update"
 * event, which fires for insertions and deletions alike.
 *
 * These tests fail against the state-vector gate and pass against the dirty
 * flag, so they pin the fix rather than the implementation detail.
 */

import * as Y from "yjs";
import { PersistenceCoordinator, type DocStore, type DocStoreCoalesceResult, type DocStoreJournalStats } from "../../server/src/persistenceCoordinator";
import { suite } from "../harness.ts";

const s = suite("persistence-delete-only");

/** Minimal in-memory DocStore: one snapshot blob plus an append-only journal. */
class MemoryDocStore implements DocStore {
	snapshot: Uint8Array | null = null;
	journal: Uint8Array[] = [];
	failAppend = false;
	failCheckpoint = false;
	/** Runs inside appendUpdate, i.e. while a save is in flight. */
	onAppend: (() => void) | null = null;

	appendUpdate(update: Uint8Array): DocStoreJournalStats | null {
		if (this.failAppend) throw new Error("append failed (injected)");
		this.journal.push(update.slice());
		this.onAppend?.();
		return this.getJournalStats();
	}

	rewriteCheckpoint(update: Uint8Array): void {
		if (this.failCheckpoint) throw new Error("checkpoint failed (injected)");
		this.snapshot = update.slice();
		this.journal = [];
	}

	getJournalStats(): DocStoreJournalStats {
		return {
			entryCount: this.journal.length,
			totalBytes: this.journal.reduce((sum, entry) => sum + entry.byteLength, 0),
		};
	}

	coalesceJournal(): DocStoreCoalesceResult {
		if (this.journal.length <= 1) return { status: "noop", stats: this.getJournalStats() };
		this.journal = [Y.mergeUpdates(this.journal)];
		return { status: "ok", stats: this.getJournalStats() };
	}

	/** Rebuild the document exactly as VaultSyncServer's cold load does. */
	replay(): Y.Doc {
		const doc = new Y.Doc();
		if (this.snapshot) Y.applyUpdate(doc, this.snapshot);
		for (const entry of this.journal) Y.applyUpdate(doc, entry);
		return doc;
	}
}

function makeDoc(text: string): { doc: Y.Doc; store: MemoryDocStore; coordinator: PersistenceCoordinator } {
	const doc = new Y.Doc();
	const map = doc.getMap("idToText");
	const ytext = new Y.Text();
	map.set("file-1", ytext);
	ytext.insert(0, text);
	const store = new MemoryDocStore();
	const coordinator = new PersistenceCoordinator(doc, store);
	return { doc, store, coordinator };
}

const svHex = (doc: Y.Doc): string => Buffer.from(Y.encodeStateVector(doc)).toString("hex");

// ---------------------------------------------------------------------------

s.section("Test 1: deleting all text is persisted and survives cold load");
{
	const { doc, store, coordinator } = makeDoc("hello world, this is the body of a note");
	await coordinator.enqueueSave();

	const before = svHex(doc);
	const ytext = doc.getMap("idToText").get("file-1") as Y.Text;
	doc.transact(() => { ytext.delete(0, ytext.length); });
	const after = svHex(doc);

	// The precondition that made the old gate wrong.  If this ever stops being
	// true the test is no longer exercising the bug.
	s.check(before === after, "state vector is UNCHANGED by a delete-only edit (precondition)");

	const result = await coordinator.enqueueSave();
	s.check(result.success, "save reports success");
	s.check(result.method !== "skipped", `save was NOT skipped (method=${result.method})`);

	const replayed = store.replay();
	const replayedText = replayed.getMap("idToText").get("file-1") as Y.Text | undefined;
	s.check(replayedText !== undefined, "replayed doc still has the file entry");
	s.check(replayedText?.toString() === "", `deletion survived cold load (got ${JSON.stringify(replayedText?.toString())})`);

	coordinator.dispose();
	doc.destroy();
	replayed.destroy();
}

s.section("Test 2: deleting a map key is persisted and survives cold load");
{
	const { doc, store, coordinator } = makeDoc("body text");
	await coordinator.enqueueSave();

	const before = svHex(doc);
	doc.transact(() => { doc.getMap("idToText").delete("file-1"); });
	s.check(before === svHex(doc), "state vector unchanged by map.delete (precondition)");

	const result = await coordinator.enqueueSave();
	s.check(result.method !== "skipped", `save was NOT skipped (method=${result.method})`);

	const replayed = store.replay();
	s.check(!replayed.getMap("idToText").has("file-1"), "key deletion survived cold load");

	coordinator.dispose();
	doc.destroy();
	replayed.destroy();
}

s.section("Test 3: reaping a tombstoned body reclaims encoded bytes durably");
{
	// The shape the reaper will produce: meta keeps the tombstone, the body goes.
	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText");
	const meta = doc.getMap("meta");
	const body = new Y.Text();
	idToText.set("f1", body);
	body.insert(0, "z".repeat(100_000));
	meta.set("f1", { path: "note.md", deletedAt: 1 });

	const store = new MemoryDocStore();
	const coordinator = new PersistenceCoordinator(doc, store);
	await coordinator.enqueueSave();
	const encodedBefore = Y.encodeStateAsUpdate(doc).byteLength;

	doc.transact(() => { idToText.delete("f1"); });
	const result = await coordinator.enqueueSave();
	s.check(result.method !== "skipped", `reap save was NOT skipped (method=${result.method})`);

	const encodedAfter = Y.encodeStateAsUpdate(doc).byteLength;
	s.check(encodedAfter < encodedBefore / 10, `reap collapsed the body in memory (${encodedBefore} -> ${encodedAfter})`);

	const replayed = store.replay();
	s.check(Y.encodeStateAsUpdate(replayed).byteLength < encodedBefore / 10, "reclamation survived cold load");
	s.check(replayed.getMap("meta").has("f1"), "tombstone preserved after reap (resurrection still blocked)");

	coordinator.dispose();
	doc.destroy();
	replayed.destroy();
}

s.section("Test 4: a genuinely unchanged document still skips");
{
	const { doc, store, coordinator } = makeDoc("unchanged");
	await coordinator.enqueueSave();
	const journalBefore = store.journal.length;

	const result = await coordinator.enqueueSave();
	s.check(result.method === "skipped", "second save with no changes is skipped");
	s.check(store.journal.length === journalBefore, "no journal entry written for a clean document");

	coordinator.dispose();
	doc.destroy();
}

s.section("Test 5: a failed save leaves the document dirty for retry");
{
	const { doc, store, coordinator } = makeDoc("retry me");
	await coordinator.enqueueSave();

	const ytext = doc.getMap("idToText").get("file-1") as Y.Text;
	store.failAppend = true;
	store.failCheckpoint = true;
	doc.transact(() => { ytext.delete(0, 4); });

	const failedResult = await coordinator.enqueueSave();
	s.check(!failedResult.success, "save fails while the store is broken");
	s.check(coordinator.health.dirty, "document remains dirty after a failed save");

	store.failAppend = false;
	store.failCheckpoint = false;
	const retry = await coordinator.enqueueSave();
	s.check(retry.success, "retry succeeds once the store recovers");
	s.check(retry.method !== "skipped", `retry actually wrote (method=${retry.method})`);

	const replayed = store.replay();
	const replayedText = replayed.getMap("idToText").get("file-1") as Y.Text;
	s.check(replayedText.toString() === "y me", `deletion persisted on retry (got ${JSON.stringify(replayedText.toString())})`);

	coordinator.dispose();
	doc.destroy();
	replayed.destroy();
}

s.section("Test 6: a change landing mid-save is not swallowed");
{
	// The dirty flag is cleared BEFORE the delta is encoded, so a change that
	// arrives while the write is in flight must leave the document dirty again
	// rather than be lost to the clear.  onAppend fires inside the save.
	const { doc, store, coordinator } = makeDoc("first");
	await coordinator.enqueueSave();

	const ytext = doc.getMap("idToText").get("file-1") as Y.Text;
	let injected = false;
	store.onAppend = () => {
		if (injected) return;
		injected = true;
		doc.transact(() => { ytext.delete(0, 1) });
	};

	doc.transact(() => { ytext.delete(4, 1); });     // "firs"
	const first = await coordinator.enqueueSave();
	s.check(first.method !== "skipped", `initial change was written (method=${first.method})`);
	s.check(injected, "a change was injected while the save was in flight");
	s.check(coordinator.health.dirty, "mid-save change left the document dirty");

	store.onAppend = null;
	const second = await coordinator.enqueueSave();
	s.check(second.method !== "skipped", `mid-save change was then written (method=${second.method})`);

	const replayed = store.replay();
	const replayedText = replayed.getMap("idToText").get("file-1") as Y.Text;
	const liveText = ytext.toString();
	s.check(replayedText.toString() === liveText, `persisted state matches live doc (${JSON.stringify(replayedText.toString())} vs ${JSON.stringify(liveText)})`);

	coordinator.dispose();
	doc.destroy();
	replayed.destroy();
}
await s.done();
