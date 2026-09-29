/**
 * S06c — open/bound authoritative-reconcile deferral.
 *
 * Runs inside a real Obsidian session. It proves that a disk divergence is
 * retained while the note is open under the closed-only policy, then is
 * imported after the normal tab-close/layout lifecycle. The controller-level
 * counterpart is tests/client/open-bound-reconcile-deferral.ts.
 *
 * This scenario uses the harness adapter write path; a controller/CDP run that
 * uses Node fs is still required for OS-watcher-specific evidence.
 */

import type { QaScenario } from "../types";

const path = "QA-closure/open-bound-closed-only.md";
const baseline = "# Open/bound closure proof\n\nBASELINE\n";
const external = "# Open/bound closure proof\n\nEXTERNAL_DISK_EDIT\n";

export const s06cClosedOnlyOpenBoundDeferral: QaScenario = {
	id: "open-bound-closed-only-deferral",
	title: "Open/bound reconcile defers, then converges after close",
	tags: ["reconcile", "closed-only", "editor-bound", "autophagy", "regression"],
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.deleteFile(path).catch(() => {});
		await ctx.waitForIdle(10_000);
	},

	async run(ctx): Promise<void> {
		let previousPolicy: "always" | "closed-only" | "never" | null = null;
		try {
			await ctx.createFile(path, baseline);
			await ctx.waitForFile(path, 15_000);
			await ctx.waitForIdle(15_000);
			await ctx.waitForDiskCrdtConverge(path, 15_000);

			await ctx.openFile(path);
			await ctx.waitForCrdtBinding(path, 15_000);

			const policy = await ctx.yaos.setExternalEditPolicyOverride("closed-only");
			previousPolicy = policy.previous;

			const baselineCrdtHash = await ctx.yaos.getCrdtHash(path);
			if (!baselineCrdtHash) throw new Error("open-bound deferral: missing baseline CRDT hash");

			// Writes disk without a CRDT/editor edit. A forced authoritative reconcile
			// must emit the deferral while the file is still open and bound.
			await ctx.writeAdapterFile(path, external);
			await ctx.yaos.forceReconcile();
			await ctx.sleep(500);

			const deferredDiskHash = await ctx.yaos.getDiskHash(path);
			const deferredCrdtHash = await ctx.yaos.getCrdtHash(path);
			const deferredEditorHash = await ctx.yaos.getEditorHash(path);
			if (!deferredDiskHash || !deferredCrdtHash || !deferredEditorHash) {
				throw new Error("open-bound deferral: could not read deferred hashes");
			}
			if (deferredCrdtHash !== baselineCrdtHash || deferredEditorHash !== baselineCrdtHash) {
				throw new Error("open-bound deferral: CRDT/editor changed before close; expected deferral");
			}
			if (deferredDiskHash === baselineCrdtHash) {
				throw new Error("open-bound deferral: disk edit was overwritten before close");
			}

			await ctx.closeFile(path);
			await ctx.waitForIdle(20_000);
			await ctx.waitForDiskCrdtConverge(path, 20_000);

			const settledDiskHash = await ctx.yaos.getDiskHash(path);
			const settledCrdtHash = await ctx.yaos.getCrdtHash(path);
			if (settledDiskHash !== deferredDiskHash || settledCrdtHash !== deferredDiskHash) {
				throw new Error("open-bound deferral: close lifecycle did not converge CRDT to external disk content");
			}

			await ctx.openFile(path);
			await ctx.waitForCrdtBinding(path, 15_000);
			const settledEditorHash = await ctx.yaos.getEditorHash(path);
			if (settledEditorHash !== deferredDiskHash) {
				throw new Error("open-bound deferral: reopened editor did not converge to external disk content");
			}
		} finally {
			if (previousPolicy !== null) {
				await ctx.yaos.setExternalEditPolicyOverride(previousPolicy);
			}
			await ctx.closeFile(path).catch(() => {});
			await ctx.deleteFile(path).catch(() => {});
		}
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies("QA-closure");
	},
};
