export {};

/**
 * Obsidian runtime members that the shipped API surface (obsidian.d.ts) does
 * not declare.
 *
 * WHY THIS FILE EXISTS: the product legitimately depends on a leaf identity
 * member that the public typings omit. Declaring it once here states the
 * assumption in one place, keeps the property optional where the runtime does
 * not guarantee it, and lets tsc check every read.
 */
declare module "obsidian" {
	interface WorkspaceLeaf {
		/**
		 * Obsidian's per-leaf identity, used for workspace serialisation. It is
		 * present on every real leaf but absent on hand-built leaf objects, so
		 * it is declared optional: callers must supply a fallback identity
		 * (they all fall back to the file path).
		 */
		readonly id?: string;
	}
}
