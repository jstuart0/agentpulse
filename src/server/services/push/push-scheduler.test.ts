/**
 * The health and digest triggers (PushTriggerScheduler), driven pass by pass with in-memory ports and a
 * fake clock: nothing here waits on a timer or touches a database. The database-backed ports are in
 * push-trigger-db.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { HealthState } from "../ai/classifier.js";
import type { DispatchResult } from "./dispatch.js";
import {
	DIGEST_INTERVAL_MS,
	type HealthCandidate,
	MAX_HEALTH_SESSIONS,
	type PushTriggerPorts,
	PushTriggerScheduler,
	digestDue,
	localDateAndHour,
} from "./push-scheduler.js";
import type { AlertOutcome } from "./push-service.js";
import type { EligibleDevice } from "./push-targets.js";
import type { DevicePrefs, PushDevice, PushEvent } from "./types.js";

const quiet = { info: () => undefined, warn: () => undefined };

function device(id: string, userId: string, prefs: DevicePrefs = {}): PushDevice {
	return {
		id,
		userId,
		ownerlessKeyId: null,
		platform: "ios",
		relayDeviceId: `relay-${id}`,
		sendTokenCiphertext: "t",
		kid: "kid",
		publicKey: "AAAA",
		clientServerRef: "ref",
		prefs,
	};
}

interface World {
	mode: "solo" | "team";
	devices: EligibleDevice[];
	sessions: HealthCandidate[];
	health: Map<string, HealthState>;
	snoozes: Set<string>;
	digestCounts: Map<string, number>;
	outcome: (deviceId: string) => AlertOutcome["status"];
	aiActive: boolean;
	/** What dispatch says became of each emitted event. */
	dispatched: (event: PushEvent) => DispatchResult;
	/** Devices that stop being eligible at the moment they are re-checked before a send. */
	revokedAtSend: Set<string>;
	/** Devices whose role changes at the re-check. */
	roleAtSend: Map<string, EligibleDevice["role"]>;
	// recordings
	emitted: PushEvent[];
	sent: Array<{ ids: string[]; event: PushEvent }>;
	marked: Array<{ deviceId: string; date: string }>;
	classifyCalls: number;
	markFails: boolean;
	nowMs: number;
}

function world(over: Partial<World> = {}): World & { ports: PushTriggerPorts } {
	const w: World = {
		mode: "solo",
		devices: [{ device: device("phone", "alice"), role: "member" }],
		sessions: [],
		health: new Map(),
		snoozes: new Set(),
		digestCounts: new Map(),
		outcome: () => "sent",
		aiActive: true,
		dispatched: () => "sent",
		revokedAtSend: new Set(),
		roleAtSend: new Map(),
		emitted: [],
		sent: [],
		marked: [],
		classifyCalls: 0,
		markFails: false,
		nowMs: Date.UTC(2026, 9, 20, 12, 0, 0),
		...over,
	};
	const ports: PushTriggerPorts = {
		enabled: async () => w.aiActive,
		mode: async () => w.mode,
		eligibleDevices: async () => w.devices,
		eligibleDevice: async (id) => {
			const entry = w.devices.find((e) => e.device.id === id);
			if (!entry || w.revokedAtSend.has(id)) return null;
			return w.roleAtSend.has(id) ? { ...entry, role: w.roleAtSend.get(id) ?? null } : entry;
		},
		activeSessions: async (limit) => w.sessions.slice(0, limit),
		classify: async (ids) => {
			w.classifyCalls += 1;
			return new Map(
				ids.flatMap((id) => (w.health.has(id) ? [[id, w.health.get(id) as HealthState]] : [])),
			);
		},
		snoozes: async () => w.snoozes,
		emit: async (event) => {
			w.emitted.push(event);
			return w.dispatched(event);
		},
		digestSessionCount: async (entry) => w.digestCounts.get(entry.device.id) ?? 1,
		sendToDevices: async (devices, event) => {
			w.sent.push({ ids: devices.map((d) => d.id), event });
			return devices.map((d) => ({ deviceId: d.id, status: w.outcome(d.id) }) as AlertOutcome);
		},
		markDigestSent: async (deviceId, date) => {
			if (w.markFails) throw new Error("db down");
			w.marked.push({ deviceId, date });
		},
	};
	return Object.assign(w, { ports });
}

function scheduler(w: World & { ports: PushTriggerPorts }) {
	return new PushTriggerScheduler({ ports: w.ports, clock: { now: () => w.nowMs }, logger: quiet });
}

const session = (id: string, ownerUserId: string | null = null): HealthCandidate => ({
	sessionId: id,
	ownerUserId,
});

describe("health: a transition into stuck or risky", () => {
	test("fires once on the way in, not on every pass, and again after the session leaves and returns", async () => {
		const w = world({ sessions: [session("s1")] });
		const s = scheduler(w);
		await s.tick(); // baseline: healthy
		w.health.set("s1", "stuck");
		await s.tick();
		expect(w.emitted).toEqual([{ type: "stuck", sessionId: "s1" }]);
		await s.tick();
		await s.tick();
		expect(w.emitted).toHaveLength(1);
		w.health.set("s1", "healthy");
		await s.tick();
		w.health.set("s1", "stuck");
		await s.tick();
		expect(w.emitted).toHaveLength(2);
	});

	test("stuck to risky is a new transition; blocked and complete_candidate are not alarms", async () => {
		const w = world({ sessions: [session("s1")] });
		const s = scheduler(w);
		await s.tick();
		w.health.set("s1", "stuck");
		await s.tick();
		w.health.set("s1", "risky");
		await s.tick();
		expect(w.emitted.map((e) => e.type)).toEqual(["stuck", "risky"]);
		w.health.set("s1", "blocked");
		await s.tick();
		w.health.set("s1", "complete_candidate");
		await s.tick();
		expect(w.emitted).toHaveLength(2);
	});

	test("the first pass only records: a backlog that is already stuck is not announced", async () => {
		const w = world({ sessions: [session("s1"), session("s2")] });
		w.health.set("s1", "stuck");
		w.health.set("s2", "risky");
		const s = scheduler(w);
		await s.tick();
		expect(w.emitted).toEqual([]);
		await s.tick();
		expect(w.emitted).toEqual([]);
	});

	test("a session that first appears already stuck, after the baseline, is announced", async () => {
		const w = world({ sessions: [session("s1")] });
		const s = scheduler(w);
		await s.tick();
		w.sessions.push(session("s2"));
		w.health.set("s2", "stuck");
		await s.tick();
		expect(w.emitted).toEqual([{ type: "stuck", sessionId: "s2" }]);
	});

	test("leaving the active set re-arms: the same session stuck again later is announced", async () => {
		const w = world({ sessions: [session("s1")] });
		const s = scheduler(w);
		await s.tick();
		w.health.set("s1", "stuck");
		await s.tick();
		w.sessions = [];
		await s.tick();
		w.sessions = [session("s1")];
		await s.tick();
		expect(w.emitted).toHaveLength(2);
	});

	test("a snooze suppresses the push and is not a way back in once it ends", async () => {
		const w = world({ sessions: [session("s1"), session("s2")] });
		const s = scheduler(w);
		await s.tick();
		w.snoozes = new Set(["stuck:stuck:s1"]);
		w.health.set("s1", "stuck");
		w.health.set("s2", "stuck");
		await s.tick();
		expect(w.emitted).toEqual([{ type: "stuck", sessionId: "s2" }]);
		w.snoozes = new Set();
		await s.tick();
		expect(w.emitted).toHaveLength(1);
		// a snooze on `risky` doesn't hide `stuck`, and stuck's doesn't hide risky
		w.snoozes = new Set(["stuck:stuck:s1"]);
		w.health.set("s1", "risky");
		await s.tick();
		expect(w.emitted.at(-1)).toEqual({ type: "risky", sessionId: "s1" });
	});

	test("nobody subscribed: nothing is classified, and the next subscriber starts from a fresh baseline", async () => {
		const off = device("phone", "alice", { categories: { STUCK: false, RISKY: false } });
		const w = world({ devices: [{ device: off, role: "member" }], sessions: [session("s1")] });
		w.health.set("s1", "stuck");
		const s = scheduler(w);
		await s.tick();
		await s.tick();
		expect(w.classifyCalls).toBe(0);
		w.devices = [{ device: device("phone", "alice"), role: "member" }];
		await s.tick();
		expect(w.emitted).toEqual([]); // already stuck when the first subscriber arrived: recorded, not announced
		expect(w.classifyCalls).toBe(1);
	});

	test("one of the two categories is enough to subscribe", async () => {
		const onlyRisky = device("phone", "alice", { categories: { STUCK: false, RISKY: true } });
		const w = world({
			devices: [{ device: onlyRisky, role: "member" }],
			sessions: [session("s1")],
		});
		const s = scheduler(w);
		await s.tick();
		expect(w.classifyCalls).toBe(1);
	});

	test("team: only sessions some subscribed device may read are classified", async () => {
		const w = world({
			mode: "team",
			devices: [{ device: device("alice-phone", "alice"), role: "member" }],
			sessions: [session("mine", "alice"), session("bobs", "bob"), session("open", null)],
		});
		const classified: string[][] = [];
		const original = w.ports.classify;
		w.ports.classify = async (ids, now) => {
			classified.push(ids);
			return original(ids, now);
		};
		const s = scheduler(w);
		await s.tick();
		expect(classified).toEqual([["mine", "open"]]);
	});

	test("a failing classifier is logged and skipped; the digest still runs", async () => {
		const w = world({
			sessions: [session("s1")],
			devices: [
				{
					device: device("phone", "alice", {
						digestHour: 8,
						categories: { DIGEST: true },
						timezone: "UTC",
					}),
					role: "member",
				},
			],
		});
		w.ports.classify = async () => {
			throw new Error("boom");
		};
		const s = scheduler(w);
		await s.tick();
		expect(w.sent).toHaveLength(1);
	});

	test("at most 200 active sessions are asked for", async () => {
		const w = world({ sessions: Array.from({ length: 450 }, (_, i) => session(`s${i}`)) });
		const asked: number[] = [];
		const original = w.ports.classify;
		w.ports.classify = async (ids, now) => {
			asked.push(ids.length);
			return original(ids, now);
		};
		await scheduler(w).tick();
		expect(MAX_HEALTH_SESSIONS).toBe(200);
		expect(asked).toEqual([200]);
	});

	test("a tick over 200 sessions, all stuck, stays under 100 ms of scheduler time", async () => {
		const sessions = Array.from({ length: 200 }, (_, i) => session(`s${i}`));
		const w = world({ sessions });
		const s = scheduler(w);
		await s.tick();
		for (const { sessionId } of sessions) w.health.set(sessionId, "stuck");
		const started = performance.now();
		await s.tick();
		const took = performance.now() - started;
		expect(w.emitted).toHaveLength(200);
		expect(took).toBeLessThan(100);
	});
});

describe("digest", () => {
	const prefs = (over: DevicePrefs = {}): DevicePrefs => ({
		timezone: "UTC",
		digestHour: 8,
		categories: { DIGEST: true },
		...over,
	});
	const at = (iso: string) => Date.parse(iso);
	const one = (p: DevicePrefs) =>
		world({
			devices: [{ device: device("phone", "alice", p), role: "member" }],
			nowMs: at("2026-10-20T09:00:00Z"),
		});

	test("sends once its local hour has come, with the local date, and marks the day done", async () => {
		const w = one(prefs());
		const s = scheduler(w);
		await s.tick();
		expect(w.sent).toEqual([
			{ ids: ["phone"], event: { type: "daily_digest", digestDate: "2026-10-20" } },
		]);
		expect(w.marked).toEqual([{ deviceId: "phone", date: "2026-10-20" }]);
	});

	test("not before digestHour, in the device's own zone", async () => {
		// 07:59 UTC is 03:59 in New York (EDT): not yet for either 8, and the Tokyo device (16:59) is past it
		const w = world({
			devices: [
				{ device: device("ny", "alice", prefs({ timezone: "America/New_York" })), role: "member" },
				{ device: device("tokyo", "bob", prefs({ timezone: "Asia/Tokyo" })), role: "member" },
				{ device: device("utc", "carol", prefs()), role: "member" },
			],
			nowMs: at("2026-10-20T07:59:00Z"),
		});
		await scheduler(w).tick();
		expect(w.sent.map((m) => m.ids)).toEqual([["tokyo"]]);
		expect(w.sent[0]?.event).toEqual({ type: "daily_digest", digestDate: "2026-10-20" });
	});

	test("the local date can differ from the UTC date", async () => {
		const w = world({
			devices: [
				{
					device: device("auckland", "alice", prefs({ timezone: "Pacific/Auckland" })),
					role: "member",
				},
			],
			// 2026-10-20T20:30Z is 09:30 on the 21st in Auckland (NZDT)
			nowMs: at("2026-10-20T20:30:00Z"),
		});
		await scheduler(w).tick();
		expect(w.sent[0]?.event).toEqual({ type: "daily_digest", digestDate: "2026-10-21" });
	});

	test("once per local day: the marker the phone already holds, and the one we wrote, both stop a second send", async () => {
		const w = one(prefs({ lastDigestDate: "2026-10-20" }));
		await scheduler(w).tick();
		expect(w.sent).toEqual([]);

		const w2 = one(prefs());
		const s = scheduler(w2);
		await s.tick();
		w2.nowMs += DIGEST_INTERVAL_MS;
		await s.tick();
		w2.nowMs += DIGEST_INTERVAL_MS;
		await s.tick();
		expect(w2.sent).toHaveLength(1);
	});

	test("a marker write that fails does not cause a second send in this process", async () => {
		const w = one(prefs());
		w.markFails = true;
		const s = scheduler(w);
		await s.tick();
		w.nowMs += DIGEST_INTERVAL_MS;
		await s.tick();
		expect(w.sent).toHaveLength(1);
	});

	test("the next local day sends again", async () => {
		const w = one(prefs());
		const s = scheduler(w);
		await s.tick();
		w.nowMs += 24 * 3600_000;
		w.devices = [
			{ device: device("phone", "alice", prefs({ lastDigestDate: "2026-10-20" })), role: "member" },
		];
		await s.tick();
		expect(w.sent.map((m) => (m.event as { digestDate: string }).digestDate)).toEqual([
			"2026-10-20",
			"2026-10-21",
		]);
	});

	test("a send refused before the relay stays due: the next digest pass tries again", async () => {
		const w = one(prefs());
		w.outcome = () => "queue_full";
		const s = scheduler(w);
		await s.digestTick();
		await s.digestTick();
		expect(w.sent).toHaveLength(2);
		expect(w.marked).toEqual([]);
		w.outcome = () => "sent";
		await s.digestTick();
		expect(w.marked).toEqual([{ deviceId: "phone", date: "2026-10-20" }]);
	});

	test("not opted in, no digestHour, or no token: nothing", async () => {
		for (const p of [
			prefs({ categories: {} }),
			prefs({ categories: { DIGEST: false } }),
			{ timezone: "UTC", categories: { DIGEST: true } },
		]) {
			const w = one(p);
			await scheduler(w).tick();
			expect(w.sent).toEqual([]);
		}
		const w = one(prefs());
		w.devices = [
			{ device: { ...device("phone", "alice", prefs()), sendTokenCiphertext: "" }, role: "member" },
		];
		await scheduler(w).tick();
		expect(w.sent).toEqual([]);
	});

	test("an unknown zone falls back to UTC rather than failing", () => {
		expect(localDateAndHour(Date.parse("2026-10-20T09:00:00Z"), "Not/AZone")).toEqual({
			date: "2026-10-20",
			hour: 9,
		});
		expect(localDateAndHour(Date.parse("2026-10-20T09:00:00Z"), undefined)).toEqual({
			date: "2026-10-20",
			hour: 9,
		});
	});

	test("midnight is hour 0, not 24", () => {
		expect(localDateAndHour(Date.parse("2026-10-20T00:05:00Z"), "UTC")).toEqual({
			date: "2026-10-20",
			hour: 0,
		});
		expect(
			digestDue(device("p", "u", prefs({ digestHour: 0 })), Date.parse("2026-10-20T00:05:00Z")).due,
		).toBe(true);
	});

	test("an owner with nothing to read gets no push, and the day is still marked", async () => {
		const w = one(prefs());
		w.digestCounts.set("phone", 0);
		w.ports.digestSessionCount = async (entry) => w.digestCounts.get(entry.device.id) ?? 1;
		await scheduler(w).tick();
		expect(w.sent).toEqual([]);
		expect(w.marked).toEqual([{ deviceId: "phone", date: "2026-10-20" }]);
	});

	test("each device is judged for its own owner: counts come from the owner's view", async () => {
		const w = world({
			mode: "team",
			devices: [
				{ device: device("alice-phone", "alice", prefs()), role: "member" },
				{ device: device("bob-phone", "bob", prefs()), role: "member" },
			],
			nowMs: at("2026-10-20T09:00:00Z"),
		});
		w.ports.digestSessionCount = async (entry) => (entry.device.userId === "alice" ? 3 : 0);
		await scheduler(w).tick();
		expect(w.sent.map((m) => m.ids)).toEqual([["alice-phone"]]);
		expect(w.marked.map((m) => m.deviceId).sort()).toEqual(["alice-phone", "bob-phone"]);
	});

	test("a refused send that is safe to repeat is retried on the next pass; an ambiguous one is not", async () => {
		const w = world({
			devices: [
				{ device: device("full", "alice", prefs()), role: "member" },
				{ device: device("slow", "bob", prefs()), role: "member" },
				{ device: device("ok", "carol", prefs()), role: "member" },
			],
			nowMs: at("2026-10-20T09:00:00Z"),
		});
		w.outcome = (id) => (id === "full" ? "queue_full" : id === "slow" ? "unavailable" : "sent");
		const s = scheduler(w);
		await s.tick();
		expect(w.marked.map((m) => m.deviceId).sort()).toEqual(["ok", "slow"]);
		w.outcome = () => "sent";
		w.nowMs += DIGEST_INTERVAL_MS;
		await s.tick();
		expect(w.sent.at(-1)?.ids).toEqual(["full"]);
	});

	test("devices with the same local date go out in one send", async () => {
		const w = world({
			devices: [
				{ device: device("a", "alice", prefs()), role: "member" },
				{ device: device("b", "bob", prefs()), role: "member" },
			],
			nowMs: at("2026-10-20T09:00:00Z"),
		});
		await scheduler(w).tick();
		expect(w.sent).toHaveLength(1);
		expect(w.sent[0]?.ids.sort()).toEqual(["a", "b"]);
	});
});

describe("start and stop follow the PushScheduler contract", () => {
	test("start is idempotent, stop halts, and the clock is the injected one", async () => {
		const w = world();
		const s = new PushTriggerScheduler({
			ports: w.ports,
			clock: { now: () => w.nowMs },
			logger: quiet,
			healthIntervalMs: 5,
		});
		expect(s.clock.now()).toBe(w.nowMs);
		s.start();
		s.start();
		await new Promise((r) => setTimeout(r, 40));
		s.stop();
		const seen = w.classifyCalls;
		await new Promise((r) => setTimeout(r, 30));
		expect(w.classifyCalls).toBe(seen);
	});
});

describe("health: a push that never reached anyone is tried again (xander L5)", () => {
	test("retry leaves the session unmarked, so the next pass announces it again; sent and settled mark it", async () => {
		for (const [result, announcements] of [
			["retry", 3],
			["settled", 1],
			["sent", 1],
		] as const) {
			const w = world({ sessions: [session("s1")] });
			w.dispatched = () => result;
			const s = scheduler(w);
			await s.tick();
			w.health.set("s1", "stuck");
			await s.tick();
			await s.tick();
			await s.tick();
			expect({ result, n: w.emitted.length }).toEqual({ result, n: announcements });
		}
	});

	test("a retried push that then goes out is not announced a third time", async () => {
		const w = world({ sessions: [session("s1")] });
		const s = scheduler(w);
		await s.tick();
		w.health.set("s1", "stuck");
		w.dispatched = () => "retry";
		await s.tick();
		w.dispatched = () => "sent";
		await s.tick();
		await s.tick();
		expect(w.emitted).toHaveLength(2);
	});

	test("a large burst is handed to dispatch in batches of at most 25 at once", async () => {
		const w = world({ sessions: Array.from({ length: 120 }, (_, i) => session(`s${i}`)) });
		const s = scheduler(w);
		await s.tick();
		for (let i = 0; i < 120; i++) w.health.set(`s${i}`, "risky");
		let inFlight = 0;
		let peak = 0;
		w.ports.emit = async (event) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await Promise.resolve();
			w.emitted.push(event);
			inFlight -= 1;
			return "sent";
		};
		await s.tick();
		expect(w.emitted).toHaveLength(120);
		expect(peak).toBeLessThanOrEqual(25);
	});
});

describe("AI switched off at runtime (xander L4)", () => {
	const digestPrefs: DevicePrefs = { timezone: "UTC", digestHour: 8, categories: { DIGEST: true } };

	test("neither job sends, and nothing is even classified", async () => {
		const w = world({
			devices: [{ device: device("phone", "alice", digestPrefs), role: "member" }],
			sessions: [session("s1")],
			nowMs: Date.parse("2026-10-20T09:00:00Z"),
		});
		w.aiActive = false;
		const s = scheduler(w);
		await s.tick();
		w.health.set("s1", "stuck");
		await s.tick();
		expect(w.classifyCalls).toBe(0);
		expect(w.emitted).toEqual([]);
		expect(w.sent).toEqual([]);
	});

	test("turned back on, the digest goes out, and a session that was already stuck is recorded, not announced", async () => {
		const w = world({
			devices: [{ device: device("phone", "alice", digestPrefs), role: "member" }],
			sessions: [session("s1")],
			nowMs: Date.parse("2026-10-20T09:00:00Z"),
		});
		const s = scheduler(w);
		w.aiActive = false;
		w.health.set("s1", "stuck");
		await s.tick();
		w.aiActive = true;
		await s.tick();
		expect(w.emitted).toEqual([]);
		expect(w.sent).toHaveLength(1);
	});

	test("switched off after the baseline: the state is forgotten, so the backlog isn't announced on return", async () => {
		const w = world({ sessions: [session("s1")] });
		const s = scheduler(w);
		await s.tick();
		w.aiActive = false;
		await s.tick();
		w.health.set("s1", "stuck");
		w.aiActive = true;
		await s.tick();
		expect(w.emitted).toEqual([]);
	});
});

describe("digest: each target is judged again just before the send (xander M1)", () => {
	const prefs: DevicePrefs = { timezone: "UTC", digestHour: 8, categories: { DIGEST: true } };
	const trio = () =>
		world({
			mode: "team",
			devices: [
				{ device: device("a", "alice", prefs), role: "member" },
				{ device: device("b", "bob", prefs), role: "member" },
				{ device: device("c", "carol", prefs), role: "admin" },
			],
			nowMs: Date.parse("2026-10-20T09:00:00Z"),
		});

	test("a device revoked during the pass is not sent to and not marked; the others are", async () => {
		const w = trio();
		w.revokedAtSend.add("b");
		await scheduler(w).digestTick();
		expect(w.sent.flatMap((m) => m.ids).sort()).toEqual(["a", "c"]);
		expect(w.marked.map((m) => m.deviceId).sort()).toEqual(["a", "c"]);
	});

	test("a revoke that lands between two devices of the same pass is seen", async () => {
		const w = trio();
		const judged: string[] = [];
		const original = w.ports.eligibleDevice;
		w.ports.eligibleDevice = async (id) => {
			judged.push(id);
			if (id === "b") w.revokedAtSend.add("c"); // c is revoked while b is being judged
			return original(id);
		};
		await scheduler(w).digestTick();
		expect(judged).toEqual(["a", "b", "c"]);
		expect(w.sent.flatMap((m) => m.ids).sort()).toEqual(["a", "b"]);
	});

	test("a device demoted from admin is counted for what it may read now", async () => {
		const w = trio();
		const counted: Array<[string, EligibleDevice["role"]]> = [];
		w.ports.digestSessionCount = async (entry) => {
			counted.push([entry.device.id, entry.role]);
			return entry.role === "admin" ? 5 : 0;
		};
		w.roleAtSend.set("c", "member");
		await scheduler(w).digestTick();
		expect(counted).toContainEqual(["c", "member"]);
		expect(w.sent).toEqual([]);
		expect(w.marked.map((m) => m.deviceId).sort()).toEqual(["a", "b", "c"]);
	});

	test("a device that another replica already finished is left alone", async () => {
		const w = trio();
		const entry = w.devices[0] as EligibleDevice;
		const original = w.ports.eligibleDevice;
		w.ports.eligibleDevice = async (id) => {
			const e = await original(id);
			return e && id === "a"
				? {
						...e,
						device: { ...e.device, prefs: { ...e.device.prefs, lastDigestDate: "2026-10-20" } },
					}
				: e;
		};
		await scheduler(w).digestTick();
		expect(w.sent.flatMap((m) => m.ids)).not.toContain(entry.device.id);
		expect(w.sent.flatMap((m) => m.ids).sort()).toEqual(["b", "c"]);
	});
});

describe("the digest runs on its own timer (xander M2)", () => {
	test("a digest pass that never finishes does not delay health", async () => {
		const prefs: DevicePrefs = { timezone: "UTC", digestHour: 8, categories: { DIGEST: true } };
		const w = world({
			devices: [{ device: device("phone", "alice", prefs), role: "member" }],
			sessions: [session("s1")],
			nowMs: Date.parse("2026-10-20T09:00:00Z"),
		});
		let digestStarted = 0;
		w.ports.digestSessionCount = () => {
			digestStarted += 1;
			return new Promise<number>(() => undefined); // stuck for good
		};
		const s = new PushTriggerScheduler({
			ports: w.ports,
			clock: { now: () => w.nowMs },
			logger: quiet,
			healthIntervalMs: 5,
			digestIntervalMs: 5,
		});
		s.start();
		await new Promise((r) => setTimeout(r, 120));
		s.stop();
		expect(digestStarted).toBe(1); // the digest pass is still running; it never overlaps itself
		expect(w.classifyCalls).toBeGreaterThanOrEqual(5); // health kept its pace
	});
});
