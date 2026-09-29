import { MarkdownView, type TFile, type Workspace } from "obsidian";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { readSource, suite } from "../harness.ts";

const s = suite("editor-binding-health-regressions");

function sliceBetween(source: string, startMarker: string, endMarker: string): string | null {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < 0 || end <= start) {
		return null;
	}
	return source.slice(start, end);
}

/**
 * `section.includes(needle)` for a slice that may not have resolved. A missing
 * section counts as "no match" — the preceding `section !== null` check is what
 * reports that failure, so the containment checks stay plain booleans.
 */
function includesIn(section: string | null, needle: string): boolean {
	return section !== null && section.includes(needle);
}

/** Source with comments removed, so call-site counts ignore prose. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
}

const workspaceSource = readSource("src/runtime/editorWorkspaceOrchestrator.ts");
const bindingSource = readSource("src/sync/editorBinding.ts");

s.section("Test 1: validateOpenBindings uses repair-only flow");
{
	const section = sliceBetween(
		workspaceSource,
		"validateOpenBindings(reason: string): void {",
		"auditBindings(reason: string): number {",
	);
	s.check(section !== null, "validateOpenBindings section found");
	s.check(includesIn(section, "editorBindings.repair("), "validateOpenBindings calls repair");
	s.check(!includesIn(section, "editorBindings.heal("), "validateOpenBindings does not call heal");
}

s.section("Test 2: bind unhealthy path uses repair, not heal");
{
	const section = sliceBetween(
		bindingSource,
		"bind(view: MarkdownView, deviceName: string): void {",
		"repair(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	s.check(section !== null, "bind section found");
	s.check(includesIn(section, "if (this.repair(view, deviceName, `bind-health:${reason}`))"), "bind unhealthy path calls repair");
	s.check(!includesIn(section, "if (this.heal(view, deviceName, `bind-health:${reason}`))"), "bind unhealthy path does not call heal");
}

s.section("Test 3: maybeHealBinding uses repair/rebind and traces repair-only");
{
	const section = sliceBetween(
		bindingSource,
		"private maybeHealBinding(",
		"private scheduleCmResolveRetry(",
	);
	s.check(section !== null, "maybeHealBinding section found");
	s.check(includesIn(section, "const repaired = this.repair("), "maybeHealBinding calls repair");
	s.check(!includesIn(section, "const healed = this.heal("), "maybeHealBinding does not call heal");
	s.check(includesIn(section, '? "repair-only"'), "health-restored action reports repair-only");
}

s.section("Test 4: editor-health-heal origin remains manual-only");
{
	const healSection = sliceBetween(
		bindingSource,
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
		"rebind(view: MarkdownView, deviceName: string, reason: string): void {",
	);
	s.check(healSection !== null, "heal section found");
	// After the origin-constants refactor the call site uses ORIGIN_EDITOR_HEALTH_HEAL
	// (imported from src/sync/origins.ts) instead of the raw string. Check for the
	// constant name rather than the literal.
	s.check(
		includesIn(healSection, "ORIGIN_EDITOR_HEALTH_HEAL"),
		"editor-health-heal origin used via named constant in heal() implementation",
	);
	// Strip the heal section then check that applyDiffToYText is NOT called
	// with ORIGIN_EDITOR_HEALTH_HEAL outside it. The import declaration
	// is allowed to remain (it's not a call site). Use [^\n)]* to stay
	// on the same line and avoid spurious cross-line matches.
	const strippedSource = bindingSource.replace(healSection ?? "", "");
	s.check(
		!strippedSource.match(/applyDiffToYText[^\n)]*ORIGIN_EDITOR_HEALTH_HEAL/),
		"ORIGIN_EDITOR_HEALTH_HEAL not passed to applyDiffToYText outside heal()",
	);
}

s.section("Test 5: CM resolution prefers editorInfoField and fails closed");
{
	const section = sliceBetween(
		bindingSource,
		"private getCmView(view: MarkdownView): EditorView | null {",
		"private warnCmDegraded(): void {",
	);
	s.check(section !== null, "getCmView section found");
	s.check(
		bindingSource.includes("cm.state.field(editorInfoField, false)"),
		"editor ownership is read from Obsidian's public editorInfoField",
	);
	const infoIndex = section?.indexOf("if (infoMatches.length === 1)") ?? -1;
	const domIndex = section?.indexOf("if (matches.length === 0)") ?? -1;
	s.check(
		infoIndex >= 0 && domIndex >= 0 && infoIndex < domIndex,
		"editorInfoField ownership is consulted before DOM containment",
	);
	const ambiguousIndex = section?.indexOf('"cm-resolution-ambiguous"') ?? -1;
	s.check(
		ambiguousIndex >= 0
		&& (section?.indexOf("return null;", ambiguousIndex) ?? -1) > ambiguousIndex,
		"ambiguous resolution fails closed instead of binding a guessed editor",
	);
	// knownCmViews is populated by our ViewPlugin, whose construction lags the
	// workspace event that triggers bind(). Measured on a 121-note vault:
	// 32 resolution failures without this fallback, 0 with it.
	const zeroMatchIndex = section?.indexOf("if (matches.length === 0)") ?? -1;
	const fromDomIndex = section?.indexOf("EditorView.findFromDOM(container)") ?? -1;
	const giveUpIndex = zeroMatchIndex >= 0
		? (section?.indexOf("return null;", zeroMatchIndex) ?? -1)
		: -1;
	s.check(
		fromDomIndex > zeroMatchIndex && fromDomIndex < giveUpIndex,
		"zero-match falls back to CodeMirror findFromDOM before giving up",
	);
}

s.section("Test 6: CM resolve retries outlast layout churn and stay diagnosable");
{
	const delayMs = Number(bindingSource.match(/CM_RESOLVE_RETRY_DELAY_MS = (\d+)/)?.[1]);
	const maxRetries = Number(bindingSource.match(/CM_RESOLVE_MAX_RETRIES = (\d+)/)?.[1]);
	const settleWindowMs = Number(
		bindingSource.match(/FAST_SWITCH_BINDING_SETTLE_WINDOW_MS = (\d+)/)?.[1],
	);
	s.check(
		Number.isFinite(delayMs) && Number.isFinite(maxRetries) && Number.isFinite(settleWindowMs),
		"CM resolve retry constants are readable",
	);
	// Delays are linear in attempt count, so the budget is the triangular sum.
	const budgetMs = (delayMs * maxRetries * (maxRetries + 1)) / 2;
	s.check(
		budgetMs > settleWindowMs,
		`CM resolve retry budget (${budgetMs}ms) outlasts the fast-switch settle window (${settleWindowMs}ms)`,
	);
	const retrySection = sliceBetween(
		bindingSource,
		"private scheduleCmResolveRetry(",
		"private clearCmResolveRetry(",
	);
	s.check(
		includesIn(retrySection, "failure: this.lastCmResolveFailure"),
		"degraded trace reports why resolution failed",
	);
}

s.section("Test 7: closed leaves release their bindings");
{
	const section = sliceBetween(
		bindingSource,
		"pruneOrphanedBindings(liveLeafKeys: ReadonlySet<string>, source: string): number {",
		"private createUndoManager(",
	);
	s.check(section !== null, "pruneOrphanedBindings section found");
	// Two independent signals must agree. Leaf-absence alone would unbind a
	// live editor if a workspace mutation transiently hid its leaf.
	s.check(
		includesIn(section, "if (liveLeafKeys.has(leafId)) continue;"),
		"a binding whose leaf is still open is never pruned",
	);
	s.check(
		includesIn(section, "if (this.knownCmViews.has(binding.cm)) {"),
		"a binding whose EditorView is still registered is never pruned",
	);
	// Teardown must match unbindByPath or the prune trades one leak for another.
	s.check(
		includesIn(section, "binding.undoManager.destroy();"),
		"pruning destroys the UndoManager",
	);
	s.check(
		includesIn(section, "this.bindings.delete(leafId);")
		&& includesIn(section, "this.cmToLeafId.delete(binding.cm);"),
		"pruning releases the binding and its CM mapping",
	);

	const orchestratorSource = readSource("src/runtime/editorWorkspaceOrchestrator.ts");
	const layout = sliceBetween(
		orchestratorSource,
		"onLayoutChange(): void {",
		"pruneOrphanedBindings(reason: string): number {",
	);
	const pruneCall = layout?.indexOf("this.pruneOrphanedBindings(") ?? -1;
	const auditCall = layout?.indexOf("this.auditBindings(") ?? -1;
	s.check(
		pruneCall >= 0 && auditCall >= 0 && pruneCall < auditCall,
		"layout-change prunes dead bindings before auditing the rest",
	);
	// Keys must be derived exactly as bind() does, or path-keyed bindings
	// would never match a live entry and would be pruned while in use.
	s.check(
		orchestratorSource.includes('"id" in leaf && typeof leaf.id === "string"')
		&& orchestratorSource.includes("view.file?.path"),
		"live leaf keys use the same leaf-id-then-path derivation as bind()",
	);
}

s.section("Test 8: Yjs doc observers do not accumulate per bind");
{
	// Y.UndoManager's constructor adds a `destroy` hook that destroy() never
	// removes, and YSyncConfig builds a second manager it never uses. Left
	// alone each bind leaked one observer of each kind, permanently.
	const bindingCode = stripComments(bindingSource);
	const undoManagerConstructions =
		bindingCode.match(/new Y\.UndoManager\(/g)?.length ?? 0;
	s.check(
		undoManagerConstructions === 1,
		"UndoManagers are only constructed inside createUndoManager",
	);
	const yCollabCalls = bindingCode.match(/yCollab\(/g)?.length ?? 0;
	s.check(
		yCollabCalls === 1,
		"yCollab is only invoked inside buildCollabExtension",
	);

	const builder = sliceBetween(
		bindingSource,
		"private buildCollabExtension(",
		"private releaseAddedDocObservers(",
	);
	s.check(builder !== null, "buildCollabExtension section found");
	s.check(
		includesIn(builder, 'this.releaseAddedDocObservers(doc, "destroy", destroyBefore)')
		&& includesIn(builder, 'this.releaseAddedDocObservers(doc, "afterTransaction", transactionBefore)'),
		"the stray YSyncConfig UndoManager's observers are both released",
	);

	const factory = sliceBetween(
		bindingSource,
		"private createUndoManager(",
		"* Build the collab extension",
	);
	s.check(
		includesIn(factory, 'this.releaseAddedDocObservers(doc, "destroy", before)')
		&& !includesIn(factory, '"afterTransaction"'),
		"our own UndoManager keeps its afterTransaction subscription so undo works",
	);
}

s.section("Test 9: active-view checks use the public Workspace API");
{
	let activeView: MarkdownView | null = null;
	let requestedViewType: unknown = null;
	const workspace = partialOf<Workspace>({
		getActiveViewOfType: ((viewType: unknown) => {
			requestedViewType = viewType;
			return activeView;
		}) as Workspace["getActiveViewOfType"],
	});
	const manager = new EditorBindingManager(
		partialOf<VaultSync>({}),
		workspace,
		false,
	);
	const active = partialOf<MarkdownView>({
		file: partialOf<TFile>({ path: "active.md" }),
	});
	const inactive = partialOf<MarkdownView>({
		file: partialOf<TFile>({ path: "inactive.md" }),
	});
	const detached = partialOf<MarkdownView>({ file: null });

	activeView = active;
	s.check(
		manager["isAuditActionable"](active, ["missing-file"]),
		"active view remains actionable for otherwise deferrable health issues",
	);
	s.check(
		requestedViewType === MarkdownView,
		"active-view lookup requests the public MarkdownView type",
	);
	s.check(
		!manager["isAuditActionable"](inactive, ["missing-file", "missing-collab-info"]),
		"inactive view defers non-actionable health issues",
	);
	s.check(
		manager["isAuditActionable"](inactive, ["missing-sync-facet"]),
		"inactive view still repairs substantive health issues",
	);
	s.check(
		!manager["isAuditActionable"](detached, ["missing-sync-facet"]),
		"detached view is never actionable",
	);

	const activeViewCalls =
		stripComments(bindingSource).match(/getActiveViewOfType\(MarkdownView\)/g)?.length ?? 0;
	s.check(activeViewCalls === 2, "both active-view decisions use getActiveViewOfType");
	s.check(!bindingSource.includes(".activeLeaf"), "deprecated activeLeaf is absent");
}
await s.done();
