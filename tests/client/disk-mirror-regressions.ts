import { suite } from "../harness.ts";

interface FileStat {
	size: number;
	mtime: number;
}

interface FileRecord {
	path: string;
	stat: FileStat;
	content: string;
}

interface MirrorFile {
	path: string;
	stat?: FileStat;
}

interface SuppressionEntry {
	kind: "delete" | "write";
	expiresAt: number;
	expectedBytes?: number;
	expectedHash?: string;
}

type ModifyHook = (path: string, content: string) => Promise<void>;

interface FileStore {
	get(path: string): FileRecord | null;
	update(path: string, content: string): FileRecord;
	read(path: string): Promise<string>;
	modify(path: string, content: string): Promise<void>;
	create(path: string, content: string): Promise<void>;
	failNextRead(path: string): void;
	setModifyHook(fn: ModifyHook | null): void;
	getMaxConcurrentWrites(): number;
}

const SUPPRESS_MS = 500;
const encoder = new TextEncoder();

const s = suite("disk-mirror-regressions");

async function fingerprintContent(content: string): Promise<{ bytes: number; hash: string }> {
	const bytes = encoder.encode(content);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return {
		bytes: bytes.length,
		hash: Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(""),
	};
}

class DiskMirrorHarness {
	store: FileStore;
	suppressedPaths: Map<string, SuppressionEntry>;
	pathWriteLocks: Map<string, Promise<void>>;
	ytexts: Map<string, string>;

	constructor(store: FileStore) {
		this.store = store;
		this.suppressedPaths = new Map();
		this.pathWriteLocks = new Map();
		this.ytexts = new Map();
	}

	setYText(path: string, value: string): void {
		this.ytexts.set(path, value);
	}

	isSuppressed(path: string): boolean {
		return this.getActiveSuppression(path) !== null;
	}

	suppressDelete(path: string): void {
		this.suppressedPaths.set(path, {
			kind: "delete",
			expiresAt: Date.now() + SUPPRESS_MS,
		});
	}

	async shouldSuppressModify(file: MirrorFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "modify");
	}

	async shouldSuppressCreate(file: MirrorFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "create");
	}

	async flushWrite(path: string): Promise<void> {
		return this.runPathWriteLocked(path, () => this.flushWriteUnlocked(path));
	}

	async flushWriteUnlocked(path: string): Promise<void> {
		const content = this.ytexts.get(path);
		if (typeof content !== "string") return;

		const existing = this.store.get(path);
		if (existing) {
			const currentContent = await this.store.read(path);
			if (currentContent === content) return;
			await this.suppressWrite(path, content);
			await this.store.modify(path, content);
			return;
		}

		await this.suppressWrite(path, content);
		await this.store.create(path, content);
	}

	getActiveSuppression(path: string): SuppressionEntry | null {
		const entry = this.suppressedPaths.get(path);
		if (!entry) return null;
		if (Date.now() < entry.expiresAt) return entry;
		this.suppressedPaths.delete(path);
		return null;
	}

	async suppressWrite(path: string, content: string): Promise<void> {
		const fingerprint = await fingerprintContent(content);
		this.suppressedPaths.set(path, {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
		});
	}

	async shouldSuppressWriteEvent(file: MirrorFile, event: "modify" | "create"): Promise<boolean> {
		const entry = this.getActiveSuppression(file.path);
		if (!entry) return false;

		if (entry.kind !== "write") {
			this.suppressedPaths.delete(file.path);
			return false;
		}

		if (
			typeof file.stat?.size === "number"
			&& typeof entry.expectedBytes === "number"
			&& file.stat.size !== entry.expectedBytes
		) {
			this.suppressedPaths.delete(file.path);
			return false;
		}

		try {
			const content = await this.store.read(file.path);
			const fingerprint = await fingerprintContent(content);
			if (
				fingerprint.bytes === entry.expectedBytes
				&& fingerprint.hash === entry.expectedHash
			) {
				this.suppressedPaths.delete(file.path);
				return true;
			}
		} catch {
			// Fall through to normal sync handling.
		}

		this.suppressedPaths.delete(file.path);
		return false;
	}

	runPathWriteLocked(path: string, work: () => Promise<void>): Promise<void> {
		const previous = this.pathWriteLocks.get(path) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		let tracked: Promise<void>;
		tracked = next.finally(() => {
			if (this.pathWriteLocks.get(path) === tracked) {
				this.pathWriteLocks.delete(path);
			}
		});
		this.pathWriteLocks.set(path, tracked);
		return tracked;
	}
}

function makeStore(): FileStore {
	const files = new Map<string, FileRecord>();
	const readFailures = new Set<string>();
	let activeWrites = 0;
	let maxConcurrentWrites = 0;
	let modifyHook: ModifyHook | null = null;

	function update(path: string, content: string): FileRecord {
		const record = files.get(path) ?? {
			path,
			stat: { size: 0, mtime: Date.now() },
			content: "",
		};
		record.content = content;
		record.stat.size = encoder.encode(content).length;
		record.stat.mtime = Date.now();
		files.set(path, record);
		return record;
	}

	return {
		get(path) {
			return files.get(path) ?? null;
		},
		update,
		async read(path) {
			if (readFailures.delete(path)) {
				throw new Error(`Injected read failure for ${path}`);
			}
			const record = files.get(path);
			if (!record) {
				throw new Error(`Missing file: ${path}`);
			}
			return record.content;
		},
		async modify(path, content) {
			activeWrites++;
			maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
			try {
				if (modifyHook) {
					await modifyHook(path, content);
				}
				update(path, content);
			} finally {
				activeWrites--;
			}
		},
		async create(path, content) {
			update(path, content);
		},
		failNextRead(path) {
			readFailures.add(path);
		},
		setModifyHook(fn) {
			modifyHook = fn;
		},
		getMaxConcurrentWrites() {
			return maxConcurrentWrites;
		},
	};
}

// `FileStore.get` is nullable because the harness models a real vault adapter,
// but every suppression call site below has just written the path it reads.
function requireFile(store: FileStore, path: string): FileRecord {
	const file = store.get(path);
	if (!file) throw new Error(`fixture is missing ${path}`);
	return file;
}

s.section("Test A: external modify inside suppression window with different content");
{
	const store = makeStore();
	const mirror = new DiskMirrorHarness(store);
	const path = "note-a.md";
	mirror.setYText(path, "ours");
	store.update(path, "before");

	await mirror.flushWrite(path);
	store.update(path, "external write");

	const suppressed = await mirror.shouldSuppressModify(requireFile(store, path));
	s.check(!suppressed, "different external content is not suppressed");
	s.check(!mirror.isSuppressed(path), "suppression entry clears after mismatch");
}

s.section("Test B: queued + direct flushWrite on the same path serialize");
{
	const store = makeStore();
	const mirror = new DiskMirrorHarness(store);
	const path = "note-b.md";
	mirror.setYText(path, "first");
	store.update(path, "seed");

	// Promise.withResolvers() would read better but is Node 22+ (see
	// tests/harness.ts); the executor runs synchronously, so both resolvers are
	// assigned before the constructor returns.
	let firstWriteStarted!: () => void;
	const firstWriteSeen = new Promise<void>((resolve) => {
		firstWriteStarted = resolve;
	});
	let releaseFirstWrite!: () => void;
	const firstWriteGate = new Promise<void>((resolve) => {
		releaseFirstWrite = resolve;
	});

	store.setModifyHook(async (_path, content) => {
		if (content === "first") {
			firstWriteStarted();
			await firstWriteGate;
		}
	});

	const queuedWrite = mirror.runPathWriteLocked(path, () => mirror.flushWriteUnlocked(path));
	await firstWriteSeen;

	mirror.setYText(path, "second");
	const directWrite = mirror.flushWrite(path);

	releaseFirstWrite();
	await Promise.all([queuedWrite, directWrite]);

	s.check(
		store.getMaxConcurrentWrites() === 1,
		"same-path writes never overlap",
	);
	s.check(
		store.get(path)?.content === "second",
		"final content reflects the later write deterministically",
	);
}

s.section("Test C: delete suppression does not eat a rapid recreate");
{
	const store = makeStore();
	const mirror = new DiskMirrorHarness(store);
	const path = "note-c.md";
	store.update(path, "recreated");

	mirror.suppressDelete(path);
	const suppressed = await mirror.shouldSuppressCreate(requireFile(store, path));

	s.check(!suppressed, "create after delete is not suppressed as a delete");
	s.check(!mirror.isSuppressed(path), "delete suppression clears after recreate mismatch");
}

s.section("Test D: suppressed write falls through safely when file read fails");
{
	const store = makeStore();
	const mirror = new DiskMirrorHarness(store);
	const path = "note-d.md";
	mirror.setYText(path, "ours");
	store.update(path, "before");

	await mirror.flushWrite(path);
	store.failNextRead(path);

	const suppressed = await mirror.shouldSuppressModify(requireFile(store, path));
	s.check(!suppressed, "read failure does not suppress the event");
	s.check(!mirror.isSuppressed(path), "suppression entry clears after read failure");
}
await s.done();
