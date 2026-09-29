/**
 * bench-memory.js — CRDT memory footprint benchmark.
 *
 * Answers one question: for a given amount of markdown, how much RAM does the
 * Y.Doc actually cost, and WHERE does that cost live?
 *
 * There are two distinct memory regimes and they have different remedies:
 *
 *   1. Cons-string bloat.  Yjs merges adjacent ContentString items with
 *      `str += str`.  Under fine-grained sequential editing that runs millions
 *      of times and V8 accumulates a deep rope of cons-string nodes it will not
 *      flatten until forced.  Item count stays flat; memory explodes.
 *      REMEDY: re-materialisation (decode into a fresh doc) rebuilds flat
 *      strings.
 *
 *   2. Item fragmentation.  Non-sequential edits (cursor jumps, interleaved
 *      remote clients) produce items whose clocks are not consecutive, so Yjs
 *      cannot merge them.  Struct count explodes and stays exploded.
 *      REMEDY: none cheap — re-materialisation does not merge them.
 *
 * The two discriminating metrics are printed for every scenario:
 *
 *   bytesPerStruct  high (~10^4) => few large items  => regime 1
 *                   low  (~10^1) => many small items => regime 2
 *   itemsPerKB      how many live structs each KB of text costs
 *
 * Each scenario runs in its OWN child process, and the source corpus is
 * released before measuring, so the reported figure is memory attributable to
 * the Y.Doc alone with no cross-scenario GC contamination.
 *
 * Usage:
 *   node --expose-gc scripts/bench-memory.js
 *   node --expose-gc scripts/bench-memory.js --vault ~/garden
 *   node --expose-gc scripts/bench-memory.js --json
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as Y from "yjs";

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Deterministic PRNG so every run is byte-identical. */
function makeRandom(seed) {
	let s = seed >>> 0;
	return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
}

function collectMarkdown(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectMarkdown(full, out);
		else if (entry.name.endsWith(".md")) out.push(readFileSync(full, "utf8"));
	}
	return out;
}

/**
 * Replace every surrogate code unit with a BMP character, preserving length.
 *
 * Y.Text indices address UTF-16 code units, so a randomly chosen edit boundary
 * can fall between the halves of a surrogate pair.  The resulting lone
 * surrogate cannot be represented in the UTF-8 payload of a Yjs update and
 * decodes back as U+FFFD -- a corruption manufactured by the benchmark, not by
 * the code under test.  Substituting BMP characters removes the confound while
 * leaving character counts, item counts and memory behaviour unchanged.
 */
function sanitiseCorpus(files) {
	return files.map((text) => text.replace(/[\uD800-\uDFFF]/g, "x"));
}

/**
 * Synthetic corpus shaped like a real vault: many small notes, a few large
 * ones. Deterministic, so results are comparable across machines.
 */
function syntheticCorpus(fileCount, targetChars) {
	const rnd = makeRandom(0x5eed);
	const words = [
		"the", "vault", "sync", "note", "yjs", "crdt", "durable", "object",
		"memory", "chunk", "journal", "checkpoint", "attachment", "obsidian",
	];
	const files = [];
	let produced = 0;
	for (let i = 0; i < fileCount && produced < targetChars; i++) {
		// Long tail: most notes small, a few big.
		const size = Math.floor(200 + Math.pow(rnd(), 3) * 60_000);
		let text = `# Note ${i}\n\n`;
		while (text.length < size) {
			const line = [];
			const n = 6 + Math.floor(rnd() * 12);
			for (let w = 0; w < n; w++) line.push(words[Math.floor(rnd() * words.length)]);
			text += line.join(" ") + "\n";
		}
		files.push(text);
		produced += text.length;
	}
	return files;
}

// ---------------------------------------------------------------------------
// Doc construction strategies
// ---------------------------------------------------------------------------

/**
 * Build a Y.Doc from `files` under a given editing pattern.
 *
 * @param {string[]} files
 * @param {{mode: string, run?: number, scatter?: number, clients?: number, deleteRatio?: number}} opts
 */
function buildDoc(files, opts) {
	const doc = new Y.Doc();
	const map = doc.getMap("idToText");
	const rnd = makeRandom(0xbeef);

	// Multi-device editing produces items authored by DIFFERENT clientIDs
	// interleaved through the same text.  Yjs can only merge adjacent items
	// from the same client with consecutive clocks, so this is what actually
	// drives fragmentation in the field.
	//
	// Simulating it by syncing N real docs is O(n^2) in document size and takes
	// hours on a multi-MB corpus.  Cycling `doc.clientID` between runs produces
	// the identical item structure at linear cost, which is what we measure.
	if (opts.mode === "multiclient") {
		const clients = opts.clients ?? 3;
		const run = opts.run ?? 8;
		// How much text one device contributes before another takes over.
		// 8 = pathological (every keystroke alternates devices); a few thousand
		// = one editing session per device, which is what really happens.
		const switchEvery = opts.switchEvery ?? run;
		const originalClientId = doc.clientID;
		let written = 0;
		for (let i = 0; i < files.length; i++) {
			const text = new Y.Text();
			map.set(`f${i}`, text);
			const source = files[i];
			for (let offset = 0; offset < source.length; offset += run) {
				doc.clientID = originalClientId
					+ (Math.floor(written / switchEvery) % clients);
				text.insert(text.length, source.slice(offset, offset + run));
				written += run;
			}
		}
		doc.clientID = originalClientId;
		return doc;
	}

	// Y.Text indices are UTF-16 code units.  Landing an insert or delete
	// boundary between the two halves of a surrogate pair produces lone
	// surrogates, which cannot survive the UTF-8 encoding inside a Yjs update
	// and come back as U+FFFD.  The corpus is sanitised to the BMP on load
	// (see sanitiseCorpus) so no random boundary can manufacture that
	// corruption here; memory behaviour is unaffected by the substitution.

	for (let i = 0; i < files.length; i++) {
		const text = new Y.Text();
		map.set(`f${i}`, text);
		const source = files[i];

		if (opts.mode === "bulk") {
			text.insert(0, source);
			continue;
		}

		const run = opts.run ?? 8;
		const scatter = opts.scatter ?? 0;
		for (let offset = 0; offset < source.length; offset += run) {
			const chunk = source.slice(offset, offset + run);
			const position = scatter > 0 && rnd() < scatter
				? Math.floor(rnd() * text.length)
				: text.length;
			text.insert(position, chunk);
		}

		if (opts.deleteRatio) {
			// Delete scattered spans to generate tombstones / GC structs.
			const deletions = Math.floor((text.length * opts.deleteRatio) / 32);
			for (let d = 0; d < deletions && text.length > 64; d++) {
				const at = Math.floor(rnd() * (text.length - 32));
				text.delete(at, 32);
			}
		}
	}
	return doc;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function census(doc) {
	let structs = 0, items = 0, gcs = 0, deleted = 0, contentChars = 0;
	for (const [, structList] of doc.store.clients) {
		structs += structList.length;
		for (const s of structList) {
			if (s.constructor.name === "GC") { gcs++; continue; }
			items++;
			if (s.deleted) deleted++;
			else contentChars += s.length;
		}
	}
	return { clients: doc.store.clients.size, structs, items, gcs, deleted, contentChars };
}

function liveBytes() {
	const m = process.memoryUsage();
	return m.heapUsed + m.arrayBuffers;
}

/**
 * Collect until the heap stops shrinking.
 *
 * Two passes is not enough, and the shortfall is the same order as the effects
 * this benchmark exists to measure.  After a multi-megabyte allocation burst
 * V8 needs several sweeps to converge, and external ArrayBuffer memory is
 * released at least one pass behind the JS heap — so a freed 1.6MB document
 * can still read as ~1.9MB resident.  That is large enough to invent a
 * reclamation that did not happen, or erase one that did.
 */
function settle(minPasses = 5, maxPasses = 24) {
	let previous = Infinity;
	for (let pass = 0; pass < maxPasses; pass++) {
		global.gc();
		const current = liveBytes();
		if (pass + 1 >= minPasses && current >= previous) return;
		previous = current;
	}
}

// ---------------------------------------------------------------------------
// Child: run exactly ONE phase of one scenario in a clean process.
//
// Phases are separate processes on purpose.  Measuring the re-materialised doc
// in the same process as the original cannot work: destroying a multi-hundred-
// megabyte object graph does not reliably return the pages within two GC
// passes, so the "after" figure silently includes the "before" one.  The build
// phase hands off only the encoded update on disk — the one artefact that is
// supposed to survive — and the remat phase starts from a clean heap.
// ---------------------------------------------------------------------------

function textDigest(doc) {
	// Cheap order-sensitive fingerprint; enough to prove the round trip did not
	// alter content, without shipping megabytes between processes.
	const map = doc.getMap("idToText");
	let hash = 0x811c9dc5;
	let chars = 0;
	for (const key of [...map.keys()].sort()) {
		const value = map.get(key).toString();
		chars += value.length;
		for (let i = 0; i < value.length; i++) {
			hash ^= value.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
	}
	return { digest: hash.toString(16), chars, keys: map.size };
}

function runChild(spec) {
	if (typeof global.gc !== "function") {
		process.stdout.write(JSON.stringify({ error: "needs --expose-gc" }) + "\n");
		process.exit(1);
	}

	// Empty-process watermark: everything below is reported net of this, so the
	// figures are Y.Doc cost rather than "Node started up".
	settle();
	const processBaseline = liveBytes();

	if (spec.phase === "remat") {
		let encoded = new Uint8Array(readFileSync(spec.updateFile));
		const doc = new Y.Doc();
		Y.applyUpdate(doc, encoded);
		encoded = null;
		settle();
		const memBytes = liveBytes() - processBaseline;
		const c = census(doc);
		const fingerprint = textDigest(doc);
		process.stdout.write(JSON.stringify({
			phase: "remat", memBytes, structs: c.structs, items: c.items, ...fingerprint,
		}) + "\n");
		return;
	}

	let files = sanitiseCorpus(spec.vault
		? collectMarkdown(spec.vault)
		: syntheticCorpus(spec.fileCount, spec.targetChars));

	const textChars = files.reduce((sum, f) => sum + f.length, 0);

	const doc = buildDoc(files, spec.opts);

	// Release the corpus so the measurement reflects the Y.Doc alone and never
	// credits a scenario for sharing string objects with the source array.
	files = null;
	settle();
	const memBytes = liveBytes() - processBaseline;

	const before = census(doc);
	const encoded = Y.encodeStateAsUpdate(doc);
	writeFileSync(spec.updateFile, encoded);
	const fingerprint = textDigest(doc);

	const kb = textChars / 1024;
	process.stdout.write(JSON.stringify({
		phase: "build",
		label: spec.label,
		textChars,
		encodedBytes: encoded.byteLength,
		structs: before.structs,
		items: before.items,
		gcs: before.gcs,
		deleted: before.deleted,
		clients: before.clients,
		itemsPerKB: before.items / kb,
		bytesPerStruct: encoded.byteLength / before.structs,
		memBytes,
		bytesPerChar: memBytes / textChars,
		memOverEncoded: memBytes / encoded.byteLength,
		...fingerprint,
	}) + "\n");
}

// ---------------------------------------------------------------------------
// Parent: orchestrate scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = [
	{ label: "bulk (floor)",        opts: { mode: "bulk" } },
	{ label: "sequential run=64",   opts: { mode: "seq", run: 64 } },
	{ label: "sequential run=8",    opts: { mode: "seq", run: 8 } },
	{ label: "sequential run=1",    opts: { mode: "seq", run: 1 } },
	{ label: "scattered p=0.05",    opts: { mode: "seq", run: 8, scatter: 0.05 } },
	{ label: "scattered p=0.20",    opts: { mode: "seq", run: 8, scatter: 0.20 } },
	{ label: "delete-heavy 30%",    opts: { mode: "seq", run: 8, deleteRatio: 0.3 } },
	{ label: "3dev alternating",    opts: { mode: "multiclient", clients: 3, run: 8, switchEvery: 8 } },
	{ label: "3dev per-paragraph",  opts: { mode: "multiclient", clients: 3, run: 8, switchEvery: 400 } },
	{ label: "3dev per-session",    opts: { mode: "multiclient", clients: 3, run: 8, switchEvery: 20000 } },
];

function runParent(argv) {
	const vaultFlag = argv.indexOf("--vault");
	const vault = vaultFlag >= 0 ? argv[vaultFlag + 1] : null;
	const asJson = argv.includes("--json");
	const only = argv.indexOf("--only") >= 0 ? argv[argv.indexOf("--only") + 1] : null;
	const fileCount = 120;
	const targetChars = 3_000_000;

	const scenarios = only
		? SCENARIOS.filter((s) => s.label.includes(only))
		: SCENARIOS;

	const updateFile = join(tmpdir(), `yaos-bench-${process.pid}.bin`);
	const runPhase = (spec) => {
		const child = spawnSync(
			process.execPath,
			["--expose-gc", SELF, "--child", JSON.stringify(spec)],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
		);
		if (child.status !== 0) {
			throw new Error(child.stderr?.slice(0, 500) || `exit ${child.status}`);
		}
		const line = child.stdout.trim().split("\n").filter(Boolean).pop();
		return JSON.parse(line);
	};

	const results = [];
	for (const scenario of scenarios) {
		const base = { ...scenario, vault, fileCount, targetChars, updateFile };
		try {
			const build = runPhase({ ...base, phase: "build" });
			const remat = runPhase({ ...base, phase: "remat" });
			results.push({
				...build,
				rematBytes: remat.memBytes,
				rematStructs: remat.structs,
				rematSavedPct: build.memBytes > 0 ? 100 * (1 - remat.memBytes / build.memBytes) : 0,
				contentPreserved: build.digest === remat.digest
					&& build.chars === remat.chars
					&& build.keys === remat.keys,
			});
		} catch (err) {
			console.error(`FAILED ${scenario.label}: ${err.message}`);
		}
	}
	try { rmSync(updateFile, { force: true }); } catch { /* best effort */ }

	if (asJson) {
		console.log(JSON.stringify(results, null, 2));
		return results;
	}

	const corpus = results[0];
	console.log(`\ncorpus: ${corpus.textChars.toLocaleString()} chars (${(corpus.textChars / 1024 / 1024).toFixed(2)} MB)` +
		(vault ? `  from ${vault}` : "  synthetic"));
	console.log("");
	const head =
		"scenario".padEnd(20) +
		"structs".padStart(10) +
		"items/KB".padStart(10) +
		"B/struct".padStart(10) +
		"encKB".padStart(8) +
		"memMiB".padStart(9) +
		"B/char".padStart(8) +
		"remat".padStart(9) +
		"saved".padStart(8) +
		"reStructs".padStart(11);
	console.log(head);
	console.log("-".repeat(head.length));
	for (const r of results) {
		console.log(
			r.label.padEnd(20) +
			r.structs.toLocaleString().padStart(10) +
			r.itemsPerKB.toFixed(1).padStart(10) +
			r.bytesPerStruct.toFixed(0).padStart(10) +
			(r.encodedBytes / 1024).toFixed(0).padStart(8) +
			(r.memBytes / 1048576).toFixed(1).padStart(9) +
			r.bytesPerChar.toFixed(1).padStart(8) +
			(r.rematBytes / 1048576).toFixed(1).padStart(9) +
			(r.rematSavedPct.toFixed(0) + "%").padStart(8) +
			r.rematStructs.toLocaleString().padStart(11),
		);
	}
	const broken = results.filter((r) => !r.contentPreserved);
	console.log("");
	console.log(broken.length === 0
		? "content preserved through re-materialisation in all scenarios"
		: `CONTENT MISMATCH in: ${broken.map((b) => b.label).join(", ")}`);
	console.log("\nregime guide: B/struct >~1000 => cons-string bound (re-materialisation helps)");
	console.log("              B/struct <~100  => fragmentation bound (it will not)");
	return results;
}

// ---------------------------------------------------------------------------

const childIndex = process.argv.indexOf("--child");
if (childIndex >= 0) {
	runChild(JSON.parse(process.argv[childIndex + 1]));
} else {
	if (typeof global.gc !== "function") {
		console.error("bench-memory: run with `node --expose-gc scripts/bench-memory.js`");
		process.exit(1);
	}
	runParent(process.argv.slice(2));
}
