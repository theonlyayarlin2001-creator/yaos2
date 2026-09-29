/**
 * Source-level guard for the VaultSyncServer post-apply echo wire.
 *
 * Full y-partyserver/Cloudflare method dispatch is exercised by worker smoke
 * tests. This test keeps the critical wiring shape honest: classify before the
 * parent handler, send only after successful parent handling, and never use a
 * finally block that would echo after failure.
 */

import { readFileSync } from "node:fs";
import { suite } from "../harness.ts";

const s = suite("server-post-apply-wiring");

const source = readFileSync("server/src/server.ts", "utf8");
const methodMatch = source.match(/handleMessage\(connection: Connection, message: WSMessage\): void \{([\s\S]*?)\n\t\}/);
const body = methodMatch?.[1] ?? "";

s.section("Test 1: post-apply echo wiring shape");
s.check(source.includes("import { isUpdateBearingSyncMessage }"), "server imports pure classifier");
s.check(methodMatch !== null, "server defines handleMessage override");
s.check(body.includes("const shouldEcho = isUpdateBearingSyncMessage(message);"), "classifier result is computed");
s.check(body.includes("super.handleMessage(connection, message);"), "parent handleMessage is called");
s.check(body.includes("if (shouldEcho)"), "postApply echo is gated on classifier result");
s.check(body.includes("\"postApply\""), "postApply kind is used");
s.check(!body.includes("finally"), "handleMessage does not echo from a finally block");

// Regression guard: docChanged MUST NOT be derived from state vectors alone.
// A Yjs state vector tracks insert clocks and is blind to the delete set, so an
// SV-only comparison reports false for a delete-only update.  This exact line
// was reintroduced once by a patch applied over a stale read of server.ts, and
// nothing caught it — the trace simply started lying about deletions again.
s.check(
	body.includes("docUpdateCount"),
	"docChanged uses the document update counter, not only a state-vector diff",
);
s.check(
	!/const docChanged =\s*svBefore !== null && !equalBytes\(svBefore, svAfter\);/.test(body),
	"docChanged is not the SV-only comparison",
);

const classifierIndex = body.indexOf("isUpdateBearingSyncMessage(message)");
const parentIndex = body.indexOf("super.handleMessage(connection, message)");
const postApplyIndex = body.indexOf("\"postApply\"");
s.check(classifierIndex >= 0 && parentIndex > classifierIndex, "classifier runs before parent handler");
s.check(parentIndex >= 0 && postApplyIndex > parentIndex, "postApply echo occurs after parent handler succeeds");
await s.done();
