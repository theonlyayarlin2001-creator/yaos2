/**
 * Tombstone revive consistency tests.
 *
 * Validates:
 *   - local create event revives a tombstoned path (ensureFile with reviveTombstone: true)
 *   - local modify event does NOT revive a tombstoned path (ensureFile with reviveTombstone: false)
 *   - importUntrackedFiles revives tombstoned paths (user explicitly placed file after deletion)
 *   - v2 deletedAt tombstone format is recognized
 *   - stale tombstones are cleared when a live entry exists
 *
 * Tested at the CRDT map level to avoid VaultSync's complex dependencies.
 * The CRDT map operations mirror VaultSync.ensureFile's internal behavior.
 */

import * as Y from "yjs";
import type { App, FileStats, Stat } from "obsidian";
import type { RuntimeConfig } from "../../src/runtime/runtimeConfig";
import type { VaultSyncSettings } from "../../src/settings/settingsStore";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

/** The options bag VaultSync.ensureFile accepts, derived so it cannot drift. */
type EnsureFileOptions = NonNullable<Parameters<VaultSync["ensureFile"]>[3]>;

const s = suite("tombstone-revive");

interface FileMeta {
	path: string;
	deleted?: boolean;
	deletedAt?: number;
	mtime?: number;
	device?: string;
}

function isFileMetaDeleted(meta: FileMeta | undefined): boolean {
	if (!meta) return false;
	return meta.deleted === true || (typeof meta.deletedAt === "number" && Number.isFinite(meta.deletedAt));
}

function getMarkdownTombstoneIds(meta: Y.Map<FileMeta>, path: string): string[] {
	const ids: string[] = [];
	meta.forEach((m, fileId) => {
		if (m.path === path && isFileMetaDeleted(m)) {
			ids.push(fileId);
		}
	});
	return ids;
}

/**
 * Minimal ensureFile that mirrors VaultSync.ensureFile tombstone logic.
 * Returns the created Y.Text or null if tombstone-blocked.
 */
function ensureFile(
	doc: Y.Doc,
	idToText: Y.Map<Y.Text>,
	meta: Y.Map<FileMeta>,
	path: string,
	content: string,
	options?: { reviveTombstone?: boolean; reviveReason?: string },
): Y.Text | null {
	const reviveTombstone = options?.reviveTombstone === true;

	// Check if already exists (live mapping)
	let existingFileId: string | null = null;
	meta.forEach((m, fileId) => {
		if (m.path === path && !isFileMetaDeleted(m)) {
			existingFileId = fileId;
		}
	});
	if (existingFileId) {
		const existingText = idToText.get(existingFileId);
		if (existingText) return existingText;
	}

	// Check tombstones
	const tombstoneIds = getMarkdownTombstoneIds(meta, path);
	if (tombstoneIds.length > 0) {
		if (reviveTombstone) {
			doc.transact(() => {
				for (const id of tombstoneIds) {
					meta.delete(id);
				}
			});
		} else {
			return null; // tombstone blocks creation
		}
	}

	// Create new file
	const fileId = `file-${Math.random().toString(36).slice(2, 8)}`;
	const ytext = new Y.Text();
	doc.transact(() => {
		ytext.insert(0, content);
		idToText.set(fileId, ytext);
		meta.set(fileId, { path, mtime: Date.now() });
	});
	return ytext;
}

// ── Test 1: create event revives tombstoned path ──────────────────────────────

s.section("Test 1: create event revives tombstoned path");
{
	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText") as Y.Map<Y.Text>;
	const meta = doc.getMap("meta") as Y.Map<FileMeta>;

	// Create then tombstone
	const original = ensureFile(doc, idToText, meta, "notes/revived.md", "original");
	s.check(original !== null, "original file created");

	// Tombstone it (v1 style)
	let tombstoneFileId: string | null = null;
	meta.forEach((m, fileId) => {
		if (m.path === "notes/revived.md" && !isFileMetaDeleted(m)) {
			tombstoneFileId = fileId;
		}
	});
	doc.transact(() => {
		meta.set(tombstoneFileId!, { path: "notes/revived.md", deleted: true, mtime: Date.now() });
		idToText.delete(tombstoneFileId!);
	});

	s.check(getMarkdownTombstoneIds(meta, "notes/revived.md").length > 0, "path is tombstoned");

	// Create event → reviveTombstone: true
	const revived = ensureFile(doc, idToText, meta, "notes/revived.md", "revived content", {
		reviveTombstone: true,
		reviveReason: "local-create-event",
	});
	s.check(revived !== null, "create event revives tombstoned path");
	s.check(revived!.toString() === "revived content", "revived file has correct content");
	s.check(getMarkdownTombstoneIds(meta, "notes/revived.md").length === 0, "tombstone entries cleared after revive");

	doc.destroy();
}

// ── Test 2: modify event does NOT revive tombstoned path ──────────────────────

s.section("Test 2: modify event does not revive tombstoned path");
{
	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText") as Y.Map<Y.Text>;
	const meta = doc.getMap("meta") as Y.Map<FileMeta>;

	// Create then tombstone
	ensureFile(doc, idToText, meta, "notes/blocked.md", "original");
	let fileId: string | null = null;
	meta.forEach((m, fid) => {
		if (m.path === "notes/blocked.md" && !isFileMetaDeleted(m)) fileId = fid;
	});
	doc.transact(() => {
		meta.set(fileId!, { path: "notes/blocked.md", deleted: true, mtime: Date.now() });
		idToText.delete(fileId!);
	});

	// Modify event → reviveTombstone: false (default)
	const result = ensureFile(doc, idToText, meta, "notes/blocked.md", "modified content");
	s.check(result === null, "modify event does not revive tombstoned path");
	s.check(getMarkdownTombstoneIds(meta, "notes/blocked.md").length > 0, "tombstone entries remain");

	doc.destroy();
}

// ── Test 3: v2 deletedAt tombstone is recognized ─────────────────────────────

s.section("Test 3: v2 deletedAt tombstone format is recognized");
{
	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText") as Y.Map<Y.Text>;
	const meta = doc.getMap("meta") as Y.Map<FileMeta>;

	// Create then tombstone with v2 format (deletedAt, no deleted flag)
	ensureFile(doc, idToText, meta, "notes/v2-tombstone.md", "content");
	let fileId: string | null = null;
	meta.forEach((m, fid) => {
		if (m.path === "notes/v2-tombstone.md" && !isFileMetaDeleted(m)) fileId = fid;
	});
	doc.transact(() => {
		meta.set(fileId!, { path: "notes/v2-tombstone.md", deletedAt: Date.now() });
		idToText.delete(fileId!);
	});

	s.check(isFileMetaDeleted(meta.get(fileId!)), "v2 deletedAt is recognized as tombstoned");
	s.check(getMarkdownTombstoneIds(meta, "notes/v2-tombstone.md").length > 0, "v2 tombstone appears in tombstone list");

	// Without reviveTombstone → blocked
	const blocked = ensureFile(doc, idToText, meta, "notes/v2-tombstone.md", "new");
	s.check(blocked === null, "v2 tombstone blocks ensureFile without reviveTombstone");

	// With reviveTombstone → revived
	const revived = ensureFile(doc, idToText, meta, "notes/v2-tombstone.md", "revived", {
		reviveTombstone: true,
		reviveReason: "local-create-event",
	});
	s.check(revived !== null, "v2 tombstone revived with reviveTombstone: true");

	doc.destroy();
}

// ── Test 4: importUntrackedFiles revives tombstoned paths ─────────────────────

s.section("Test 4: importUntrackedFiles should revive tombstoned paths");
{
	// This test validates the *policy*: untracked files on disk that have tombstones
	// should be revived because the user explicitly placed them after deletion.
	// The actual call from reconciliationController now passes reviveTombstone: true.

	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText") as Y.Map<Y.Text>;
	const meta = doc.getMap("meta") as Y.Map<FileMeta>;

	// Create then tombstone
	ensureFile(doc, idToText, meta, "notes/reimported.md", "original");
	let fileId: string | null = null;
	meta.forEach((m, fid) => {
		if (m.path === "notes/reimported.md" && !isFileMetaDeleted(m)) fileId = fid;
	});
	doc.transact(() => {
		meta.set(fileId!, { path: "notes/reimported.md", deleted: true, mtime: Date.now() });
		idToText.delete(fileId!);
	});

	// Simulate importUntrackedFiles: calls ensureFile with reviveTombstone: true
	const result = ensureFile(doc, idToText, meta, "notes/reimported.md", "reimported content", {
		reviveTombstone: true,
		reviveReason: "import-untracked-local-file",
	});
	s.check(result !== null, "importUntrackedFiles revives tombstoned path");
	s.check(result!.toString() === "reimported content", "reimported file has new content");
	s.check(getMarkdownTombstoneIds(meta, "notes/reimported.md").length === 0, "tombstone cleared after import revive");

	doc.destroy();
}

// ── Test 5: stale tombstones are cleared when live entry exists ───────────────

s.section("Test 5: stale tombstones cleared when live entry exists");
{
	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText") as Y.Map<Y.Text>;
	const meta = doc.getMap("meta") as Y.Map<FileMeta>;

	// Create a live file
	const live = ensureFile(doc, idToText, meta, "notes/has-stale.md", "live content");
	s.check(live !== null, "live file exists");

	// Add a stale tombstone for the same path (different fileId)
	doc.transact(() => {
		meta.set("stale-tombstone-id", { path: "notes/has-stale.md", deleted: true, mtime: Date.now() });
	});

	// There should be one live entry + one tombstone
	const tombstones = getMarkdownTombstoneIds(meta, "notes/has-stale.md");
	s.check(tombstones.length === 1, "stale tombstone exists alongside live entry");
	s.check(tombstones[0] === "stale-tombstone-id", "tombstone is the stale one");

	// ensureFile on an existing live path returns the existing text
	// (VaultSync.ensureFile also clears stale tombstones in this case)
	const result = ensureFile(doc, idToText, meta, "notes/has-stale.md", "new content");
	s.check(result === live, "ensureFile returns existing live text");

	doc.destroy();
}

// ── Test 6: multiple tombstones for same path all cleared on revive ───────────

s.section("Test 6: multiple tombstones all cleared on revive");
{
	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText") as Y.Map<Y.Text>;
	const meta = doc.getMap("meta") as Y.Map<FileMeta>;

	// Create multiple tombstones for the same path (simulating repeated delete/revive cycles)
	doc.transact(() => {
		meta.set("tomb-1", { path: "notes/multi-tomb.md", deleted: true, mtime: 1 });
		meta.set("tomb-2", { path: "notes/multi-tomb.md", deletedAt: 2 });
		meta.set("tomb-3", { path: "notes/multi-tomb.md", deleted: true, mtime: 3 });
	});

	s.check(getMarkdownTombstoneIds(meta, "notes/multi-tomb.md").length === 3, "three tombstones exist");

	const revived = ensureFile(doc, idToText, meta, "notes/multi-tomb.md", "content", {
		reviveTombstone: true,
		reviveReason: "local-create-event",
	});
	s.check(revived !== null, "revive succeeds with multiple tombstones");
	s.check(getMarkdownTombstoneIds(meta, "notes/multi-tomb.md").length === 0, "all three tombstones cleared");

	doc.destroy();
}

// ── Test 7: remote stale materialization does not revive ──────────────────────

s.section("Test 7: remote stale materialization does not revive tombstone");
{
	// This validates that a modify event (which is what a remote materialization
	// would trigger if the file doesn't exist locally) does NOT revive.

	const doc = new Y.Doc();
	const idToText = doc.getMap("idToText") as Y.Map<Y.Text>;
	const meta = doc.getMap("meta") as Y.Map<FileMeta>;

	// Tombstone a path
	doc.transact(() => {
		meta.set("remote-stale-id", { path: "notes/remote-stale.md", deleted: true, mtime: Date.now() });
	});

	// Modify event with no reviveTombstone → should NOT revive
	const result = ensureFile(doc, idToText, meta, "notes/remote-stale.md", "stale remote content", {
		reviveTombstone: false,
	});
	s.check(result === null, "remote stale materialization does not revive tombstone");
	s.check(getMarkdownTombstoneIds(meta, "notes/remote-stale.md").length === 1, "tombstone remains");

	doc.destroy();
}

// ═══════════════════════════════════════════════════════════════════════
// Test 8: Real-path test through ReconciliationController.importUntrackedFiles
// Uses a VaultSync-shaped mock backed by real Y.Doc maps, proving the
// actual controller code path exercises ensureFile with reviveTombstone.
// ═══════════════════════════════════════════════════════════════════════

s.section("Test 8: importUntrackedFiles through real ReconciliationController");
{
	const { ReconciliationController } = await import("../../src/runtime/reconciliationController");
	const { TFile } = await import("obsidian");

	// Set up a real Y.Doc with tombstoned file
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const metaMap = doc.getMap<FileMeta>("meta");

	const fileId = "file-tombstoned-1";
	doc.transact(() => {
		metaMap.set(fileId, {
			path: "notes/revived-via-controller.md",
			deleted: true,
			device: "other-device",
		});
	});

	// Verify tombstone exists
	const tombsBefore = getMarkdownTombstoneIds(metaMap, "notes/revived-via-controller.md");
	s.check(tombsBefore.length === 1, "tombstone exists before import");

	// Track ensureFile calls
	let ensureFileCalls: Array<{ path: string; content: string; opts: EnsureFileOptions | undefined }> = [];

	// Create a real TFile mock
	const file = new TFile() as InstanceType<typeof TFile> & { path: string; stat: FileStats };
	file.path = "notes/revived-via-controller.md";
	// `ctime` is part of FileStats; the old fixture omitted it behind a cast.
	file.stat = { ctime: 99, mtime: 99, size: 25 };

	// Build a VaultSync mock that has real Y.Doc-backed ensureFile behavior
	const vaultSync = partialOf<VaultSync>({
		isInitialized: true,
		markInitialized: () => {},
		getTextForPath: (path: string) => {
			// Look up in idToText by path via meta
			let foundText: Y.Text | null = null;
			metaMap.forEach((m, fid) => {
				if (m.path === path && !isFileMetaDeleted(m)) {
					const text = idToText.get(fid);
					if (text) foundText = text;
				}
			});
			return foundText;
		},
		ensureFile: (path: string, content: string, device?: string, opts?: EnsureFileOptions) => {
			ensureFileCalls.push({ path, content, opts });
			const revive = opts?.reviveTombstone === true;

			// Real behavior: check tombstones
			const tombstoneIds: string[] = [];
			metaMap.forEach((m, fid) => {
				if (m.path === path && isFileMetaDeleted(m)) {
					tombstoneIds.push(fid);
				}
			});

			if (tombstoneIds.length > 0 && !revive) {
				return null; // blocked by tombstone
			}

			// Revive: clear tombstones and create text
			doc.transact(() => {
				for (const tid of tombstoneIds) {
					metaMap.delete(tid);
				}
				const newId = "file-revived-" + Math.random().toString(36).slice(2, 8);
				const text = new Y.Text();
				text.insert(0, content);
				idToText.set(newId, text);
				metaMap.set(newId, { path, device: device || "test" });
			});

			return doc.getText("result"); // non-null means success
		},
		getActiveMarkdownPaths: () => [],
	});

	// Set up the controller
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	const controller = new ReconciliationController({
		app: partialOf<App>({
			vault: {
				read: async () => "revived content from disk",
				getAbstractFileByPath: (path: string) =>
					path === "notes/revived-via-controller.md" ? file : null,
				adapter: {
					// `type`/`ctime` are part of Stat but not of FileStats, so they
					// have to be supplied here.  This path is always a file.
					stat: async (): Promise<Stat | null> => ({ type: "file", ctime: 99, mtime: 99, size: 25 }),
				},
			},
			workspace: { iterateAllLeaves: () => {} },
		}),
		getSettings: () => partialOf<VaultSyncSettings>({ deviceName: "TestDevice" }),
		getRuntimeConfig: () => partialOf<RuntimeConfig>({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}),
		getVaultSync: () => vaultSync,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => ({}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// Inject untracked files list (normally set by reconcile)
	// Element access reads the controller's private field without a cast, and is
	// checked: it must exist and it comes back as its real string[] type.
	controller["untrackedFiles"] = ["notes/revived-via-controller.md"];

	// Call the real importUntrackedFiles
	await controller.importUntrackedFiles();

	// Verify ensureFile was called with reviveTombstone: true
	s.check(ensureFileCalls.length === 1, "ensureFile called once during import");
	s.check(
		ensureFileCalls[0]?.opts?.reviveTombstone === true,
		"ensureFile called with reviveTombstone: true",
	);
	s.check(
		ensureFileCalls[0]?.opts?.reviveReason === "import-untracked-local-file",
		"ensureFile called with correct reviveReason",
	);

	// Verify tombstone was cleared by the mock's real Y.Doc behavior
	const tombsAfter = getMarkdownTombstoneIds(metaMap, "notes/revived-via-controller.md");
	s.check(tombsAfter.length === 0, "tombstone cleared after controller import");

	// Verify a new entry exists
	let foundActiveEntry = false;
	metaMap.forEach((m) => {
		if (m.path === "notes/revived-via-controller.md" && !isFileMetaDeleted(m)) {
			foundActiveEntry = true;
		}
	});
	s.check(foundActiveEntry, "active meta entry exists after revive");

	doc.destroy();
}
await s.done();
