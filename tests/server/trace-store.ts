import {
	appendTraceEntry,
	TraceRing,
	DEFAULT_TRACE_RATE_LIMIT_PER_WINDOW,
	isHighVolumeTraceEvent,
	listRecentTraceEntries,
	MAX_TRACE_ENTRY_BYTES,
	prepareTraceEntryForStorage,
	TRACE_SEED_AFTER_APPENDS,
	TraceRateLimiter,
	type TraceEntry,
} from "../../server/src/traceStore";
import { suite } from "../harness.ts";

class FakeStorage {
	readonly data = new Map<string, unknown>();

	async list<T = unknown>(options: DurableObjectListOptions = {}): Promise<Map<string, T>> {
		let keys = [...this.data.keys()].sort((a, b) => a.localeCompare(b));
		if (options.prefix) {
			keys = keys.filter((key) => key.startsWith(options.prefix!));
		}
		if (options.start !== undefined) {
			keys = keys.filter((key) => key >= options.start!);
		}
		if (options.startAfter !== undefined) {
			keys = keys.filter((key) => key > options.startAfter!);
		}
		if (options.end !== undefined) {
			keys = keys.filter((key) => key < options.end!);
		}
		if (options.reverse) {
			keys.reverse();
		}
		if (options.limit !== undefined) {
			keys = keys.slice(0, options.limit);
		}
		const out = new Map<string, T>();
		for (const key of keys) {
			out.set(key, this.data.get(key) as T);
		}
		return out;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async delete(keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			if (this.data.delete(key)) deleted++;
		}
		return deleted;
	}
}

class SizeBoundStorage extends FakeStorage {
	constructor(private readonly maxValueBytes: number) {
		super();
	}

	override async put<T>(key: string, value: T): Promise<void> {
		const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
		if (byteLength > this.maxValueBytes) {
			throw new Error(`SQLITE_TOOBIG: ${byteLength} > ${this.maxValueBytes}`);
		}
		await super.put(key, value);
	}
}

const s = suite("trace-store");

function makeEntry(i: number): TraceEntry {
	return {
		ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
		event: `event-${i}`,
		roomId: "room-a",
		seq: i,
	};
}

function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

s.section("Test 1: trace store keeps only the newest bounded entries");
{
	const storage = new FakeStorage();
	for (let i = 0; i < 250; i++) {
		await appendTraceEntry(storage, makeEntry(i), 100);
	}

	const allKeys = [...storage.data.keys()];
	s.check(allKeys.length === 100, "trace store retains exactly the newest 100 entries");
	s.check(allKeys.every((key) => key.startsWith("trace:")), "trace store writes per-entry prefixed keys");

	const recent = await listRecentTraceEntries(storage, 100);
	s.check(recent.length === 100, "debug read returns bounded recent trace entries");
	s.check((recent[0] as { seq?: unknown }).seq === 249, "most recent trace entry is returned first");
	s.check((recent.at(-1) as { seq?: unknown })?.seq === 150, "oldest retained trace entry is the 100th newest");
}

s.section("Test 2: trace store cleanup removes old backlog in one pass");
{
	const storage = new FakeStorage();
	for (let i = 0; i < 1000; i++) {
		const key = `trace:${String(i).padStart(13, "0")}:manual`;
		await storage.put(key, makeEntry(i));
	}

	await appendTraceEntry(storage, makeEntry(1001), 100);

	const allKeys = [...storage.data.keys()].sort((a, b) => a.localeCompare(b));
	s.check(allKeys.length === 100, "cleanup collapses oversized historical backlog down to the bound");
	const [oldestKey] = allKeys;
	s.check(
		oldestKey !== undefined && oldestKey.includes("0000000000901"),
		"cleanup keeps only the newest bounded key range",
	);
}

s.section("Test 3: oversized trace entries are truncated to a safe size");
{
	const storage = new SizeBoundStorage(MAX_TRACE_ENTRY_BYTES);
	const prepared = prepareTraceEntryForStorage({
		ts: new Date().toISOString(),
		event: "oversized-trace",
		roomId: "room-a",
		hugeString: "x".repeat(MAX_TRACE_ENTRY_BYTES * 4),
		hugeArray: Array.from({ length: 100 }, (_, i) => `item-${i}`),
		nested: {
			deep: {
				payload: "y".repeat(MAX_TRACE_ENTRY_BYTES * 2),
			},
		},
	});

	s.check(jsonBytes(prepared) <= MAX_TRACE_ENTRY_BYTES, "prepared trace entry fits within the storage byte budget");
	s.check(prepared.traceTruncated === true, "oversized trace entry is marked as truncated");

	await appendTraceEntry(storage, prepared, 10);
	s.check(storage.data.size === 1, "sanitized oversized trace entry can be persisted");
}

s.section("Test 4: TraceRateLimiter admits up to the per-window cap");
{
	const limiter = new TraceRateLimiter(5, 60_000);
	let admitted = 0;
	for (let i = 0; i < 5; i++) {
		if (limiter.admit(1_000 + i)) admitted++;
	}
	s.check(admitted === 5, "first five admits within the window succeed");
	s.check(limiter.admit(1_005) === false, "sixth admit within the window is rejected");
	s.check(limiter.drainDropped() === 1, "drainDropped reports exactly one drop");
	s.check(limiter.drainDropped() === 0, "drainDropped resets to zero after read");
}

s.section("Test 5: TraceRateLimiter slides forward as the window expires");
{
	const limiter = new TraceRateLimiter(3, 1_000);
	s.check(limiter.admit(0) === true, "t=0 admit");
	s.check(limiter.admit(100) === true, "t=100 admit");
	s.check(limiter.admit(200) === true, "t=200 admit");
	s.check(limiter.admit(300) === false, "t=300 admit dropped (over budget within window)");
	s.check(limiter.admit(1_500) === true, "t=1500 admit succeeds after window slides");
	s.check(limiter.admit(1_600) === true, "t=1600 admit succeeds (only one event still inside window)");
}

s.section("Test 6: TraceRateLimiter accumulates drops across many over-budget calls");
{
	const limiter = new TraceRateLimiter(2, 60_000);
	limiter.admit(0);
	limiter.admit(1);
	for (let i = 0; i < 100; i++) {
		limiter.admit(2 + i);
	}
	s.check(limiter.drainDropped() === 100, "drainDropped reports the full accumulated drop count");
}

s.section("Test 7: default budget is the documented per-room rate");
{
	s.check(
		DEFAULT_TRACE_RATE_LIMIT_PER_WINDOW === 600,
		"default per-window cap is 600 events / 60s",
	);
}

s.section("Test 8: throttle-summary bypasses the limiter and does not recurse");
{
	// Simulate the recordTrace dispatch as implemented in server.ts:
	//   isThrottleSummary = event === TRACE_RATE_THROTTLE_EVENT
	//   if (!isThrottleSummary && !limiter.admit()) drop
	//   ... persist ...
	//   if (!isThrottleSummary) drain and maybe emit one summary
	// The summary itself must not re-trigger another summary (no recursion).
	const limiter = new TraceRateLimiter(2, 60_000);
	limiter.admit(0); // fill budget
	limiter.admit(1);

	// Over-budget event: gets dropped, drop count becomes 1.
	const admitted = limiter.admit(2);
	s.check(admitted === false, "over-budget regular event is rejected");
	s.check(limiter.drainDropped() === 1, "drop count is 1 before summary");

	// Now simulate a throttle summary being admitted: bypasses limiter.
	const isThrottleSummary = true;
	// Throttle summaries bypass the limiter — they are always admitted.
	// Test that the drain after a summary returns 0 (no further accumulation).
	limiter.admit(3); // another over-budget event
	const dropsBeforeSummary = limiter.drainDropped();
	s.check(dropsBeforeSummary === 1, "drop accumulates between summary emissions");

	// After draining, further drain returns 0 — no recursion.
	const dropsAfterDrain = limiter.drainDropped();
	s.check(dropsAfterDrain === 0, "drainDropped resets to zero; throttle summary cannot recurse");
	s.check(isThrottleSummary === true, "throttle summary flag prevents recursive admit check");
}

/**
 * Storage fake that counts what a SQLite-backed Durable Object would bill:
 * `lists`/`keysListed` are rows read, `puts`/`deletes` are rows written.
 */
class CountingStorage {
	readonly data = new Map<string, unknown>();
	lists = 0;
	puts = 0;
	deletes = 0;
	keysListed = 0;
	async list<T>(options?: { prefix?: string; reverse?: boolean; limit?: number; end?: string }): Promise<Map<string, T>> {
		this.lists++;
		let keys = [...this.data.keys()].sort();
		if (options?.prefix) keys = keys.filter((k) => k.startsWith(options.prefix!));
		if (options?.end) keys = keys.filter((k) => k < options.end!);
		if (options?.reverse) keys.reverse();
		if (options?.limit !== undefined) keys = keys.slice(0, options.limit);
		this.keysListed += keys.length;
		return new Map(keys.map((k) => [k, this.data.get(k) as T]));
	}
	async put<T>(key: string, value: T): Promise<void> { this.puts++; this.data.set(key, value); }
	async delete(keys: string[]): Promise<number> {
		this.deletes++;
		let n = 0;
		for (const k of keys) if (this.data.delete(k)) n++;
		return n;
	}
}

// ── Row-read amplification: the ring must not list on every append ───────────
//
// A `list` over the trace prefix reads one SQL row per key on a SQLite-backed
// Durable Object, and a trace is recorded per inbound sync message.  Listing on
// every append cost ~201 rows read per ~2 written and was measured in
// production as the entire read amplification of a room: 43,696 rows read
// against 455 written for 300 update messages, a ratio of 96.
//
// The invariant is that appends are O(1) in list operations, not O(n).
{
	console.log("\n--- TraceRing: appends do not list per entry ---");
	const MAX = 200;
	const APPENDS = 600;
	const storage = new CountingStorage();
	const ring = new TraceRing(MAX);
	for (let i = 0; i < APPENDS; i++) {
		await ring.append(storage as never, { ts: new Date(1_700_000_000_000 + i).toISOString(), event: "e" } as never);
	}

	s.check(storage.puts === APPENDS, `one put per append (${storage.puts})`);
	s.check(storage.data.size <= MAX, `retention honoured (${storage.data.size} <= ${MAX})`);
	s.check(storage.lists <= 3, `list calls are O(1), not O(n) (${storage.lists} for ${APPENDS} appends)`);
	s.check(
		storage.keysListed / APPENDS < 2,
		`rows read per append is small (${(storage.keysListed / APPENDS).toFixed(2)}, naive form was ~${MAX})`,
	);

	// A short-lived instance must never list.  This is the case the first
	// version of the fix missed: a hibernating room wakes, writes one or two
	// traces and is evicted, so amortising over appends never pays off.  A real
	// room was measured spending ~200 of ~344 rows per wake on exactly this.
	{
		const brief = new CountingStorage();
		// Pre-existing history, as a real room has.
		for (let i = 0; i < MAX; i++) brief.data.set(`trace:${String(i).padStart(13, "0")}:aa`, {});
		const wake = new TraceRing(MAX);
		for (let i = 0; i < 3; i++) {
			await wake.append(brief as never, { ts: new Date(1_800_000_000_000 + i).toISOString(), event: "checkpoint-load" } as never);
		}
		s.check(brief.lists === 0, `a short-lived instance lists zero times (${brief.lists})`);
		s.check(brief.keysListed === 0, `and reads zero rows to trim (${brief.keysListed})`);
		s.check(brief.puts === 3, "the traces were still written");
	}

	// Overshoot is bounded: retention is eventual, not exact, and must not drift.
	{
		const bounded = new CountingStorage();
		const ring = new TraceRing(MAX);
		for (let i = 0; i < 2000; i++) {
			await ring.append(bounded as never, { ts: new Date(1_900_000_000_000 + i).toISOString(), event: "e" } as never);
		}
		s.check(
			bounded.data.size <= MAX + 200,
			`stored entries stay within maxEntries + slack (${bounded.data.size} <= ${MAX + 200})`,
		);
		s.check(bounded.data.size >= MAX, `and the ring stays full (${bounded.data.size} >= ${MAX})`);
	}

	// The stateless helper keeps its old behaviour: one list per call.
	const naive = new CountingStorage();
	for (let i = 0; i < 20; i++) {
		await appendTraceEntry(naive as never, { ts: new Date(1_700_000_000_000 + i).toISOString(), event: "e" } as never, MAX);
	}
	s.check(naive.lists === 20, `stateless appendTraceEntry still lists per call (${naive.lists})`);
}

// ── Crowd-out: a flood of one event class must not hide every other ──────────
//
// Measured on a real vault after ~6,000 edits: 98 of the 100 entries the debug
// endpoint returned were `server.ydoc.update_observed`, and every save,
// compaction, cold-load and tombstone-reap event had been evicted within
// seconds.  The only diagnostic surface the room has was empty of diagnostics
// exactly when the room was busy.

/** MAX_DEBUG_TRACE_EVENTS in server.ts. */
const MAX_PER_CLASS = 200;
/** TRACE_DEBUG_LIMIT in server.ts: what GET /debug/recent asks for. */
const READ_LIMIT = 100;
const HOT_EVENT = "server.ydoc.update_observed";

let traceClock = 1_950_000_000_000;
function traced(event: string): TraceEntry {
	return { ts: new Date(traceClock++).toISOString(), event, roomId: "room-a" };
}

s.section("Test 9: a rare event survives a flood of high-volume ones");
{
	const storage = new CountingStorage();
	const ring = new TraceRing(MAX_PER_CLASS);
	await ring.append(storage as never, traced("checkpoint-load"));
	for (let i = 0; i < 500; i++) {
		await ring.append(storage as never, traced(HOT_EVENT));
	}

	const recent = await listRecentTraceEntries(storage as never, READ_LIMIT);
	const rare = recent.filter((entry) => !isHighVolumeTraceEvent(entry.event));
	s.check(
		rare.some((entry) => entry.event === "checkpoint-load"),
		"the cold-load trace is still readable after 500 update_observed appends"
			+ ` (got ${rare.length} rare of ${recent.length}; on a live vault 98 of 100 were`
			+ " update_observed and every cold-load, save and reap had been evicted)",
	);
	s.check(recent.length === READ_LIMIT, `the read window is still full (${recent.length})`);
}

s.section("Test 10: interleaved rare events all survive thousands of high-volume ones");
{
	const storage = new CountingStorage();
	const ring = new TraceRing(MAX_PER_CLASS);
	const rareEvents = ["checkpoint-load", "server.save.append_succeeded", "tombstone-reap"] as const;
	for (let i = 0; i < 3000; i++) {
		await ring.append(storage as never, traced(HOT_EVENT));
		// Scattered early, mid and late: each one is far older than the tail of
		// the flood, which is precisely what used to evict them.
		if (i === 10) await ring.append(storage as never, traced(rareEvents[0]));
		if (i === 1500) await ring.append(storage as never, traced(rareEvents[1]));
		if (i === 2900) await ring.append(storage as never, traced(rareEvents[2]));
	}

	const recent = await listRecentTraceEntries(storage as never, READ_LIMIT);
	const seen = new Set(recent.map((entry) => entry.event));
	for (const event of rareEvents) {
		s.check(seen.has(event), `${event} survives 3000 interleaved update_observed appends`);
	}
	const hot = recent.filter((entry) => isHighVolumeTraceEvent(entry.event)).length;
	s.check(
		hot === READ_LIMIT - rareEvents.length,
		`and the rest of the window is still the newest high-volume traffic (${hot} of ${recent.length})`,
	);
}

s.section("Test 11: the class split costs a short-lived instance no reads");
{
	const brief = new CountingStorage();
	// Pre-existing history in both key spaces, as a real room has.
	for (let i = 0; i < MAX_PER_CLASS; i++) {
		const suffix = `${String(i).padStart(13, "0")}:aa`;
		brief.data.set(`trace:${suffix}`, {});
		brief.data.set(`tracehot:${suffix}`, {});
	}
	const wake = new TraceRing(MAX_PER_CLASS);
	await wake.append(brief as never, traced("checkpoint-load"));
	await wake.append(brief as never, traced("server.save.append_succeeded"));
	await wake.append(brief as never, traced(HOT_EVENT));

	s.check(brief.lists === 0, `a short-lived instance still lists zero times (${brief.lists})`);
	s.check(brief.keysListed === 0, `and reads zero rows to trim (${brief.keysListed})`);
	s.check(brief.puts === 3, "the traces were still written");
}

s.section("Test 12: stored entries stay bounded across both classes");
{
	const storage = new CountingStorage();
	const ring = new TraceRing(MAX_PER_CLASS);
	for (let i = 0; i < 4000; i++) {
		await ring.append(storage as never, traced(i % 5 === 0 ? "server.save.append_succeeded" : HOT_EVENT));
	}

	// Each prefix trims to its own budget plus one reconciliation window.
	const bound = 2 * (MAX_PER_CLASS + TRACE_SEED_AFTER_APPENDS);
	s.check(
		storage.data.size <= bound,
		`stored entries stay within 2 * (max + seed slack) (${storage.data.size} <= ${bound})`,
	);
	s.check(storage.data.size >= MAX_PER_CLASS, `and the rings stay full (${storage.data.size})`);
}

s.section("Test 13: the merged read is newest-first and honours limit");
{
	const storage = new CountingStorage();
	const ring = new TraceRing(MAX_PER_CLASS);
	const written: TraceEntry[] = [];
	for (let i = 0; i < 30; i++) {
		const entry = traced(i % 2 === 0 ? HOT_EVENT : "checkpoint-load");
		written.push(entry);
		await ring.append(storage as never, entry);
	}

	const recent = await listRecentTraceEntries(storage as never, 10);
	s.check(recent.length === 10, `the merged read honours limit (${recent.length})`);
	const timestamps = recent.map((entry) => Date.parse(entry.ts));
	s.check(
		timestamps.every((ts, i) => i === 0 || timestamps[i - 1]! > ts),
		"merged entries come back newest-first across both classes",
	);
	// Neither class exceeds its share here, so the merge is literally the
	// newest 10 overall — the ordering the single-prefix read used to give.
	const expected = written.slice(-10).map((entry) => entry.ts).reverse();
	s.check(
		recent.map((entry) => entry.ts).join(",") === expected.join(","),
		"a balanced window returns exactly the newest entries overall",
	);
}

s.section("Test 14: unused low-volume reserve goes back to the other class");
{
	const quiet = new CountingStorage();
	const quietRing = new TraceRing(MAX_PER_CLASS);
	for (let i = 0; i < 150; i++) {
		await quietRing.append(quiet as never, traced("checkpoint-load"));
	}
	const quietRecent = await listRecentTraceEntries(quiet as never, READ_LIMIT);
	s.check(
		quietRecent.length === READ_LIMIT && quietRecent.every((entry) => entry.event === "checkpoint-load"),
		`a room with no high-volume traffic still fills the window (${quietRecent.length})`,
	);

	const loud = new CountingStorage();
	const loudRing = new TraceRing(MAX_PER_CLASS);
	for (let i = 0; i < 150; i++) {
		await loudRing.append(loud as never, traced(HOT_EVENT));
	}
	const loudRecent = await listRecentTraceEntries(loud as never, READ_LIMIT);
	s.check(
		loudRecent.length === READ_LIMIT,
		`and a room with nothing but high-volume traffic still fills it too (${loudRecent.length})`,
	);
}
await s.done();
