import {
	buildFrontmatterQuarantineDebugLines,
	clearFrontmatterQuarantinePath,
	readPersistedFrontmatterQuarantine,
	upsertFrontmatterQuarantineEntry,
} from "../../src/sync/frontmatterQuarantine";
import type { FrontmatterQuarantineEntry } from "../../src/sync/frontmatterQuarantine";
import { suite } from "../harness.ts";

const s = suite("frontmatter-quarantine-regressions");

s.section("Test 1: quarantine upsert is per-path and strictly diagnostic");
{
	let entries: FrontmatterQuarantineEntry[] = [];
	entries = upsertFrontmatterQuarantineEntry(entries, {
		path: "Bathroom floor clean.md",
		firstSeenAt: 10,
		lastSeenAt: 10,
		direction: "disk-to-crdt",
		reasons: ["duplicate-key:taskSourceType", "duplicate-key:taskSourceType"],
		prevHash: "prev-a",
		nextHash: "next-a",
		lastNoticeAt: 10,
		lastNotifiedFingerprint: "fp-a",
		count: 1,
	});
	entries = upsertFrontmatterQuarantineEntry(entries, {
		path: "Bathroom floor clean.md",
		firstSeenAt: 20,
		lastSeenAt: 20,
		direction: "crdt-to-disk",
		reasons: ["yaml-parse-error"],
		prevHash: "prev-b",
		nextHash: "next-b",
		count: 1,
	});

	s.check(entries.length === 1, "same path collapses into one diagnostic entry");
	s.check(entries[0]?.count === 2, "same path increments count");
	s.check(entries[0]?.direction === "crdt-to-disk", "same path keeps the latest direction");
	s.check(entries[0]?.reasons.length === 1 && entries[0]?.reasons[0] === "yaml-parse-error", "same path keeps normalized latest reasons");
	s.check(entries[0]?.lastNoticeAt === 10, "same path preserves prior notice timestamp when no new notice is provided");
	s.check(entries[0]?.lastNotifiedFingerprint === "fp-a", "same path preserves prior notice fingerprint when no new notice is provided");
}

s.section("Test 2: quarantine stays bounded and newest-first");
{
	let entries: FrontmatterQuarantineEntry[] = [];
	for (let i = 0; i < 5; i++) {
		entries = upsertFrontmatterQuarantineEntry(entries, {
			path: `note-${i}.md`,
			firstSeenAt: i,
			lastSeenAt: i,
			direction: "disk-to-crdt",
			reasons: [`reason-${i}`],
			count: 1,
		}, 3);
	}

	s.check(entries.length === 3, "quarantine entry list is capped");
	s.check(entries[0]?.path === "note-4.md", "newest entry stays first");
	s.check(entries[2]?.path === "note-2.md", "oldest retained entry is the cutoff");
}

s.section("Test 3: quarantine clears by path on clean convergence");
{
	const entries: FrontmatterQuarantineEntry[] = [
		{
			path: "keep.md",
			firstSeenAt: 1,
			lastSeenAt: 2,
			direction: "disk-to-crdt",
			reasons: ["a"],
			count: 1,
		},
		{
			path: "clear.md",
			firstSeenAt: 3,
			lastSeenAt: 4,
			direction: "crdt-to-disk",
			reasons: ["b"],
			count: 2,
		},
	];
	const next = clearFrontmatterQuarantinePath(entries, "clear.md");
	s.check(next.length === 1, "clear removes only the target path");
	s.check(next[0]?.path === "keep.md", "clear keeps unrelated paths");
}

s.section("Test 4: persisted quarantine state is sanitized");
{
	const entries = readPersistedFrontmatterQuarantine([
		{
			path: "Bathroom floor clean.md",
			firstSeenAt: 10,
			lastSeenAt: 20,
			direction: "disk-to-crdt",
			reasons: ["z", "a", "z"],
			prevHash: "prev",
			nextHash: "next",
			count: 3,
		},
		{ nope: true },
	]);

	s.check(entries.length === 1, "invalid persisted entries are dropped");
	s.check(entries[0]?.reasons.join(",") === "a,z", "persisted reasons are normalized");
}

s.section("Test 5: debug lines summarize quarantined paths without content");
{
	const lines = buildFrontmatterQuarantineDebugLines([
		{
			path: "Bathroom floor clean.md",
			firstSeenAt: 10,
			lastSeenAt: 20,
			direction: "disk-to-crdt",
			reasons: ["yaml-parse-error"],
			count: 2,
		},
	]);

	s.check(lines[0] === "Frontmatter quarantines: 1", "debug header includes entry count");
	s.check(lines[1]?.includes("Bathroom floor clean.md") === true, "debug summary includes path");
	s.check(lines[1]?.includes("lastNotice") === true, "debug summary includes notice timing metadata");
	s.check(lines[1]?.includes("noticeFingerprint") === true, "debug summary includes notice fingerprint metadata");
	s.check(!lines[1]?.includes("prevHash"), "debug summary does not expose hashes or content by default");
}
await s.done();
