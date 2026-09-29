import * as Y from "yjs";
import { getMetaDeletedAt, getMetaPath } from "../../src/sync/fileMeta";
import { diffSnapshot, restoreFromSnapshot } from "../../src/sync/snapshotClient";
import { suite } from "../harness.ts";

interface FlatFileMeta {
	path?: string;
	mtime?: number;
	device?: string;
	deletedAt?: number;
	deleted?: boolean;
}

const s = suite("v2-offline-rename-regressions");

function cloneDoc(doc: Y.Doc): Y.Doc {
	const clone = new Y.Doc();
	Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
	return clone;
}

function syncBoth(docA: Y.Doc, docB: Y.Doc): void {
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
	Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
}

function activeMetaPaths(doc: Y.Doc): Map<string, string> {
	const paths = new Map<string, string>();
	const meta = doc.getMap<FlatFileMeta>("meta");
	meta.forEach((entry, fileId) => {
		if (!entry || typeof entry.path !== "string") return;
		if (typeof entry.deletedAt === "number" || entry.deleted === true) return;
		paths.set(entry.path, fileId);
	});
	return paths;
}

s.section("Test 1: v2 concurrent offline rename converges to one active path");
{
	const base = new Y.Doc();
	const sys = base.getMap<number>("sys");
	const idToText = base.getMap<Y.Text>("idToText");
	const meta = base.getMap<FlatFileMeta>("meta");
	const pathToId = base.getMap<string>("pathToId");
	const fileId = "file-1";
	const initialPath = "Projects/Alpha/note.md";

	base.transact(() => {
		sys.set("schemaVersion", 2);
		const text = new Y.Text();
		text.insert(0, "Hello from YAOS");
		idToText.set(fileId, text);
		meta.set(fileId, { path: initialPath, mtime: 1, device: "seed" });
		// Keep legacy map populated to ensure v2 behavior does not depend on it.
		pathToId.set(initialPath, fileId);
	});

	const desktop = cloneDoc(base);
	const mobile = cloneDoc(base);

	const desktopMeta = desktop.getMap<FlatFileMeta>("meta");
	const mobileMeta = mobile.getMap<FlatFileMeta>("meta");

	desktop.transact(() => {
		desktopMeta.set(fileId, { path: "Projects/Beta/note.md", mtime: 2, device: "desktop" });
		desktop.getMap<string>("pathToId").set("Projects/Beta/note.md", fileId);
	});

	mobile.transact(() => {
		mobileMeta.set(fileId, { path: "Projects/Gamma/note.md", mtime: 3, device: "mobile" });
		mobile.getMap<string>("pathToId").set("Projects/Gamma/note.md", fileId);
	});

	syncBoth(desktop, mobile);

	const desktopPath = desktop.getMap<FlatFileMeta>("meta").get(fileId)?.path;
	const mobilePath = mobile.getMap<FlatFileMeta>("meta").get(fileId)?.path;
	s.check(typeof desktopPath === "string", "desktop kept an active path");
	s.check(typeof mobilePath === "string", "mobile kept an active path");
	s.check(desktopPath === mobilePath, "both replicas converge to one winner path");
	s.check(desktop.getMap<Y.Text>("idToText").size === 1, "desktop did not clone file IDs");
	s.check(mobile.getMap<Y.Text>("idToText").size === 1, "mobile did not clone file IDs");
	s.check(activeMetaPaths(desktop).size === 1, "desktop has exactly one active markdown path");
	s.check(activeMetaPaths(mobile).size === 1, "mobile has exactly one active markdown path");

	desktop.destroy();
	mobile.destroy();
	base.destroy();
}

s.section("Test 2: snapshot diff ignores legacy pathToId noise for schema v2");
{
	const seed = new Y.Doc();
	const sys = seed.getMap<number>("sys");
	const idToText = seed.getMap<Y.Text>("idToText");
	const meta = seed.getMap<FlatFileMeta>("meta");
	const fileId = "file-2";
	seed.transact(() => {
		sys.set("schemaVersion", 2);
		const text = new Y.Text();
		text.insert(0, "Stable content");
		idToText.set(fileId, text);
		meta.set(fileId, { path: "notes/stable.md", mtime: 1, device: "seed" });
	});

	const snapshotDoc = cloneDoc(seed);
	const liveDoc = cloneDoc(seed);
	liveDoc.transact(() => {
		// Deliberately inject stale/extra legacy aliases.
		const livePathToId = liveDoc.getMap<string>("pathToId");
		livePathToId.set("notes/stable.md", fileId);
		livePathToId.set("notes/ghost.md", fileId);
	});

	const diff = diffSnapshot(snapshotDoc, liveDoc);
	s.check(diff.createdSinceSnapshot.length === 0, "no fake creates from pathToId aliases");
	s.check(diff.deletedSinceSnapshot.length === 0, "no fake deletes from pathToId aliases");
	s.check(diff.contentChanged.length === 0, "no fake content changes from pathToId aliases");
	s.check(diff.unchanged.includes("notes/stable.md"), "active v2 path remains unchanged");

	seed.destroy();
	snapshotDoc.destroy();
	liveDoc.destroy();
}

s.section("Test 3: v2 restore undeletes without writing legacy pathToId");
{
	const snapshotDoc = new Y.Doc();
	const snapSys = snapshotDoc.getMap<number>("sys");
	const snapIdToText = snapshotDoc.getMap<Y.Text>("idToText");
	const snapMeta = snapshotDoc.getMap<FlatFileMeta>("meta");
	const fileId = "file-3";
	snapshotDoc.transact(() => {
		snapSys.set("schemaVersion", 2);
		const text = new Y.Text();
		text.insert(0, "Recovered");
		snapIdToText.set(fileId, text);
		snapMeta.set(fileId, { path: "notes/recover.md", mtime: 1, device: "snapshot" });
	});

	const liveDoc = new Y.Doc();
	const liveSys = liveDoc.getMap<number>("sys");
	const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
	const liveMeta = liveDoc.getMap<FlatFileMeta>("meta");
	const livePathToId = liveDoc.getMap<string>("pathToId");
	liveDoc.transact(() => {
		liveSys.set("schemaVersion", 2);
		const stale = new Y.Text();
		stale.insert(0, "Stale value");
		liveIdToText.set(fileId, stale);
		liveMeta.set(fileId, { path: "notes/recover.md", deletedAt: Date.now() - 1000 });
	});

	const restored = restoreFromSnapshot(snapshotDoc, liveDoc, {
		markdownPaths: ["notes/recover.md"],
		device: "test-device",
	});
	const restoredMeta = liveMeta.get(fileId);
	const restoredText = liveIdToText.get(fileId)?.toString();
	s.check(restored.markdownUndeleted === 1, "restore undeleted one markdown file");
	s.check(restoredText === "Recovered", "restore replaced stale content");
	// Use helper to read both flat (v2) and nested (v3) metadata shapes.
	s.check(getMetaPath(restoredMeta) === "notes/recover.md", "restore kept expected path");
	s.check(getMetaDeletedAt(restoredMeta) === null, "restore cleared tombstone state");
	s.check(livePathToId.size === 0, "restore did not write legacy pathToId in schema v2");

	snapshotDoc.destroy();
	liveDoc.destroy();
}
await s.done();
