/**
 * Tests for the receipt confirmation rule.
 *
 * THE BUG THIS PINS
 *
 * A Yjs state vector maps client -> highest clock: it describes INSERTS.
 * Deletions live in the delete set, which it does not describe.  So a
 * deletion-only local change captures a candidate state vector IDENTICAL to the
 * previous one — which the server already had — and `isStateVectorGe(serverSv,
 * candidateSv)` returns true on the very next echo.  Deleting a paragraph was
 * reported to the user as "the server has your state" without the server having
 * received, let alone stored, anything.
 *
 * The fix requires the server's persist counter to have ADVANCED past the value
 * observed when the candidate was captured.  That works for deletions and
 * insertions alike, and upgrades the claim from "applied in memory" to "written
 * to storage" — which is what the receipt always implied.
 *
 * Servers that predate the marker keep the old state-vector behaviour, so
 * upgrading the client alone does not withdraw receipts they already grant.
 */

import * as Y from "yjs";
import { ServerAckTracker } from "../../src/sync/serverAckTracker";
import { parseSvEchoMessageDetailed } from "../../src/sync/svEchoMessage";
import { makeSvEchoCustomMessage } from "../../server/src/svEcho";
import { PersistenceCoordinator, type DocStore, type DocStoreCoalesceResult, type DocStoreJournalStats } from "../../server/src/persistenceCoordinator";
import { suite } from "../harness.ts";

const s = suite("receipt-durability");

const EPOCH = "epoch-a";

/**
 * A tracker attached to a doc, with the same origin plumbing vaultSync uses.
 * `provider` is the origin that marks an update as REMOTE; anything else counts
 * as a local change worth tracking.
 */
function makeTracker(): { doc: Y.Doc; tracker: ServerAckTracker; provider: object } {
	const doc = new Y.Doc();
	const provider = { name: "provider" };
	const tracker = new ServerAckTracker();
	tracker.attach(doc, () => Y.encodeStateVector(doc), provider, { name: "idb" });
	return { doc, tracker, provider };
}

const sv = (doc: Y.Doc): Uint8Array => Y.encodeStateVector(doc);

/** Server-side echo, parsed by the client, exactly as the wire does it. */
function echo(
	tracker: ServerAckTracker,
	doc: Y.Doc,
	generation: number | null,
	degraded?: boolean,
): void {
	const payload = generation === null
		? makeSvEchoCustomMessage(sv(doc))
		: makeSvEchoCustomMessage(sv(doc), { generation, epoch: EPOCH, ...(degraded ? { degraded: true } : {}) });
	const parsed = parseSvEchoMessageDetailed(payload);
	if (parsed.kind !== "valid_sv_echo") throw new Error(`echo did not parse: ${parsed.kind}`);
	tracker.recordServerSvEcho(parsed.sv, parsed.durability);
}

// ---------------------------------------------------------------------------

s.section("Test 1: the wire carries the marker, and stays schema 1");
{
	const doc = new Y.Doc();
	doc.getText("t").insert(0, "hello");

	const withMarker = JSON.parse(makeSvEchoCustomMessage(sv(doc), { generation: 7, epoch: EPOCH }));
	s.check(withMarker.schema === 1, "schema is still 1, so existing clients keep accepting echoes");
	s.check(withMarker.gen === 7, "generation carried");
	s.check(withMarker.genEpoch === EPOCH, "epoch carried");

	const without = JSON.parse(makeSvEchoCustomMessage(sv(doc)));
	s.check(without.gen === undefined, "no marker emitted when none supplied");

	const parsed = parseSvEchoMessageDetailed(JSON.stringify(withMarker));
	s.check(parsed.kind === "valid_sv_echo", "marker payload parses");
	s.check(parsed.kind === "valid_sv_echo" && parsed.durability?.generation === 7, "generation parsed");

	const parsedOld = parseSvEchoMessageDetailed(JSON.stringify(without));
	s.check(parsedOld.kind === "valid_sv_echo" && parsedOld.durability === null, "absent marker parses as null");

	// A half-written marker must degrade, not fail the whole echo.
	const partial = parseSvEchoMessageDetailed(JSON.stringify({ ...withMarker, genEpoch: undefined }));
	s.check(partial.kind === "valid_sv_echo" && partial.durability === null, "partial marker treated as absent");
	doc.destroy();
}

s.section("Test 2: a DELETION is not confirmed until a persist happens");
{
	const { doc, tracker } = makeTracker();
	const text = doc.getText("t");
	// onConnect sends a baseline echo before any local edit, so a real client
	// always has a generation to measure against.  Mirror that.
	echo(tracker, doc, 0);
	doc.transact(() => { text.insert(0, "alpha beta gamma"); });
	echo(tracker, doc, 1);                       // insert persisted
	s.check(tracker.serverAppliedLocalState === true, "the insert is confirmed");

	const svBefore = Buffer.from(sv(doc)).toString("hex");
	doc.transact(() => { text.delete(0, 6); });  // deletion only
	const svAfter = Buffer.from(sv(doc)).toString("hex");
	s.check(svBefore === svAfter, "state vector unchanged by the deletion (the precondition)");
	s.check(tracker.hasUnconfirmedCandidate, "the deletion is a pending candidate");

	// The server applied it but has not saved yet: same generation.
	echo(tracker, doc, 1);
	s.check(
		tracker.serverAppliedLocalState === false,
		"NOT confirmed while the persist counter has not advanced",
	);
	s.check(tracker.hasUnconfirmedCandidate, "still pending");

	// The save completes.
	echo(tracker, doc, 2);
	s.check(tracker.serverAppliedLocalState === true, "confirmed once the counter advances");
	s.check(!tracker.hasUnconfirmedCandidate, "no longer pending");
	doc.destroy();
}

s.section("Test 3: the old rule confirms that deletion immediately (the bug)");
{
	// Same sequence with no marker: reproduces the false positive, so the test
	// pins the bug rather than the implementation.
	const { doc, tracker } = makeTracker();
	const text = doc.getText("t");
	doc.transact(() => { text.insert(0, "alpha beta gamma"); });
	echo(tracker, doc, null);
	doc.transact(() => { text.delete(0, 6); });
	s.check(tracker.hasUnconfirmedCandidate, "deletion pending before any echo");
	echo(tracker, doc, null);
	s.check(
		tracker.serverAppliedLocalState === true,
		"legacy fallback confirms the deletion with no persist at all (documented weakness)",
	);
	doc.destroy();
}

s.section("Test 4: an INSERT still needs the counter to advance");
{
	const { doc, tracker } = makeTracker();
	echo(tracker, doc, 5);                       // establish a baseline
	doc.transact(() => { doc.getText("t").insert(0, "new content"); });
	echo(tracker, doc, 5);
	s.check(tracker.serverAppliedLocalState === false, "applied-but-unsaved insert is not confirmed");
	echo(tracker, doc, 6);
	s.check(tracker.serverAppliedLocalState === true, "confirmed after the save");
	doc.destroy();
}

s.section("Test 5: a server restart re-baselines instead of hanging");
{
	const { doc, tracker } = makeTracker();
	const text = doc.getText("t");
	doc.transact(() => { text.insert(0, "content"); });
	echo(tracker, doc, 40);
	doc.transact(() => { text.delete(0, 3); });

	// New instance: counter restarts at 0 under a different epoch.  Without epoch
	// handling the client would wait forever for 41.
	const restart = JSON.parse(makeSvEchoCustomMessage(sv(doc), { generation: 0, epoch: "epoch-b" }));
	const parsed = parseSvEchoMessageDetailed(JSON.stringify(restart));
	if (parsed.kind !== "valid_sv_echo") throw new Error("restart echo did not parse");
	tracker.recordServerSvEcho(parsed.sv, parsed.durability);
	s.check(
		tracker.serverAppliedLocalState === false,
		"the restart echo does not confirm — the new instance may not hold the change",
	);

	// And progress on the new instance confirms normally.
	const next = JSON.parse(makeSvEchoCustomMessage(sv(doc), { generation: 1, epoch: "epoch-b" }));
	const parsedNext = parseSvEchoMessageDetailed(JSON.stringify(next));
	if (parsedNext.kind !== "valid_sv_echo") throw new Error("next echo did not parse");
	tracker.recordServerSvEcho(parsedNext.sv, parsedNext.durability);
	s.check(tracker.serverAppliedLocalState === true, "confirmed by progress after the restart");
	doc.destroy();
}

s.section("Test 6: a remote update is not a local candidate");
{
	const { doc, tracker, provider } = makeTracker();
	const other = new Y.Doc();
	other.getText("t").insert(0, "from another device");
	// Applied with the provider as origin => remote, must not create a candidate.
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), provider);
	s.check(!tracker.hasUnconfirmedCandidate, "remote updates do not create candidates");
	doc.destroy();
	other.destroy();
}

s.section("Test 7: no baseline yet means no confirmation");
{
	// A local change before any echo has been seen: there is nothing to advance
	// past, so the tracker must wait rather than assume.
	const { doc, tracker } = makeTracker();
	doc.transact(() => { doc.getText("t").insert(0, "first ever change"); });
	echo(tracker, doc, 3);
	s.check(
		tracker.serverAppliedLocalState === false,
		"first echo only establishes the baseline",
	);
	echo(tracker, doc, 4);
	s.check(tracker.serverAppliedLocalState === true, "next persist confirms");
	doc.destroy();
}

s.section("Test 8: the counter advances only on a SUCCESSFUL persist");
{
	// The whole guarantee rests on this: if the counter advanced on a failed
	// write, the client would confirm a change that never reached storage —
	// exactly the false positive being fixed, reintroduced from the other end.
	class FlakyStore implements DocStore {
		snapshot: Uint8Array | null = null;
		journal: Uint8Array[] = [];
		fail = false;
		appendUpdate(update: Uint8Array): DocStoreJournalStats {
			if (this.fail) throw new Error("append failed (injected)");
			this.journal.push(update.slice());
			return this.getJournalStats();
		}
		rewriteCheckpoint(update: Uint8Array): void {
			if (this.fail) throw new Error("checkpoint failed (injected)");
			this.snapshot = update.slice();
			this.journal = [];
		}
		getJournalStats(): DocStoreJournalStats {
			return { entryCount: this.journal.length, totalBytes: this.journal.reduce((n, e) => n + e.byteLength, 0) };
		}
		coalesceJournal(): DocStoreCoalesceResult {
			if (this.journal.length <= 1) return { status: "noop", stats: this.getJournalStats() };
			this.journal = [Y.mergeUpdates(this.journal)];
			return { status: "ok", stats: this.getJournalStats() };
		}
	}

	const doc = new Y.Doc();
	doc.getText("t").insert(0, "body");
	const store = new FlakyStore();
	const coordinator = new PersistenceCoordinator(doc, store);

	s.check(coordinator.health.persistedGeneration === 0, "starts at zero");
	s.check(coordinator.health.generationEpoch.length > 0, "an epoch is assigned per instance");

	const first = await coordinator.enqueueSave();
	s.check(first.success, "first save succeeds");
	s.check(coordinator.health.persistedGeneration === 1, `advanced to 1 (got ${coordinator.health.persistedGeneration})`);

	// A no-op save must NOT advance it: nothing new reached storage.
	const skipped = await coordinator.enqueueSave();
	s.check(skipped.method === "skipped", "clean document skips");
	s.check(coordinator.health.persistedGeneration === 1, "a skipped save does not advance the counter");

	// A DELETION that fails to write must not advance it either.
	store.fail = true;
	doc.transact(() => { doc.getText("t").delete(0, 2); });
	const failed = await coordinator.enqueueSave();
	s.check(!failed.success, "save fails while the store is broken");
	s.check(
		coordinator.health.persistedGeneration === 1,
		`a failed save does not advance the counter (got ${coordinator.health.persistedGeneration})`,
	);

	// And once storage recovers, the deletion lands and the counter moves.
	store.fail = false;
	const retry = await coordinator.enqueueSave();
	s.check(retry.success, "retry succeeds");
	s.check(coordinator.health.persistedGeneration === 2, `advanced to 2 (got ${coordinator.health.persistedGeneration})`);

	const replayed = new Y.Doc();
	if (store.snapshot) Y.applyUpdate(replayed, store.snapshot);
	for (const e of store.journal) Y.applyUpdate(replayed, e);
	s.check(replayed.getText("t").toString() === "dy", `the deletion is in storage (got ${JSON.stringify(replayed.getText("t").toString())})`);

	// Two instances over the same document must not share an epoch, or a restart
	// would look like progress.
	const second = new PersistenceCoordinator(doc, store);
	s.check(
		second.health.generationEpoch !== coordinator.health.generationEpoch,
		"a new instance gets a distinct epoch",
	);

	coordinator.dispose();
	second.dispose();
	doc.destroy();
	replayed.destroy();
}

s.section("Test 9: server persistence health reaches the client");
{
	// The silent-failure class this closes: the socket is healthy, edits reach
	// other devices, and the writes are only discovered missing after the room
	// is evicted.  The client has no other channel to learn it, so the echo
	// carries it.
	const { doc, tracker } = makeTracker();

	echo(tracker, doc, 1);
	s.check(
		tracker.serverPersistenceDegraded === false,
		"a healthy echo omits the flag and reports healthy",
	);
	s.check(
		tracker.getState().serverPersistenceDegraded === false,
		"health is exposed on the snapshot the status bar reads",
	);

	echo(tracker, doc, 1, true);
	s.check(tracker.serverPersistenceDegraded === true, "a degraded echo is observed");
	s.check(
		tracker.getState().serverPersistenceDegraded === true,
		"degraded state reaches the snapshot",
	);

	// Recovery must clear it, otherwise the indicator sticks and stops meaning
	// anything.
	echo(tracker, doc, 2);
	s.check(tracker.serverPersistenceDegraded === false, "recovery clears the flag");

	// A server too old to report health must not be read as healthy: with no
	// marker at all there is nothing to believe, so the last known value stands.
	echo(tracker, doc, 3, true);
	echo(tracker, doc, null);
	s.check(
		tracker.serverPersistenceDegraded === true,
		"an echo without a durability marker does not silently clear the warning",
	);

	doc.destroy();
}

s.section("Test 10: degradation does not by itself withdraw a receipt");
{
	// Independence matters: a receipt says "this state was persisted", and one
	// already granted stays true even if the NEXT save fails.  Conflating the
	// two would make the receipt flap on unrelated faults.
	const { doc, tracker, provider } = makeTracker();
	echo(tracker, doc, 5);
	doc.getText("a").insert(0, "hello");
	echo(tracker, doc, 6, true);
	s.check(
		tracker.getState().serverAppliedLocalState === true,
		"the generation advanced, so the receipt is granted despite degradation",
	);
	s.check(tracker.serverPersistenceDegraded === true, "and degradation is reported alongside it");

	// Now a failing save: generation stalls, so no receipt for the new edit.
	doc.getText("a").insert(5, " world");
	echo(tracker, doc, 6, true);
	s.check(
		tracker.getState().serverAppliedLocalState === false,
		"a stalled generation withholds the receipt for the newer edit",
	);
	void provider;
	doc.destroy();
}

s.section("Test 11: the guarantee level is observed, not assumed");
{
	// The UI wording is driven by this.  Claiming a durable write against a
	// server that never reported one would be the same class of lie the receipt
	// change set out to remove, so it must start false and only ever be raised
	// by evidence on the wire.
	const { doc, tracker } = makeTracker();
	s.check(
		tracker.receiptGuaranteeIsDurable === false,
		"a tracker that has seen no echo does not claim durability",
	);

	echo(tracker, doc, null);
	s.check(
		tracker.receiptGuaranteeIsDurable === false,
		"an echo without a durability marker leaves the weaker guarantee in force",
	);

	echo(tracker, doc, 1);
	s.check(
		tracker.receiptGuaranteeIsDurable === true,
		"a marker-bearing echo raises the guarantee",
	);
	s.check(
		tracker.getState().receiptGuaranteeIsDurable === true,
		"the guarantee level reaches the snapshot the status bar reads",
	);
	doc.destroy();
}
await s.done();
