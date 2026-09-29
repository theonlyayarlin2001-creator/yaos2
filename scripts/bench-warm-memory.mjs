/**
 * bench-warm-memory.js — how much memory a WARM server document accumulates,
 * and how much of that is recoverable.
 *
 * bench-memory.js measures documents built in one process.  This measures the
 * thing the server actually does: cold-load a document from storage, then apply
 * a stream of client update messages to it for hours.  Those are different, and
 * the difference is the whole question.
 *
 * WHY RSS AND NOT heapUsed
 *
 * Content decoded out of a Yjs update lands in V8's `external` memory, not in
 * `heapUsed`.  A 2,000,000-character body shows up as +0.5 MiB of heapUsed and
 * +4 MiB of external.  Measuring `heapUsed + arrayBuffers` therefore reports
 * near-zero for decoded content and silently invalidates the experiment.  RSS
 * captures everything the process actually holds.
 *
 * WHY EACH PHASE IS A SEPARATE PROCESS
 *
 * Destroying a Y.Doc does not return RSS, so measuring "before" and "after" in
 * one process reports the sum, not the difference — which reads as a
 * re-materialisation making memory worse.  Each phase therefore starts from a
 * clean process and receives its input as an encoded update on disk.
 *
 * WHAT IT SHOWS
 *
 * Recovery depends entirely on edit locality, i.e. how many consecutive edits
 * land in the same note before the author moves on:
 *
 *   burst=1    switching note every edit    ~33% recoverable
 *   burst=50   a normal editing burst       ~73% recoverable
 *
 * Yjs merges adjacent same-client inserts, so a burst collapses into one item
 * whose string was built by repeated concatenation — a V8 rope, which
 * re-materialising flattens.  Switching notes constantly produces items that
 * cannot merge, and item fragmentation is not recoverable by any re-encode.
 *
 * At realistic burst lengths the re-materialised document costs the same as a
 * freshly cold-loaded one, which is the floor.
 *
 * Usage:
 *   node --expose-gc scripts/bench-warm-memory.js
 *   node --expose-gc scripts/bench-warm-memory.js --edits 40000 --json
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

const SELF = fileURLToPath(import.meta.url);
const TMP = tmpdir();
const BASE = join(TMP, "yaos-warm-base.bin");
const EDITS = join(TMP, "yaos-warm-edits.bin");
const STATE = join(TMP, "yaos-warm-state.bin");

const NOTE_COUNT = 60;
const NOTE_CHARS = 50_000;

function makeRandom(seed) {
	let s = seed >>> 0;
	return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
}

/**
 * Collect until RSS stops shrinking.
 *
 * A fixed pass count under-reports: V8 needs several sweeps to converge after
 * a multi-megabyte burst, and external ArrayBuffer memory is released a pass
 * behind the JS heap.  With three passes a freed document can still read as
 * ~1.9MB resident — the same order as the growth being measured here.
 */
const settle = (minPasses = 5, maxPasses = 24) => {
	let previous = Infinity;
	for (let pass = 0; pass < maxPasses; pass++) {
		global.gc();
		const current = process.memoryUsage().rss;
		if (pass + 1 >= minPasses && current >= previous) return;
		previous = current;
	}
};
const rss = () => process.memoryUsage().rss;
const mib = (bytes) => Number((bytes / 1048576).toFixed(1));

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** Build the vault a cold load would produce and write its encoded state. */
function phaseBase() {
	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText");
	const rnd = makeRandom(7);
	const words = ["vault", "sync", "note", "crdt", "durable", "object", "memory", "chunk"];
	for (let i = 0; i < NOTE_COUNT; i++) {
		const text = new Y.Text();
		idToText.set(`f${i}`, text);
		let body = "";
		while (body.length < NOTE_CHARS) {
			const n = 6 + Math.floor(rnd() * 10);
			const line = [];
			for (let w = 0; w < n; w++) line.push(words[Math.floor(rnd() * words.length)]);
			body += line.join(" ") + "\n";
		}
		text.insert(0, body);
	}
	writeFileSync(BASE, Y.encodeStateAsUpdate(doc));
	return { baseBytes: Y.encodeStateAsUpdate(doc).byteLength };
}

/**
 * Capture the exact update messages a server would receive.
 *
 * `burst` is how many consecutive edits land in one note before moving on, and
 * it is the variable that decides how much is recoverable.
 */
function phaseEdits(count, burst) {
	const client = new Y.Doc();
	Y.applyUpdate(client, new Uint8Array(readFileSync(BASE)));
	const keys = [...client.getMap("idToText").keys()];
	const rnd = makeRandom(99);
	const chunks = [];
	let pending = null;
	client.on("update", (update) => { pending = update; });

	let current = null;
	let left = 0;
	for (let i = 0; i < count; i++) {
		if (left <= 0) { current = keys[Math.floor(rnd() * keys.length)]; left = burst; }
		left--;
		const text = client.getMap("idToText").get(current);
		client.transact(() => { text.insert(text.length, "word "); });
		if (pending) {
			const header = Buffer.alloc(4);
			header.writeUInt32LE(pending.byteLength);
			chunks.push(header, Buffer.from(pending));
			pending = null;
		}
	}
	writeFileSync(EDITS, Buffer.concat(chunks));
	return { edits: count, burst };
}

/** Cold-load, then apply the update stream, as a warm server does. */
function phaseWarm(limit) {
	settle();
	const base = rss();

	const server = new Y.Doc();
	Y.applyUpdate(server, new Uint8Array(readFileSync(BASE)));
	settle();
	const afterLoad = rss() - base;

	const buf = readFileSync(EDITS);
	let offset = 0;
	let applied = 0;
	while (offset < buf.length && applied < limit) {
		const len = buf.readUInt32LE(offset);
		offset += 4;
		Y.applyUpdate(server, new Uint8Array(buf.subarray(offset, offset + len)));
		offset += len;
		applied++;
	}
	settle();
	const warm = rss() - base;

	// Hand the state to a clean process so re-materialisation is measured
	// without the warm document's unreturned pages inflating the result.
	writeFileSync(STATE, Y.encodeStateAsUpdate(server));
	return {
		applied,
		afterLoadMiB: mib(afterLoad),
		warmMiB: mib(warm),
		encodedMiB: mib(readFileSync(STATE).byteLength),
	};
}

/** What re-materialising costs: the same state, freshly decoded. */
function phaseRemat() {
	settle();
	const base = rss();
	const doc = new Y.Doc();
	Y.applyUpdate(doc, new Uint8Array(readFileSync(STATE)));
	settle();
	return { rematMiB: mib(rss() - base), notes: doc.getMap("idToText").size };
}

// ---------------------------------------------------------------------------

function runChild(spec) {
	if (typeof global.gc !== "function") {
		process.stdout.write(JSON.stringify({ error: "needs --expose-gc" }) + "\n");
		process.exit(1);
	}
	let out;
	if (spec.phase === "base") out = phaseBase();
	else if (spec.phase === "edits") out = phaseEdits(spec.edits, spec.burst);
	else if (spec.phase === "warm") out = phaseWarm(spec.edits);
	else out = phaseRemat();
	process.stdout.write(JSON.stringify(out) + "\n");
}

function child(spec) {
	const proc = spawnSync(
		process.execPath,
		["--expose-gc", SELF, "--child", JSON.stringify(spec)],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
	);
	if (proc.status !== 0) throw new Error(proc.stderr?.slice(0, 400) || `exit ${proc.status}`);
	return JSON.parse(proc.stdout.trim().split("\n").filter(Boolean).pop());
}

function runParent(argv) {
	const flag = (name, fallback) => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? Number(argv[i + 1]) : fallback;
	};
	const edits = flag("edits", 20_000);
	const asJson = argv.includes("--json");

	const { baseBytes } = child({ phase: "base" });
	const results = [];
	for (const burst of [1, 10, 50, 200]) {
		child({ phase: "edits", edits, burst });
		const warm = child({ phase: "warm", edits });
		const remat = child({ phase: "remat" });
		results.push({
			burst,
			...warm,
			...remat,
			recoveredPct: Number((100 * (1 - remat.rematMiB / warm.warmMiB)).toFixed(0)),
		});
	}

	if (asJson) {
		console.log(JSON.stringify({ baseBytes, edits, results }, null, 2));
		return results;
	}

	console.log(`\nvault ${(baseBytes / 1048576).toFixed(2)} MB encoded, ${edits.toLocaleString()} edits applied\n`);
	const head = "burst".padEnd(8) + "coldLoad".padStart(10) + "warm".padStart(9)
		+ "encoded".padStart(9) + "remat".padStart(8) + "recovered".padStart(11);
	console.log(head);
	console.log("-".repeat(head.length));
	for (const r of results) {
		console.log(
			String(r.burst).padEnd(8)
			+ String(r.afterLoadMiB).padStart(10)
			+ String(r.warmMiB).padStart(9)
			+ String(r.encodedMiB).padStart(9)
			+ String(r.rematMiB).padStart(8)
			+ `${r.recoveredPct}%`.padStart(11),
		);
	}
	console.log("\nburst = consecutive edits in one note before switching.");
	console.log("Low burst leaves items that cannot merge; that cost is NOT recoverable.");
	console.log("At realistic bursts, remat returns the document to its cold-load size.");
	for (const f of [BASE, EDITS, STATE]) { try { rmSync(f, { force: true }); } catch { /* best effort */ } }
	return results;
}

const childIndex = process.argv.indexOf("--child");
if (childIndex >= 0) {
	runChild(JSON.parse(process.argv[childIndex + 1]));
} else if (typeof global.gc !== "function") {
	console.error("bench-warm-memory: run with `node --expose-gc scripts/bench-warm-memory.js`");
	process.exit(1);
} else {
	runParent(process.argv.slice(2));
}
