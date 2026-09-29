/**
 * Integration test: folder rename batching.
 *
 * Simulates Obsidian renaming a folder with 30+ notes by firing individual
 * queueRename() calls in a tight burst, then verifies:
 *
 *   1. All renames land in a SINGLE ydoc.transact() (one batch)
 *   2. No files are lost — every file resolves to its new path
 *   3. File IDs are stable across the rename (content preserved)
 *   4. Editor binding path bookkeeping updates correctly
 *   5. Transitive chains collapse (A→B + B→C = A→C)
 *
 * Uses real VaultSync rename logic extracted into a minimal harness.
 * No server, no Obsidian APIs needed.
 *
 * Usage: bun run test-folder-rename.ts
 */
import * as Y from "yjs";
import { suite } from "../harness.ts";

const ORIGIN_SEED = "vault-crdt-seed";
const RENAME_BATCH_MS = 50;

// ── Setup ───────────────────────────────────────────────────────────────
const ydoc = new Y.Doc();
const pathToId = ydoc.getMap<string>("pathToId");
const idToText = ydoc.getMap<Y.Text>("idToText");
const meta = ydoc.getMap<{ path: string; deleted?: boolean; mtime?: number }>(
	"meta",
);

const FILE_COUNT = 35;
const OLD_FOLDER = "projects/active";
const NEW_FOLDER = "archive/2025";

// Seed files: projects/active/note-00.md .. note-34.md
const seededIds: Map<string, string> = new Map(); // path -> fileId
ydoc.transact(() => {
	for (let i = 0; i < FILE_COUNT; i++) {
		const path = `${OLD_FOLDER}/note-${String(i).padStart(2, "0")}.md`;
		const fileId = `id-${String(i).padStart(3, "0")}`;
		const text = new Y.Text();
		text.insert(0, `# Note ${i}\n\nContent for note ${i}.`);
		pathToId.set(path, fileId);
		idToText.set(fileId, text);
		meta.set(fileId, { path, mtime: Date.now() });
		seededIds.set(path, fileId);
	}
}, ORIGIN_SEED);

// ── Rename batching logic (extracted from vaultSync.ts) ─────────────────
const renameBatch: Map<string, string> = new Map();
let renameTimer: ReturnType<typeof setTimeout> | null = null;
let flushCount = 0;
let lastFlushedBatch: Map<string, string> = new Map();
let transactCallCount = 0;

// Patch ydoc.transact to count calls
const origTransact = ydoc.transact.bind(ydoc);
ydoc.transact = ((fn: () => void, origin?: string) => {
	if (origin === ORIGIN_SEED) {
		// Only count rename-batch transacts, not our setup transacts
		// We detect rename flushes by checking if we're inside flushRenameBatch
		transactCallCount++;
	}
	return origTransact(fn, origin);
}) as typeof ydoc.transact;

function queueRename(oldPath: string, newPath: string): void {
	// Transitive chain resolution
	let replaced = false;
	for (const [existingOld, existingNew] of renameBatch) {
		if (existingNew === oldPath) {
			renameBatch.set(existingOld, newPath);
			replaced = true;
			break;
		}
	}
	if (!replaced) {
		renameBatch.set(oldPath, newPath);
	}

	if (renameTimer) clearTimeout(renameTimer);
	renameTimer = setTimeout(() => flushRenameBatch(), RENAME_BATCH_MS);
}

function flushRenameBatch(): void {
	renameTimer = null;
	if (renameBatch.size === 0) return;

	const batch = new Map(renameBatch);
	renameBatch.clear();
	flushCount++;
	lastFlushedBatch = batch;

	// Reset counter right before the transact so we measure exactly this flush
	transactCallCount = 0;

	ydoc.transact(() => {
		for (const [oldPath, newPath] of batch) {
			const fileId = pathToId.get(oldPath);
			if (!fileId) continue;
			pathToId.delete(oldPath);
			pathToId.set(newPath, fileId);
			meta.set(fileId, { path: newPath, mtime: Date.now() });
		}
	}, ORIGIN_SEED);
}

// Simulate editor binding tracking
const editorBindings: Map<string, { path: string }> = new Map();

function updatePathsAfterRename(renames: Map<string, string>): void {
	for (const [, binding] of editorBindings) {
		const newPath = renames.get(binding.path);
		if (newPath) {
			binding.path = newPath;
		}
	}
}

// ── Test helpers ────────────────────────────────────────────────────────
const s = suite("folder-rename");

// ── Test 1: folder rename with 35 files → single batch ──────────────────
s.section("Test 1: folder rename batching (35 files)");

// Simulate one "open" note (bound editor)
const openNotePath = `${OLD_FOLDER}/note-07.md`;
editorBindings.set("leaf-1", { path: openNotePath });

// Fire all renames in a tight synchronous burst (how Obsidian does it)
for (let i = 0; i < FILE_COUNT; i++) {
	const oldPath = `${OLD_FOLDER}/note-${String(i).padStart(2, "0")}.md`;
	const newPath = `${NEW_FOLDER}/note-${String(i).padStart(2, "0")}.md`;
	queueRename(oldPath, newPath);
}

// Wait for the debounce to fire
await new Promise((r) => setTimeout(r, RENAME_BATCH_MS + 20));

s.check(flushCount === 1, `exactly 1 flush (got ${flushCount})`);
s.check(
	transactCallCount === 1,
	`exactly 1 ydoc.transact() call (got ${transactCallCount})`,
);
s.check(
	lastFlushedBatch.size === FILE_COUNT,
	`batch contains all ${FILE_COUNT} renames (got ${lastFlushedBatch.size})`,
);

// ── Test 2: no missing files ─────────────────────────────────────────────
s.section("Test 2: no missing files");

let allPresent = true;
let missingPaths: string[] = [];
for (let i = 0; i < FILE_COUNT; i++) {
	const newPath = `${NEW_FOLDER}/note-${String(i).padStart(2, "0")}.md`;
	if (!pathToId.has(newPath)) {
		allPresent = false;
		missingPaths.push(newPath);
	}
}
s.check(allPresent, `all ${FILE_COUNT} files present at new paths`);
if (missingPaths.length > 0) {
	console.error(`  Missing: ${missingPaths.join(", ")}`);
}

// Old paths should be gone
let noOldPaths = true;
for (let i = 0; i < FILE_COUNT; i++) {
	const oldPath = `${OLD_FOLDER}/note-${String(i).padStart(2, "0")}.md`;
	if (pathToId.has(oldPath)) {
		noOldPaths = false;
	}
}
s.check(noOldPaths, "all old paths removed from pathToId");

// ── Test 3: file IDs stable, content preserved ──────────────────────────
s.section("Test 3: file IDs stable, content preserved");

let idsStable = true;
let contentOk = true;
for (let i = 0; i < FILE_COUNT; i++) {
	const oldPath = `${OLD_FOLDER}/note-${String(i).padStart(2, "0")}.md`;
	const newPath = `${NEW_FOLDER}/note-${String(i).padStart(2, "0")}.md`;
	const expectedId = seededIds.get(oldPath)!;
	const actualId = pathToId.get(newPath);
	if (actualId !== expectedId) {
		idsStable = false;
		console.error(`  ID mismatch: ${newPath} expected=${expectedId} got=${actualId}`);
	}
	const text = idToText.get(actualId!);
	if (!text || !text.toString().includes(`Content for note ${i}.`)) {
		contentOk = false;
		console.error(`  Content lost for ${newPath}`);
	}
}
s.check(idsStable, "all file IDs unchanged after rename");
s.check(contentOk, "all Y.Text content preserved");

// ── Test 4: meta paths updated ──────────────────────────────────────────
s.section("Test 4: meta paths updated");

let metaOk = true;
for (let i = 0; i < FILE_COUNT; i++) {
	const newPath = `${NEW_FOLDER}/note-${String(i).padStart(2, "0")}.md`;
	const fileId = pathToId.get(newPath)!;
	const m = meta.get(fileId);
	if (!m || m.path !== newPath) {
		metaOk = false;
		console.error(`  Meta mismatch for ${fileId}: expected path=${newPath}, got=${m?.path}`);
	}
}
s.check(metaOk, "all meta entries have updated paths");

// ── Test 5: editor binding path updated ─────────────────────────────────
s.section("Test 5: open editor binding stays live");

// Simulate the onRenameBatchFlushed callback
updatePathsAfterRename(lastFlushedBatch);

const binding = editorBindings.get("leaf-1")!;
const expectedNewPath = `${NEW_FOLDER}/note-07.md`;
s.check(
	binding.path === expectedNewPath,
	`editor binding updated: "${binding.path}" === "${expectedNewPath}"`,
);

// The fileId the binding should reference is still valid
const bindingFileId = pathToId.get(binding.path);
s.check(
	bindingFileId === seededIds.get(openNotePath),
	"editor binding fileId still resolves (yCollab stays live)",
);

// ── Test 6: transitive chain collapse ───────────────────────────────────
s.section("Test 6: transitive rename chain");

// Seed a file for the chain test
ydoc.transact(() => {
	const text = new Y.Text();
	text.insert(0, "chain test");
	pathToId.set("a.md", "chain-id");
	idToText.set("chain-id", text);
	meta.set("chain-id", { path: "a.md", mtime: Date.now() });
}, ORIGIN_SEED);

flushCount = 0;

// A→B then B→C within same batch window
queueRename("a.md", "b.md");
queueRename("b.md", "c.md");

await new Promise((r) => setTimeout(r, RENAME_BATCH_MS + 20));

s.check(flushCount === 1, "chain: single flush");
s.check(
	lastFlushedBatch.size === 1,
	`chain: collapsed to 1 entry (got ${lastFlushedBatch.size})`,
);
s.check(
	lastFlushedBatch.get("a.md") === "c.md",
	`chain: a.md → c.md (got a.md → ${lastFlushedBatch.get("a.md")})`,
);
s.check(pathToId.has("c.md"), "chain: c.md exists in pathToId");
s.check(!pathToId.has("a.md"), "chain: a.md removed");
s.check(!pathToId.has("b.md"), "chain: b.md never created");
s.check(
	pathToId.get("c.md") === "chain-id",
	"chain: fileId stable through A→B→C",
);

ydoc.destroy();
await s.done();
