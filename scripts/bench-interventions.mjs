/**
 * bench-interventions.mjs — absolute memory cost of each rope remedy.
 *
 * Yjs merges adjacent inserts with `this.str += right.str` (v13
 * src/structs/ContentString.js, v14 src/structs/Item.js). V8 answers that with
 * a cons-string node rather than a flat string, and nothing ever flattens it,
 * so a warm document costs many times a freshly decoded one holding identical
 * state. There are three places to intervene, and this measures all of them on
 * the same documents:
 *
 *   remat     application layer, what YAOS ships. Encode the document's own
 *             state and decode it into a fresh Y.Doc. Lossless: byte-identical
 *             encoding, IDs, clocks and delete set all preserved.
 *   flatten   application layer, no Yjs change. Walk every ContentString and
 *             replace `str` with a forcibly-flat copy. Depends on V8 internals.
 *   upstream  library change. Patch mergeWith to flatten after concatenating,
 *             so ropes never form. Nothing to run later.
 *
 * WHY PEAK IS THE HEADLINE, NOT THE STEADY STATE
 *
 * A Durable Object has 128 MB. `remat` transiently holds the old document, the
 * encoded update AND the new document simultaneously, so the interesting
 * question is not what it settles at but whether the settling fits. A remedy
 * that spikes past the budget OOMs the object it was meant to rescue.
 *
 * Every figure is heapUsed + arrayBuffers, net of an empty-process watermark,
 * collected to convergence. Each (size x variant) pair runs in its own process
 * so nothing leaks between measurements, and the source text is released before
 * measuring so no variant is credited for sharing strings with the corpus.
 *
 * Usage:
 *   node --expose-gc scripts/bench-interventions.mjs
 *   node --expose-gc scripts/bench-interventions.mjs --json
 *   node --expose-gc scripts/bench-interventions.mjs --sizes 250000,1000000
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = dirname(dirname(SELF));
const STOCK_YJS = join(REPO, "node_modules", "yjs", "dist", "yjs.mjs");

const DEFAULT_SIZES = [250_000, 500_000, 1_000_000, 2_000_000];
const VARIANTS = ["warm", "encode", "remat", "flatten", "upstream"];

// ---------------------------------------------------------------------------
// The upstream patch, built once into a temp copy of yjs
// ---------------------------------------------------------------------------

/** The exact source form of the merge in the shipped dist builds. */
const MERGE_SOURCE = "mergeWith (right) {\n    this.str += right.str;\n    return true\n  }";

/**
 * Flatten after concatenating.
 *
 * `(' ' + s).slice(1)` is the cheapest way to force V8 to materialise a flat
 * sequential string; a plain assignment keeps the rope. Guarded by a length
 * floor so short merges do not pay for a copy they do not need.
 */
const MERGE_PATCHED = "mergeWith (right) {\n"
	+ "    const s = this.str + right.str;\n"
	+ "    this.str = s.length > 512 ? (' ' + s).slice(1) : s;\n"
	+ "    return true\n  }";

function buildPatchedYjs() {
	const root = mkdtempSync(join(tmpdir(), "yaos-bench-yjs-"));
	// The patched copy must resolve lib0, so it lives inside a node_modules
	// directory alongside a link to the real one.
	const modules = join(root, "node_modules");
	const target = join(modules, "yjs-flat");
	cpSync(join(REPO, "node_modules", "yjs"), target, { recursive: true });
	cpSync(join(REPO, "node_modules", "lib0"), join(modules, "lib0"), { recursive: true });

	let patched = 0;
	for (const file of ["dist/yjs.cjs", "dist/yjs.mjs"]) {
		const path = join(target, file);
		const source = readFileSync(path, "utf8");
		if (!source.includes(MERGE_SOURCE)) continue;
		writeFileSync(path, source.replaceAll(MERGE_SOURCE, MERGE_PATCHED));
		patched++;
	}
	if (patched === 0) {
		rmSync(root, { recursive: true, force: true });
		throw new Error(
			"could not patch yjs: ContentString.mergeWith did not match the expected "
			+ "source. The dist build changed; update MERGE_SOURCE.",
		);
	}
	return { root, entry: join(target, "dist", "yjs.mjs") };
}

// ---------------------------------------------------------------------------
// Child: one size, one variant, clean process
// ---------------------------------------------------------------------------

function liveBytes() {
	const m = process.memoryUsage();
	return m.heapUsed + m.arrayBuffers;
}

/** Collect until the measured figure stops shrinking; a fixed count under-reports. */
function settle(minPasses = 5, maxPasses = 24) {
	let previous = Infinity;
	for (let pass = 0; pass < maxPasses; pass++) {
		global.gc();
		const current = liveBytes();
		if (pass + 1 >= minPasses && current >= previous) return;
		previous = current;
	}
}

function census(Y, doc) {
	let structs = 0;
	let items = 0;
	let ropeStrings = 0;
	for (const list of doc.store.clients.values()) {
		structs += list.length;
		for (const struct of list) {
			if (struct instanceof Y.Item) {
				items++;
				const content = struct.content;
				if (content && typeof content.str === "string") ropeStrings++;
			}
		}
	}
	return { structs, items, ropeStrings };
}

async function runChild(spec) {
	const Y = await import(pathToFileURL(spec.yjs).href);
	const chars = spec.chars;

	settle();
	const baseline = liveBytes();

	// Build the warm document the way an editing session does: one insert per
	// transaction, which is what a keystroke produces through the CM6 binding.
	const doc = new Y.Doc();
	const map = doc.getMap("idToText");
	const NOTE_CHARS = 40_000;
	const notes = Math.max(1, Math.round(chars / NOTE_CHARS));
	for (let n = 0; n < notes; n++) {
		const text = new Y.Text();
		map.set(`n${n}`, text);
		for (let i = 0; i < NOTE_CHARS; i++) text.insert(text.length, "x");
	}

	settle();
	const warm = liveBytes() - baseline;
	const before = census(Y, doc);

	const started = performance.now();
	let peak = warm;
	let after = warm;
	let live = doc;

	if (spec.variant === "encode") {
		// Encoding reads every ContentString, which forces V8 to materialise a
		// flat string and leaves the item holding the flattened one.  The whole
		// remedy is a side effect, and the save path already pays for it.
		let encoded = Y.encodeStateAsUpdate(doc);
		settle();
		peak = Math.max(warm, liveBytes() - baseline);
		// Drop the update: it is a transient of the encode, not a residue of the
		// remedy, and keeping it would charge this variant for the buffer.
		void encoded.byteLength;
		encoded = undefined;
		settle();
		after = liveBytes() - baseline;
	} else if (spec.variant === "remat") {
		// The sequence a re-materialising swap would run, and its peak: old
		// document + encoded update + new document all resident at once.  The
		// server has no such method; this bench is why.
		const encoded = Y.encodeStateAsUpdate(doc);
		settle();
		const withUpdate = liveBytes() - baseline;
		const fresh = new Y.Doc();
		Y.applyUpdate(fresh, encoded);
		settle();
		peak = Math.max(warm, withUpdate, liveBytes() - baseline);
		doc.destroy();
		live = fresh;
		settle();
		after = liveBytes() - baseline;
	} else if (spec.variant === "flatten") {
		// In-place: no second document, so the peak is one flat copy of the
		// largest string on top of the rope it replaces.
		for (const list of doc.store.clients.values()) {
			for (const struct of list) {
				const content = struct.content;
				if (content && typeof content.str === "string") {
					content.str = (" " + content.str).slice(1);
				}
			}
		}
		settle();
		peak = Math.max(warm, liveBytes() - baseline);
		after = liveBytes() - baseline;
	}
	// "warm" measures the untreated document; "upstream" already grew flat, so
	// for both the intervention is a no-op and after === warm.

	const elapsedMs = performance.now() - started;

	// Correctness gate. A remedy that loses a character is not a remedy, and
	// the flatten path in particular rewrites live strings underneath Yjs.
	let totalChars = 0;
	let intact = true;
	for (const [, text] of live.getMap("idToText")) {
		const value = text.toString();
		totalChars += value.length;
		if (value.length !== NOTE_CHARS || /[^x]/.test(value)) intact = false;
	}
	// Measured last: encoding mutates string representation, so doing it any
	// earlier would flatten the document being measured.
	const finalEncoded = Y.encodeStateAsUpdate(live).byteLength;

	process.stdout.write(JSON.stringify({
		variant: spec.variant,
		chars: totalChars,
		notes,
		warmBytes: warm,
		peakBytes: peak,
		afterBytes: after,
		bytesPerCharWarm: warm / totalChars,
		bytesPerCharAfter: after / totalChars,
		reclaimedPct: warm > 0 ? 100 * (1 - after / warm) : 0,
		structs: before.structs,
		ropeStrings: before.ropeStrings,
		encodedBytes: finalEncoded,
		elapsedMs,
		intact,
	}) + "\n");
}

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

function chart(rows, sizes, pick, label, unit) {
	const width = 42;
	const max = Math.max(...rows.map((r) => pick(r)));
	console.log(`\n${label}`);
	for (const size of sizes) {
		console.log(`  ${(size / 1_000_000).toFixed(2)}M chars`);
		for (const variant of VARIANTS) {
			const row = rows.find((r) => r.chars >= size * 0.9 && r.chars <= size * 1.1 && r.variant === variant);
			if (!row) continue;
			const value = pick(row);
			const bar = "#".repeat(Math.max(0, Math.round((value / max) * width)));
			console.log(`    ${variant.padEnd(9)}${bar.padEnd(width)} ${value.toFixed(unit === "MiB" ? 1 : 2)} ${unit}`);
		}
	}
}

function main(argv) {
	const asJson = argv.includes("--json");
	const sizeArg = argv.indexOf("--sizes");
	const sizes = sizeArg >= 0
		? argv[sizeArg + 1].split(",").map((s) => Number(s.trim()))
		: DEFAULT_SIZES;

	const patched = buildPatchedYjs();
	const rows = [];
	try {
		for (const chars of sizes) {
			for (const variant of VARIANTS) {
				const spec = {
					chars,
					variant,
					yjs: variant === "upstream" ? patched.entry : STOCK_YJS,
				};
				const child = spawnSync(
					process.execPath,
					["--expose-gc", "--max-old-space-size=4096", SELF, "--child", JSON.stringify(spec)],
					{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 900_000 },
				);
				if (child.status !== 0) {
					console.error(`FAILED ${chars}/${variant}: ${(child.stderr || "").slice(0, 300)}`);
					continue;
				}
				const line = child.stdout.trim().split("\n").filter(Boolean).pop();
				rows.push(JSON.parse(line));
			}
		}
	} finally {
		rmSync(patched.root, { recursive: true, force: true });
	}

	if (asJson) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}

	const head = "chars".padEnd(9) + "variant".padEnd(10)
		+ "warm".padStart(9) + "peak".padStart(9) + "after".padStart(9)
		+ "B/char".padStart(9) + "saved".padStart(8)
		+ "structs".padStart(9) + "ms".padStart(8) + "  ok";
	console.log("\n" + head);
	console.log("-".repeat(head.length));
	const mib = (b) => (b / 1048576).toFixed(1);
	for (const r of rows) {
		console.log(
			`${(r.chars / 1_000_000).toFixed(2)}M`.padEnd(9)
			+ r.variant.padEnd(10)
			+ mib(r.warmBytes).padStart(9)
			+ mib(r.peakBytes).padStart(9)
			+ mib(r.afterBytes).padStart(9)
			+ r.bytesPerCharAfter.toFixed(2).padStart(9)
			+ (r.reclaimedPct.toFixed(0) + "%").padStart(8)
			+ r.structs.toLocaleString().padStart(9)
			+ r.elapsedMs.toFixed(0).padStart(8)
			+ `  ${r.intact ? "yes" : "NO"}`,
		);
	}
	console.log("\nwarm/peak/after in MiB. saved = warm -> after. ok = text verified intact.");

	chart(rows, sizes, (r) => r.afterBytes / 1048576, "Resident after the remedy (MiB)", "MiB");
	chart(rows, sizes, (r) => r.peakBytes / 1048576, "Peak DURING the remedy (MiB) — this is what must fit in 128", "MiB");
}

const childIndex = process.argv.indexOf("--child");
if (childIndex >= 0) {
	if (typeof global.gc !== "function") {
		process.stdout.write(JSON.stringify({ error: "needs --expose-gc" }) + "\n");
		process.exit(1);
	}
	await runChild(JSON.parse(process.argv[childIndex + 1]));
} else if (typeof global.gc !== "function") {
	console.error("bench-interventions: run with `node --expose-gc scripts/bench-interventions.mjs`");
	process.exit(1);
} else {
	main(process.argv.slice(2));
}
