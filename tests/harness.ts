// Shared test harness for every suite under tests/.
//
// WHY THIS EXISTS. Before this file, each suite carried its own copy of the
// same reporting shell: two counters, a local `assert(cond, msg)` that logged
// PASS/FAIL and incremented them, a hand-drawn summary rule, and a
// `process.exit`. Ninety suites, thirteen textually distinct `assert`
// implementations, three exit dialects, eleven summary rules. All of it
// re-derived per file, none of it tested.
//
// The duplication was the cheap problem. The expensive one was that the shape
// let a suite lie: a file whose test bodies were async but never awaited would
// print `Results: 0 passed, 0 failed` and exit 0 while its assertions were
// still queued on the microtask queue — green, and empty. That pattern shipped
// in this repo and was removed by accident rather than by design.
//
// `done()` makes it structurally impossible. It is the only way a suite ends:
// it awaits every queued body before it prints anything, and a suite that
// finishes without calling it fails loudly (see the beforeExit guard below)
// instead of exiting 0 by default.
//
// INFRASTRUCTURE, NOT A PRODUCT DEPENDENCY. This file imports nothing from
// src/ or server/src/, so a suite can never fail or pass because of what the
// harness pulled in. tests/harness-self.ts is its regression guard.

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Product code uses window-scoped browser APIs for Obsidian popout
// compatibility. Node suites install that host once through the shared harness.
if (typeof window === "undefined") {
	Object.defineProperty(globalThis, "window", {
		value: globalThis,
		configurable: true,
	});
}


/** A queued throw-style test: `name` is the label, `body` may be async. */
interface QueuedTest {
	readonly name: string;
	readonly body: () => void | Promise<void>;
}

export interface Suite {
	/**
	 * Boolean-counter assertion. Drop-in replacement for the per-suite
	 * `assert(cond, msg)` this harness replaced. Returns `condition` so call
	 * sites can guard follow-up work on it.
	 */
	check(condition: boolean, message: string): boolean;
	/**
	 * Throw-style test. The body is QUEUED, not run: `done()` awaits each one
	 * in registration order and counts it as exactly one pass or one failure.
	 * A body that throws synchronously and a body whose promise rejects are
	 * treated identically — one failure carrying the error message, with the
	 * remaining tests still run.
	 */
	test(name: string, body: () => void | Promise<void>): void;
	/** Section header. Replaces hand-written `console.log("\n--- … ---")`. */
	section(title: string): void;
	/**
	 * Awaits every queued test, prints the summary, and exits: 0 when nothing
	 * failed, 1 otherwise. Never returns. Output is flushed first, because
	 * `process.exit` truncates pending writes when stdout is a pipe — which it
	 * is under the regression runner.
	 */
	done(): Promise<never>;
	/** Assertion tallies at the moment of the read. */
	readonly counts: { readonly passed: number; readonly failed: number };
}

/**
 * Create a suite. The name appears in the summary line, so a failing suite is
 * identifiable from a scrollback of ninety of them.
 */
export function suite(name: string): Suite {
	let passed = 0;
	let failed = 0;
	let finished = false;
	const queue: QueuedTest[] = [];

	// A suite that reaches the end of its module without calling done() has
	// either forgotten the call or thrown past it. Either way its counters were
	// never reported and node would exit 0. Refuse to let that read as success.
	process.on("beforeExit", () => {
		if (finished) return;
		console.error(
			`\nSUITE DID NOT FINISH: ${name} never called done(). `
			+ `${passed} passed, ${failed} failed, ${queue.length} test(s) still queued. `
			+ `Add \`await s.done()\` as the last statement of the suite.`,
		);
		process.exitCode = 1;
	});

	return {
		check(condition: boolean, message: string): boolean {
			if (condition) {
				passed++;
				console.log(`  PASS ${message}`);
			} else {
				failed++;
				console.error(`  FAIL ${message}`);
			}
			return condition;
		},

		test(testName: string, body: () => void | Promise<void>): void {
			queue.push({ name: testName, body });
		},

		section(title: string): void {
			console.log(`\n--- ${title} ---`);
		},

		async done(): Promise<never> {
			// Drain in registration order. `await body()` covers both the
			// synchronous-throw and the rejected-promise case, and the await is
			// the whole point: the summary below cannot print early.
			for (const queued of queue) {
				try {
					await queued.body();
					passed++;
					console.log(`  PASS ${queued.name}`);
				} catch (error) {
					failed++;
					console.error(`  FAIL ${queued.name} — ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			queue.length = 0;
			finished = true;

			const rule = "─".repeat(55);
			console.log(`\n${rule}`);
			console.log(`Results: ${passed} passed, ${failed} failed  [${name}]`);
			console.log(`${rule}\n`);

			// Writes to a pipe are asynchronous in node and process.exit drops
			// whatever is still buffered — which would be exactly the summary
			// line the runner exists to read. Writes are ordered, so a callback
			// on an empty trailing write fires once everything before it landed.
			//
			// Promise.withResolvers() would read better here, but it is Node 22+
			// and CI runs Node 20 (.github/workflows/ci.yml).
			for (const stream of [process.stdout, process.stderr]) {
				await new Promise<void>((flushed) => stream.write("", () => flushed()));
			}

			process.exit(failed > 0 ? 1 : 0);
		},

		get counts() {
			return { passed, failed };
		},
	};
}

// ── Shared utilities ────────────────────────────────────────────────────────

/** Yield to the event loop for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise<void>((elapsed) => {
		setTimeout(elapsed, ms);
	});
}

/**
 * Poll `predicate` until it is true. Rejects on timeout rather than hanging,
 * so a broken wait surfaces as a failed suite instead of a stalled runner.
 */
export async function until(
	predicate: () => boolean,
	options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
	const { timeoutMs = 1000, intervalMs = 5, message } = options;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() >= deadline) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message ?? "condition"}`);
		}
		await sleep(intervalMs);
	}
}

/**
 * Run `body` against a fresh temp directory and remove it afterwards, even if
 * `body` throws. Suites that leak temp trees are a slow-burning disk problem
 * and a fast source of cross-test interference.
 */
export async function withTempDir<T>(
	prefix: string,
	body: (dir: string) => Promise<T> | T,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	try {
		return await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Absolute path to the repository root, with no trailing separator.
 *
 * Suites live one directory deeper since the bucket reorganisation, and every
 * file that computed its own `../..` anchor had to be edited when they moved.
 * Anchor here instead: this file's own location is the only thing that has to
 * be right.
 */
export function repoRoot(): string {
	return fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
}

/** Read a repo-root-relative source file as UTF-8. */
export function readSource(relPath: string): string {
	return readFileSync(resolve(repoRoot(), relPath), "utf8");
}
