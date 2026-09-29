import { randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const PRODUCT_PLUGIN_ID = "yaos";
export const HARNESS_PLUGIN_ID = "yaos-qa-harness";

export const PREPARE_VAULT_USAGE = `Usage: bun run qa:prepare --fixture <id> --dest <new-path> [--preset <name>]

Options:
  --fixture <id>     Direct fixture directory below qa/fixtures/vaults.
  --dest <new-path>  New vault directory. Its existing parent must be a directory.
                     The final path must not exist; existing directories and symlinks fail.
  --preset <name>    Plugin preset from qa/plugin-lock.json (default: minimal).
  --help, -h         Print this help.

qa:prepare never deletes, merges into, or overwrites a destination. --clean and
all other deletion options are rejected.`;

export interface PrepareVaultPaths {
	fixturesDir: string;
	harnessBuild: string;
	harnessManifest: string;
	yaosBuild: string;
	yaosManifest: string;
	pluginLock: string;
	blankWorkspace: string;
}

export const DEFAULT_PREPARE_VAULT_PATHS: PrepareVaultPaths = {
	fixturesDir: join(REPO_ROOT, "qa", "fixtures", "vaults"),
	harnessBuild: join(REPO_ROOT, "qa", "obsidian-harness", "main.js"),
	harnessManifest: join(REPO_ROOT, "qa", "obsidian-harness", "manifest.json"),
	yaosBuild: join(REPO_ROOT, "qa", "obsidian-harness", "product-main.js"),
	yaosManifest: join(REPO_ROOT, "manifest.json"),
	pluginLock: join(REPO_ROOT, "qa", "plugin-lock.json"),
	blankWorkspace: join(REPO_ROOT, "qa", "scripts", "blank-workspace.json"),
};

export interface PrepareVaultOptions {
	fixture: string;
	dest: string;
	preset?: string;
}

export interface PreparedVault {
	dest: string;
	fixture: string;
	preset: string;
	vaultId: string;
	presetPlugins: PluginEntry[];
}

interface PluginEntry {
	id: string;
	minVersion: string;
}

interface PluginLock {
	presets: Record<string, PluginEntry[]>;
}

interface PluginManifest {
	id: string;
}

export class PrepareVaultError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrepareVaultError";
	}
}

interface ParsedPrepareVaultArgs extends PrepareVaultOptions {
	help: false;
}

interface PrepareVaultHelpArgs {
	help: true;
}

export function parsePrepareVaultArgs(args: string[]): ParsedPrepareVaultArgs | PrepareVaultHelpArgs {
	let fixture: string | undefined;
	let dest: string | undefined;
	let preset: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--clean" || arg.startsWith("--clean=")) {
			throw new PrepareVaultError("--clean is not supported: qa:prepare never deletes a destination.");
		}
		if (arg !== "--fixture" && arg !== "--dest" && arg !== "--preset") {
			throw new PrepareVaultError(`Unknown argument: ${arg}`);
		}

		const value = args[i + 1];
		if (!value || value.startsWith("--")) {
			throw new PrepareVaultError(`${arg} requires a value.`);
		}
		i++;

		if (arg === "--fixture") fixture = value;
		if (arg === "--dest") dest = value;
		if (arg === "--preset") preset = value;
	}

	if (!fixture || !dest) {
		throw new PrepareVaultError("Both --fixture and --dest are required.");
	}

	return { fixture, dest, preset: preset ?? "minimal", help: false };
}

/**
 * Builds a QA vault only in a newly created final destination. The caller's
 * existing parent and sibling paths are read-only from this function's point
 * of view; no cleanup or rollback deletes any path.
 */
export async function prepareVault(
	options: PrepareVaultOptions,
	paths: PrepareVaultPaths = DEFAULT_PREPARE_VAULT_PATHS,
): Promise<PreparedVault> {
	const fixtureDir = await resolveFixtureDir(options.fixture, paths.fixturesDir);
	const dest = await validateNewDestination(options.dest);
	const preset = options.preset ?? "minimal";
	const preflight = await preflightInputs(paths, preset);

	// This non-recursive call establishes that this invocation owns the final
	// destination. Everything written afterwards is below that new directory.
	await mkdir(dest);
	await copyFixtureContents(fixtureDir, dest);

	const obsidianDir = join(dest, ".obsidian");
	await mkdir(obsidianDir, { recursive: true });
	await writeJson(join(obsidianDir, "app.json"), { legacyEditor: false, livePreview: true });
	await writeJson(join(obsidianDir, "appearance.json"), { theme: "obsidian" });
	await writeFile(join(obsidianDir, "workspace.json"), preflight.workspaceBytes, "utf8");

	const yaosPluginDir = join(obsidianDir, "plugins", PRODUCT_PLUGIN_ID);
	await mkdir(yaosPluginDir, { recursive: true });
	await copyFile(paths.yaosManifest, join(yaosPluginDir, "manifest.json"));
	await copyFile(paths.yaosBuild, join(yaosPluginDir, "main.js"));

	// Every preparation receives a new room identity. This must remain random:
	// deterministic workspace/configuration bytes must not cause runs to share
	// a sync room accidentally.
	const vaultId = randomUUID();
	await writeJson(join(yaosPluginDir, "data.json"), createYaosSettings(vaultId));

	const harnessPluginDir = join(obsidianDir, "plugins", HARNESS_PLUGIN_ID);
	await mkdir(harnessPluginDir, { recursive: true });
	await copyFile(paths.harnessManifest, join(harnessPluginDir, "manifest.json"));
	await copyFile(paths.harnessBuild, join(harnessPluginDir, "main.js"));

	// The destination is fresh, so construct rather than merge this list. Its
	// fixed order is required by the harness runtime guard.
	await writeJson(join(obsidianDir, "community-plugins.json"), [PRODUCT_PLUGIN_ID, HARNESS_PLUGIN_ID]);

	return { dest, fixture: options.fixture, preset, vaultId, presetPlugins: preflight.presetPlugins };
}

export async function listFixtureIds(fixturesDir: string): Promise<string[]> {
	const entries = await readdir(fixturesDir, { withFileTypes: true });
	return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

async function resolveFixtureDir(fixture: string, fixturesDir: string): Promise<string> {
	if (
		fixture.length === 0 ||
		fixture === "." ||
		fixture === ".." ||
		fixture.includes("/") ||
		fixture.includes("\\")
	) {
		throw new PrepareVaultError(`Invalid fixture ID: ${JSON.stringify(fixture)}. Use a direct known fixture directory name.`);
	}

	const fixtureIds = await listFixtureIds(fixturesDir);
	if (!fixtureIds.includes(fixture)) {
		throw new PrepareVaultError(
			`Unknown fixture ID: ${JSON.stringify(fixture)}. Available fixtures: ${fixtureIds.join(", ") || "(none)"}.`,
		);
	}

	const fixtureDir = join(fixturesDir, fixture);
	const stat = await lstat(fixtureDir);
	if (!stat.isDirectory()) {
		throw new PrepareVaultError(`Fixture is not a directory: ${fixture}`);
	}
	return fixtureDir;
}

async function validateNewDestination(dest: string): Promise<string> {
	const destAbs = resolve(dest);
	if (await pathExists(destAbs)) {
		throw new PrepareVaultError(
			`Destination already exists: ${destAbs}. Refusing to merge into, overwrite, or delete it.`,
		);
	}

	const parent = dirname(destAbs);
	const parentStat = await lstatIfExists(parent);
	if (!parentStat?.isDirectory()) {
		throw new PrepareVaultError(`Destination parent must already exist as a directory: ${parent}`);
	}
	return destAbs;
}

async function preflightInputs(paths: PrepareVaultPaths, preset: string): Promise<{
	workspaceBytes: string;
	presetPlugins: PluginEntry[];
}> {
	await Promise.all([
		assertRegularFile(paths.yaosBuild, "QA-enabled YAOS build (run npm run build:qa-product)"),
		assertRegularFile(paths.yaosManifest, "YAOS manifest"),
		assertRegularFile(paths.harnessBuild, "QA harness build (run npm run build:harness)"),
		assertRegularFile(paths.harnessManifest, "QA harness manifest"),
	]);

	const [workspaceBytes, yaosManifestText, harnessManifestText, lockText] = await Promise.all([
		readFile(paths.blankWorkspace, "utf8"),
		readFile(paths.yaosManifest, "utf8"),
		readFile(paths.harnessManifest, "utf8"),
		readFile(paths.pluginLock, "utf8"),
	]);
	validateBlankWorkspace(workspaceBytes);
	validatePluginManifest(yaosManifestText, PRODUCT_PLUGIN_ID, "YAOS");
	validatePluginManifest(harnessManifestText, HARNESS_PLUGIN_ID, "QA harness");

	let pluginLock: PluginLock;
	try {
		pluginLock = JSON.parse(lockText) as PluginLock;
	} catch {
		throw new PrepareVaultError(`Plugin lock is not valid JSON: ${paths.pluginLock}`);
	}
	if (!isPluginLock(pluginLock)) {
		throw new PrepareVaultError(`Plugin lock has an invalid preset structure: ${paths.pluginLock}`);
	}
	if (!Object.prototype.hasOwnProperty.call(pluginLock.presets, preset)) {
		throw new PrepareVaultError(`Unknown plugin preset: ${JSON.stringify(preset)}`);
	}

	return { workspaceBytes, presetPlugins: pluginLock.presets[preset]! };
}

function validateBlankWorkspace(workspaceBytes: string): void {
	let workspace: unknown;
	try {
		workspace = JSON.parse(workspaceBytes) as unknown;
	} catch {
		throw new PrepareVaultError("The checked-in blank workspace template is not valid JSON.");
	}
	if (!isRecord(workspace) || !Array.isArray(workspace.lastOpenFiles) || workspace.lastOpenFiles.length !== 0) {
		throw new PrepareVaultError("The blank workspace template must contain an empty lastOpenFiles array.");
	}
	if (containsMarkdownLeafOrFilePath(workspace)) {
		throw new PrepareVaultError("The blank workspace template must not contain an active markdown leaf or file path.");
	}
	if (!workspaceBytes.endsWith("\n")) {
		throw new PrepareVaultError("The blank workspace template must end with a newline for stable bytes.");
	}
}

function containsMarkdownLeafOrFilePath(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsMarkdownLeafOrFilePath);
	if (!isRecord(value)) return false;
	if (value.type === "markdown") return true;
	for (const [key, nested] of Object.entries(value)) {
		if ((key === "file" || key === "path") && typeof nested === "string" && nested.length > 0) return true;
		if (containsMarkdownLeafOrFilePath(nested)) return true;
	}
	return false;
}

function validatePluginManifest(text: string, expectedId: string, label: string): void {
	let manifest: PluginManifest;
	try {
		manifest = JSON.parse(text) as PluginManifest;
	} catch {
		throw new PrepareVaultError(`${label} manifest is not valid JSON.`);
	}
	if (manifest.id !== expectedId) {
		throw new PrepareVaultError(`${label} manifest must declare plugin id ${JSON.stringify(expectedId)}.`);
	}
}

function isPluginLock(value: unknown): value is PluginLock {
	return isRecord(value) && isRecord(value.presets) && Object.values(value.presets).every(entries =>
		Array.isArray(entries) && entries.every(entry =>
			isRecord(entry) && typeof entry.id === "string" && typeof entry.minVersion === "string",
		),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function copyFixtureContents(fixtureDir: string, dest: string): Promise<void> {
	const entries = await readdir(fixtureDir);
	for (const entry of entries) {
		await cp(join(fixtureDir, entry), join(dest, entry), {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
	}
}

function createYaosSettings(vaultId: string): Record<string, unknown> {
	return {
		host: "",
		token: "",
		vaultId,
		deviceName: "qa-device-a",
		// debug:true is what starts the flight recorder. There is no separate
		// trace switch any more — QA scenarios depend on this being on.
		debug: true,
		frontmatterGuardEnabled: true,
		excludePatterns: "",
		maxFileSizeKB: 2048,
		externalEditPolicy: "always",
		enableAttachmentSync: true,
		attachmentSyncExplicitlyConfigured: false,
		maxAttachmentSizeKB: 10240,
		attachmentConcurrency: 1,
		showRemoteCursors: true,
		updateRepoUrl: "",
		updateRepoBranch: "main",
		qaDebugMode: true,
	};
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertRegularFile(path: string, label: string): Promise<void> {
	const stat = await lstatIfExists(path);
	if (!stat?.isFile()) throw new PrepareVaultError(`Missing ${label}: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
	return (await lstatIfExists(path)) !== null;
}

async function lstatIfExists(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
