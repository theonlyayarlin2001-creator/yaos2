import * as Y from "yjs";
import {
	makeSvEchoCustomMessage,
	makeSvEchoCustomMessageForDoc,
	trySendSvEcho,
	trySendSvEchoStateVector,
} from "../../server/src/svEcho";
import { parseSvEchoMessage } from "../../src/sync/svEchoMessage";
import { isStateVectorGe } from "../../src/sync/stateVectorAck";
import * as clientProtocol from "../../src/sync/svEchoProtocol";
import * as serverProtocol from "../../server/src/svEchoProtocol";
import { suite } from "../harness.ts";

const s = suite("server-sv-echo");

function buildDocWithClients(count: number): Y.Doc {
	const merged = new Y.Doc();
	for (let i = 0; i < count; i++) {
		const client = new Y.Doc();
		client.getText(`note-${i}`).insert(0, `hello-${i}`);
		Y.applyUpdate(merged, Y.encodeStateAsUpdate(client));
		client.destroy();
	}
	return merged;
}

s.section("Test 1: payload shape and client parser round-trip");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "server receipt payload");
	const serverSv = Y.encodeStateVector(doc);
	const payload = makeSvEchoCustomMessage(serverSv);
	const parsedJson = JSON.parse(payload) as Record<string, unknown>;
	const parsedSv = parseSvEchoMessage(payload);

	s.check(parsedJson.type === clientProtocol.SV_ECHO_TYPE, "payload type is namespaced");
	s.check(parsedJson.schema === clientProtocol.SV_ECHO_SCHEMA, "payload schema is 1");
	s.check(typeof parsedJson.sv === "string" && parsedJson.sv.length > 0, "payload has base64 sv");
	s.check(parsedSv !== null, "client parser accepts server payload");
	s.check(parsedSv !== null && isStateVectorGe(parsedSv, serverSv), "parsed SV dominates original server SV");
	s.check(parsedSv !== null && isStateVectorGe(serverSv, parsedSv), "parsed SV equals original server SV");

	doc.destroy();
}

s.section("Test 2: client/server protocol constants stay aligned");
{
	s.check(serverProtocol.SV_ECHO_TYPE === clientProtocol.SV_ECHO_TYPE, "type constant matches client");
	s.check(serverProtocol.SV_ECHO_SCHEMA === clientProtocol.SV_ECHO_SCHEMA, "schema constant matches client");
	s.check(
		serverProtocol.MAX_SV_ECHO_BASE64_BYTES === clientProtocol.MAX_SV_ECHO_BASE64_BYTES,
		"max base64 size matches client",
	);
}

s.section("Test 3: doc helper encodes current doc state vector");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "doc helper");
	const payload = makeSvEchoCustomMessageForDoc(doc);
	const parsedSv = parseSvEchoMessage(payload);
	const currentSv = Y.encodeStateVector(doc);

	s.check(parsedSv !== null, "doc helper payload parses");
	s.check(parsedSv !== null && isStateVectorGe(parsedSv, currentSv), "doc helper SV dominates current doc SV");
	s.check(parsedSv !== null && isStateVectorGe(currentSv, parsedSv), "doc helper SV equals current doc SV");

	doc.destroy();
}

s.section("Test 4: large state vector uses byte-safe base64");
{
	const doc = buildDocWithClients(1800);
	const payload = makeSvEchoCustomMessageForDoc(doc);
	const parsedSv = parseSvEchoMessage(payload);
	const currentSv = Y.encodeStateVector(doc);

	s.check(payload.length > 8192, "large SV payload exceeds one base64 chunk");
	s.check(parsedSv !== null, "large SV payload parses");
	s.check(parsedSv !== null && isStateVectorGe(parsedSv, currentSv), "large parsed SV dominates current doc SV");
	s.check(parsedSv !== null && isStateVectorGe(currentSv, parsedSv), "large parsed SV equals current doc SV");

	doc.destroy();
}

s.section("Test 5: trySendSvEcho frames custom message and reports bytes");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "send helper");
	const sent: string[] = [];
	const result = trySendSvEcho({
		readyState: 1,
		send(message: string) {
			sent.push(message);
		},
	}, doc, "baseline");

	s.check(result.ok, "send helper returns ok=true on send success");
	s.check(result.kind === "baseline", "send helper preserves kind");
	s.check(result.bytes > 0, "send helper reports framed message bytes");
	s.check(sent.length === 1, "send helper sends exactly one message");
	const framed = sent[0] ?? "";
	s.check(framed.startsWith("__YPS:"), "send helper uses y-partyserver custom-message prefix");
	s.check(parseSvEchoMessage(framed.slice("__YPS:".length)) !== null, "framed payload parses after prefix removal");

	doc.destroy();
}

s.section("Test 6: trySendSvEcho respects readyState before sending");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "ready state");
	const sent: string[] = [];
	const sendable = (readyState: number | undefined) => ({
		...(readyState === undefined ? {} : { readyState }),
		send(message: string) {
			sent.push(message);
		},
	});

	const connecting = trySendSvEcho(sendable(0), doc, "postApply");
	const open = trySendSvEcho(sendable(1), doc, "postApply");
	const closing = trySendSvEcho(sendable(2), doc, "postApply");
	const closed = trySendSvEcho(sendable(3), doc, "postApply");
	const unknown = trySendSvEcho(sendable(undefined), doc, "postApply");

	s.check(!connecting.ok && connecting.failure === "not_open", "CONNECTING => no send, not_open");
	s.check(open.ok, "OPEN => send attempted");
	s.check(!closing.ok && closing.failure === "not_open", "CLOSING => no send, not_open");
	s.check(!closed.ok && closed.failure === "not_open", "CLOSED => no send, not_open");
	s.check(unknown.ok, "undefined readyState => send attempted");
	s.check(sent.length === 2, "only OPEN and undefined readyState send");

	doc.destroy();
}

s.section("Test 7: trySendSvEcho reports send failures and oversize drops");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "send failure");
	const throwResult = trySendSvEcho({
		readyState: 1,
		send() {
			throw new Error("boom");
		},
	}, doc, "postApply");
	const oversizeResult = trySendSvEchoStateVector({
		readyState: 1,
		send() {
			throw new Error("should not send");
		},
	}, new Uint8Array(clientProtocol.MAX_SV_ECHO_BASE64_BYTES), "postApply");

	s.check(!throwResult.ok && throwResult.failure === "send_failed", "send throw => send_failed");
	s.check(throwResult.bytes > 0, "throw result reports attempted payload bytes");
	s.check(!oversizeResult.ok && oversizeResult.failure === "oversize", "oversize payload => oversize failure");
	s.check(oversizeResult.bytes > 0, "oversize result reports framed payload bytes");

	doc.destroy();
}
await s.done();
