/**
 * What a flood of events costs the server. The pre-resolution dedupe runs before
 * any read; the eligible-device list is reused for a moment; time-sensitive
 * events keep headroom when the rest flood; one dispatch reads its session once;
 * and the drop log doesn't become a flood of its own.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	DISPATCH_AMBIGUOUS_HOLD_MS,
	DISPATCH_DEDUPE_MS,
	MAX_INFLIGHT_DISPATCHES,
	MAX_INFLIGHT_PER_ORIGIN,
	TIME_SENSITIVE_HEADROOM,
	_resetDispatchForTest,
	configurePushRuntime,
	dispatchEvent,
} from "./dispatch.js";
import type { AlertOutcome } from "./push-service.js";
import { InMemoryDeviceSource, PolicyPushTargets, type PushSubjectReader } from "./push-targets.js";
import type { PushDevice, PushEvent, SessionSnapshot } from "./types.js";

const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
const logger = {
	info: () => undefined,
	warn: (message: string, fields?: Record<string, string | number | boolean>) => {
		warnings.push({ message, fields });
	},
};

async function settle() {
	for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

const phone: PushDevice = {
	id: "phone",
	userId: "u",
	platform: "ios",
	relayDeviceId: "relay-phone",
	sendTokenCiphertext: "t",
	kid: "k",
	publicKey: "AAAA",
	clientServerRef: "r",
	prefs: {},
};
const sent = (): AlertOutcome[] => [{ deviceId: "phone", status: "sent", pushId: null }];

let resolves: PushEvent[];
let reads: string[];
let release: () => void;
let gate: Promise<void>;

function install(over: { hold?: boolean } = {}) {
	resolves = [];
	reads = [];
	gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	configurePushRuntime({
		targets: {
			resolve: async (event, ctx) => {
				resolves.push(event);
				if ("sessionId" in event && event.sessionId) await ctx?.session(event.sessionId);
				if (over.hold) await gate;
				return [phone];
			},
		},
		readSession: async (id): Promise<SessionSnapshot | null> => {
			reads.push(id);
			return { ownerUserId: null };
		},
		service: { sendToDevices: async () => sent() },
		logger,
	});
}

beforeEach(() => {
	warnings.length = 0;
	_resetDispatchForTest();
});
afterEach(async () => {
	release?.();
	await settle();
	configurePushRuntime(null);
});

describe("pre-resolution dedupe", () => {
	test("the same event twice in the window resolves once and reads nothing the second time", async () => {
		install();
		const event: PushEvent = { type: "stuck", sessionId: "s1" };
		await dispatchEvent(event);
		await dispatchEvent(event);
		expect(resolves).toHaveLength(1);
		expect(reads).toEqual(["s1"]);
	});

	test("a different session or type is not a repeat", async () => {
		install();
		await dispatchEvent({ type: "stuck", sessionId: "s1" });
		await dispatchEvent({ type: "stuck", sessionId: "s2" });
		await dispatchEvent({ type: "risky", sessionId: "s1" });
		expect(resolves).toHaveLength(3);
	});

	test("D35: a failure detected as session_failed and as an alert rule is dispatched once", async () => {
		install();
		await dispatchEvent({ type: "alert_rule_fired", sessionId: "s1", trigger: "failed" });
		await dispatchEvent({ type: "session_failed", sessionId: "s1" });
		expect(resolves.map((e) => e.type)).toEqual(["alert_rule_fired"]);
	});

	test("D35: a completion detected two ways is dispatched once; failure and completion are separate", async () => {
		install();
		await dispatchEvent({ type: "session_completed", sessionId: "s1" });
		await dispatchEvent({ type: "alert_rule_fired", sessionId: "s1", trigger: "completed" });
		await dispatchEvent({ type: "session_failed", sessionId: "s1" });
		expect(resolves.map((e) => e.type)).toEqual(["session_completed", "session_failed"]);
	});

	test("a launch status never merges with the session's failure", async () => {
		install();
		await dispatchEvent({ type: "session_failed", sessionId: "s1" });
		await dispatchEvent({ type: "launch_status", launchId: "l1", sessionId: "s1", failed: true });
		expect(resolves.map((e) => e.type)).toEqual(["session_failed", "launch_status"]);
	});

	test("the window is 60 s", async () => {
		expect(DISPATCH_DEDUPE_MS).toBe(60_000);
	});
});

describe("a dispatch that failed", () => {
	test("doesn't hold the dedupe: the same event may be dispatched again", async () => {
		let calls = 0;
		configurePushRuntime({
			targets: {
				resolve: async () => {
					calls += 1;
					if (calls === 1) throw new Error("first fails");
					return [phone];
				},
			},
			service: { sendToDevices: async () => sent() },
			logger,
		});
		const event: PushEvent = { type: "stuck", sessionId: "retry" };
		await dispatchEvent(event);
		await dispatchEvent(event);
		await dispatchEvent(event);
		expect(calls).toBe(2); // the failure was retried once; the success is then deduped
	});
});

describe("a push the relay refused or may have taken", () => {
	const outcome = (status: string): AlertOutcome[] =>
		[
			status === "budget_limited"
				? { deviceId: "phone", status, retryAfterSec: 30 }
				: status === "invalid"
					? { deviceId: "phone", status, reason: "x" }
					: { deviceId: "phone", status },
		] as AlertOutcome[];
	function installReturning(status: string) {
		resolves = [];
		configurePushRuntime({
			targets: {
				resolve: async (event) => {
					resolves.push(event);
					return [phone];
				},
			},
			service: { sendToDevices: async () => outcome(status) },
			logger,
		});
	}
	afterEach(() => setSystemTime());

	test("the hold is 5 to 10 seconds", () => {
		expect(DISPATCH_AMBIGUOUS_HOLD_MS).toBeGreaterThanOrEqual(5_000);
		expect(DISPATCH_AMBIGUOUS_HOLD_MS).toBeLessThanOrEqual(10_000);
	});

	for (const status of ["unavailable", "budget_limited"]) {
		test(`${status}: an immediate repeat is deduped, and the key is released after the back-off`, async () => {
			const start = Date.now();
			installReturning(status);
			const event: PushEvent = { type: "stuck", sessionId: `hold-${status}` };
			await dispatchEvent(event);
			await dispatchEvent(event);
			expect(resolves).toHaveLength(1);

			setSystemTime(start + DISPATCH_AMBIGUOUS_HOLD_MS - 1_000);
			await dispatchEvent(event);
			expect(resolves).toHaveLength(1);

			setSystemTime(start + DISPATCH_AMBIGUOUS_HOLD_MS + 1_000);
			await dispatchEvent(event);
			expect(resolves).toHaveLength(2);
		});
	}

	for (const status of ["invalid", "queue_full"]) {
		test(`${status}: nothing reached the relay, so the key is released at once`, async () => {
			installReturning(status);
			const event: PushEvent = { type: "stuck", sessionId: `release-${status}` };
			await dispatchEvent(event);
			await dispatchEvent(event);
			expect(resolves).toHaveLength(2);
		});
	}
});

describe("one session read per dispatch", () => {
	test("target resolution and enrichment share it", async () => {
		reads = [];
		let enrichedWith = null as SessionSnapshot | null;
		configurePushRuntime({
			targets: {
				resolve: async (event, ctx) => {
					if ("sessionId" in event && event.sessionId) await ctx?.session(event.sessionId);
					return [{ id: "d" } as PushDevice];
				},
			},
			readSession: async (id) => {
				reads.push(id);
				return { ownerUserId: "u" };
			},
			enrich: async (event, ctx) => {
				if ("sessionId" in event && event.sessionId)
					enrichedWith = await ctx.session(event.sessionId);
				return event;
			},
			service: { sendToDevices: async () => [] },
			logger,
		});
		await dispatchEvent({ type: "stuck", sessionId: "shared" });
		expect(reads).toEqual(["shared"]);
		expect(enrichedWith).toEqual({ ownerUserId: "u" });
	});

	test("an event nobody can receive reads no session at all in solo mode", async () => {
		reads = [];
		const targets = new PolicyPushTargets(new InMemoryDeviceSource([]), async () => "solo");
		configurePushRuntime({
			targets,
			readSession: async (id) => {
				reads.push(id);
				return null;
			},
			enrich: async (e, ctx) => {
				if ("sessionId" in e && e.sessionId) await ctx.session(e.sessionId);
				return e;
			},
			service: { sendToDevices: async () => [] },
			logger,
		});
		await dispatchEvent({ type: "stuck", sessionId: "s" });
		expect(reads).toEqual([]);
	});
});

describe("headroom for time-sensitive events", () => {
	test("a flood of ordinary events stops at the budget; permission and HITL events still get through", async () => {
		install({ hold: true });
		const ordinary = MAX_INFLIGHT_DISPATCHES - TIME_SENSITIVE_HEADROOM;
		for (let i = 0; i < MAX_INFLIGHT_DISPATCHES + 200; i++) {
			void dispatchEvent({ type: "stuck", sessionId: `flood-${i}` });
		}
		await settle();
		expect(resolves).toHaveLength(ordinary);

		for (let i = 0; i < TIME_SENSITIVE_HEADROOM + 50; i++) {
			void dispatchEvent({
				type: i % 2 === 0 ? "permission_wait" : "hitl_opened",
				sessionId: `urgent-${i}`,
				...(i % 2 === 0 ? {} : { hitlId: `h-${i}`, proposalId: "p" }),
			} as PushEvent);
		}
		await settle();
		expect(resolves).toHaveLength(MAX_INFLIGHT_DISPATCHES);
		expect(
			resolves.filter((e) => e.type === "permission_wait" || e.type === "hitl_opened"),
		).toHaveLength(TIME_SENSITIVE_HEADROOM);
	});

	test("the drop is logged once for the whole flood, with how many it stands for", async () => {
		install({ hold: true });
		for (let i = 0; i < MAX_INFLIGHT_DISPATCHES + 300; i++) {
			void dispatchEvent({ type: "stuck", sessionId: `noisy-${i}` });
		}
		await settle();
		const drops = warnings.filter((w) => w.message.includes("dropped"));
		expect(drops).toHaveLength(1);
		expect(drops[0]?.fields?.dropped).toBe(1);
	});
});

describe("the eligible-device cache", () => {
	const device = (id: string): PushDevice => ({
		id,
		userId: "u",
		platform: "ios",
		relayDeviceId: `relay-${id}`,
		sendTokenCiphertext: "t",
		kid: "k",
		publicKey: "AAAA",
		clientServerRef: "r",
		prefs: {},
	});
	const subjects: PushSubjectReader = {
		sessionOwner: async () => ({ ownerUserId: null }),
		launchRequester: async () => ({ ownerUserId: null }),
	};

	test("is reused inside the window and re-read after it", async () => {
		let listed = 0;
		let now = 1_000;
		const source = new InMemoryDeviceSource([device("a")]);
		const counting = {
			listEligibleDevices: async () => {
				listed += 1;
				return source.listEligibleDevices();
			},
		};
		const targets = new PolicyPushTargets(counting, async () => "solo", subjects, {
			ms: 1_500,
			now: () => now,
		});
		const event: PushEvent = { type: "stuck", sessionId: "s" };
		await targets.resolve(event);
		now += 1_000;
		await targets.resolve(event);
		expect(listed).toBe(1);
		now += 600;
		await targets.resolve(event);
		expect(listed).toBe(2);
	});

	test("with no window every resolve reads afresh (the default)", async () => {
		let listed = 0;
		const targets = new PolicyPushTargets(
			{
				listEligibleDevices: async () => {
					listed += 1;
					return [];
				},
			},
			async () => "solo",
		);
		await targets.resolve({ type: "stuck", sessionId: "s" });
		await targets.resolve({ type: "stuck", sessionId: "s" });
		expect(listed).toBe(2);
	});
});

describe("one origin cannot hold the reserved headroom", () => {
	const wait = (i: number): PushEvent => ({ type: "permission_wait", sessionId: `noisy-${i}` });

	test("a noisy ingest origin stops at its own cap, and other origins and server events still get through", async () => {
		install({ hold: true });
		for (let i = 0; i < MAX_INFLIGHT_PER_ORIGIN + 120; i++) {
			void dispatchEvent(wait(i), "owner:noisy");
		}
		await settle();
		expect(resolves).toHaveLength(MAX_INFLIGHT_PER_ORIGIN);

		void dispatchEvent(wait(1_000), "owner:quiet");
		void dispatchEvent({ type: "hitl_opened", sessionId: "s", hitlId: "h1", proposalId: "p" });
		await settle();
		expect(resolves).toHaveLength(MAX_INFLIGHT_PER_ORIGIN + 2);
		expect(resolves.map((e) => e.type)).toContain("hitl_opened");
	});

	test("the noisy origin's slots come back when its events finish", async () => {
		install({ hold: true });
		for (let i = 0; i < MAX_INFLIGHT_PER_ORIGIN + 10; i++)
			void dispatchEvent(wait(i), "owner:noisy");
		await settle();
		release();
		await settle();
		resolves.length = 0;
		install();
		void dispatchEvent(wait(5_000), "owner:noisy");
		await settle();
		expect(resolves).toHaveLength(1);
	});

	test("a failed dispatch frees its origin slot too", async () => {
		configurePushRuntime({
			targets: {
				resolve: async () => {
					throw new Error("boom");
				},
			},
			service: { sendToDevices: async () => [] },
			logger,
		});
		for (let i = 0; i < MAX_INFLIGHT_PER_ORIGIN * 3; i++) await dispatchEvent(wait(i), "owner:x");
		expect(warnings.filter((w) => w.message.includes("dropped"))).toHaveLength(0);
	});
});

describe("the test reset", () => {
	test("dispatches still hanging from before it do not count against the new tally, and finishing late does not underflow it", async () => {
		install({ hold: true });
		const budget = MAX_INFLIGHT_DISPATCHES - TIME_SENSITIVE_HEADROOM;
		for (let i = 0; i < budget; i++) void dispatchEvent({ type: "stuck", sessionId: `old-${i}` });
		await settle();
		expect(resolves).toHaveLength(budget);

		_resetDispatchForTest();
		resolves.length = 0;
		for (let i = 0; i < budget; i++) void dispatchEvent({ type: "stuck", sessionId: `new-${i}` });
		await settle();
		expect(resolves).toHaveLength(budget);

		release(); // the old ones finish now; the budget must still be exactly `budget`, not budget + budget
		await settle();
		resolves.length = 0;
		install({ hold: true });
		for (let i = 0; i < budget + 20; i++)
			void dispatchEvent({ type: "stuck", sessionId: `after-${i}` });
		await settle();
		expect(resolves).toHaveLength(budget);
	});
});

describe("the dedupe key is released when nobody was told", () => {
	const event: PushEvent = { type: "stuck", sessionId: "retry-me" };

	function installWith(devices: PushDevice[], outcomes: () => AlertOutcome[]) {
		let resolved = 0;
		configurePushRuntime({
			targets: {
				resolve: async () => {
					resolved += 1;
					return devices;
				},
			},
			service: { sendToDevices: async () => outcomes() },
			logger,
		});
		return () => resolved;
	}

	test("a resolve that found no device does not block the same event once a device exists", async () => {
		const resolved = installWith([], sent);
		await dispatchEvent(event);
		await dispatchEvent(event);
		expect(resolved()).toBe(2);
	});

	test("an event every send of which was refused before reaching the relay may be dispatched again", async () => {
		const resolved = installWith([phone], () =>
			["invalid", "queue_full"].map((status) => ({ deviceId: "phone", status }) as AlertOutcome),
		);
		await dispatchEvent(event);
		await dispatchEvent(event);
		expect(resolved()).toBe(2);
	});

	test("positive control: one sent push holds the key, even beside refunded ones", async () => {
		const resolved = installWith([phone], () => [
			{ deviceId: "a", status: "unavailable" },
			{ deviceId: "b", status: "sent", pushId: null },
		]);
		await dispatchEvent(event);
		await dispatchEvent(event);
		expect(resolved()).toBe(1);
	});

	test("positive control: outcomes that were not refunded (deduped, category off) keep the key", async () => {
		const resolved = installWith([phone], () => [
			{ deviceId: "a", status: "deduped" },
			{ deviceId: "b", status: "skipped", reason: "category_off" },
		]);
		await dispatchEvent(event);
		await dispatchEvent(event);
		expect(resolved()).toBe(1);
	});
});

describe("PolicyPushTargets.invalidate", () => {
	const subjects: PushSubjectReader = {
		sessionOwner: async () => ({ ownerUserId: null }),
		launchRequester: async () => ({ ownerUserId: null }),
	};
	const stuck: PushEvent = { type: "stuck", sessionId: "s" };

	test("a revoke followed at once by a dispatch reaches no revoked device", async () => {
		const source = new InMemoryDeviceSource([{ ...phone }]);
		const targets = new PolicyPushTargets(source, async () => "solo", subjects, {
			ms: 60_000,
			now: () => 1,
		});
		expect((await targets.resolve(stuck)).map((d) => d.id)).toEqual(["phone"]);
		source.remove("phone");
		expect((await targets.resolve(stuck)).map((d) => d.id)).toEqual(["phone"]); // control: the cache is what hides it
		targets.invalidate();
		expect(await targets.resolve(stuck)).toEqual([]);
	});

	test("a list read that was already running when invalidate was called is not remembered", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let listed = 0;
		const targets = new PolicyPushTargets(
			{
				listEligibleDevices: async () => {
					listed += 1;
					const snapshot = listed === 1 ? [{ device: phone, role: "member" as const }] : [];
					if (listed === 1) await held;
					return snapshot;
				},
			},
			async () => "solo",
			subjects,
			{ ms: 60_000, now: () => 1 },
		);
		const first = targets.resolve(stuck);
		await settle();
		targets.invalidate();
		release();
		await first;
		expect(await targets.resolve(stuck)).toEqual([]);
		expect(listed).toBe(2);
	});
});
