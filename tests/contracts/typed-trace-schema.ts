import { readSource, suite } from "../harness.ts";

const s = suite("typed-trace-schema");

s.section("Test 1: dangerous transitions have typed trace events");
{
	const reconciliation = readSource("src/runtime/reconciliationController.ts");
	const blobSync = readSource("src/sync/blobSync.ts");
	const diskMirror = readSource("src/sync/diskMirror.ts");
	const serverAck = readSource("src/sync/serverAckTracker.ts");
	const main = readSource("src/main.ts");
	const fmCoordinator = readSource("src/sync/frontmatterGuardCoordinator.ts");

	s.check(reconciliation.includes('"recovery-postcondition-observed"'), "recovery postcondition observations are traced");
	s.check(reconciliation.includes('"recovery-force-replace-applied"'), "recovery force-replace fallback is traced");
	s.check(reconciliation.includes('"recovery-postcondition-failed"'), "recovery postcondition failure is traced");
	s.check(reconciliation.includes('"recovery-postcondition-skipped"'), "recovery lock skips are traced");
	s.check(reconciliation.includes('"conflict-artifact-needed"'), "ambiguous divergence conflict need is traced");
	s.check(fmCoordinator.includes('"frontmatter-quarantined"'), "frontmatter quarantine uses quarantine trace source");
	s.check(fmCoordinator.includes('"frontmatter-quarantine-cleared"'), "frontmatter quarantine clear uses quarantine trace source");
	s.check(blobSync.includes('"download-overwrite-decision"'), "attachment download overwrite decisions are traced");
	s.check(blobSync.includes('"download-conflict-quarantined"'), "attachment download conflicts are quarantined and traced");
	s.check(serverAck.includes('"receipt-candidate-captured"'), "receipt candidate capture is traced");
	s.check(serverAck.includes('"receipt-server-echo"'), "server receipt echo transitions are traced");
	s.check(diskMirror.includes('"suppression-acknowledged"'), "suppression acknowledgements are traced");
	s.check(diskMirror.includes('"suppression-mismatch"'), "suppression mismatches are traced");
	s.check(diskMirror.includes('"remote-delete-applied"'), "remote delete completions are traced in diskMirror");
	s.check(blobSync.includes('"remote-delete-applied"'), "remote delete completions are traced in blobSync");
	s.check(reconciliation.includes('"recovery-quarantined"'), "recovery loop quarantine is traced");
	s.check(reconciliation.includes('"conflict-artifact-created"'), "conflict artifact creation is traced");
	s.check(reconciliation.includes('convergenceApplied'), "conflict convergence decision is traced");
}

s.section("Test 2: reconciliation traces safety and authority summaries");
{
	const reconciliation = readSource("src/runtime/reconciliationController.ts");
	s.check(reconciliation.includes('"reconcile-scan-complete"'), "reconcile scan summary is traced");
	s.check(reconciliation.includes('"reconcile-safety-brake-blocked"'), "safety-brake block is traced");
	s.check(reconciliation.includes('"reconcile-authority-summary"'), "reconcile authority summary is traced");
	s.check(reconciliation.includes('tracePathList("blockedUpdate"'), "blocked update path samples are included in trace details");
}

s.section("Test 3: source-grep static guard for recovery.skipped frontmatter-ingest-blocked wiring");
//
// This is a static-text guard, not a runtime schema validator. It catches
// accidental drift in the controller's frontmatter-ingest-blocked
// instrumentation by checking that the typed exports exist in the
// canonical module, the helper exists in the controller, and the helper
// is invoked exactly six times. Real type-level enforcement comes from
// `RecoverySkippedFrontmatterData` and `FrontmatterIngestBlockBranch` in
// src/observability/recoveryEventTypes.ts; the runtime invariants are asserted
// by tests/client/frontmatter-guard-orchestration.ts.
{
	const reconciliation = readSource("src/runtime/reconciliationController.ts");
	const recoveryTypes = readSource("src/observability/recoveryEventTypes.ts");
	const taxonomy = readSource("src/observability/flightTaxonomy.ts");

	// Typed recovery payload exports live in src/observability/recoveryEventTypes.ts
	// (the helper imports them; the test asserts they exist there, not in the
	// controller, so accidental local copies in the controller are caught).
	s.check(
		recoveryTypes.includes("export type RecoverySkippedReason ="),
		"recoveryEventTypes.ts exports RecoverySkippedReason union",
	);
	s.check(
		recoveryTypes.includes("export type FrontmatterIngestBlockBranch ="),
		"recoveryEventTypes.ts exports FrontmatterIngestBlockBranch union",
	);
	s.check(
		recoveryTypes.includes("export type RecoverySkippedFrontmatterData ="),
		"recoveryEventTypes.ts exports RecoverySkippedFrontmatterData payload type",
	);

	// Closed-enum branch type covers exactly the six block sites.
	const branchTypeMatch = recoveryTypes.match(
		/export type FrontmatterIngestBlockBranch =\s*([\s\S]*?);/,
	);
	s.check(branchTypeMatch !== null, "FrontmatterIngestBlockBranch declaration parses");
	const branchSrc = branchTypeMatch?.[1] ?? "";
	for (const literal of [
		"disk-to-crdt-existing",
		"disk-to-crdt-seed",
		"bound-file-local-only-divergence",
		"bound-file-local-only-seed",
		"bound-file-open-idle-disk-recovery",
		"bound-file-open-idle-seed",
	]) {
		s.check(
			branchSrc.includes(`"${literal}"`),
			`FrontmatterIngestBlockBranch includes "${literal}"`,
		);
	}

	// RecoverySkippedReason carries every reason the controller emits today.
	const reasonTypeMatch = recoveryTypes.match(
		/export type RecoverySkippedReason =\s*([\s\S]*?);/,
	);
	s.check(reasonTypeMatch !== null, "RecoverySkippedReason declaration parses");
	const reasonSrc = reasonTypeMatch?.[1] ?? "";
	for (const literal of [
		"crdt-current-no-op",
		"recovery-lock-active",
		"recent-editor-activity",
		"frontmatter-ingest-blocked",
	]) {
		s.check(
			reasonSrc.includes(`"${literal}"`),
			`RecoverySkippedReason includes "${literal}"`,
		);
	}

	// Controller imports the typed exports from the taxonomy module
	// (production code does NOT redeclare a local copy of the branch type).
	s.check(
		reconciliation.includes("FrontmatterIngestBlockBranch"),
		"controller references FrontmatterIngestBlockBranch",
	);
	s.check(
		reconciliation.includes("RecoverySkippedFrontmatterData"),
		"controller uses the typed RecoverySkippedFrontmatterData payload",
	);
	s.check(
		!reconciliation.includes("type FrontmatterIngestBlockBranch ="),
		"controller does NOT redeclare FrontmatterIngestBlockBranch locally",
	);

	// Helper exists and the helper is the only emitter of the new reason
	// value (one declaration of the literal in the helper plus the typed
	// payload above brings the count to two; six call sites do not contain
	// the literal directly).
	s.check(
		reconciliation.includes("private recordFrontmatterIngestBlocked("),
		"ReconciliationController defines recordFrontmatterIngestBlocked helper",
	);
	s.check(
		reconciliation.includes('reason: "frontmatter-ingest-blocked"'),
		"helper builds payload with reason: \"frontmatter-ingest-blocked\"",
	);

	// Helper is invoked exactly six times (once per block site).
	const helperInvocations = reconciliation.match(/this\.recordFrontmatterIngestBlocked\(/g) ?? [];
	s.check(
		helperInvocations.length === 6,
		`recordFrontmatterIngestBlocked invoked exactly six times in controller (got ${helperInvocations.length})`,
	);

	// FLIGHT_TAXONOMY_VERSION is at 12 (bumped by the qa.trace.* -> debug.trace.* rename;
	// amplifier guard for recovery.amplification.quarantined). It is declared in
	// the published vocabulary module, not in the recorder.
	s.check(
		taxonomy.includes("export const FLIGHT_TAXONOMY_VERSION = 12"),
		"FLIGHT_TAXONOMY_VERSION at 12",
	);
}
await s.done();
