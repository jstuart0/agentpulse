/**
 * The device table as the push modules see it. `toPushDevice` is the one place a
 * `mobile_devices` row becomes a `PushDevice`: the send token stays in its stored
 * (encrypted) form and the service decrypts it per send; the public key is the
 * phone's, never a secret.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
	apiKeys,
	askThreads,
	launchRequests,
	mobileDevices,
	sessions,
	users,
} from "../../db/schema/index.js";
import type { ThreadOwner } from "../ask/thread-ownership.js";
import type {
	EligibleDevice,
	PushDeviceSource,
	PushSubjectReader,
	SubjectOwner,
} from "./push-targets.js";
import type { DevicePrefs, PushDevice, QuietHours, SessionSnapshot } from "./types.js";

type DeviceRow = typeof mobileDevices.$inferSelect;

const DIGEST_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
	if (
		typeof raw.digestHour === "number" &&
		Number.isInteger(raw.digestHour) &&
		raw.digestHour >= 0 &&
		raw.digestHour <= 23
	) {
		prefs.digestHour = raw.digestHour;
	}
	if (typeof raw.lastDigestDate === "string" && DIGEST_DATE.test(raw.lastDigestDate)) {
		prefs.lastDigestDate = raw.lastDigestDate;
	}
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
		ownerlessKeyId: row.userId === null ? row.apiKeyId : null,
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
	listEligibleDevices(): Promise<EligibleDevice[]> {
		return listEligibleDevices();
	}

	async listActiveDevices(): Promise<PushDevice[]> {
		const rows = await getDb()
			.select()
			.from(mobileDevices)
			.where(and(isNull(mobileDevices.revokedAt), ne(mobileDevices.sendToken, "")))
			.orderBy(mobileDevices.createdAt);
		return rows.map(toPushDevice);
	}
}

interface EligibilityRow {
	device: DeviceRow;
	keyActive: boolean;
	keyOwnerUserId: string | null;
	userId: string | null;
	userRole: string | null;
	userDisabledAt: string | null;
}

/**
 * The one eligibility rule, for every send (alerts and activity updates alike):
 * the device is live, its linked key is active and still belongs to the
 * device's user, and that user exists and isn't disabled. An ownerless key's
 * device has no user to check and carries no role.
 */
function toEligible(row: EligibilityRow): EligibleDevice | null {
	if (row.device.revokedAt !== null || row.device.sendToken === "") return null;
	if (!row.keyActive) return null;
	if ((row.keyOwnerUserId ?? null) !== (row.device.userId ?? null)) return null;
	if (row.device.userId === null) return { device: toPushDevice(row.device), role: null };
	if (row.userId === null || row.userDisabledAt !== null) return null;
	return { device: toPushDevice(row.device), role: row.userRole === "admin" ? "admin" : "member" };
}

function eligibilityQuery() {
	return getDb()
		.select({
			device: mobileDevices,
			keyActive: apiKeys.isActive,
			keyOwnerUserId: apiKeys.ownerUserId,
			userId: users.id,
			userRole: users.role,
			userDisabledAt: users.disabledAt,
		})
		.from(mobileDevices)
		.innerJoin(apiKeys, eq(apiKeys.id, mobileDevices.apiKeyId))
		.leftJoin(users, eq(users.id, mobileDevices.userId));
}

/** One device if it may be sent to right now, else null. The Live Activity publisher asks this before every send. */
export async function getEligibleDevice(id: string): Promise<EligibleDevice | null> {
	const [row] = await eligibilityQuery().where(eq(mobileDevices.id, id)).limit(1);
	return row ? toEligible(row) : null;
}

/** The devices that may be sent to right now, with the role of each one's owner. */
export async function listEligibleDevices(): Promise<EligibleDevice[]> {
	const rows = await eligibilityQuery()
		.where(and(isNull(mobileDevices.revokedAt), ne(mobileDevices.sendToken, "")))
		.orderBy(mobileDevices.createdAt);
	return rows.flatMap((row) => toEligible(row) ?? []);
}

/** Who owns the session or launch an event is about, read at send time so a handover is honored. */
export class DbPushSubjects implements PushSubjectReader {
	async sessionOwner(sessionId: string): Promise<SubjectOwner | null> {
		const [row] = await getDb()
			.select({ ownerUserId: sessions.ownerUserId })
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		return row ? { ownerUserId: row.ownerUserId ?? null } : null;
	}

	async askThreadOwner(threadId: string): Promise<ThreadOwner | null> {
		const [row] = await getDb()
			.select({ ownerUserId: askThreads.ownerUserId, ownerKeyId: askThreads.ownerKeyId })
			.from(askThreads)
			.where(eq(askThreads.id, threadId))
			.limit(1);
		return row
			? { ownerUserId: row.ownerUserId ?? null, ownerKeyId: row.ownerKeyId ?? null }
			: null;
	}

	async launchRequester(launchId: string): Promise<SubjectOwner | null> {
		const [row] = await getDb()
			.select({ ownerUserId: launchRequests.requestedByUserId })
			.from(launchRequests)
			.where(eq(launchRequests.id, launchId))
			.limit(1);
		return row ? { ownerUserId: row.ownerUserId ?? null } : null;
	}
}

/** The whole session row, for one dispatch to share between targeting and enrichment. */
export async function readSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
	const [row] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row ? { ...row, ownerUserId: row.ownerUserId ?? null } : null;
}
