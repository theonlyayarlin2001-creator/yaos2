/**
 * T0/T1/T2/T3/T4 — Server persistence proof for sequential-device handoff.
 *
 * Issue #24 RCA experiment. Tests the causal chain:
 *   Device A creates file → server Y.Doc mutates → save fires → journal grows
 *   → cold load replays state → Device B receives file.
 *
 * This test runs against a live wrangler dev server (started by
 * worker-integration.mjs or manually).
 *
 * Required env:
 *   YAOS_TEST_HOST (default: http://127.0.0.1:8787)
 *   SYNC_TOKEN
 *   YAOS_TEST_VAULT_ID (default: yaos-persistence-proof-<timestamp>)
 */

import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema.ts";

const HOST = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";
const TOKEN = process.env.SYNC_TOKEN || "";
const VAULT_ID = process.env.YAOS_TEST_VAULT_ID || `yaos-persistence-proof-${Date.now().toString(36)}`;
const SYNC_PREFIX = `/vault/sync/${encodeURIComponent(VAULT_ID)}`;

if (!TOKEN) {
	throw new Error("SYNC_TOKEN is required");
}

/** A path→id row of the server's document, as this proof reads it. */
interface PathRow {
	readonly path: string;
	readonly fileId: string;
}

/** The snapshot of server state fetchServerDocument() reports. */
interface ServerDocument {
	readonly pathCount: number;
	readonly paths: PathRow[];
}

/**
 * The `persistence` block of `GET /debug/recent` — the coordinator's
 * PersistenceHealth (server/src/persistenceCoordinator.ts), narrowed to the
 * fields this proof asserts on.
 */
interface PersistenceHealth {
	readonly successfulSaveCount: number;
	readonly failedSaveCount: number;
	readonly journalEntryCount: number | null;
	readonly lastSaveError: string | null;
}

/** The trace-row fields this proof reads. */
interface TraceRow {
	readonly event?: string;
	readonly journalEntryCount?: number;
	readonly journalBytes?: number;
	readonly deltaBytes?: number;
}

/** The subset of `GET /debug/recent` this proof reads. */
interface DebugPayload {
	readonly recent?: TraceRow[];
	readonly persistence?: PersistenceHealth | null;
}

/** One simulated device: a connected client plus the edits this proof makes. */
interface Device {
	readonly doc: Y.Doc;
	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<unknown>;
	readonly provider: YSyncProvider;
	getPathCount(): number;
	createFile(path: string, content: string): string;
	readFile(path: string): string | null;
	disconnect(): void;
}

let passed = 0;
let failed = 0;

function assert(condition: unknown, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function wait(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function authHeaders(): Record<string, string> {
	return { Authorization: `Bearer ${TOKEN}` };
}

// ── Server state helpers ─────────────────────────────────────────────────────

async function fetchDebug(): Promise<DebugPayload | null> {
	const res = await fetch(
		`${HOST}/vault/${encodeURIComponent(VAULT_ID)}/debug/recent`,
		{ headers: authHeaders() },
	);
	if (!res.ok) {
		throw new Error(`debug fetch failed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as DebugPayload | null;
}

async function fetchServerDocument(): Promise<ServerDocument> {
	// The /__yaos/document endpoint is on the DO itself. We access it
	// by routing through the vault sync path which hits the DO's fetch().
	// But that requires the Worker to forward — let's use the debug route
	// which we know works from the worker level.
	//
	// Actually, we need the raw document. Let's connect a fresh Yjs client,
	// wait for sync, then count paths. This is more reliable than trying
	// to hit internal DO endpoints.
	return new Promise<ServerDocument>((resolve, reject) => {
		const doc = new Y.Doc();
		const pathToId = doc.getMap<string>("pathToId");
		const timeout = setTimeout(() => {
			provider.destroy();
			doc.destroy();
			reject(new Error("fetchServerDocument timed out"));
		}, 15_000);

		const provider = new YSyncProvider(HOST, VAULT_ID, doc, {
			prefix: SYNC_PREFIX,
			params: { token: TOKEN, schemaVersion: String(SCHEMA_VERSION) },
			WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
			connect: true,
		});

		provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			clearTimeout(timeout);
			const paths: PathRow[] = [];
			pathToId.forEach((fileId, path) => {
				paths.push({ path, fileId });
			});
			provider.destroy();
			doc.destroy();
			resolve({ pathCount: paths.length, paths });
		});
	});
}

// ── Device simulation ────────────────────────────────────────────────────────

function connectDevice(label: string): Promise<Device> {
	return new Promise<Device>((resolve, reject) => {
		const doc = new Y.Doc();
		const pathToId = doc.getMap<string>("pathToId");
		const idToText = doc.getMap<Y.Text>("idToText");
		const meta = doc.getMap("meta");
		const timeout = setTimeout(() => {
			provider.destroy();
			doc.destroy();
			reject(new Error(`${label} connection timed out`));
		}, 15_000);

		const provider = new YSyncProvider(HOST, VAULT_ID, doc, {
			prefix: SYNC_PREFIX,
			params: { token: TOKEN, schemaVersion: String(SCHEMA_VERSION) },
			WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
			connect: true,
		});

		provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			clearTimeout(timeout);
			resolve({
				doc,
				pathToId,
				idToText,
				meta,
				provider,
				getPathCount(): number {
					return pathToId.size;
				},
				createFile(path: string, content: string): string {
					const fileId = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
					doc.transact(() => {
						pathToId.set(path, fileId);
						const ytext = new Y.Text();
						ytext.insert(0, content);
						idToText.set(fileId, ytext);
						meta.set(fileId, { path, deleted: false });
					}, "disk-sync");
					return fileId;
				},
				readFile(path: string): string | null {
					const fileId = pathToId.get(path);
					if (!fileId) return null;
					const ytext = idToText.get(fileId);
					if (!ytext) return null;
					return ytext.toString();
				},
				disconnect(): void {
					provider.destroy();
					doc.destroy();
				},
			});
		});
	});
}

// ── Main experiment ──────────────────────────────────────────────────────────

async function main() {
	console.log(`\nPersistence handoff proof — Issue #24 RCA`);
	console.log(`Host: ${HOST}`);
	console.log(`Vault: ${VAULT_ID}`);
	console.log();

	// ── T0: Baseline server state ──────────────────────────────────────────
	console.log("--- T0: Baseline server state ---");
	const t0 = await fetchServerDocument();
	console.log(`  Server path count at T0: ${t0.pathCount}`);
	const baselinePathCount = t0.pathCount;

	// ── T1: Device A creates a file while connected ────────────────────────
	console.log("\n--- T1: Device A creates handoff-test.md ---");
	const deviceA = await connectDevice("Device A");
	console.log(`  Device A synced. Path count: ${deviceA.getPathCount()}`);
	assert(deviceA.getPathCount() === baselinePathCount, `Device A starts with ${baselinePathCount} paths`);

	deviceA.createFile("handoff-test.md", "hello from Device A — persistence proof");
	console.log("  Created handoff-test.md on Device A");

	// Give the update a moment to propagate to server
	await wait(2_000);

	// Verify server in-memory doc has the file (connect a read-only client)
	const t1 = await fetchServerDocument();
	console.log(`  Server path count at T1: ${t1.pathCount}`);
	assert(t1.pathCount === baselinePathCount + 1, `Server has ${baselinePathCount + 1} paths after Device A edit`);
	const t1HasFile = t1.paths.some((p) => p.path === "handoff-test.md");
	assert(t1HasFile, "Server in-memory doc contains handoff-test.md");

	// ── T2: Wait for save debounce + check persistence health ──────────────
	console.log("\n--- T2: Wait for save debounce, check persistence health ---");
	// y-partyserver debounce is 2s with maxWait 10s. We already waited 2s.
	// Wait a bit more to be safe.
	await wait(5_000);

	const t2Debug = await fetchDebug();
	const persistence = t2Debug?.persistence;
	console.log("  Persistence health:", JSON.stringify(persistence, null, 2));

	if (persistence) {
		assert(
			persistence.successfulSaveCount > 0,
			`successfulSaveCount > 0 (got ${persistence.successfulSaveCount})`,
		);
		assert(
			persistence.failedSaveCount === 0,
			`failedSaveCount === 0 (got ${persistence.failedSaveCount})`,
		);
		if (persistence.journalEntryCount !== null) {
			assert(
				persistence.journalEntryCount > 0,
				`journalEntryCount > 0 (got ${persistence.journalEntryCount})`,
			);
		}
		if (persistence.lastSaveError) {
			console.error(`  WARNING: lastSaveError = ${persistence.lastSaveError}`);
		}
	} else {
		console.log("  (persistence health not available — server may not have instrumentation yet)");
	}

	// Check trace for save events
	const traceEvents = t2Debug?.recent || [];
	const saveSucceeded = traceEvents.filter((e) => e?.event === "server.save.append_succeeded");
	const saveFailed = traceEvents.filter((e) => e?.event === "server.save.append_failed");
	const saveSkippedSv = traceEvents.filter((e) => e?.event === "server.save.skipped_equal_sv");
	const saveSkippedEmpty = traceEvents.filter((e) => e?.event === "server.save.skipped_empty_delta");
	const updateObserved = traceEvents.filter((e) => e?.event === "server.ydoc.update_observed");

	console.log(`  Trace: ${updateObserved.length} update_observed, ${saveSucceeded.length} append_succeeded, ${saveFailed.length} append_failed, ${saveSkippedSv.length} skipped_equal_sv, ${saveSkippedEmpty.length} skipped_empty_delta`);

	if (saveSucceeded.length > 0) {
		// Non-null: guarded by the length check on the line above.
		const lastSave = saveSucceeded[saveSucceeded.length - 1]!;
		console.log(`  Last successful save: journalEntryCount=${lastSave.journalEntryCount}, journalBytes=${lastSave.journalBytes}, deltaBytes=${lastSave.deltaBytes}`);
		assert((lastSave.journalEntryCount ?? 0) > 0, "Journal has entries after save");
	} else if (saveFailed.length > 0) {
		console.error(`  CRITICAL: Save failed. Last error:`, saveFailed[saveFailed.length - 1]);
		assert(false, "No save failures (got append_failed events)");
	} else if (saveSkippedSv.length > 0 || saveSkippedEmpty.length > 0) {
		console.error("  WARNING: onSave fired but skipped — possible state vector baseline bug");
		assert(false, "Save should not skip when doc has been mutated");
	} else {
		console.log("  WARNING: No save trace events found. Either onSave never fired or instrumentation is missing.");
	}

	// ── Disconnect Device A ────────────────────────────────────────────────
	console.log("\n--- Disconnect Device A ---");
	deviceA.disconnect();
	console.log("  Device A disconnected");

	// ── T3: Wait for DO idle/eviction, then check cold-load state ──────────
	console.log("\n--- T3: Wait for DO eviction + cold-load check ---");
	// In local wrangler dev, the DO may not truly evict. But we can still
	// verify that the data is in the journal by checking debug after a pause.
	await wait(5_000);

	const t3 = await fetchServerDocument();
	console.log(`  Server path count at T3 (after Device A disconnect + wait): ${t3.pathCount}`);
	const t3HasFile = t3.paths.some((p) => p.path === "handoff-test.md");
	assert(t3HasFile, "Server still has handoff-test.md after Device A disconnect and wait");

	const t3Debug = await fetchDebug();
	const checkpointLoads = (t3Debug?.recent || []).filter((e) => e?.event === "checkpoint-load");
	if (checkpointLoads.length > 0) {
		const latestLoad = checkpointLoads[checkpointLoads.length - 1];
		console.log(`  Latest checkpoint-load: journalEntryCount=${latestLoad?.journalEntryCount}, journalBytes=${latestLoad?.journalBytes}`);
		if (latestLoad?.journalEntryCount !== undefined) {
			assert(
				latestLoad.journalEntryCount > 2,
				`Cold-load journal has more than 2 entries (got ${latestLoad.journalEntryCount})`,
			);
		}
	}

	// ── T4: Device B connects and receives the file ────────────────────────
	console.log("\n--- T4: Device B connects and checks for handoff-test.md ---");
	const deviceB = await connectDevice("Device B");
	console.log(`  Device B synced. Path count: ${deviceB.getPathCount()}`);

	const bContent = deviceB.readFile("handoff-test.md");
	assert(bContent !== null, "Device B has handoff-test.md in CRDT");
	if (bContent !== null) {
		assert(
			bContent === "hello from Device A — persistence proof",
			`Device B has correct content (got: "${bContent.slice(0, 60)}")`,
		);
	}

	assert(
		deviceB.getPathCount() === baselinePathCount + 1,
		`Device B has ${baselinePathCount + 1} paths`,
	);

	deviceB.disconnect();

	// ── Summary ────────────────────────────────────────────────────────────
	console.log(`\n${"─".repeat(55)}`);
	console.log(`Results: ${passed} passed, ${failed} failed`);
	console.log(`${"─".repeat(55)}\n`);

	if (failed > 0) {
		console.log("INTERPRETATION:");
		if (!t1HasFile) {
			console.log("  T1 failed → Server never received Device A's update (link 3-4 broken)");
		} else if (saveSucceeded.length === 0 && saveFailed.length === 0) {
			console.log("  T2 failed → onSave never fired or instrumentation missing (link 6-7)");
		} else if (saveFailed.length > 0) {
			console.log("  T2 failed → appendUpdate failed (link 9 broken — check error details)");
		} else if (saveSkippedSv.length > 0) {
			console.log("  T2 failed → onSave fired but skipped (link 8 broken — SV baseline bug)");
		} else if (!t3HasFile) {
			console.log("  T3 failed → Persistence or replay failure (link 9-10 broken)");
		} else if (bContent === null) {
			console.log("  T4 failed → Device B did not receive persisted state (link 11 broken)");
		}
	}

	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
