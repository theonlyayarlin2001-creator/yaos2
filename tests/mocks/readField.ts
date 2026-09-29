/**
 * Field reads off values whose shape TypeScript cannot know.
 *
 * Three distinct places in the suites hold a genuinely untyped value:
 *
 *   - `Response.json()` is `unknown`, and correctly so — nothing guarantees what
 *     a live Worker returned.
 *   - `Y.Map.get()` on an untyped map is `unknown`, and the schema-v2 migration
 *     tests deliberately store pre-v3 *flat* objects with no Yjs type to narrow
 *     through.
 *   - A debug endpoint body is a product contract, but it still arrives over HTTP
 *     as bytes.
 *
 * The old answer was `(body as any).persistence.status`, which is worse than
 * untyped: it invents a shape at the one boundary where the test's whole job is
 * to establish it, so a server that renamed the field reads `undefined` and the
 * assertion fails with no hint that the shape, not the value, is what moved.
 *
 * `readField` keeps every result `unknown`, which forces each assertion to check
 * what it claims, and returns `undefined` for any missing or non-object link in
 * the path so a shape regression fails an assertion instead of throwing.
 */

/**
 * Walk `path` through `value`, returning `unknown`.
 *
 * Goes through property descriptors rather than `value[key]` because the `in`
 * operator only narrows `unknown` for a *literal* key; a `string` parameter puts
 * an implicit `any` back on the index read, which is the thing this exists to
 * remove.  Own properties only — every shape read here is a plain data object or
 * a parsed JSON body, never something serving fields off a prototype.
 */
export function readField(value: unknown, ...path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (typeof current !== "object" || current === null) return undefined;
		current = Object.getOwnPropertyDescriptor(current, key)?.value;
	}
	return current;
}

/**
 * `readField`, narrowed to `number`, or `undefined` if it is anything else.
 *
 * Exists because the numeric assertions (`saves > 0`) cannot be written against
 * `unknown` at all, and inlining `typeof x === "number" && x > 0` at each site
 * buries the comparison the test is actually making.
 */
export function readNumber(value: unknown, ...path: string[]): number | undefined {
	const found = readField(value, ...path);
	return typeof found === "number" ? found : undefined;
}
