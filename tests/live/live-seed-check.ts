import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { describeFatalFrame, onFatalFrame } from "./fatalFrame.ts";

const host = process.env.YAOS_TEST_HOST;
const token = process.env.SYNC_TOKEN;
const room = process.env.YAOS_TEST_VAULT_ID;
const mode = process.env.YAOS_TEST_MODE ?? "seed";

if (!host || !token || !room) {
	throw new Error("YAOS_TEST_HOST, SYNC_TOKEN, and YAOS_TEST_VAULT_ID are required");
}

const ydoc = new Y.Doc();
const provider = new YSyncProvider(host, room, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(room)}`,
	params: { token, schemaVersion: String(SCHEMA_VERSION) },
	WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
	connect: true,
});

const timeout = setTimeout(() => {
	console.error("Timed out waiting for sync");
	provider.destroy();
	ydoc.destroy();
	process.exit(1);
}, 15_000);

function fail(msg: string, details?: unknown): void {
	console.error(msg, details ?? "");
	clearTimeout(timeout);
	provider.destroy();
	ydoc.destroy();
	process.exit(1);
}

// The Worker sends its fatal rejection frame on the "__YPS:" channel, which the
// provider re-emits as "custom-message" (see ./fatalFrame.ts). Registered
// before the first await so it cannot miss a frame sent during admission.
onFatalFrame(provider, (frame) => {
	fail(`Server rejected the connection: ${describeFatalFrame(frame)}`, frame);
});

provider.on("sync", (synced: boolean) => {
	if (!synced) return;

	const sys = ydoc.getMap("sys");
	const pathToId = ydoc.getMap<string>("pathToId");
	const idToText = ydoc.getMap<Y.Text>("idToText");
	const meta = ydoc.getMap("meta");

	if (mode === "seed") {
		ydoc.transact(() => {
			sys.set("initialized", true);
			sys.set("schemaVersion", SCHEMA_VERSION);
			let fileId = pathToId.get("redeploy-test.md");
			if (!fileId) {
				fileId = "redeploy-test-file";
				pathToId.set("redeploy-test.md", fileId);
				idToText.set(fileId, new Y.Text());
			}
			const ytext = idToText.get(fileId);
			if (!ytext) {
				throw new Error("Missing Y.Text for redeploy-test.md");
			}
			ytext.delete(0, ytext.length);
			ytext.insert(
				0,
				`YAOS redeploy durability test\nts=${new Date().toISOString()}\nvault=${room}\nmode=${mode}`,
			);
			meta.set(fileId, { path: "redeploy-test.md", mtime: Date.now() });
		});
	}

	setTimeout(() => {
		const files = [...pathToId.keys()];
		const fileId = pathToId.get("redeploy-test.md");
		const ytext = fileId ? idToText.get(fileId) : null;
		const payload = {
			mode,
			room,
			schemaVersion: sys.get("schemaVersion"),
			initialized: sys.get("initialized"),
			files,
			text: ytext?.toString() ?? null,
		};
		console.log(JSON.stringify(payload, null, 2));
		clearTimeout(timeout);
		provider.destroy();
		ydoc.destroy();
		process.exit(0);
	}, mode === "seed" ? 1500 : 500);
});
