/**
 * S05 — Frontmatter safety loop (two variants).
 *
 * Purpose: Prove that external frontmatter edits do not cause a write loop
 * or duplicate frontmatter corruption.
 *
 * Variants:
 *   s05a — closed file: write frontmatter twice while file is closed
 *   s05b — open editor: type in body, then write frontmatter externally
 *           while the file is open in the editor (the historical failure case)
 *
 * Key events expected:
 *   disk.modify.observed × N (external writes)
 *   (NO disk.event.not_suppressed — suppress must work)
 *   (NO recovery.loop.detected)
 *   (NO conflict artifacts)
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH_CLOSED = "QA-scratch/s05-frontmatter-closed.md";
const SCRATCH_OPEN = "QA-scratch/s05-frontmatter-open-editor.md";

const INITIAL_FM = [
	"---",
	"title: S05 Frontmatter Test",
	"created: 2024-01-01",
	"---",
	"",
	"Initial body content.",
	"",
].join("\n");

const FM_EDIT_1 = [
	"---",
	"title: S05 Frontmatter Test",
	"created: 2024-01-01",
	"updated: 2024-06-01",
	"status: active",
	"---",
	"",
	"Initial body content.",
	"",
].join("\n");

const FM_EDIT_2 = [
	"---",
	"title: S05 Frontmatter Test (revised)",
	"created: 2024-01-01",
	"updated: 2024-06-02",
	"status: published",
	"---",
	"",
	"Initial body content.",
	"",
].join("\n");

// -----------------------------------------------------------------------
// S05a — closed file variant (baseline test)
// -----------------------------------------------------------------------

export const s05aFrontmatterClosedFile: QaScenario = {
	id: "frontmatter-safety-loop-closed",
	title: "Frontmatter: two external writes on closed file, no loop",
	tags: ["frontmatter", "single-device", "layer2"],

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH_CLOSED).catch(() => {});
		await ctx.waitForIdle(5000);
	},

	async run(ctx: QaContext): Promise<void> {
		const createTs = Date.now();
		await ctx.createFile(SCRATCH_CLOSED, INITIAL_FM);
		await ctx.waitForIdle(8000);
		await ctx.yaos.waitForReceiptAfter(createTs, 20_000);

		// Each mutation gets its own candidate-bound receipt proof. The second
		// wait cannot be satisfied by confirmation of the first external edit.
		const firstEditTs = Date.now();
		await ctx.writeAdapterFile(SCRATCH_CLOSED, FM_EDIT_1);
		await ctx.waitForIdle(15_000);
		await ctx.yaos.waitForReceiptAfter(firstEditTs, 20_000);

		const finalEditTs = Date.now();
		await ctx.writeAdapterFile(SCRATCH_CLOSED, FM_EDIT_2);
		await ctx.waitForIdle(15_000);
		await ctx.yaos.waitForReceiptAfter(finalEditTs, 20_000);
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileExists(SCRATCH_CLOSED);
		await ctx.assert.fileContent(SCRATCH_CLOSED, FM_EDIT_2);
		await ctx.assert.diskEqualsCrdt(SCRATCH_CLOSED);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH_CLOSED).catch(() => {});
	},
};

// -----------------------------------------------------------------------
// S05b — open editor variant (the nasty historical failure case)
// -----------------------------------------------------------------------

export const s05bFrontmatterOpenEditor: QaScenario = {
	id: "frontmatter-safety-loop-open-editor",
	title: "Frontmatter: two external writes while editor is OPEN, no loop/dupe",
	tags: ["frontmatter", "editor-bound", "single-device", "layer2"],

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH_OPEN).catch(() => {});
		await ctx.waitForIdle(5000);
	},

	async run(ctx: QaContext): Promise<void> {
		await ctx.createFile(SCRATCH_OPEN, INITIAL_FM);
		await ctx.waitForIdle(8000);
		await ctx.openFile(SCRATCH_OPEN);

		await ctx.typeIntoFile(SCRATCH_OPEN, "\n\nTyped while editor open.");
		await ctx.waitForIdle(5000);

		const firstEditTs = Date.now();
		await ctx.writeAdapterFile(SCRATCH_OPEN, FM_EDIT_1 + "\n\nTyped while editor open.");
		await ctx.waitForIdle(20_000);
		await ctx.yaos.waitForReceiptAfter(firstEditTs, 20_000);

		const finalEditTs = Date.now();
		await ctx.writeAdapterFile(SCRATCH_OPEN, FM_EDIT_2 + "\n\nTyped while editor open.");
		await ctx.waitForIdle(20_000);
		await ctx.yaos.waitForReceiptAfter(finalEditTs, 20_000);

		await ctx.closeFile(SCRATCH_OPEN);
		await ctx.waitForIdle(8000);
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileExists(SCRATCH_OPEN);
		await ctx.assert.diskEqualsCrdt(SCRATCH_OPEN);
		const file = ctx.app.vault.getFileByPath(SCRATCH_OPEN);
		if (!file) throw new Error(`File not found: ${SCRATCH_OPEN}`);
		const content = await ctx.app.vault.read(file);
		const fmMatches = (content.match(/^---$/gm) ?? []).length;
		if (fmMatches !== 2) {
			throw new Error(
				`Expected exactly 2 '---' markers (one frontmatter block) but found ${fmMatches}.\n` +
				`Content:\n${content}`,
			);
		}
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.closeFile(SCRATCH_OPEN).catch(() => {});
		await ctx.deleteFile(SCRATCH_OPEN).catch(() => {});
	},
};
