import { suite } from "../harness.ts";

const s = suite("markdown-ingest-regressions");

class MarkdownIngestHarness {
	dirtyMarkdownPaths = new Map<string, string>();
	markdownDrainPromise: Promise<void> | null = null;
	disk = new Map<string, string>();
	synced = new Map<string, string>();
	tombstonedPaths = new Set<string>();
	processCount = 0;
	processedReasons: string[] = [];
	onProcessStart: ((path: string, reason: string, count: number) => Promise<void>) | null = null;

	setDisk(path: string, content: string) {
		this.disk.set(path, content);
	}

	getSynced(path: string) {
		return this.synced.get(path);
	}

	tombstonePath(path: string) {
		this.tombstonedPaths.add(path);
	}

	async markMarkdownDirty(path: string, reason: string) {
		const previous = this.dirtyMarkdownPaths.get(path);
		if (previous !== "create") {
			this.dirtyMarkdownPaths.set(path, reason);
		}

		if (this.markdownDrainPromise) return;

		this.markdownDrainPromise = this.drainDirtyMarkdownPaths()
			.finally(() => {
				this.markdownDrainPromise = null;
				if (this.dirtyMarkdownPaths.size > 0) {
					void this.markMarkdownDrainPending();
				}
			});

		await this.markdownDrainPromise;
	}

	async markMarkdownDrainPending() {
		if (this.markdownDrainPromise) return;

		this.markdownDrainPromise = this.drainDirtyMarkdownPaths()
			.finally(() => {
				this.markdownDrainPromise = null;
				if (this.dirtyMarkdownPaths.size > 0) {
					void this.markMarkdownDrainPending();
				}
			});

		await this.markdownDrainPromise;
	}

	async drainDirtyMarkdownPaths() {
		while (this.dirtyMarkdownPaths.size > 0) {
			const batch = Array.from(this.dirtyMarkdownPaths.entries());
			this.dirtyMarkdownPaths.clear();

			for (const [path, reason] of batch) {
				await this.processDirtyMarkdownPath(path, reason);
			}
		}
	}

	async processDirtyMarkdownPath(path: string, reason: string) {
		this.processCount++;
		this.processedReasons.push(reason);
		if (this.onProcessStart) {
			await this.onProcessStart(path, reason, this.processCount);
		}
		if (this.tombstonedPaths.has(path)) {
			if (reason === "create") {
				this.tombstonedPaths.delete(path);
			} else {
				return;
			}
		}
		const content = this.disk.get(path);
		if (typeof content === "string") {
			this.synced.set(path, content);
		}
	}
}

s.section("Test: markdown dirty-set coalesces modify bursts under backpressure");
{
	const harness = new MarkdownIngestHarness();
	const path = "burst.md";
	harness.setDisk(path, "seed");

	let firstProcessStarted!: () => void;
	const firstProcessSeen = new Promise<void>((resolve) => {
		firstProcessStarted = resolve;
	});
	let releaseFirstProcess!: () => void;
	const firstProcessGate = new Promise<void>((resolve) => {
		releaseFirstProcess = resolve;
	});

	harness.onProcessStart = async (_path, _reason, count) => {
		if (count === 1) {
			firstProcessStarted();
			await firstProcessGate;
		}
	};

	const initialDrain = harness.markMarkdownDirty(path, "modify");
	await firstProcessSeen;

	const burstStart = Date.now();
	for (let i = 1; i <= 100; i++) {
		harness.setDisk(path, `version-${i}`);
		void harness.markMarkdownDirty(path, "modify");
	}
	const burstDurationMs = Date.now() - burstStart;

	releaseFirstProcess();
	await initialDrain;
	if (harness.markdownDrainPromise) {
		await harness.markdownDrainPromise;
	}

	console.log(`  INFO  queued 100 modify events in ${burstDurationMs}ms`);
	s.check(harness.processCount === 2, `coalesced burst into 2 drain passes (got ${harness.processCount})`);
	s.check(
		harness.getSynced(path) === "version-100",
		"final synced content matches the latest disk content",
	);
	s.check(harness.dirtyMarkdownPaths.size === 0, "dirty map empty after drain settles");
}

s.section("Test: tombstoned paths revive on create intent (not modify)");
{
	const harness = new MarkdownIngestHarness();
	const path = "restore.md";

	harness.setDisk(path, "v1");
	await harness.markMarkdownDirty(path, "create");
	s.check(harness.getSynced(path) === "v1", "initial create synced");

	harness.tombstonePath(path);
	harness.setDisk(path, "v2");

	await harness.markMarkdownDirty(path, "modify");
	s.check(harness.getSynced(path) === "v1", "modify event keeps tombstoned path blocked");

	await harness.markMarkdownDirty(path, "create");
	s.check(harness.getSynced(path) === "v2", "create event revives tombstoned path");
}
await s.done();
