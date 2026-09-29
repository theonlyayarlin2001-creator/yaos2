/**
 * Pure readiness decision for action-relative server receipt waits.
 *
 * Candidate identity is the proof: the candidate captured after the action
 * must be the same candidate that a server state-vector echo confirmed.
 * Timestamp-only observations are deliberately insufficient because delayed
 * or duplicate historical echoes are not causally tied to the action.
 */
export interface ReceiptWaitState {
	candidateId: string | null;
	capturedAt: number | null;
	lastConfirmedCandidateId: string | null;
	lastConfirmedAt: number | null;
	hasUnconfirmedCandidate: boolean;
}

/**
 * Opaque, renderer-local anchor for a receipt wait that crosses an action
 * boundary (for example, releasing an offline hold). Callers must capture it
 * from the same device immediately before that action and pass it unchanged to
 * the checkpoint wait.
 */
export interface ReceiptWaitCheckpoint {
	checkpointAt: number;
	candidateId: string | null;
	candidateWasUnconfirmed: boolean;
}

export function isReceiptWaitReadyAfter(
	afterTimestamp: number,
	receipt: ReceiptWaitState,
): boolean {
	// A candidate captured after the action must be the candidate the server
	// confirmed. Keep the strict boundary: events at the supplied timestamp do
	// not establish that they occurred after the action.
	if (
		receipt.candidateId !== null &&
		receipt.capturedAt !== null &&
		receipt.capturedAt > afterTimestamp &&
		receipt.lastConfirmedCandidateId === receipt.candidateId
	) {
		return true;
	}

	return false;
}

/**
 * Readiness decision for a candidate that may already have been pending when
 * an action began. It deliberately admits only two proofs:
 *
 * 1. a different candidate captured strictly after the checkpoint, then
 *    confirmed; or
 * 2. the exact candidate that was unconfirmed at checkpoint capture, after it
 *    transitions to confirmed.
 *
 * A candidate already confirmed at capture is never accepted, even if a
 * delayed duplicate echo updates its timestamp. Matching confirmation IDs and
 * the unconfirmed-to-confirmed transition are both required so an old echo for
 * a superseded candidate cannot satisfy the wait.
 *
 * A checkpoint with `candidateId === null` always fails closed. Candidate IDs
 * are intentionally renderer-local and are not persisted, so an id-less
 * checkpoint after a restored candidate state cannot prove that a later
 * confirmation is causally related to the action.
 */
export function isReceiptWaitReadyAfterCheckpoint(
	checkpoint: ReceiptWaitCheckpoint,
	receipt: ReceiptWaitState,
): boolean {
	if (checkpoint.candidateId === null) return false;

	const currentCandidateIsConfirmed =
		receipt.candidateId !== null &&
		receipt.lastConfirmedCandidateId === receipt.candidateId &&
		receipt.hasUnconfirmedCandidate === false;

	if (!currentCandidateIsConfirmed) return false;

	const hasNewConfirmedCandidate =
		receipt.candidateId !== checkpoint.candidateId &&
		receipt.capturedAt !== null &&
		receipt.capturedAt > checkpoint.checkpointAt;
	if (hasNewConfirmedCandidate) return true;

	return (
		checkpoint.candidateWasUnconfirmed &&
		checkpoint.candidateId !== null &&
		receipt.candidateId === checkpoint.candidateId
	);
}
