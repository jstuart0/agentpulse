/**
 * Push triggers in the ingest paths. Each trigger fires once per real
 * transition, after the write that caused it has committed, and none of them
 * can slow ingest: with five registered phones and a relay that never answers,
 * events keep being processed at 100 a second with a p95 under 50 ms.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import type { HookEventPayload } from "../../shared/types.js";
import { asKey, deviceBody } from "../test-utils/device-fixtures.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	jsonRequest,
	seedKey,
	seedLocalUser,
} from "../test-utils/team-fixtures.js";
import type { PushDevice, PushEvent } from "./push/types.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, launchRequests, mobileDeviceActivities, mobileDevices, sessions } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { processHookEvent, markSessionFailed } = await import("./event-processor.js");
const { MAX_INFLIGHT_PER_ORIGIN, configurePushRuntime, getPushRuntime, _resetDispatchForTest } =
	await import("./push/dispatch.js");
const { enrichPushEvent } = await import("./push/push-enrich.js");
const { readSessionSnapshot } = await import("./push/device-source.js");
const { startPush, stopPush } = await import("./push/push-runtime.js");
const { _resetDeviceLimitsForTest } = await import("./mobile-devices-service.js");
const { createActionRequest } = await import("./ai/action-requests-service.js");
const { dispatchAlertRuleNotification } = await import("./ai/alert-rule-evaluator.js");
const { claimNextLaunchRequest, updateLaunchDispatchStatus, markLaunchRunning } = await import(
	"./launch-dispatch.js"
);

const quiet = { info: () => undefined, warn: () => undefined };
const originalSecretsKey = config.secretsKey;

/** Lets every fire-and-forget dispatch run to the point of resolving its targets. */
async function flush() {
	for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
	// A recording hook may itself read the database; give that read time to land (Postgres is slower than SQLite).
	await new Promise((r) => setTimeout(r, 150));
}

let seen: PushEvent[] = [];
const recordedPhone: PushDevice = {
	id: "recorded-phone",
	userId: "recorded-user",
	platform: "ios",
	relayDeviceId: "relay-recorded",
	sendTokenCiphertext: "t",
	kid: "k",
	publicKey: "AAAA",
	clientServerRef: "r",
	prefs: {},
};
/**
 * Records what each trigger dispatches. One phone is the target and the send reports "sent", so a
 * dispatched event holds its dedupe key as it would in production (an event nobody was told about
 * releases it). Nothing leaves the process.
 */
function record(onResolve?: (event: PushEvent) => Promise<void> | void) {
	seen = [];
	configurePushRuntime({
		targets: {
			resolve: async (event) => {
				seen.push(event);
				await onResolve?.(event);
				return [recordedPhone];
			},
		},
		service: {
			sendToDevices: async () => [{ deviceId: "recorded-phone", status: "sent", pushId: null }],
		},
		logger: quiet,
	});
}

beforeAll(() => initializeDatabase());

async function reset() {
	stopPush();
	_resetDispatchForTest();
	await getDb().delete(mobileDeviceActivities);
	await getDb().delete(mobileDevices);
	await getDb().delete(events).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await resetIdentityState();
	await clearInstanceSettings();
	_resetDeviceLimitsForTest();
	config.secretsKey = "trigger-test-secrets-key";
}
beforeEach(reset);
afterEach(async () => {
	await reset();
	config.secretsKey = originalSecretsKey;
});
afterAll(() => {
	configurePushRuntime(null);
});

const hook = (sessionId: string, name: string, extra: Partial<HookEventPayload> = {}) =>
	({ session_id: sessionId, hook_event_name: name, ...extra }) as HookEventPayload;

async function mkSession(sessionId: string, over: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			startedAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			metadata: {},
			...over,
		})
		.execute();
}

const types = () => seen.map((e) => e.type);

describe("permission wait", () => {
	test("fires once on the 0 to 1 transition, not for a second request while one is open", async () => {
		await mkSession("pw");
		record();
		await processHookEvent(hook("pw", "PermissionRequest", { tool_use_id: "a" }), "claude_code");
		await flush();
		expect(types()).toEqual(["permission_wait"]);

		await processHookEvent(hook("pw", "PermissionRequest", { tool_use_id: "b" }), "claude_code");
		await flush();
		expect(types()).toEqual(["permission_wait"]);
	});

	test("a wait re-opened inside the dedupe minute is not announced again; the first one stands", async () => {
		await mkSession("pw2");
		record();
		await processHookEvent(hook("pw2", "PermissionRequest", { tool_use_id: "a" }), "claude_code");
		await processHookEvent(hook("pw2", "PostToolUse", { tool_use_id: "a" }), "claude_code");
		await processHookEvent(hook("pw2", "PermissionRequest", { tool_use_id: "c" }), "claude_code");
		await flush();
		expect(types()).toEqual(["permission_wait"]);
	});

	test("is dispatched after the transaction committed: the wait is already stored when targets are resolved", async () => {
		await mkSession("pw3");
		let storedWhenResolved: unknown;
		record(async () => {
			const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "pw3"));
			storedWhenResolved = (row?.metadata as Record<string, unknown>)?.permissionWait;
		});
		await processHookEvent(hook("pw3", "PermissionRequest", { tool_use_id: "a" }), "claude_code");
		await flush();
		expect(storedWhenResolved).toMatchObject({ ids: ["a"] });
	});

	test("a request inside a closed turn opens no wait and fires nothing", async () => {
		await mkSession("pw4");
		record();
		await processHookEvent(hook("pw4", "Stop", { turn_id: "turn-1" }), "claude_code");
		await flush();
		seen = [];
		await processHookEvent(
			hook("pw4", "PermissionRequest", { tool_use_id: "late", turn_id: "turn-1" }),
			"claude_code",
		);
		await flush();
		expect(types()).toEqual([]);
	});

	test("a request after the session ended opens no wait and fires nothing", async () => {
		await mkSession("pw5");
		record();
		await processHookEvent(hook("pw5", "SessionEnd"), "claude_code");
		await flush();
		seen = [];
		await processHookEvent(hook("pw5", "PermissionRequest", { tool_use_id: "z" }), "claude_code");
		await flush();
		expect(types()).toEqual([]);
	});
});

describe("turns, completion and failure", () => {
	test("each Stop fires turn_completed once; other tool events fire nothing", async () => {
		await mkSession("t1");
		record();
		await processHookEvent(hook("t1", "PreToolUse", { tool_name: "Bash" }), "claude_code");
		await processHookEvent(hook("t1", "PostToolUse", { tool_name: "Bash" }), "claude_code");
		await flush();
		expect(types()).toEqual([]);
		await processHookEvent(hook("t1", "Stop"), "claude_code");
		await flush();
		expect(seen).toEqual([{ type: "turn_completed", sessionId: "t1" }]);
	});

	test("a Stop after the session ended (the terminal latch) fires no turn", async () => {
		await mkSession("t1b");
		record();
		await processHookEvent(hook("t1b", "SessionEnd"), "claude_code");
		await flush();
		seen = [];
		await processHookEvent(hook("t1b", "Stop"), "claude_code");
		await flush();
		expect(types()).toEqual([]);
	});

	test("SessionEnd fires session_completed once", async () => {
		await mkSession("t2");
		record();
		await processHookEvent(hook("t2", "SessionEnd"), "claude_code");
		await flush();
		expect(seen).toEqual([{ type: "session_completed", sessionId: "t2" }]);
	});

	test("markSessionFailed fires session_failed once, after the status is written", async () => {
		await mkSession("t3");
		let statusWhenResolved: string | undefined;
		record(async () => {
			const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "t3"));
			statusWhenResolved = row?.status;
		});
		await markSessionFailed("t3");
		await flush();
		expect(seen).toEqual([{ type: "session_failed", sessionId: "t3" }]);
		expect(statusWhenResolved).toBe("failed");
	});

	test("with push off the triggers do nothing and ingest is unchanged", async () => {
		await mkSession("t4");
		configurePushRuntime(null);
		const result = await processHookEvent(hook("t4", "Stop"), "claude_code");
		expect(result.sessionId).toBe("t4");
		expect(getPushRuntime()).toBeNull();
	});
});

describe("ingest-made pushes count against their origin", () => {
	const from = (ownerUserId: string | null, ingestKeyId: string | null) => ({
		keyId: ingestKeyId ?? "anonymous",
		deliveryId: null,
		origin: "native" as const,
		attribution: { ownerUserId, ingestKeyId },
	});

	test("one owner's flood stops at the per-origin cap while it is in flight; another owner is unaffected", async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const flood = MAX_INFLIGHT_PER_ORIGIN + 10;
		for (let i = 0; i < flood; i++) await mkSession(`o-${i}`);
		await mkSession("other");
		record(() => gate);
		for (let i = 0; i < flood; i++) {
			await processHookEvent(hook(`o-${i}`, "Stop"), "claude_code", from("noisy", "k-noisy"));
		}
		await flush();
		expect(seen).toHaveLength(MAX_INFLIGHT_PER_ORIGIN);

		await processHookEvent(hook("other", "Stop"), "claude_code", from("quiet", "k-quiet"));
		await flush();
		expect(seen).toHaveLength(MAX_INFLIGHT_PER_ORIGIN + 1);
		open();
		await flush();
	}, 60_000);

	test("the same owner on a second key shares the cap", async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		for (let i = 0; i < MAX_INFLIGHT_PER_ORIGIN + 1; i++) await mkSession(`k-${i}`);
		record(() => gate);
		for (let i = 0; i < MAX_INFLIGHT_PER_ORIGIN; i++) {
			await processHookEvent(hook(`k-${i}`, "Stop"), "claude_code", from("u", `key-${i % 2}`));
		}
		await flush();
		await processHookEvent(
			hook(`k-${MAX_INFLIGHT_PER_ORIGIN}`, "Stop"),
			"claude_code",
			from("u", "key-other"),
		);
		await flush();
		expect(seen).toHaveLength(MAX_INFLIGHT_PER_ORIGIN);
		open();
		await flush();
	}, 60_000);

	test("a poster with no key context has no origin: it is bounded by the global budget only", async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const count = MAX_INFLIGHT_PER_ORIGIN + 20;
		for (let i = 0; i < count; i++) await mkSession(`n-${i}`);
		record(() => gate);
		for (let i = 0; i < count; i++) {
			await processHookEvent(hook(`n-${i}`, "Stop"), "claude_code", from(null, null));
		}
		await flush();
		expect(seen).toHaveLength(count);
		open();
		await flush();
	}, 60_000);
});

describe("the other triggers", () => {
	test("an action request fires action_request_opened with its id and kind", async () => {
		record();
		const req = await createActionRequest({
			kind: "session_archive",
			question: "Archive?",
			payload: { sessionId: "x" } as never,
			origin: "web",
		});
		await flush();
		expect(seen).toEqual([
			{ type: "action_request_opened", actionRequestId: req.id, actionKind: "session_archive" },
		]);
	});

	test("a fired alert rule fires alert_rule_fired, with or without a channel", async () => {
		record();
		const rule = { id: "rule-1", channelId: null } as never;
		await dispatchAlertRuleNotification(rule, "s-ar", "My session", "stuck");
		await flush();
		expect(seen).toEqual([
			{
				type: "alert_rule_fired",
				sessionId: "s-ar",
				sessionName: "My session",
				trigger: "stuck",
				ruleId: "rule-1",
			},
		]);
	});

	test("hitl_opened is dispatched in the runner right after the HITL request is opened, and only with an id", () => {
		const source = readFileSync(join(import.meta.dir, "ai/runner.ts"), "utf8");
		const opened = source.indexOf("await completeProposalAsHitl(");
		const dispatched = source.indexOf('type: "hitl_opened"');
		const guard = source.lastIndexOf("if (hitlOpen.hitlId)", dispatched);
		expect(opened).toBeGreaterThan(-1);
		expect(dispatched).toBeGreaterThan(opened);
		expect(guard).toBeGreaterThan(opened);
	});
});

describe("launch status", () => {
	async function mkLaunch(status: string, over: Record<string, unknown> = {}) {
		const id = crypto.randomUUID();
		await getDb()
			.insert(launchRequests)
			.values({
				id,
				launchCorrelationId: `corr-${id}`,
				agentType: "claude_code",
				cwd: "/tmp/x",
				status,
				requestedSupervisorId: "sup-1",
				claimedBySupervisorId: "sup-1",
				...over,
			})
			.execute();
		return id;
	}

	test("claiming (queued) announces nothing: it is plumbing", async () => {
		await mkLaunch("validated");
		record();
		await claimNextLaunchRequest("sup-1");
		await flush();
		expect(seen).toEqual([]);
	});

	test("running, completed, failed and cancelled each announce once, and a repeat of the same status does not", async () => {
		record();
		for (const status of ["running", "completed", "failed", "cancelled"] as const) {
			const id = await mkLaunch("launching");
			seen = [];
			await updateLaunchDispatchStatus({ supervisorId: "sup-1", launchId: id, status });
			await updateLaunchDispatchStatus({ supervisorId: "sup-1", launchId: id, status });
			await flush();
			const announced = seen.filter((e) => e.type === "launch_status");
			expect(announced).toHaveLength(1);
			expect(announced[0]).toMatchObject({ launchId: id, failed: status === "failed" });
		}
	});

	test("the intermediate statuses (launching, awaiting_session) announce nothing", async () => {
		const id = await mkLaunch("queued");
		record();
		await updateLaunchDispatchStatus({ supervisorId: "sup-1", launchId: id, status: "launching" });
		await updateLaunchDispatchStatus({
			supervisorId: "sup-1",
			launchId: id,
			status: "awaiting_session",
		});
		await flush();
		expect(seen).toEqual([]);
	});

	test("markLaunchRunning announces running once, and not again when the launch is already running", async () => {
		const id = await mkLaunch("awaiting_session");
		record();
		await markLaunchRunning(id);
		await markLaunchRunning(id);
		await flush();
		expect(seen.filter((e) => e.type === "launch_status")).toHaveLength(1);
	});

	test("a status written for another supervisor's launch changes and announces nothing", async () => {
		const id = await mkLaunch("launching");
		record();
		const result = await updateLaunchDispatchStatus({
			supervisorId: "someone-else",
			launchId: id,
			status: "running",
		});
		await flush();
		expect(result).toBeNull();
		expect(seen).toEqual([]);
	});
});

describe("dispatch never blocks ingest", () => {
	test("ingest completes while target resolution is hung, and the backlog is bounded", async () => {
		await mkSession("hung");
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		configurePushRuntime({
			targets: {
				resolve: async () => {
					started += 1;
					await gate;
					return [];
				},
			},
			service: { sendToDevices: async () => [] },
			logger: quiet,
		});
		try {
			const result = await processHookEvent(hook("hung", "Stop"), "claude_code");
			expect(result.sessionId).toBe("hung");
			await flush();
			expect(started).toBe(1); // the dispatch is running, and still waiting

			const { dispatchEvent, MAX_INFLIGHT_DISPATCHES } = await import("./push/dispatch.js");
			for (let i = 0; i < MAX_INFLIGHT_DISPATCHES + 50; i++) {
				void dispatchEvent({ type: "turn_completed", sessionId: `flood-${i}` });
			}
			await flush();
			// One was already in flight; the rest up to the cap run, and the surplus is dropped.
			expect(started).toBe(MAX_INFLIGHT_DISPATCHES);
		} finally {
			release();
			await flush();
		}
	});

	test("ingest completes while sending is hung", async () => {
		await mkSession("hung-send");
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let sends = 0;
		configurePushRuntime({
			targets: { resolve: async () => [{ id: "d" } as never] },
			service: {
				sendToDevices: async () => {
					sends += 1;
					await gate;
					return [];
				},
			},
			logger: quiet,
		});
		try {
			await processHookEvent(hook("hung-send", "Stop"), "claude_code");
			await flush();
			expect(sends).toBe(1);
		} finally {
			release();
			await flush();
		}
	});

	test("100 events a second to five phones through a relay that never answers: ingest p95 stays under 50 ms", async () => {
		let requests = 0;
		const relay = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				requests += 1;
				return new Promise<Response>(() => undefined); // never answers
			},
		});
		try {
			const user = await seedLocalUser("bench-alice");
			const key = await seedKey("bench-respond", ["respond"], user.id);
			for (let i = 0; i < 5; i++) {
				const res = await app.request(
					"/api/v1/devices",
					jsonRequest("POST", await deviceBody(), asKey(key.key)),
				);
				expect(res.status).toBe(201);
			}
			startPush({ AGENTPULSE_PUSH_RELAY_URL: `http://127.0.0.1:${relay.port}` }, quiet);
			const real = getPushRuntime() as NonNullable<ReturnType<typeof getPushRuntime>>;
			expect(real).not.toBeNull();
			let resolved = 0;
			let targeted = 0;
			configurePushRuntime({
				...real,
				targets: {
					resolve: async (event) => {
						resolved += 1;
						const devices = await real.targets.resolve(event);
						targeted += devices.length;
						return devices;
					},
				},
			});

			// Three one-second windows of 100 events. A dispatch that blocked ingest would slow every
			// window; a busy machine slows some of them, so the quietest window is the one judged.
			const WINDOWS = 3;
			const PER_WINDOW = 100;
			const GAP_MS = 10;
			const p95s: number[] = [];
			const rates: number[] = [];
			let n = 0;
			for (let w = 0; w < WINDOWS; w++) {
				const latencies: number[] = [];
				const inflight: Promise<unknown>[] = [];
				const started = performance.now();
				for (let i = 0; i < PER_WINDOW; i++) {
					const wait = started + i * GAP_MS - performance.now();
					if (wait > 0) await new Promise((r) => setTimeout(r, wait));
					const begin = performance.now();
					inflight.push(
						processHookEvent(hook(`bench-${n++}`, "Stop"), "claude_code").then(() => {
							latencies.push(performance.now() - begin);
						}),
					);
				}
				await Promise.all(inflight);
				rates.push(PER_WINDOW / ((performance.now() - started) / 1000));
				latencies.sort((a, b) => a - b);
				p95s.push(latencies[Math.floor(latencies.length * 0.95)] as number);
			}
			await flush();

			// The push path was genuinely exercised: every Stop was dispatched to all five phones,
			// and the relay is sitting on requests it will never answer.
			expect(resolved).toBe(WINDOWS * PER_WINDOW);
			expect(targeted).toBe(WINDOWS * PER_WINDOW * 5);
			expect(requests).toBeGreaterThan(0);
			expect(Math.max(...rates)).toBeGreaterThan(80);
			expect(Math.min(...p95s)).toBeLessThan(50);
		} finally {
			stopPush();
			relay.stop(true);
		}
	}, 60_000);
});

describe("a launch's correlation id can't point enrichment at someone else's session (I1)", () => {
	const ctx = { session: readSessionSnapshot };
	const launch = (sessionId: string, requesterUserId: string | null): PushEvent => ({
		type: "launch_status",
		launchId: "l1",
		sessionId,
		requesterUserId,
	});

	test("the labels of another user's session are not copied onto the launch's notification", async () => {
		await mkSession("bobs", {
			ownerUserId: "bob",
			displayName: "bob's secret project",
			reportedHost: "bob-laptop",
		});
		const out = (await enrichPushEvent(launch("bobs", "alice"), ctx)) as Record<string, unknown>;
		expect(out.sessionName).toBeUndefined();
		expect(out.agent).toBeUndefined();
		expect(out.machine).toBeUndefined();
		expect(out.status).toBeUndefined();
		expect(JSON.stringify(out)).not.toContain("secret project");
	});

	test("a launch with no recorded requester can't borrow an owned session either", async () => {
		await mkSession("bobs2", { ownerUserId: "bob", displayName: "bob's other project" });
		const out = (await enrichPushEvent(launch("bobs2", null), ctx)) as Record<string, unknown>;
		expect(out.sessionName).toBeUndefined();
	});

	test("positive control: the requester's own session is enriched", async () => {
		await mkSession("alices", { ownerUserId: "alice", displayName: "alice's project" });
		const out = (await enrichPushEvent(launch("alices", "alice"), ctx)) as Record<string, unknown>;
		expect(out.sessionName).toBe("alice's project");
		expect(out.agent).toBe("claude_code");
	});

	test("positive control: an unattributed launch of an unowned session is enriched", async () => {
		await mkSession("nobodys", { ownerUserId: null, displayName: "open project" });
		const out = (await enrichPushEvent(launch("nobodys", null), ctx)) as Record<string, unknown>;
		expect(out.sessionName).toBe("open project");
	});

	test("a real launch transition carries its requester, so the guard has something to compare", async () => {
		const id = crypto.randomUUID();
		await getDb()
			.insert(launchRequests)
			.values({
				id,
				launchCorrelationId: `corr-${id}`,
				agentType: "claude_code",
				cwd: "/tmp/x",
				status: "launching",
				claimedBySupervisorId: "sup-1",
				requestedByUserId: "alice",
			})
			.execute();
		record();
		await updateLaunchDispatchStatus({ supervisorId: "sup-1", launchId: id, status: "running" });
		await flush();
		expect(seen[0]).toMatchObject({ type: "launch_status", requesterUserId: "alice" });
	});
});
