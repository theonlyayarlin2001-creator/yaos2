import {
	attachmentSizeCapKB,
	MAX_ATTACHMENT_SIZE_KB,
	readVaultSyncSettings,
} from "../../src/settings/settingsStore";
import { suite } from "../harness.ts";

const s = suite("settings-hardening");

s.section("Test 1: attachment max is capped to the server upload contract");
{
	const { settings, migrated } = readVaultSyncSettings({
		maxAttachmentSizeKB: MAX_ATTACHMENT_SIZE_KB + 1,
	});
	s.check(settings.maxAttachmentSizeKB === MAX_ATTACHMENT_SIZE_KB, "oversized attachment setting is capped");
	s.check(migrated, "oversized attachment setting marks settings as migrated");
}

s.section("Test 2: invalid attachment max falls back inside the valid range");
{
	const { settings, migrated } = readVaultSyncSettings({
		maxAttachmentSizeKB: -10,
	});
	s.check(settings.maxAttachmentSizeKB >= 1, "invalid attachment setting is repaired to a positive value");
	s.check(settings.maxAttachmentSizeKB <= MAX_ATTACHMENT_SIZE_KB, "repaired attachment setting stays under cap");
	s.check(migrated, "invalid attachment setting marks settings as migrated");
}

s.section("Test 3: valid attachment max is preserved");
{
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		maxAttachmentSizeKB: 4096,
	});
	s.check(settings.maxAttachmentSizeKB === 4096, "valid attachment setting is preserved");
	s.check(!migrated, "valid attachment setting does not force migration");
}

s.section("Test 4: server capability can lower the effective attachment cap");
{
	s.check(
		attachmentSizeCapKB(5 * 1024 * 1024) === 5 * 1024,
		"5 MB server capability lowers effective attachment cap to 5120 KB",
	);
	s.check(
		attachmentSizeCapKB(50 * 1024 * 1024) === MAX_ATTACHMENT_SIZE_KB,
		"larger server capability does not raise the client above the built-in ceiling",
	);
	s.check(
		attachmentSizeCapKB(null) === MAX_ATTACHMENT_SIZE_KB,
		"missing server capability falls back to built-in ceiling",
	);
}
await s.done();
