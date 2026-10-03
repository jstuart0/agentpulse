/**
 * Boot, for API keys: the default key first, then the warning about ownerless
 * manage keys that team mode treats as members. The order matters: a key the
 * default step mints is one the warning has to see.
 */
import { ensureDefaultApiKey } from "../auth/api-key.js";
import { getMode, warnAboutUnlistedAdminServiceKeysAtBoot } from "./instance-mode.js";

export async function ensureDefaultKeyThenWarn(): Promise<string | null> {
	const defaultKey = await ensureDefaultApiKey(await getMode());
	await warnAboutUnlistedAdminServiceKeysAtBoot();
	return defaultKey;
}
