/**
 * Unit tests for svEchoMessage.ts — parseSvEchoMessage, makeSvEchoMessage,
 * and the byte-safe base64 helpers.
 *
 * All tests are pure Node — no Obsidian.
 */

import * as Y from "yjs";
import {
	makeSvEchoMessage,
	parseSvEchoMessage,
	parseSvEchoMessageDetailed,
	createSvEchoCounters,
	recordSvEchoParseResult,
	encodeBytesBase64,
	decodeBytesBase64,
	MAX_SV_ECHO_BASE64_BYTES,
} from "../../src/sync/svEchoMessage";
import { suite } from "../harness.ts";

const s = suite("sv-echo-message");

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function makeStateVector(text = "sv"): Uint8Array {
	const doc = new Y.Doc();
	doc.getText("t").insert(0, text);
	const sv = Y.encodeStateVector(doc);
	doc.destroy();
	return sv;
}

// ── Base64 helpers ────────────────────────────────────────────────────────────

s.section("Test 1: base64 round-trip");
{
	const empty = new Uint8Array(0);
	const decoded = decodeBytesBase64(encodeBytesBase64(empty));
	s.check(decoded !== null && decoded.length === 0, "empty bytes round-trip");

	const small = new Uint8Array([1, 2, 3, 255, 0, 127]);
	const decoded2 = decodeBytesBase64(encodeBytesBase64(small));
	s.check(decoded2 !== null && arraysEqual(decoded2, small), "small bytes round-trip");

	// 256 bytes of arbitrary data
	const medium = new Uint8Array(256);
	for (let i = 0; i < 256; i++) medium[i] = i;
	const decoded3 = decodeBytesBase64(encodeBytesBase64(medium));
	s.check(decoded3 !== null && arraysEqual(decoded3, medium), "256 bytes round-trip");
}

s.section("Test 2: base64 large payload (above spread limit)");
{
	// 70000 bytes — above the 65535 spread limit that would break naive encoding
	const large = new Uint8Array(70000);
	for (let i = 0; i < 70000; i++) large[i] = i & 0xff;
	const encoded = encodeBytesBase64(large);
	const decoded = decodeBytesBase64(encoded);
	s.check(decoded !== null, "large payload encodes without error");
	s.check(decoded !== null && arraysEqual(decoded, large), "large payload decodes correctly");
}

s.section("Test 3: decodeBytesBase64 invalid input");
{
	s.check(decodeBytesBase64("not-valid-base64!!!") === null, "invalid base64 => null");
	s.check(decodeBytesBase64("") !== null, "empty string => zero-length array (not null)");
}

// ── parseSvEchoMessage ────────────────────────────────────────────────────────

s.section("Test 4: valid message parses");
{
	const sv = makeStateVector("valid parse");
	const msg = makeSvEchoMessage(sv);
	const result = parseSvEchoMessage(msg);
	s.check(result !== null, "valid message: result is not null");
	s.check(result !== null && arraysEqual(result, sv), "valid message: bytes match");
}

s.section("Test 5: parseSvEchoMessage rejects invalid inputs");
{
	s.check(parseSvEchoMessage("not json") === null, "non-JSON => null");
	s.check(parseSvEchoMessage("null") === null, "JSON null => null");
	s.check(parseSvEchoMessage("42") === null, "JSON number => null");
	s.check(parseSvEchoMessage("[]") === null, "JSON array => null");
	s.check(parseSvEchoMessage("{}") === null, "empty object => null");
}

s.section("Test 6: wrong type field");
{
	const validSv = makeStateVector("wrong type");
	const encoded = encodeBytesBase64(validSv);
	const wrong = JSON.stringify({ type: "other/sv-echo", schema: 1, sv: encoded });
	s.check(parseSvEchoMessage(wrong) === null, "wrong type => null");
	const unnamespaced = JSON.stringify({ type: "sv-echo", schema: 1, sv: encoded });
	s.check(parseSvEchoMessage(unnamespaced) === null, "unnamespaced type => null");
	const missing = JSON.stringify({ schema: 1, sv: encoded });
	s.check(parseSvEchoMessage(missing) === null, "missing type field => null");
}

s.section("Test 7: wrong schema version");
{
	const encoded = encodeBytesBase64(makeStateVector("wrong schema"));
	const wrongSchema = JSON.stringify({ type: "yaos/sv-echo", schema: 2, sv: encoded });
	s.check(parseSvEchoMessage(wrongSchema) === null, "schema 2 => null");
	const zeroSchema = JSON.stringify({ type: "yaos/sv-echo", schema: 0, sv: encoded });
	s.check(parseSvEchoMessage(zeroSchema) === null, "schema 0 => null");
	const strSchema = JSON.stringify({ type: "yaos/sv-echo", schema: "1", sv: encoded });
	s.check(parseSvEchoMessage(strSchema) === null, "schema as string => null");
}

s.section("Test 8: missing or non-string sv field");
{
	const base = { type: "yaos/sv-echo", schema: 1 };
	s.check(parseSvEchoMessage(JSON.stringify(base)) === null, "missing sv => null");
	s.check(parseSvEchoMessage(JSON.stringify({ ...base, sv: 42 })) === null, "numeric sv => null");
	s.check(parseSvEchoMessage(JSON.stringify({ ...base, sv: null })) === null, "null sv => null");
	s.check(parseSvEchoMessage(JSON.stringify({ ...base, sv: [] })) === null, "array sv => null");
}

s.section("Test 9: oversized payload rejected");
{
	// Build a base64 string longer than MAX_SV_ECHO_BASE64_BYTES
	const oversizedB64 = "A".repeat(MAX_SV_ECHO_BASE64_BYTES + 1);
	const oversized = JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: oversizedB64 });
	s.check(parseSvEchoMessage(oversized) === null, "oversized payload => null");

	// Exactly at the limit: handled without throwing. It may still be rejected
	// by base64 or state-vector validation.
	const atLimit = "A".repeat(MAX_SV_ECHO_BASE64_BYTES);
	const atLimitMsg = JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: atLimit });
	// Might return null due to invalid base64 content, but NOT due to size rejection
	const result = parseSvEchoMessage(atLimitMsg);
	// We don't assert the value — just that it doesn't throw
	s.check(true, `at-limit payload handled without throwing (result: ${result === null ? "null" : "bytes"})`);
}

s.section("Test 10: invalid base64 in sv field");
{
	const badB64 = JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: "not-valid-base64!!!" });
	s.check(parseSvEchoMessage(badB64) === null, "invalid base64 in sv => null");
}

s.section("Test 11: decoded-but-invalid state vectors are rejected");
{
	const zeroBytes = JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: encodeBytesBase64(new Uint8Array(0)) });
	s.check(parseSvEchoMessage(zeroBytes) === null, "zero-byte decoded SV => null");

	const garbage = JSON.stringify({
		type: "yaos/sv-echo",
		schema: 1,
		sv: encodeBytesBase64(new TextEncoder().encode("garbage")),
	});
	s.check(parseSvEchoMessage(garbage) === null, "base64 garbage decoded SV => null");
}

s.section("Test 12: makeSvEchoMessage + parseSvEchoMessage round-trip");
{
	const sv = makeStateVector("round trip");
	const msg = makeSvEchoMessage(sv);
	const result = parseSvEchoMessage(msg);
	s.check(result !== null, "full round-trip: not null");
	s.check(result !== null && arraysEqual(result, sv), "full round-trip: bytes match");

	// Valid empty Yjs state vector is encoded as [0], not zero bytes.
	const emptyDoc = new Y.Doc();
	const emptySv = Y.encodeStateVector(emptyDoc);
	emptyDoc.destroy();
	const emptyMsg = makeSvEchoMessage(emptySv);
	const emptyResult = parseSvEchoMessage(emptyMsg);
	s.check(emptyResult !== null && arraysEqual(emptyResult, emptySv), "valid empty SV round-trip");
}

s.section("Test 13: detailed parser reports reasons and counters");
{
	const validSv = makeStateVector("detailed parser");
	const encoded = encodeBytesBase64(validSv);
	const valid = parseSvEchoMessageDetailed(makeSvEchoMessage(validSv));
	const wrongType = parseSvEchoMessageDetailed(JSON.stringify({ type: "other/sv-echo", schema: 1, sv: encoded }));
	const wrongSchema = parseSvEchoMessageDetailed(JSON.stringify({ type: "yaos/sv-echo", schema: 2, sv: encoded }));
	const oversized = parseSvEchoMessageDetailed(JSON.stringify({
		type: "yaos/sv-echo",
		schema: 1,
		sv: "A".repeat(MAX_SV_ECHO_BASE64_BYTES + 1),
	}));
	const invalidSv = parseSvEchoMessageDetailed(JSON.stringify({
		type: "yaos/sv-echo",
		schema: 1,
		sv: encodeBytesBase64(new TextEncoder().encode("garbage")),
	}));

	s.check(valid.kind === "valid_sv_echo", "detailed valid echo => valid_sv_echo");
	s.check(wrongType.kind === "not_sv_echo", "detailed wrong type => not_sv_echo");
	s.check(wrongSchema.kind === "invalid_sv_echo" && wrongSchema.reason === "wrong_schema", "detailed wrong schema reason");
	s.check(oversized.kind === "invalid_sv_echo" && oversized.reason === "oversize", "detailed oversize reason");
	s.check(invalidSv.kind === "invalid_sv_echo" && invalidSv.reason === "invalid_state_vector", "detailed invalid SV reason");

	const counters = createSvEchoCounters();
	for (const result of [valid, wrongType, oversized, invalidSv]) {
		recordSvEchoParseResult(counters, result);
	}
	s.check(counters.customMessageSeenCount === 4, "counters: custom messages seen count");
	s.check(counters.svEchoSeenCount === 3, "counters: sv-echo seen count excludes wrong type");
	s.check(counters.acceptedCount === 1, "counters: accepted count");
	s.check(counters.rejectedCount === 2, "counters: rejected count excludes wrong type");
	s.check(counters.rejectedOversizeCount === 1, "counters: oversize rejected count");
	s.check(counters.rejectedInvalidCount === 1, "counters: invalid rejected count");
	s.check(counters.bytesMax > 0, "counters: max bytes recorded");
}
await s.done();
