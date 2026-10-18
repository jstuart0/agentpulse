/**
 * The device table as the push modules see it. `toPushDevice` is the one place a
 * `mobile_devices` row becomes a `PushDevice`: the send token stays in its stored
 * (encrypted) form and the service decrypts it per send; the public key is the
 * phone's, never a secret.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { mobileDevices } from "../../db/schema/index.js";
import type { PushDeviceSource } from "./push-targets.js";
import type { DevicePrefs, PushDevice, QuietHours } from "./types.js";

type DeviceRow = typeof mobileDevices.$inferSelect;

function isQuietHours(value: unknown): value is QuietHours {
	const q = value as Record<string, unknown> | null;
	return (
		typeof q === "object" &&
		q !== null &&
		typeof q.enabled === "boolean" &&
		typeof q.start === "string" &&
		typeof q.end === "string"
	);
}

/** The members of the stored prefs the push modules read. Registration validated them; anything unreadable is ignored. */
export function parsePrefs(prefsJson: string | null): DevicePrefs {
	if (!prefsJson) return {};
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(prefsJson) as Record<string, unknown>;
	} catch {
		return {};
	}
	const prefs: DevicePrefs = {};
	if (typeof raw.showContent === "boolean") prefs.showContent = raw.showContent;
	if (typeof raw.includeAgentText === "boolean") prefs.includeAgentText = raw.includeAgentText;
	if (isQuietHours(raw.quietHours)) prefs.quietHours = raw.quietHours;
	if (typeof raw.timezone === "string") prefs.timezone = raw.timezone;
	if (typeof raw.categories === "object" && raw.categories !== null) {
		const categories: Record<string, boolean> = {};
		for (const [name, enabled] of Object.entries(raw.categories)) {
			if (typeof enabled === "boolean") categories[name] = enabled;
		}
		prefs.categories = categories;
	}
	return prefs;
}

export function toPushDevice(row: DeviceRow): PushDevice {
	return {
		id: row.id,
		// An ownerless key's phones are grouped by the key, so the per-user fan-out cap still means something.
		userId: row.userId ?? `key:${row.apiKeyId}`,
		platform: row.platform,
		relayDeviceId: row.relayDeviceId,
		sendTokenCiphertext: row.sendToken,
		kid: row.kid,
		publicKey: row.publicKey,
		clientServerRef: row.clientServerRef,
		prefs: parsePrefs(row.prefsJson),
	};
}

/** One live device by id, or null when it is missing or revoked. */
export async function getPushDevice(id: string): Promise<PushDevice | null> {
	const [row] = await getDb()
		.select()
		.from(mobileDevices)
		.where(and(eq(mobileDevices.id, id), isNull(mobileDevices.revokedAt)))
		.limit(1);
	return row ? toPushDevice(row) : null;
}

/** Every live device that still has a send token (a revoked device's token is wiped, so it is never here). */
export class DbPushDeviceSource implements PushDeviceSource {
	async listActiveDevices(): Promise<PushDevice[]> {
		const rows = await getDb()
			.select()
			.from(mobileDevices)
			.where(and(isNull(mobileDevices.revokedAt), ne(mobileDevices.sendToken, "")))
			.orderBy(mobileDevices.createdAt);
		return rows.map(toPushDevice);
	}
}
