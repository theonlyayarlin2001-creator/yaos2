/**
 * Narrowing helpers for `MetaSemanticChange`.
 *
 * `MetaSemanticChange` is a discriminated union on `kind`, but the two ways a
 * test gets hold of one do not narrow it:
 *
 *   - `changes.find((c) => c.kind === "deleted")` returns the whole union,
 *     because a boolean predicate is not a type guard.
 *   - `changes[0]` returns the whole union (plus `undefined`).
 *
 * So every field read used to be written `(deleted as any).path`, which is worse
 * than merely untyped: `path` exists on four of the eight variants with the same
 * type and on none of the others, so a change that starts arriving as a
 * different kind reads `undefined` and the assertion fails with no hint that the
 * shape, not the value, is what moved.
 *
 * These return the requested variant or `undefined` — never a throw — so a
 * missing change stays a failed assertion rather than becoming a crashed suite.
 *
 * Lives under tests/mocks/ because that directory is declared test
 * infrastructure by tests/run-suites.mjs and therefore needs no suites.json
 * exclusion, unlike a file inside a suite bucket.
 */

import type { MetaSemanticChange } from "../../src/sync/fileMeta.ts";

/** The single variant of `MetaSemanticChange` discriminated by `K`. */
export type MetaChangeOf<K extends MetaSemanticChange["kind"]> = Extract<
	MetaSemanticChange,
	{ kind: K }
>;

/**
 * Type predicate over the `kind` discriminant.
 *
 * Use on a single value — `changes[0]`, or a variable a previous assertion
 * already checked — where a plain comparison would leave the union intact.
 */
export function isKind<K extends MetaSemanticChange["kind"]>(
	change: MetaSemanticChange | undefined,
	kind: K,
): change is MetaChangeOf<K> {
	return change?.kind === kind;
}

/** `Array.prototype.find` on the discriminant, narrowed to the one variant. */
export function findKind<K extends MetaSemanticChange["kind"]>(
	changes: readonly MetaSemanticChange[],
	kind: K,
): MetaChangeOf<K> | undefined {
	return changes.find((change): change is MetaChangeOf<K> => change.kind === kind);
}
