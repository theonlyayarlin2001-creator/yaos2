/**
 * Unit tests for server-ack origin classification.
 */

import { isAckTrackedLocalOrigin } from "../../src/sync/ackOrigins";
import { suite } from "../harness.ts";

const s = suite("ack-origins");

s.section("Test 1: null/undefined provider and persistence do not suppress local origin=null");
{
	s.check(isAckTrackedLocalOrigin(null, null, null), "provider=null, persistence=null, origin=null => tracked");
	s.check(isAckTrackedLocalOrigin(null, undefined, undefined), "provider=undefined, persistence=undefined, origin=null => tracked");
}

s.section("Test 2: concrete provider/persistence origins are suppressed");
{
	const provider = { kind: "provider" };
	const persistence = { kind: "persistence" };
	s.check(!isAckTrackedLocalOrigin(provider, provider, persistence), "origin=provider => not tracked");
	s.check(!isAckTrackedLocalOrigin(persistence, provider, persistence), "origin=persistence => not tracked");
	s.check(isAckTrackedLocalOrigin(null, provider, persistence), "origin=null with concrete provider/persistence => tracked");
}
await s.done();
