/**
 * Hard cap on markdown conflict-artifact minting.
 *
 * Content fingerprints cannot stop a loop whose body mutates every cycle
 * (Templater append, concurrent forceReplace). Count of files created for
 * a source path — and in the session — is the last line.
 *
 * Per-path 2 = one CRDT sibling + one disk sibling, the bound-file
 * three-way pair. Session 20 bounds a vault-wide storm.
 */
export const MAX_MARKDOWN_CONFLICT_ARTIFACTS_PER_PATH = 2;
export const MAX_MARKDOWN_CONFLICT_ARTIFACTS_SESSION = 20;

export type ConflictArtifactCapReason = "ok" | "path-cap" | "session-cap";

export function evaluateConflictArtifactCap(input: {
	artifactsForPath: number;
	artifactsInSession: number;
}): { allowed: boolean; reason: ConflictArtifactCapReason } {
	if (input.artifactsInSession >= MAX_MARKDOWN_CONFLICT_ARTIFACTS_SESSION) {
		return { allowed: false, reason: "session-cap" };
	}
	if (input.artifactsForPath >= MAX_MARKDOWN_CONFLICT_ARTIFACTS_PER_PATH) {
		return { allowed: false, reason: "path-cap" };
	}
	return { allowed: true, reason: "ok" };
}
