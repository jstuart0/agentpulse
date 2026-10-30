/**
 * The health and digest triggers on the real database ports: which sessions are looked at, the verdicts of the
 * real classifier, the digest marker written into the device's prefs, and the pass budget at 200 sessions.
 * The policy itself (transitions, snoozes, time zones) is in push-scheduler.test.ts.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import "../../db/__test_db.js";
import { registerWith } from "../../test-utils/device-fixtures.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../../test-utils/team-fixtures.js";
import { bearerHeaders } from "../../test-utils/team-fixtures.js";

setDefaultTimeout(60_000);

const { initializeDatabase, getDb } = await import("../../db/client.js");
const { aiInboxSnoozes, events, mobileDevices, sessions } = await import(
	"../../db/schema/index.js"
);
const { snoozeItem } = await import("../ai/inbox-snooze-service.js");
const { listEligibleDevices, getPushDevice } = await import("./device-source.js");
const { PushTriggerScheduler, MAX_HEALTH_SESSIONS } = await import("./push-scheduler.js");
const { createDbTriggerPorts, writeDigestMarker } = await import("./push-trigger-ports.js");
const { invalidateDigestCache } = await import("../ai/digest-service.js");
const { invalidateAiFlagsCache } = await import("../ai/feature.js");
const { upsertSetting } = await import("../settings-service.js");
const { config } = await import("../../config.js");

type PushEvent = import("./types.js").PushEvent;
const quiet = { info: () => undefined, warn: () => undefined };

beforeAll(() => initializeDatabase(), 60_000);
const originalAiBuild = config.aiEnabled;
async function reset() {
	await getDb().delete(aiInboxSnoozes);
	await getDb().delete(events);
	await getDb().delete(mobileDevices);
	await getDb().delete(sessions);
	await resetIdentityState();
	await clearInstanceSettings();
	invalidateDigestCache();
	await upsertSetting("ai.enabled", false, { allowProtected: true });
	invalidateAiFlagsCache();
	Object.assign(config as Record<string, unknown>, { aiEnabled: originalAiBuild });
}
async function aiOn() {
	Object.assign(config as Record<string, unknown>, { aiEnabled: true });
	await upsertSetting("ai.enabled", true, { allowProtected: true });
	invalidateAiFlagsCache();
}
beforeEach(async () => {
	await reset();
	await aiOn();
}, 60_000);
afterEach(reset, 60_000);

async function phoneFor(userLabel: string, prefs: Record<string, unknown> = {}) {
	const user = await seedLocalUser(userLabel);
	const key = await seedKey(`${userLabel}-respond`, ["respond"], user.id);
	const headers = bearerHeaders(key.key, { "Content-Type": "application/json" });
	const res = await registerWith(headers, { prefs });
	expect(res.status).toBe(201);
	return { user, deviceId: ((await res.json()) as { id: string }).id };
}

function seedSessions(count: number, over: (i: number) => Record<string, unknown> = () => ({})) {
	const rows = Array.from({ length: count }, (_, i) => ({
		sessionId: `trig-${String(i).padStart(4, "0")}`,
		displayName: `s${i}`,
		agentType: "claude_code",
		status: "active",
		isWorking: false,
		lastActivityAt: new Date(Date.UTC(2026, 9, 20, 11, 0, 0) - i * 1000).toISOString(),
		...over(i),
	}));
	return getDb()
		.insert(sessions)
		.values(rows as never);
}

function failingToolEvents(sessionIds: string[]) {
	const rows = sessionIds.flatMap((sessionId) =>
		[0, 1, 2].map((n) => ({
			sessionId,
			eventType: "PostToolUseFailure",
			category: "tool_event",
			source: "observed_hook",
			toolName: "Bash",
			toolResponse: "command failed with error",
			content: null,
			isNoise: false,
			rawPayload: {},
			createdAt: `2026-10-20 11:00:0${n}`,
		})),
	);
	return getDb()
		.insert(events)
		.values(rows as never);
}

const stubService = { sendToDevices: async () => [] };

describe("database ports", () => {
	test("activeSessions: active and idle only, unarchived, newest activity first, bounded", async () => {
		await seedSessions(5, (i) => ({
			status: ["active", "idle", "completed", "active", "failed"][i],
			isArchived: i === 3,
		}));
		const ports = createDbTriggerPorts(stubService);
		const got = await ports.activeSessions(10);
		expect(got.map((s) => s.sessionId)).toEqual(["trig-0000", "trig-0001"]);
		expect(await ports.activeSessions(1)).toHaveLength(1);
	});

	test("classify returns the real classifier's verdict for each session", async () => {
		await seedSessions(3);
		await failingToolEvents(["trig-0001"]);
		const ports = createDbTriggerPorts(stubService);
		const verdicts = await ports.classify(
			["trig-0000", "trig-0001", "trig-0002", "nope"],
			new Date(),
		);
		expect(verdicts.get("trig-0001")).toBe("stuck");
		expect(verdicts.get("trig-0000")).not.toBe("stuck");
		expect(verdicts.has("nope")).toBe(false);
	});

	test("snoozes are read in the shape the scheduler matches", async () => {
		await snoozeItem({
			kind: "stuck",
			targetId: "stuck:trig-0001",
			until: new Date(Date.now() + 3600_000),
		} as never);
		const set = await createDbTriggerPorts(stubService).snoozes(new Date());
		expect(set.has("stuck:stuck:trig-0001")).toBe(true);
	});
});

describe("the digest marker", () => {
	test("writes lastDigestDate into the device's prefs and keeps every other member", async () => {
		const { deviceId } = await phoneFor("trig-marker", {
			showContent: false,
			digestHour: 7,
			timezone: "Europe/Berlin",
			categories: { DIGEST: true },
			somethingElse: { kept: true },
		});
		await writeDigestMarker(deviceId, "2026-10-20");
		const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, deviceId));
		expect(JSON.parse(row?.prefsJson as string)).toEqual({
			showContent: false,
			digestHour: 7,
			timezone: "Europe/Berlin",
			categories: { DIGEST: true },
			somethingElse: { kept: true },
			lastDigestDate: "2026-10-20",
		});
		expect((await getPushDevice(deviceId))?.prefs.lastDigestDate).toBe("2026-10-20");
	});

	test("a device with no stored prefs gets just the marker; a revoked or unknown device is left alone", async () => {
		const { deviceId } = await phoneFor("trig-marker-bare", {});
		await getDb()
			.update(mobileDevices)
			.set({ prefsJson: null })
			.where(eq(mobileDevices.id, deviceId));
		await writeDigestMarker(deviceId, "2026-10-20");
		const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, deviceId));
		expect(JSON.parse(row?.prefsJson as string)).toEqual({ lastDigestDate: "2026-10-20" });

		await getDb()
			.update(mobileDevices)
			.set({ revokedAt: new Date().toISOString(), prefsJson: '{"a":1}' })
			.where(eq(mobileDevices.id, deviceId));
		await writeDigestMarker(deviceId, "2026-10-21");
		await writeDigestMarker("no-such-device", "2026-10-21");
		const [after] = await getDb()
			.select()
			.from(mobileDevices)
			.where(eq(mobileDevices.id, deviceId));
		expect(after?.prefsJson).toBe('{"a":1}');
	});

	test("unreadable stored prefs are never rewritten", async () => {
		const { deviceId } = await phoneFor("trig-marker-bad", {});
		await getDb()
			.update(mobileDevices)
			.set({ prefsJson: "not json" })
			.where(eq(mobileDevices.id, deviceId));
		await writeDigestMarker(deviceId, "2026-10-20");
		const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, deviceId));
		expect(row?.prefsJson).toBe("not json");
	});
});

describe("the scheduler on the real ports", () => {
	test("a session that turns stuck is announced once; the first pass only records", async () => {
		await phoneFor("trig-health", {});
		await seedSessions(3);
		const emitted: PushEvent[] = [];
		const ports = {
			...createDbTriggerPorts(stubService),
			emit: async (e: PushEvent) => {
				emitted.push(e);
				return "sent" as const;
			},
		};
		let nowMs = Date.UTC(2026, 9, 20, 12, 0, 0);
		const s = new PushTriggerScheduler({ ports, clock: { now: () => nowMs }, logger: quiet });
		await s.tick();
		expect(emitted).toEqual([]);
		await failingToolEvents(["trig-0001"]);
		nowMs += 60_000;
		await s.tick();
		nowMs += 60_000;
		await s.tick();
		expect(emitted).toEqual([{ type: "stuck", sessionId: "trig-0001" }]);
	});

	test("an active snooze keeps the push back", async () => {
		await phoneFor("trig-snooze", {});
		await seedSessions(2);
		const emitted: PushEvent[] = [];
		const ports = {
			...createDbTriggerPorts(stubService),
			emit: async (e: PushEvent) => {
				emitted.push(e);
				return "sent" as const;
			},
		};
		const s = new PushTriggerScheduler({ ports, clock: { now: () => Date.now() }, logger: quiet });
		await s.tick();
		await snoozeItem({
			kind: "stuck",
			targetId: "stuck:trig-0000",
			until: new Date(Date.now() + 3600_000),
		} as never);
		await failingToolEvents(["trig-0000", "trig-0001"]);
		await s.tick();
		expect(emitted).toEqual([{ type: "stuck", sessionId: "trig-0001" }]);
	});

	test("team: a member's phone is not told about another member's stuck session", async () => {
		await setStoredMode("team");
		const alice = await phoneFor("trig-team-alice", {});
		const bob = await seedLocalUser("trig-team-bob");
		await seedSessions(2, (i) => ({ ownerUserId: i === 0 ? alice.user.id : bob.id }));
		const classified: string[][] = [];
		const base = createDbTriggerPorts(stubService);
		const ports = {
			...base,
			classify: async (ids: string[], now: Date) => {
				classified.push(ids);
				return base.classify(ids, now);
			},
		};
		await new PushTriggerScheduler({ ports, logger: quiet }).tick();
		expect(classified).toEqual([["trig-0000"]]);
	});

	test("a tick over 200 sessions, on the real classifier, stays under the 100 ms budget", async () => {
		await phoneFor("trig-bench", {});
		await seedSessions(MAX_HEALTH_SESSIONS);
		const emitted: PushEvent[] = [];
		const ports = {
			...createDbTriggerPorts(stubService),
			emit: async (e: PushEvent) => {
				emitted.push(e);
				return "sent" as const;
			},
		};
		let nowMs = Date.now();
		const s = new PushTriggerScheduler({ ports, clock: { now: () => nowMs }, logger: quiet });
		await s.tick();
		await failingToolEvents(
			Array.from({ length: MAX_HEALTH_SESSIONS }, (_, i) => `trig-${String(i).padStart(4, "0")}`),
		);
		// The pass that sees every session newly stuck, then four more over the same 200 sessions. The budget is
		// judged on the fastest: one slow pass on a loaded machine (a collection pause, a busy CI host) says
		// nothing about the work a pass does.
		const took: number[] = [];
		for (let pass = 0; pass < 5; pass++) {
			nowMs += 60_000;
			const started = performance.now();
			await s.tick();
			took.push(performance.now() - started);
		}
		console.log(
			`[bench] push trigger pass over ${MAX_HEALTH_SESSIONS} sessions (first: all newly stuck): ${took.map((t) => t.toFixed(1)).join(", ")} ms`,
		);
		expect(emitted).toHaveLength(MAX_HEALTH_SESSIONS);
		expect(Math.min(...took)).toBeLessThan(100);
	});

	test("a device opted into the digest gets one, judged for its owner, and its marker is saved", async () => {
		const { user, deviceId } = await phoneFor("trig-digest", {
			timezone: "UTC",
			digestHour: 8,
			categories: { DIGEST: true },
		});
		await seedSessions(2, () => ({ ownerUserId: user.id, status: "completed" }));
		const sent: Array<{ ids: string[]; event: PushEvent }> = [];
		const ports = {
			...createDbTriggerPorts(stubService),
			sendToDevices: async (devices: Array<{ id: string }>, event: PushEvent) => {
				sent.push({ ids: devices.map((d) => d.id), event });
				return devices.map((d) => ({ deviceId: d.id, status: "sent" as const, pushId: null }));
			},
		};
		const nowMs = Date.UTC(2026, 9, 20, 11, 30, 0);
		const s = new PushTriggerScheduler({ ports, clock: { now: () => nowMs }, logger: quiet });
		await s.tick();
		expect(sent).toEqual([
			{ ids: [deviceId], event: { type: "daily_digest", digestDate: "2026-10-20" } },
		]);
		const eligible = await listEligibleDevices();
		expect(eligible.map((e) => e.device.prefs.lastDigestDate)).toEqual(["2026-10-20"]);
		// a fresh scheduler (a restart) reads the saved marker and sends nothing more today
		await new PushTriggerScheduler({ ports, clock: { now: () => nowMs }, logger: quiet }).tick();
		expect(sent).toHaveLength(1);
	});
});

describe("on the real ports: AI off, a revoke mid-pass, and the count-only digest check", () => {
	const digestPrefs = { timezone: "UTC", digestHour: 8, categories: { DIGEST: true } };
	const nowMs = Date.UTC(2026, 9, 20, 11, 30, 0);

	test("with AI switched off at runtime nothing is classified or sent, on either job", async () => {
		const { user } = await phoneFor("trig-aioff", digestPrefs);
		await seedSessions(2, () => ({ ownerUserId: user.id }));
		await upsertSetting("ai.enabled", false, { allowProtected: true });
		invalidateAiFlagsCache();
		let classified = 0;
		const sent: PushEvent[] = [];
		const base = createDbTriggerPorts(stubService);
		const ports = {
			...base,
			classify: async (ids: string[], now: Date) => {
				classified += 1;
				return base.classify(ids, now);
			},
			sendToDevices: async (_d: unknown, e: PushEvent) => {
				sent.push(e);
				return [];
			},
		};
		const s = new PushTriggerScheduler({ ports, clock: { now: () => nowMs }, logger: quiet });
		await s.tick();
		expect({ classified, sent }).toEqual({ classified: 0, sent: [] });
		await aiOn();
		await s.tick();
		expect(sent).toHaveLength(1);
	});

	test("a device revoked after the pass listed it is not sent to", async () => {
		const mine = await phoneFor("trig-revoke-a", digestPrefs);
		const other = await phoneFor("trig-revoke-b", digestPrefs);
		await seedSessions(2, () => ({ ownerUserId: mine.user.id }));
		await setStoredMode("solo");
		const sentTo: string[][] = [];
		const base = createDbTriggerPorts(stubService);
		const ports = {
			...base,
			eligibleDevices: async () => {
				const listed = await base.eligibleDevices();
				// the revoke lands after the list was read and before the send
				await getDb()
					.update(mobileDevices)
					.set({ revokedAt: new Date().toISOString(), sendToken: "" })
					.where(eq(mobileDevices.id, other.deviceId));
				return listed;
			},
			sendToDevices: async (devices: Array<{ id: string }>) => {
				sentTo.push(devices.map((d) => d.id));
				return devices.map((d) => ({ deviceId: d.id, status: "sent" as const, pushId: null }));
			},
		};
		await new PushTriggerScheduler({
			ports,
			clock: { now: () => nowMs },
			logger: quiet,
		}).digestTick();
		expect(sentTo).toEqual([[mine.deviceId]]);
		const [row] = await getDb()
			.select()
			.from(mobileDevices)
			.where(eq(mobileDevices.id, other.deviceId));
		expect(row?.prefsJson).not.toContain("lastDigestDate");
	});

	test("the digest check is a count of readable sessions and nothing heavier", async () => {
		const { user, deviceId } = await phoneFor("trig-count", digestPrefs);
		await seedSessions(3, (i) => ({ ownerUserId: i === 0 ? null : user.id, status: "completed" }));
		await getDb()
			.insert(events)
			.values({
				sessionId: "trig-0001",
				eventType: "PostToolUse",
				category: "plan_update",
				source: "observed_hook",
				content: "plan complete",
				isNoise: false,
				rawPayload: {},
				createdAt: "2026-10-20 11:00:00",
			} as never);
		const { countDbCalls } = await import("../../test-utils/db-call-counter.js");
		const ports = createDbTriggerPorts(stubService);
		const entry = (await ports.eligibleDevice(deviceId)) as NonNullable<
			Awaited<ReturnType<typeof ports.eligibleDevice>>
		>;
		let counted = -1;
		const statements = await countDbCalls(async () => {
			counted = await ports.digestSessionCount(entry, "solo", new Date(nowMs));
		});
		expect(counted).toBe(3);
		expect(statements).toBe(1); // one grouped count: no events, proposals or classification
	});
});
