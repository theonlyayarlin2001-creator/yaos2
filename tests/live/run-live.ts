import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "../harness.ts";

const HOST = "http://127.0.0.1:8787";
const VAULT_ID = `yaos-integration-${Date.now().toString(36)}`;
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");

// Loader flags every spawned suite needs. tests/live/*.ts are TypeScript, so
// bare `node` cannot load them; this is the same loader tests/run-suites.mjs
// uses for the regression buckets, which keeps the two entry points on one
// dialect.
//
// JITI_ALIAS is deliberately NOT mirrored from tests/run-suites.mjs. None of
// its four entries applies to a live suite: they import only yjs,
// y-partyserver/provider, ws and src/sync/schema.ts (which is Obsidian-free),
// so the `obsidian` and `@shared` aliases would be dead; the `partyserver`
// mock must never be substituted into a suite whose whole point is talking to
// a real Worker; and "yjs" already resolves to the single root copy here
// (verified — no "Yjs was already imported" warning from a child).
const NODE_TS = ["--import", "jiti/register"];

async function waitForWorker(): Promise<void> {
	const deadline = Date.now() + 15_000;
	const probeUrl = `${HOST}/api/capabilities`;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(probeUrl, { method: "GET" });
			if (res.status > 0) return;
		} catch {
			// Worker not accepting connections yet.
		}
		await sleep(250);
	}

	throw new Error("Timed out waiting for wrangler dev to accept requests");
}

function runCommand(
	cmd: string,
	args: string[],
	token: string,
	extraEnv: Record<string, string> = {},
): Promise<void> {
	// Executor form, not `Promise.withResolvers`: tsconfig.tests.json pins `lib`
	// to ES2023 because package.json engines.node is ">=20", and withResolvers
	// is an ES2024 API absent from Node 20.
	return new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn(cmd, args, {
			cwd: resolve("."),
			stdio: "inherit",
			env: {
				...process.env,
				YAOS_TEST_HOST: HOST,
				SYNC_TOKEN: token,
				YAOS_TEST_VAULT_ID: VAULT_ID,
				...extraEnv,
			},
		});

		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			rejectPromise(
				new Error(
					`${cmd} ${args.join(" ")} exited with ` +
					(signal ? `signal ${signal}` : `code ${code}`),
				),
			);
		});
		child.on("error", rejectPromise);
	});
}

/** The subset of `POST /claim`'s body this driver asserts on. */
interface ClaimResponse {
	readonly obsidianUrl?: unknown;
}

/** The subset of `GET /api/capabilities` this driver asserts on. */
interface Capabilities {
	readonly claimed?: unknown;
	readonly authMode?: unknown;
}

async function claimServer() {
	const token = randomBytes(32).toString("hex");
	const res = await fetch(`${HOST}/claim`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ token }),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`claim failed (${res.status}): ${text}`);
	}

	const payload = (await res.json()) as ClaimResponse | null;
	if (typeof payload?.obsidianUrl !== "string" || !payload.obsidianUrl.startsWith("obsidian://yaos?")) {
		throw new Error("claim response missing Obsidian setup URL");
	}

	const capabilities = (await fetch(`${HOST}/api/capabilities`).then((result) => result.json())) as Capabilities | null;
	if (capabilities?.claimed !== true || capabilities?.authMode !== "claim") {
		throw new Error("server did not enter claimed mode");
	}

	return token;
}

async function resolveAuthToken(defaultEnvToken: string): Promise<string> {
	const capabilitiesRes = await fetch(`${HOST}/api/capabilities`);
	if (!capabilitiesRes.ok) {
		throw new Error(`capabilities probe failed (${capabilitiesRes.status})`);
	}
	const capabilities = (await capabilitiesRes.json()) as Capabilities | null;
	if (capabilities?.claimed === true && capabilities?.authMode === "env") {
		return defaultEnvToken;
	}
	return await claimServer();
}

async function main() {
	const persistDir = mkdtempSync(join(tmpdir(), "yaos-wrangler-"));
	const envToken = randomBytes(32).toString("hex");
	const wrangler = spawn(
		WRANGLER_BIN,
		[
			"dev",
			"--ip",
			"127.0.0.1",
			"--port",
			"8787",
			"--local-protocol",
			"http",
			"--persist-to",
			persistDir,
			"--log-level",
			"error",
			// Short ticket TTL for the ws-ticket-reconnect smoke test — allows
			// post-expiry reconnect to be exercised in seconds, not 5 minutes.
			"--var",
			"YAOS_TICKET_TTL_MS:8000",
		],
		{
			cwd: resolve("server"),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
			CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
			CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
			SYNC_TOKEN: envToken,
			},
		},
	);
	const wranglerExit = new Promise<void>((resolvePromise) => {
		wrangler.once("exit", () => resolvePromise());
	});

	let output = "";
	const capture = (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 8_000) {
			output = output.slice(-8_000);
		}
	};
	if (!wrangler.stdout || !wrangler.stderr) {
		throw new Error("wrangler dev did not expose piped stdout/stderr");
	}
	wrangler.stdout.on("data", capture);
	wrangler.stderr.on("data", capture);

	try {
		await waitForWorker();
		const token = await resolveAuthToken(envToken);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/schema-guard.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/provider-manual-connect.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/sync-client.ts",
			"smoke.md",
			"\n\nhello from worker integration pass 1",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/sync-client.ts",
			"smoke.md",
			"\n\nhello from worker integration pass 2",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/snapshots.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/hardening-worker.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/ws-ticket-reconnect.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/ws-admission-protocol.ts",
		], token);
	} catch (err) {
		if (output.trim()) {
			console.error("\n[wrangler output]");
			console.error(output.trim());
		}
		throw err;
	} finally {
		if (wrangler.exitCode === null) {
			wrangler.kill("SIGTERM");
		}
		await wranglerExit;
		rmSync(persistDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
