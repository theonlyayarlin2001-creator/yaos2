import * as Y from "yjs";
import { normalizePath } from "obsidian";
import { VaultSync } from "../../src/sync/vaultSync";
import { createNestedActiveMeta, type MetaSemanticChange } from "../../src/sync/fileMeta";
import { suite } from "../harness.ts";

const s = suite("path-index-collision");

// `Object.create(VaultSync.prototype)` gives the real prototype methods without
// the constructor's provider/IndexedDB wiring. The fields go in through a single
// `Object.assign` because most of them are `readonly` (or private) on the class
// and the fixture is deliberately reaching behind that.
function makeVaultSyncFixture(): VaultSync {
	const ydoc = new Y.Doc();
	const vaultSync: VaultSync = Object.assign(Object.create(VaultSync.prototype), {
		ydoc,
		pathToId: ydoc.getMap<string>("pathToId"),
		idToText: ydoc.getMap<Y.Text>("idToText"),
		meta: ydoc.getMap<unknown>("meta"),
		sys: ydoc.getMap<unknown>("sys"),
		pathToBlob: ydoc.getMap("pathToBlob"),
		blobMeta: ydoc.getMap("blobMeta"),
		blobTombstones: ydoc.getMap("blobTombstones"),
		provider: {},
		_pathIndex: new Map<string, string>(),
		_deletedPathIndex: new Set<string>(),
		_pathIndexesDirty: true,
		_metaSnapshot: new Map(),
		_metaSemanticListeners: new Set(),
		_metaObserverFallbackCount: 0,
		_textToFileId: new WeakMap(),
		_eventRing: [],
		debug: false,
	});
	vaultSync.sys.set("schemaVersion", 3);
	return vaultSync;
}

s.section("Path-index collision invalidation");

{
	const vaultSync = makeVaultSyncFixture();
	const path = "notes/collision.md";
	vaultSync.ydoc.transact(() => {
		vaultSync.meta.set("id-a", createNestedActiveMeta(path, 100, "device-a"));
		vaultSync.meta.set("id-b", createNestedActiveMeta(path, 200, "device-b"));
	});

	const invalidate = (changes: readonly MetaSemanticChange[]): void => {
		vaultSync["invalidatePathIndexesForMetaChanges"](changes);
	};

	s.check(vaultSync.getFileId(path) === "id-b", "higher initial mtime wins the collision");
	s.check(
		vaultSync["_pathIndexesDirty"] === false,
		"initial lookup leaves the lazy index clean",
	);

	vaultSync.ydoc.transact(() => {
		(vaultSync.meta.get("id-a") as Y.Map<unknown>).set("mtime", 300);
	});
	invalidate([{ kind: "mtime-changed", fileId: "id-a", path }]);

	s.check(
		vaultSync["_pathIndexesDirty"] === true,
		"mtime-only change dirties an index whose winner depends on mtime",
	);
	s.check(vaultSync.getFileId(path) === "id-a", "next lazy lookup recomputes the new mtime winner");

	vaultSync.ydoc.transact(() => {
		(vaultSync.meta.get("id-a") as Y.Map<unknown>).set("device", "device-a2");
	});
	invalidate([{ kind: "device-changed", fileId: "id-a", path }]);

	s.check(
		vaultSync["_pathIndexesDirty"] === false,
		"device-only change does not dirty the path index",
	);
	s.check(vaultSync.getFileId(normalizePath(path)) === "id-a", "device-only change preserves the current winner");
}
await s.done();
