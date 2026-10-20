/**
 * The database-backed ports of the health and digest triggers (see PushTriggerScheduler). Everything
 * that touches a table or another service lives here, so the scheduler itself stays a pure policy.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { mobileDevices, sessions } from "../../db/schema/index.js";
import { type DigestAudience, EVERYONE, countDigestSessions } from "../ai/digest-service.js";
import { isAiActive } from "../ai/feature.js";
import { activeSnoozeSet, listActiveSnoozes } from "../ai/inbox-snooze-service.js";
import { intelligenceForSessions } from "../ai/intelligence-service.js";
import { getMode } from "../instance-mode.js";
import { getEligibleDevice, listEligibleDevices } from "./device-source.js";
import { dispatchEvent } from "./dispatch.js";
import type { PushTriggerPorts } from "./push-scheduler.js";
import type { PushService } from "./push-service.js";
import { type EligibleDevice, canDeviceReadSession } from "./push-targets.js";

/** Times a lost race on the prefs write is retried: each retry re-reads the row the phone just changed. */
const MARKER_WRITE_ATTEMPTS = 3;

/**
 * Whose digest a device gets: solo and admins read everything; a member reads what `canReadSession` says;
 * an ownerless key's phone has no person and reads nothing in team mode. The key says which devices
 * share a cached digest.
 */
export function digestAudienceOf(entry: EligibleDevice, mode: "solo" | "team"): DigestAudience {
	if (mode === "solo" || entry.role === "admin") return EVERYONE;
	if (entry.role === null) return { key: "none", canRead: () => false };
	return {
		key: `user:${entry.device.userId}`,
		canRead: (session) => canDeviceReadSession(entry, session.ownerUserId, mode),
	};
}

/**
 * Writes the device's `prefs.lastDigestDate`, keeping every other member as the phone last set it. The write is
 * guarded by the prefs text that was read, so a PATCH from the phone in between is not overwritten: the
 * read is repeated instead.
 */
export async function writeDigestMarker(deviceId: string, date: string): Promise<void> {
	const db = getDb();
	for (let attempt = 0; attempt < MARKER_WRITE_ATTEMPTS; attempt++) {
		const [row] = await db
			.select({ prefsJson: mobileDevices.prefsJson })
			.from(mobileDevices)
			.where(and(eq(mobileDevices.id, deviceId), isNull(mobileDevices.revokedAt)))
			.limit(1);
		if (!row) return;
		let prefs: Record<string, unknown> = {};
		if (row.prefsJson) {
			try {
				prefs = JSON.parse(row.prefsJson) as Record<string, unknown>;
			} catch {
				return; // unreadable prefs are the phone's to repair; never rewrite them
			}
		}
		prefs.lastDigestDate = date;
		const unchanged =
			row.prefsJson === null
				? isNull(mobileDevices.prefsJson)
				: eq(mobileDevices.prefsJson, row.prefsJson);
		const written = await db
			.update(mobileDevices)
			.set({ prefsJson: JSON.stringify(prefs) })
			.where(and(eq(mobileDevices.id, deviceId), isNull(mobileDevices.revokedAt), unchanged))
			.returning({ id: mobileDevices.id });
		if (written.length > 0) return;
	}
}

/** The origin the health job dispatches under: it bounds the job to its own share of the in-flight budget. */
export const HEALTH_DISPATCH_ORIGIN = "push-health";

export function createDbTriggerPorts(
	service: Pick<PushService, "sendToDevices">,
): PushTriggerPorts {
	return {
		enabled: isAiActive,
		mode: getMode,
		eligibleDevices: listEligibleDevices,
		eligibleDevice: getEligibleDevice,
		activeSessions: async (limit) => {
			const rows = await getDb()
				.select({ sessionId: sessions.sessionId, ownerUserId: sessions.ownerUserId })
				.from(sessions)
				.where(and(inArray(sessions.status, ["active", "idle"]), eq(sessions.isArchived, false)))
				.orderBy(desc(sessions.lastActivityAt))
				.limit(limit);
			return rows.map((r) => ({ sessionId: r.sessionId, ownerUserId: r.ownerUserId ?? null }));
		},
		classify: async (sessionIds, now) => {
			const intel = await intelligenceForSessions(sessionIds, now);
			return new Map([...intel].map(([id, i]) => [id, i.health]));
		},
		snoozes: async (now) => activeSnoozeSet(await listActiveSnoozes(now)),
		emit: (event) => dispatchEvent(event, HEALTH_DISPATCH_ORIGIN),
		digestSessionCount: (entry, mode, now) =>
			countDigestSessions({ audience: digestAudienceOf(entry, mode), now }),
		sendToDevices: (devices, event) => service.sendToDevices(devices, event),
		markDigestSent: writeDigestMarker,
	};
}
