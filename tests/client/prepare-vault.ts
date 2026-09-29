import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_PREPARE_VAULT_PATHS,
	type PrepareVaultPaths,
	PrepareVaultError,
	parsePrepareVaultArgs,
	prepareVault,
} from "../../qa/scripts/prepare-vault-lib";
import { suite } from "../harness.ts";

const s = suite("prepare-vault");

async function expectPrepareError(action: () => Promise<unknown>, includes: string): Promise<void> {
	await assert.rejects(action, (error: unknown) =>
		error instanceof PrepareVaultError && error.message.includes(includes),
	);
}

async function makeLayout(): Promise<{ root: string; paths: PrepareVaultPaths; vaultParent: string; workspaceBytes: string }> {
	const root = await mkdtemp(join(tmpdir(), "yaos-prepare-vault-"));
	const fixturesDir = join(root, "fixtures");
	const fixtureDir = join(fixturesDir, "001-known");
	const vaultParent = join(root, "vaults");
	const workspaceBytes = await readFile(DEFAULT_PREPARE_VAULT_PATHS.blankWorkspace, "utf8");

	await mkdir(fixtureDir, { recursive: true });
	await mkdir(vaultParent);
	await writeFile(join(fixtureDir, "fixture-note.md"), "# fixture\n", "utf8");
	await writeFile(join(root, "product-main.js"), "// QA product\n", "utf8");
	await writeFile(join(root, "harness-main.js"), "// QA harness\n", "utf8");
	await writeFile(join(root, "yaos-manifest.json"), "{\"id\":\"yaos\"}\n", "utf8");
	await writeFile(join(root, "harness-manifest.json"), "{\"id\":\"yaos-qa-harness\"}\n", "utf8");
	await writeFile(join(root, "plugin-lock.json"), "{\"presets\":{\"minimal\":[]}}\n", "utf8");
	await writeFile(join(root, "blank-workspace.json"), workspaceBytes, "utf8");

	return {
		root,
		vaultParent,
		workspaceBytes,
		paths: {
			fixturesDir,
			yaosBuild: join(root, "product-main.js"),
			yaosManifest: join(root, "yaos-manifest.json"),
			harnessBuild: join(root, "harness-main.js"),
			harnessManifest: join(root, "harness-manifest.json"),
			pluginLock: join(root, "plugin-lock.json"),
			blankWorkspace: join(root, "blank-workspace.json"),
		},
	};
}

function containsMarkdownLeafOrFilePath(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsMarkdownLeafOrFilePath);
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.type === "markdown") return true;
	return Object.entries(record).some(([key, nested]) => {
		const hasFilePath = (key === "file" || key === "path") && typeof nested === "string" && nested.length > 0;
		return hasFilePath || containsMarkdownLeafOrFilePath(nested);
	});
}

s.section("QA vault preparation regressions");

s.test("rejects --clean before any filesystem mutation", async () => {
	assert.throws(
		() => parsePrepareVaultArgs(["--fixture", "001-known", "--dest", "/tmp/new-vault", "--clean"]),
		(error: unknown) => error instanceof PrepareVaultError && error.message.includes("never deletes"),
	);
});

s.test("never merges into or overwrites existing destinations", async () => {
	const { paths, vaultParent } = await makeLayout();
	const destination = join(vaultParent, "already-there");
	const sibling = join(vaultParent, "unrelated-sibling.txt");
	await mkdir(destination);
	await writeFile(join(destination, "sentinel.txt"), "preserve me", "utf8");
	await writeFile(sibling, "sibling survives", "utf8");

	await expectPrepareError(
		() => prepareVault({ fixture: "001-known", dest: destination }, paths),
		"Destination already exists",
	);
	assert.equal(await readFile(join(destination, "sentinel.txt"), "utf8"), "preserve me");
	assert.equal(await readFile(sibling, "utf8"), "sibling survives");

	const emptyDestination = join(vaultParent, "empty-directory");
	await mkdir(emptyDestination);
	await expectPrepareError(
		() => prepareVault({ fixture: "001-known", dest: emptyDestination }, paths),
		"Destination already exists",
	);

	const symlinkDestination = join(vaultParent, "dangling-link");
	await symlink(join(vaultParent, "missing-target"), symlinkDestination);
	await expectPrepareError(
		() => prepareVault({ fixture: "001-known", dest: symlinkDestination }, paths),
		"Destination already exists",
	);
});

s.test("rejects traversal and path-like fixture IDs without creating a destination", async () => {
	const { paths, vaultParent } = await makeLayout();
	const traversalDestination = join(vaultParent, "traversal-target");
	await expectPrepareError(
		() => prepareVault({ fixture: "../001-known", dest: traversalDestination }, paths),
		"Invalid fixture ID",
	);
	await assert.rejects(async () => readFile(traversalDestination), { code: "ENOENT" });

	const pathLikeDestination = join(vaultParent, "path-like-target");
	await expectPrepareError(
		() => prepareVault({ fixture: "nested/fixture", dest: pathLikeDestination }, paths),
		"Invalid fixture ID",
	);
	await assert.rejects(async () => readFile(pathLikeDestination), { code: "ENOENT" });
});

s.test("writes the checked-in blank workspace bytes without file state or vault paths", async () => {
	const { paths, vaultParent, workspaceBytes } = await makeLayout();
	const destination = join(vaultParent, "workspace-vault");
	await prepareVault({ fixture: "001-known", dest: destination }, paths);

	const bytes = await readFile(join(destination, ".obsidian", "workspace.json"), "utf8");
	assert.equal(bytes, workspaceBytes);
	assert.equal(bytes.includes(destination), false);
	assert.equal(bytes.includes(vaultParent), false);
	const workspace = JSON.parse(bytes) as Record<string, unknown>;
	assert.deepEqual(workspace.lastOpenFiles, []);
	assert.equal(containsMarkdownLeafOrFilePath(workspace), false);
});

s.test("creates fresh random vault IDs while keeping plugin order deterministic", async () => {
	const { paths, vaultParent } = await makeLayout();
	const first = await prepareVault({ fixture: "001-known", dest: join(vaultParent, "first") }, paths);
	const second = await prepareVault({ fixture: "001-known", dest: join(vaultParent, "second") }, paths);
	assert.notEqual(first.vaultId, second.vaultId);

	const firstSettings = JSON.parse(await readFile(join(first.dest, ".obsidian", "plugins", "yaos", "data.json"), "utf8")) as {
		vaultId: string;
	};
	const enabledPlugins = JSON.parse(await readFile(join(first.dest, ".obsidian", "community-plugins.json"), "utf8")) as string[];
	assert.equal(firstSettings.vaultId, first.vaultId);
	assert.deepEqual(enabledPlugins, ["yaos", "yaos-qa-harness"]);
});
await s.done();
