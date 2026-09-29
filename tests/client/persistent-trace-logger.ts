import type { App } from "obsidian";
import { PersistentTraceLogger } from "../../src/telemetry/debug/trace";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("persistent-trace-logger");

function makeFakeApp() {
	const writes = new Map<string, string>();
	return {
		writes,
		app: partialOf<App>({
			vault: {
				configDir: ".obsidian",
				adapter: {
					mkdir: async () => {},
					exists: async () => true,
					write: async (path: string, data: string) => {
						writes.set(path, data);
					},
					append: async (path: string, data: string) => {
						writes.set(path, (writes.get(path) ?? "") + data);
					},
				},
			},
		}),
	};
}

s.section("Test 1: persistent trace logger drops instead of growing unbounded");
{
	const fake = makeFakeApp();
	const logger = new PersistentTraceLogger(fake.app, {
		enabled: true,
		deviceName: "Device",
		vaultId: "vault",
	});

	for (let i = 0; i < 2_500; i++) {
		logger.record("test", "storm", { i, path: `Private/${i}.md` });
	}
	await logger.shutdown();

	const sessionLog = [...fake.writes.entries()]
		.find(([path]) => path.endsWith(".ndjson") && !path.endsWith("-state.ndjson"))?.[1] ?? "";
	const lines = sessionLog.trim().split("\n").filter(Boolean);
	const dropped = lines
		.map((line) => JSON.parse(line))
		.find((event) => event.msg === "trace-events-dropped");

	s.check(Boolean(dropped), "trace storm emits a dropped-event marker");
	s.check(dropped?.details?.count > 0, "dropped-event marker reports how many events were dropped");
	s.check(lines.length <= 2_002, "trace storm log stays bounded after marker and shutdown event");
}
await s.done();
