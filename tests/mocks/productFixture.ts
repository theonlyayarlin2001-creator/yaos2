/**
 * Partially-implemented stand-ins for product types.
 *
 * Constructors like `DiskMirror`'s take whole product objects — `App`,
 * `VaultSync`, `EditorBindingManager` — but reach only a handful of members on
 * each.  A suite cannot reasonably implement the rest, so historically it wrote
 * `new DiskMirror(fakeApp as any, fakeVaultSync as any, ...)`, which switches the
 * compiler off across the entire seam between the test and the product.  Two
 * distinct bugs hide behind that cast:
 *
 *   - A member renamed or removed in src/ leaves the fixture supplying a key
 *     nobody reads and the production code reading a key nobody supplies, and
 *     the suite still compiles.
 *   - The stubs themselves go unchecked.  A `getTextForPath` returning
 *     `{ toString() {} }` where the product promises a `Y.Text`, or an
 *     `adapter.stat` returning `{ mtime, size }` where the product promises a
 *     whole `Stat`, typechecks fine behind a cast — and then diverges from the
 *     real thing in precisely the way the test claims to verify.
 *
 * `Fixture<T>` closes both.  Prefer `partialOf`; reach for `fixtureOf` only when
 * something genuinely does `instanceof`.
 */

/** Recursion budget.  `Prev[D]` is `D - 1`; `Prev[0]` is `never`, which stops it. */
type Prev = [never, 0, 1, 2, 3];

/** Depths `Fixture` descends before demanding an exact type. */
type Depth = 0 | 1 | 2 | 3 | 4;

/**
 * A partial view of `T`, to a bounded depth, with function members exact.
 *
 * Three rules, each earning its keep:
 *
 *   - **Optional at every level.** A fixture supplies what the code under test
 *     reaches and nothing else, and the nesting is real: the deepest thing the
 *     suites here stub is `app.vault.adapter.stat`, so a plain `Partial<T>`
 *     (which would demand a whole `Vault`, then a whole `DataAdapter`) is not
 *     enough.
 *   - **Function members keep their exact type.** This is the half that catches
 *     lying stubs: a stub whose signature does not match what the product
 *     promises becomes a compile error rather than a runtime divergence.
 *   - **Keys must exist on `T`.** A member renamed in src/ breaks the fixture
 *     instead of leaving it feeding a key nobody reads.
 *
 * The depth bound is what keeps this usable.  `VaultSync.ydoc` is a `Y.Doc` and
 * the Yjs types are mutually recursive, so an unbounded deep-partial hits
 * TypeScript's instantiation-depth limit.  Past the budget the type is required
 * exactly, which is right anyway — nobody hand-builds a partial `Y.Doc` five
 * levels down; they pass a real one.
 */
export type Fixture<T, D extends Depth = 4> = [Prev[D]] extends [never]
	? T
	: {
		[K in keyof T]?: T[K] extends (...args: never[]) => unknown
			? T[K]
			: T[K] extends object
				? Fixture<T[K], Prev[D]>
				: T[K];
	};

/**
 * A checked partial standing in for the whole of `T`.
 *
 * This is the default.  It needs only `import type { T }`, so it adds no runtime
 * module load: `src/sync/editorBinding.ts` imports `editorInfoField` from
 * obsidian (absent from tests/mocks/obsidian.ts) plus @codemirror/state,
 * @codemirror/view and y-codemirror.next, so merely reaching
 * `EditorBindingManager.prototype` would drag all of that into a client suite
 * that has no use for it.  Nothing in these suites does `instanceof` on the
 * objects handed to a constructor, so the prototype buys nothing.
 *
 * `T` is always written explicitly — `partialOf<VaultSync>({ ... })` — because
 * it is the whole point: it names the product type the stub is claiming to be,
 * and it is what `Fixture` checks the fields against.
 *
 * The single `as` is the irreducible claim, "this partial stands in for the
 * whole", and it is confined here, downstream of `Fixture<T>` having checked
 * every key and every signature.
 */
export function partialOf<T extends object>(fields: Fixture<T>): T {
	return fields as T;
}

/**
 * Like `partialOf`, but the result is a real (uninitialised) instance of `ctor`,
 * so `instanceof` holds.
 *
 * Use ONLY when something under test does an `instanceof` check.  It forces a
 * value import of the class, and therefore a runtime load of its whole module
 * graph — see `partialOf` for why that is not free.  Members the fixture does
 * not supply resolve to the real prototype method and throw on the
 * uninitialised state, which is louder than being silently absent.
 */
export function fixtureOf<T extends object>(ctor: { prototype: T }, fields: Fixture<T>): T {
	return Object.assign(Object.create(ctor.prototype) as T, fields);
}
