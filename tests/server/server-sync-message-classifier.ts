import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { isUpdateBearingSyncMessage } from "../../server/src/syncMessageClassifier";
import { suite } from "../harness.ts";

const s = suite("server-sync-message-classifier");

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

function frameSync(writeInner: (encoder: encoding.Encoder) => void): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	writeInner(encoder);
	return encoding.toUint8Array(encoder);
}

function frameAwareness(update: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
	encoding.writeVarUint8Array(encoder, update);
	return encoding.toUint8Array(encoder);
}

function frameOuterOnly(outerType: number): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, outerType);
	return encoding.toUint8Array(encoder);
}

function buildDocWithText(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText("note").insert(0, text);
	return doc;
}

s.section("Test 1: real y-protocol sync messages");
{
	const doc = buildDocWithText("hello");
	const syncStep1 = frameSync((encoder) => syncProtocol.writeSyncStep1(encoder, doc));
	const syncStep2 = frameSync((encoder) => syncProtocol.writeSyncStep2(encoder, doc, Y.encodeStateVector(new Y.Doc())));
	const update = Y.encodeStateAsUpdate(doc);
	const yjsUpdate = frameSync((encoder) => syncProtocol.writeUpdate(encoder, update));

	s.check(!isUpdateBearingSyncMessage(syncStep1), "SyncStep1 => false");
	s.check(isUpdateBearingSyncMessage(syncStep2), "SyncStep2 => true");
	s.check(isUpdateBearingSyncMessage(yjsUpdate), "Update => true");

	doc.destroy();
}

s.section("Test 2: non-sync frames are ignored");
{
	const doc = new Y.Doc();
	const awareness = new awarenessProtocol.Awareness(doc);
	awareness.setLocalState({ user: { name: "tester" } });
	const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]);
	const message = frameAwareness(awarenessUpdate);

	s.check(!isUpdateBearingSyncMessage(message), "Awareness => false");
	s.check(!isUpdateBearingSyncMessage("__YPS:{\"type\":\"yaos/sv-echo\"}"), "String custom message => false");

	awareness.destroy();
	doc.destroy();
}

s.section("Test 3: malformed and unknown messages fail closed");
{
	const unknownOuter = frameOuterOnly(99);
	const unknownInner = frameSync((encoder) => encoding.writeVarUint(encoder, 99));

	s.check(!isUpdateBearingSyncMessage(new Uint8Array()), "empty binary => false");
	s.check(!isUpdateBearingSyncMessage(frameOuterOnly(MESSAGE_SYNC)), "malformed sync frame with no inner type => false");
	s.check(!isUpdateBearingSyncMessage(new Uint8Array([255])), "malformed varuint => false");
	s.check(!isUpdateBearingSyncMessage(unknownOuter), "unknown outer type => false");
	s.check(!isUpdateBearingSyncMessage(unknownInner), "unknown sync inner type => false");
}

s.section("Test 4: supported binary container shapes");
{
	const doc = buildDocWithText("container");
	const updateFrame = frameSync((encoder) => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc)));
	const copiedBuffer = updateFrame.buffer.slice(updateFrame.byteOffset, updateFrame.byteOffset + updateFrame.byteLength);
	const dataView = new DataView(copiedBuffer);

	s.check(isUpdateBearingSyncMessage(copiedBuffer), "ArrayBuffer update frame => true");
	s.check(isUpdateBearingSyncMessage(dataView), "ArrayBuffer view update frame => true");

	doc.destroy();
}
await s.done();
