/**
 * Ambient declarations for the Bun APIs qa/ relies on.
 *
 * qa/ scripts run under `bun run`, not the Obsidian renderer, but bun-types is
 * not a dependency of this repo. Only the members actually used are declared.
 */

interface ImportMeta {
	/** Bun: true when this module is the entrypoint the process was started with. */
	readonly main: boolean;
}
