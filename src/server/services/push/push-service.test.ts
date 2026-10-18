import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { config } from "../../config.js";
import { decryptSecret, decryptSecretAsync, encryptSecret } from "../ai/secrets.js";
import { HPKE_INFO, type PushPayload, type RelayEnvelope, pushAad } from "./hpke-seal.js";
import { PushPayloadSchema } from "./push-payload.js";
import {
	ACTIVITY_BURST,
	ACTIVITY_CONCURRENCY,
	ACTIVITY_MAX_PENDING,
	ALERT_CONCURRENCY,
	CATEGORY_LIMIT_PER_HOUR,
	DEDUPE_MAX_KEYS,
	DEDUPE_WINDOW_MS,
	MAX_DEVICES_PER_USER,
	NEW_SESSION_CEILING_MULTIPLE,
	PushService,
	type RelayPoster,
	SESSION_LIMIT_PER_HOUR,
	TIME_SENSITIVE_LIMIT_PER_HOUR,
	TIME_SENSITIVE_SESSION_LIMIT_PER_HOUR,
	WorkPool,
} from "./push-service.js";
import { RelayClient } from "./relay-client.js";
import type {
	DevicePrefs,
	InterruptionLevel,
	PushCategory,
	PushDevice,
	PushEvent,
	PushLogger,
	PushRevocationSink,
	RelayPriority,
} from "./types.js";

const suite = new CipherSuite({
	kem: new DhkemP256HkdfSha256(),
	kdf: new HkdfSha256(),
	aead: new Aes256Gcm(),
});
const T0 = 1_760_000_000_000;
const SEC = 1000;
const HOUR = 3_600_000;
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

function makeClock(start = T0) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		set: (v: number) => {
			t = v;
		},
	};
}

/** Stands in for encryptSecret/decryptSecret: reversible, and visibly not the plain token. */
const storedToken = (plain: string) => `stored:${plain.split("").reverse().join("")}`;
const unstoreToken = (stored: string) => {
	if (!stored.startsWith("stored:")) throw new Error("not a stored token");
	return stored.slice(7).split("").reverse().join("");
};
const plainToken = (device: PushDevice) => unstoreToken(device.sendTokenCiphertext);

let deviceSeq = 0;
/** A device with a real key pair, so what the service seals can be opened here. */
async function makeDevice(over: Partial<PushDevice> = {}) {
	const pair = await suite.kem.generateKeyPair();
	const n = ++deviceSeq;
	const device: PushDevice = {
		id: `dev-${n}`,
		userId: "user-1",
		platform: "ios",
		relayDeviceId: `relayDevice${String(n).padStart(12, "0")}`,
		sendTokenCiphertext: storedToken(`send-token-SECRET-${n}.0123456789abcdef`),
		kid: `kid-${n}`,
		publicKey: Buffer.from(
			new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey)),
		).toString("base64url"),
		clientServerRef: "srv-ref-1",
		prefs: {},
		...over,
	};
	const open = async (envelope: RelayEnvelope): Promise<PushPayload> => {
		const plaintext = await suite.open(
			{
				recipientKey: pair.privateKey,
				enc: b64(envelope.e),
				info: new TextEncoder().encode(HPKE_INFO),
			},
			b64(envelope.c),
			new TextEncoder().encode(pushAad(envelope.d, envelope.p)),
		);
		return JSON.parse(new TextDecoder().decode(plaintext)) as PushPayload;
	};
	return { device, open };
}

interface SeenRequest {
	raw: string;
	body: Record<string, unknown>;
	headers: Headers;
}
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
});

function startMockRelay(
	handler: (
		body: Record<string, unknown>,
		seen: SeenRequest[],
	) => Response | Promise<Response> = () => accepted(),
) {
	const seen: SeenRequest[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const raw = await req.text();
			const body = JSON.parse(raw) as Record<string, unknown>;
			seen.push({ raw, body, headers: req.headers });
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				return await handler(body, seen);
			} finally {
				inFlight--;
			}
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, seen, maxInFlight: () => maxInFlight };
}
const accepted = () =>
	new Response(JSON.stringify({ pushId: "11111111-2222-3333-4444-555555555555" }), {
		status: 202,
		headers: { "content-type": "application/json" },
	});
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

function makeSink() {
	const calls: string[] = [];
	const sink: PushRevocationSink = {
		deviceGone: (d) => void calls.push(`deviceGone:${d.id}`),
		activityGone: (d, slot) => void calls.push(`activityGone:${d.id}:${slot}`),
		tokenRejected: (d) => void calls.push(`tokenRejected:${d.id}`),
	};
	return { sink, calls };
}

function makeLogger() {
	const lines: string[] = [];
	const logger: PushLogger = {
		info: (m, f) => void lines.push(`${m} ${JSON.stringify(f ?? {})}`),
		warn: (m, f) => void lines.push(`${m} ${JSON.stringify(f ?? {})}`),
	};
	return { lines, logger };
}

function makeService(
	relay: RelayPoster,
	extra: Partial<ConstructorParameters<typeof PushService>[0]> = {},
) {
	const clock = makeClock();
	const { sink, calls } = makeSink();
	const log = makeLogger();
	let n = 0;
	const service = new PushService({
		relay,
		revocations: sink,
		readSendToken: unstoreToken,
		clock,
		logger: log.logger,
		newPushId: () => `push-${++n}`,
		...extra,
	});
	return { service, clock, calls, ...log };
}

function liveClient(
	url: string,
	options: ReturnType<typeof makeClock> | { failureThreshold: number } = makeClock(),
) {
	const tuning = "now" in options ? { clock: options } : { clock: makeClock(), ...options };
	return new RelayClient({ relayUrl: url, logger: makeLogger().logger, ...tuning });
}

let sessionSeq = 0;
const permissionWait = (over: Record<string, unknown> = {}): PushEvent =>
	({
		type: "permission_wait",
		sessionId: `sess-${++sessionSeq}`,
		sessionName: "refactor the auth module",
		agent: "claude",
		machine: "example-machine",
		status: "waiting",
		pending: 1,
		...over,
	}) as PushEvent;

describe("the sealed alert", () => {
	test("a permission wait reaches the relay sealed, with the device's send token, and opens to the schema's members", async () => {
		const relay = startMockRelay();
		const { device, open } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		const event = permissionWait({
			sessionId: "sess-abc",
			text: "Bash wants to run rm -rf build/",
		});
		const [outcome] = await service.sendToDevices([device], event);

		expect(outcome).toEqual({
			deviceId: device.id,
			status: "sent",
			pushId: "11111111-2222-3333-4444-555555555555",
		});
		expect(relay.seen).toHaveLength(1);
		const [seen] = relay.seen;
		expect(seen?.headers.get("authorization")).toBe(`Bearer ${plainToken(device)}`);
		expect(Object.keys(seen?.body ?? {}).sort()).toEqual([
			"collapseId",
			"envelope",
			"kind",
			"priority",
		]);
		expect(seen?.body).toMatchObject({ kind: "alert", priority: "needs-you" });
		const envelope = seen?.body.envelope as RelayEnvelope;
		expect(Object.keys(envelope).sort()).toEqual(["c", "d", "e", "p", "v"]);
		expect(envelope).toMatchObject({ v: 1, d: device.relayDeviceId, p: "push-1" });

		const payload = await open(envelope);
		expect(payload).toEqual({
			v: 1,
			kid: device.kid,
			pid: "push-1",
			ts: Math.floor(clock.now() / 1000),
			ref: "srv-ref-1",
			t: "permission_wait",
			cat: "NEEDS_YOU_PERMISSION",
			il: "time-sensitive",
			sid: "sess-abc",
			sname: "refactor the auth module",
			agent: "claude",
			machine: "example-machine",
			status: "waiting",
			pending: 1,
		});
		expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
	});

	test("the relay never sees a session id, a name, a machine or any text: the body is the envelope and cleartext routing only", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice({ prefs: { includeAgentText: true } });
		const { service } = makeService(liveClient(relay.url));
		await service.sendToDevices(
			[device],
			permissionWait({
				sessionId: "sess-PLAINTEXT-ID",
				sessionName: "PLAINTEXT-NAME",
				machine: "PLAINTEXT-HOST",
				text: "PLAINTEXT-TEXT",
			}),
		);
		const raw = relay.seen.map((s) => s.raw).join("\n");
		for (const secret of [
			"PLAINTEXT",
			"sess-",
			"claude",
			"permission_wait",
			"NEEDS_YOU",
			"time-sensitive",
		]) {
			expect(raw.includes(secret), `the relay body contained ${secret}`).toBe(false);
		}
	});

	test("the collapse id is opaque and stable per session and category", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		await service.sendToDevices([device], permissionWait({ sessionId: "sess-same" }));
		clock.advance(2 * DEDUPE_WINDOW_MS);
		await service.sendToDevices([device], permissionWait({ sessionId: "sess-same" }));
		await service.sendToDevices([device], { type: "turn_completed", sessionId: "sess-same" });
		const ids = relay.seen.map((s) => s.body.collapseId as string);
		expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[2]).not.toBe(ids[0]);
	});
});

describe("category, interruption level and relay priority", () => {
	const cases: [PushEvent, PushCategory, InterruptionLevel, RelayPriority][] = [
		[{ type: "turn_completed", sessionId: "s" }, "NEEDS_YOU_TURN", "time-sensitive", "needs-you"],
		[
			{ type: "permission_wait", sessionId: "s" },
			"NEEDS_YOU_PERMISSION",
			"time-sensitive",
			"needs-you",
		],
		[{ type: "session_failed", sessionId: "s" }, "SESSION_FAILED", "active", "normal"],
		[
			{ type: "hitl_opened", sessionId: "s", hitlId: "h1", proposalId: "p1" },
			"WATCHER_HITL",
			"time-sensitive",
			"needs-you",
		],
		[
			{ type: "action_request_opened", actionRequestId: "a1", actionKind: "launch_request" },
			"ACTION_REQUEST",
			"active",
			"normal",
		],
		[{ type: "stuck", sessionId: "s" }, "STUCK", "active", "normal"],
		[{ type: "risky", sessionId: "s" }, "RISKY", "time-sensitive", "needs-you"],
		[{ type: "session_completed", sessionId: "s" }, "SESSION_COMPLETED", "passive", "quiet"],
		[{ type: "launch_status", launchId: "l1" }, "LAUNCH_STATUS", "passive", "quiet"],
		[{ type: "launch_status", launchId: "l1", failed: true }, "LAUNCH_STATUS", "active", "normal"],
		[{ type: "daily_digest", digestDate: "2026-10-17" }, "DIGEST", "passive", "quiet"],
	];

	test.each(cases)("%j -> %s, %s, %s", async (event, category, level, priority) => {
		const relay = startMockRelay();
		const { device, open } = await makeDevice({
			prefs: { categories: { SESSION_COMPLETED: true, LAUNCH_STATUS: true, DIGEST: true } },
		});
		const { service } = makeService(liveClient(relay.url));
		const [outcome] = await service.sendToDevices([device], event);
		expect(outcome?.status).toBe("sent");
		const payload = await open(relay.seen[0]?.body.envelope as RelayEnvelope);
		expect(payload.cat).toBe(category);
		expect(payload.il).toBe(level);
		expect(relay.seen[0]?.body.priority).toBe(priority);
		expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
	});

	test("the server always sends the base category: a Free phone downgrades decision categories itself", async () => {
		const relay = startMockRelay();
		const { device, open } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		await service.sendToDevices([device], {
			type: "hitl_opened",
			sessionId: "s",
			hitlId: "h",
			proposalId: "p",
		});
		await service.sendToDevices([device], {
			type: "action_request_opened",
			actionRequestId: "a",
			actionKind: "k",
		});
		const cats = await Promise.all(
			relay.seen.map(async (s) => (await open(s.body.envelope as RelayEnvelope)).cat),
		);
		expect(cats).toEqual(["WATCHER_HITL", "ACTION_REQUEST"]);
		expect(cats.some((c) => c.endsWith("_VIEW"))).toBe(false);
	});

	test("per-event members: hitl ids and prompt hash, action ids, launch id, durations", async () => {
		const relay = startMockRelay();
		const { device, open } = await makeDevice({
			prefs: { categories: { SESSION_COMPLETED: true, LAUNCH_STATUS: true } },
		});
		const { service } = makeService(liveClient(relay.url));
		const hash = "a".repeat(64);
		await service.sendToDevices([device], {
			type: "hitl_opened",
			sessionId: "s1",
			hitlId: "h1",
			proposalId: "p1",
			promptHash: hash,
		});
		await service.sendToDevices([device], {
			type: "action_request_opened",
			actionRequestId: "ar1",
			actionKind: "session_stop",
		});
		await service.sendToDevices([device], { type: "launch_status", launchId: "l1" });
		await service.sendToDevices([device], {
			type: "session_completed",
			sessionId: "s2",
			durationSec: 2520.9,
			toolCount: 118,
		});
		const payloads = await Promise.all(
			relay.seen.map((s) => open(s.body.envelope as RelayEnvelope)),
		);
		expect(payloads[0]).toMatchObject({
			hitlId: "h1",
			proposalId: "p1",
			promptHash: hash,
			sid: "s1",
		});
		expect(payloads[1]).toMatchObject({ actionRequestId: "ar1", actionKind: "session_stop" });
		expect(payloads[1]?.sid).toBeUndefined();
		expect(payloads[2]).toMatchObject({ launchId: "l1" });
		expect(payloads[3]).toMatchObject({ durationSec: 2520, toolCount: 118 });
	});

	test("members that break the schema are left out, not sent: a bad prompt hash, an oversized id", async () => {
		const relay = startMockRelay();
		const { device, open } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		await service.sendToDevices([device], {
			type: "hitl_opened",
			sessionId: "s",
			hitlId: "h".repeat(80),
			proposalId: "p",
			promptHash: "NOT-A-HASH",
		});
		const payload = await open(relay.seen[0]?.body.envelope as RelayEnvelope);
		expect(payload.hitlId).toBeUndefined();
		expect(payload.promptHash).toBeUndefined();
		expect(payload.proposalId).toBe("p");
		expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
	});
});

describe("device prefs", () => {
	const send = async (prefs: DevicePrefs, event: PushEvent) => {
		const relay = startMockRelay();
		const { device, open } = await makeDevice({ prefs });
		const { service, clock } = makeService(liveClient(relay.url));
		const [outcome] = await service.sendToDevices([device], event);
		return { outcome, relay, open, clock, service, device };
	};

	test("Show content defaults on and, when off, drops the name, agent and machine", async () => {
		const on = await send({}, permissionWait());
		const off = await send({ showContent: false }, permissionWait());
		const a = await on.open(on.relay.seen[0]?.body.envelope as RelayEnvelope);
		const b = await off.open(off.relay.seen[0]?.body.envelope as RelayEnvelope);
		expect(a).toMatchObject({
			sname: "refactor the auth module",
			agent: "claude",
			machine: "example-machine",
		});
		expect(b.sname).toBeUndefined();
		expect(b.agent).toBeUndefined();
		expect(b.machine).toBeUndefined();
		expect(b.sid).toBeDefined(); // the id still routes the tap
		expect(b.status).toBe("waiting");
	});

	test("agent text is off by default even when the event carries it", async () => {
		const out = await send({}, permissionWait({ text: "Bash wants to run: rm -rf build/" }));
		const payload = await out.open(out.relay.seen[0]?.body.envelope as RelayEnvelope);
		expect(payload.text).toBeUndefined();
		expect(out.relay.seen[0]?.raw).not.toContain("rm -rf");
	});

	test("Include agent text adds a redacted line cut to 180 characters", async () => {
		const secret = "AKIAIOSFODNN7EXAMPLE";
		const long = `${"word ".repeat(60)}${secret} tail`;
		const out = await send(
			{ includeAgentText: true },
			permissionWait({ text: `export KEY=${secret} && ${long}` }),
		);
		const payload = await out.open(out.relay.seen[0]?.body.envelope as RelayEnvelope);
		expect(payload.text).toBeDefined();
		expect(Array.from(payload.text ?? "").length).toBeLessThanOrEqual(180);
		expect(payload.text).not.toContain(secret);
		expect(payload.text).toContain("[REDACTED");
	});

	test("an event with no text sends no text key even with the opt-in", async () => {
		const out = await send({ includeAgentText: true }, permissionWait());
		const payload = await out.open(out.relay.seen[0]?.body.envelope as RelayEnvelope);
		expect("text" in payload).toBe(false);
	});

	test("default-off categories (completed, launches, digest) are skipped, and an explicit true sends them", async () => {
		const completed: PushEvent = { type: "session_completed", sessionId: "s" };
		const skipped = await send({}, completed);
		expect(skipped.outcome).toEqual({
			deviceId: skipped.device.id,
			status: "skipped",
			reason: "category_off",
		});
		expect(skipped.relay.seen).toHaveLength(0);
		const sent = await send({ categories: { SESSION_COMPLETED: true } }, completed);
		expect(sent.outcome?.status).toBe("sent");
	});

	test("an explicit false turns off a default-on category", async () => {
		const out = await send({ categories: { NEEDS_YOU_PERMISSION: false } }, permissionWait());
		expect(out.outcome?.status).toBe("skipped");
		expect(out.relay.seen).toHaveLength(0);
	});

	test("a skipped alert uses up nothing: it neither dedupes nor counts toward the hourly limit", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice({ prefs: { categories: { NEEDS_YOU_PERMISSION: false } } });
		const { service } = makeService(liveClient(relay.url));
		const event = permissionWait({ sessionId: "sess-fixed" });
		await service.sendToDevices([device], event);
		device.prefs = {};
		expect((await service.sendToDevices([device], event))[0]?.status).toBe("sent");
	});

	describe("quiet hours", () => {
		const event = () => permissionWait();
		const quiet = (start: string, end: string, timezone?: string): DevicePrefs => ({
			quietHours: { enabled: true, start, end },
			...(timezone ? { timezone } : {}),
		});
		const levelAt = async (prefs: DevicePrefs, iso: string) => {
			const relay = startMockRelay();
			const { device, open } = await makeDevice({ prefs });
			const { service, clock } = makeService(liveClient(relay.url));
			clock.set(Date.parse(iso));
			await service.sendToDevices([device], event());
			const payload = await open(relay.seen[0]?.body.envelope as RelayEnvelope);
			return { il: payload.il, priority: relay.seen[0]?.body.priority };
		};

		test("inside the window the alert goes out passive and quiet; outside it keeps its level", async () => {
			expect(await levelAt(quiet("22:00", "07:00", "UTC"), "2026-10-17T23:30:00Z")).toEqual({
				il: "passive",
				priority: "quiet",
			});
			expect(await levelAt(quiet("22:00", "07:00", "UTC"), "2026-10-17T12:00:00Z")).toEqual({
				il: "time-sensitive",
				priority: "needs-you",
			});
		});

		test("the window wraps midnight, includes its start, and excludes its end", async () => {
			const p = quiet("22:00", "07:00", "UTC");
			expect((await levelAt(p, "2026-10-17T22:00:00Z")).il).toBe("passive");
			expect((await levelAt(p, "2026-10-18T03:00:00Z")).il).toBe("passive");
			expect((await levelAt(p, "2026-10-18T06:59:00Z")).il).toBe("passive");
			expect((await levelAt(p, "2026-10-18T07:00:00Z")).il).toBe("time-sensitive");
			expect((await levelAt(p, "2026-10-17T21:59:00Z")).il).toBe("time-sensitive");
		});

		test("a same-day window works too", async () => {
			const p = quiet("13:00", "14:30", "UTC");
			expect((await levelAt(p, "2026-10-17T13:00:00Z")).il).toBe("passive");
			expect((await levelAt(p, "2026-10-17T14:29:00Z")).il).toBe("passive");
			expect((await levelAt(p, "2026-10-17T14:30:00Z")).il).toBe("time-sensitive");
		});

		test("the device's own time zone decides, including across the date line", async () => {
			const p = quiet("22:00", "07:00", "America/Los_Angeles");
			// 2026-10-18T05:30Z is 22:30 the evening before in Los Angeles (PDT, UTC-7).
			expect((await levelAt(p, "2026-10-18T05:30:00Z")).il).toBe("passive");
			// 2026-10-17T12:00Z is 05:00 there, still inside; 15:00Z is 08:00 there, outside.
			expect((await levelAt(p, "2026-10-17T12:00:00Z")).il).toBe("passive");
			expect((await levelAt(p, "2026-10-17T15:00:00Z")).il).toBe("time-sensitive");
		});

		test("disabled, equal start and end, junk times and an unknown zone never break a push", async () => {
			expect(
				(
					await levelAt(
						{ quietHours: { enabled: false, start: "00:00", end: "23:59" } },
						"2026-10-17T12:00:00Z",
					)
				).il,
			).toBe("time-sensitive");
			expect((await levelAt(quiet("09:00", "09:00", "UTC"), "2026-10-17T09:00:00Z")).il).toBe(
				"time-sensitive",
			);
			expect((await levelAt(quiet("25:00", "07:00", "UTC"), "2026-10-17T03:00:00Z")).il).toBe(
				"time-sensitive",
			);
			expect((await levelAt(quiet("22:00", "07:00", "Not/AZone"), "2026-10-17T23:00:00Z")).il).toBe(
				"passive",
			); // UTC fallback
		});

		test("quiet hours turn an alert down, they never drop it", async () => {
			const relay = startMockRelay();
			const { device } = await makeDevice({ prefs: quiet("00:00", "23:59", "UTC") });
			const { service } = makeService(liveClient(relay.url));
			expect((await service.sendToDevices([device], event()))[0]?.status).toBe("sent");
		});
	});
});

describe("fan-out", () => {
	test("at most 10 devices per user are sent to; the rest are reported as capped", async () => {
		const relay = startMockRelay();
		const made = await Promise.all(
			Array.from({ length: 13 }, () => makeDevice({ userId: "user-big" })),
		);
		const other = await makeDevice({ userId: "user-small" });
		const { service } = makeService(liveClient(relay.url));
		const outcomes = await service.sendToDevices(
			[...made.map((m) => m.device), other.device],
			permissionWait(),
		);
		expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(MAX_DEVICES_PER_USER + 1);
		expect(outcomes.filter((o) => o.status === "capped").map((o) => o.deviceId)).toEqual(
			made.slice(MAX_DEVICES_PER_USER).map((m) => m.device.id),
		);
		expect(relay.seen).toHaveLength(MAX_DEVICES_PER_USER + 1);
	});

	test("never more than four posts at a time", async () => {
		const relay = startMockRelay(async () => {
			await new Promise((r) => setTimeout(r, 40));
			return accepted();
		});
		const made = await Promise.all(
			Array.from({ length: 16 }, (_, i) => makeDevice({ userId: `user-${i % 4}` })), // 4 per user: under the per-user cap
		);
		const { service } = makeService(liveClient(relay.url));
		const outcomes = await service.sendToDevices(
			made.map((m) => m.device),
			permissionWait(),
		);
		expect(outcomes.every((o) => o.status === "sent")).toBe(true);
		expect(relay.maxInFlight()).toBeLessThanOrEqual(ALERT_CONCURRENCY);
		expect(relay.maxInFlight()).toBeGreaterThan(1); // and it did overlap
	});

	test("one device failing does not stop the others, and outcomes keep the input order", async () => {
		const relay = startMockRelay((body) =>
			(body.envelope as RelayEnvelope).d.endsWith("2") ? jsonResponse(503, {}) : accepted(),
		);
		const made = await Promise.all(
			[1, 2, 3].map((n) => makeDevice({ relayDeviceId: `relayDevice00000000000${n}` })),
		);
		const { service } = makeService(liveClient(relay.url));
		const outcomes = await service.sendToDevices(
			made.map((m) => m.device),
			permissionWait(),
		);
		expect(outcomes.map((o) => o.deviceId)).toEqual(made.map((m) => m.device.id));
		expect(outcomes.map((o) => o.status).sort()).toEqual(["sent", "sent", "unavailable"]);
	});
});

describe("dedupe (60 s)", () => {
	const sentCount = async (gapMs: number) => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		const event = permissionWait({ sessionId: "sess-dup" });
		const first = await service.sendToDevices([device], event);
		clock.advance(gapMs);
		const second = await service.sendToDevices([device], event);
		return { first: first[0]?.status, second: second[0]?.status };
	};

	test("the same event for the same device 59 s later is dropped", async () => {
		expect(await sentCount(59 * SEC)).toEqual({ first: "sent", second: "deduped" });
	});
	test("60 s later it goes out", async () => {
		expect(await sentCount(60 * SEC)).toEqual({ first: "sent", second: "sent" });
	});
	test("61 s later it goes out", async () => {
		expect(await sentCount(61 * SEC)).toEqual({ first: "sent", second: "sent" });
	});

	test("a different device, session or type is not a repeat", async () => {
		const relay = startMockRelay();
		const a = await makeDevice();
		const b = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		const event = permissionWait({ sessionId: "sess-1" });
		expect((await service.sendToDevices([a.device], event))[0]?.status).toBe("sent");
		expect((await service.sendToDevices([b.device], event))[0]?.status).toBe("sent");
		expect(
			(await service.sendToDevices([a.device], permissionWait({ sessionId: "sess-2" })))[0]?.status,
		).toBe("sent");
		expect(
			(await service.sendToDevices([a.device], { type: "turn_completed", sessionId: "sess-1" }))[0]
				?.status,
		).toBe("sent");
	});

	test("the key is the thing the event is about: two HITL requests in one session are two alerts", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		const hitl = (hitlId: string): PushEvent => ({
			type: "hitl_opened",
			sessionId: "s",
			hitlId,
			proposalId: "p",
		});
		expect((await service.sendToDevices([device], hitl("h1")))[0]?.status).toBe("sent");
		expect((await service.sendToDevices([device], hitl("h2")))[0]?.status).toBe("sent");
		expect((await service.sendToDevices([device], hitl("h1")))[0]?.status).toBe("deduped");
	});

	test("D35: a failure detected two ways is one push, the first in the window winning", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		const failed: PushEvent = { type: "session_failed", sessionId: "s-f" };
		const ruleFailed: PushEvent = { type: "alert_rule_fired", sessionId: "s-f", trigger: "failed" };
		expect((await service.sendToDevices([device], ruleFailed))[0]?.status).toBe("sent");
		expect((await service.sendToDevices([device], failed))[0]?.status).toBe("deduped");
	});

	test("D35: a completion detected two ways is one push, in either order", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice({ prefs: { categories: { SESSION_COMPLETED: true } } });
		const { service } = makeService(liveClient(relay.url));
		const done: PushEvent = { type: "session_completed", sessionId: "s-c" };
		const ruleDone: PushEvent = {
			type: "alert_rule_fired",
			sessionId: "s-c",
			trigger: "completed",
		};
		expect((await service.sendToDevices([device], done))[0]?.status).toBe("sent");
		expect((await service.sendToDevices([device], ruleDone))[0]?.status).toBe("deduped");
	});

	test("D35: failure and completion of the same session are different pushes, as are other rule triggers", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice({ prefs: { categories: { SESSION_COMPLETED: true } } });
		const { service } = makeService(liveClient(relay.url));
		expect(
			(await service.sendToDevices([device], { type: "session_failed", sessionId: "s-x" }))[0]
				?.status,
		).toBe("sent");
		expect(
			(await service.sendToDevices([device], { type: "session_completed", sessionId: "s-x" }))[0]
				?.status,
		).toBe("sent");
		expect(
			(
				await service.sendToDevices([device], {
					type: "alert_rule_fired",
					sessionId: "s-x",
					trigger: "stuck",
				})
			)[0]?.status,
		).toBe("sent");
	});

	test("D35: a launch status is its own push and never merges with the session's failure", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice({ prefs: { categories: { LAUNCH_STATUS: true } } });
		const { service } = makeService(liveClient(relay.url));
		const failed: PushEvent = { type: "session_failed", sessionId: "s-l" };
		const launch: PushEvent = {
			type: "launch_status",
			launchId: "l1",
			sessionId: "s-l",
			failed: true,
		};
		expect((await service.sendToDevices([device], failed))[0]?.status).toBe("sent");
		expect((await service.sendToDevices([device], launch))[0]?.status).toBe("sent");
	});

	test("D35: a launch status is off unless the device turns the category on", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		const outcome = (
			await service.sendToDevices([device], { type: "launch_status", launchId: "l2" })
		)[0];
		expect(outcome).toMatchObject({ status: "skipped", reason: "category_off" });
	});

	test("the dedupe map is bounded to 10,000 keys, least recently used first", async () => {
		const poster: RelayPoster = {
			postAlert: async () => ({ kind: "accepted", pushId: null }),
			postLiveActivity: async () => ({ kind: "accepted", pushId: null }),
		};
		const { service } = makeService(poster, {
			logger: { info: () => undefined, warn: () => undefined },
		});
		const { device: template } = await makeDevice();
		const total = DEDUPE_MAX_KEYS + 50;
		for (let from = 0; from < total; from += 250) {
			const batch = Array.from({ length: Math.min(250, total - from) }, (_, k) => ({
				...template,
				id: `dev-bound-${from + k}`,
				userId: `user-bound-${from + k}`,
			}));
			await Promise.all(
				batch.map((d) =>
					service.sendToDevices([d], { type: "turn_completed", sessionId: `s-${d.id}` }),
				),
			);
		}
		expect(service.stats().dedupeKeys).toBe(DEDUPE_MAX_KEYS);
	}, 60_000);
});

describe("quotas: per session, per category, and the decision categories' own bucket", () => {
	const failed = (n: number | string): PushEvent => ({
		type: "session_failed",
		sessionId: `sess-f-${n}`,
	});
	const permission = (n: number | string): PushEvent => ({
		type: "permission_wait",
		sessionId: `sess-p-${n}`,
	});
	const statuses = (outcomes: { status: string }[]) => outcomes.map((o) => o.status);

	/** The same session again, a little over the dedupe window later. */
	async function repeat(
		service: PushService,
		clock: ReturnType<typeof makeClock>,
		device: PushDevice,
		event: PushEvent,
		times: number,
	) {
		const out: string[] = [];
		for (let i = 0; i < times; i++) {
			out.push((await service.sendToDevices([device], event))[0]?.status ?? "none");
			clock.advance(DEDUPE_WINDOW_MS + SEC);
		}
		return out;
	}

	test("one session gets 5 an hour in an ordinary category and 10 in a decision category, then is held", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		const ordinary = await repeat(
			service,
			clock,
			device,
			failed("one"),
			SESSION_LIMIT_PER_HOUR + 1,
		);
		expect(ordinary).toEqual([...Array(SESSION_LIMIT_PER_HOUR).fill("sent"), "session_limited"]);
		const decision = await repeat(
			service,
			clock,
			device,
			permission("one"),
			TIME_SENSITIVE_SESSION_LIMIT_PER_HOUR + 1,
		);
		expect(decision).toEqual([
			...Array(TIME_SENSITIVE_SESSION_LIMIT_PER_HOUR).fill("sent"),
			"session_limited",
		]);
	});

	test("the session's window slides: its oldest alert ages out and frees a place", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		await repeat(service, clock, device, failed("slide"), SESSION_LIMIT_PER_HOUR);
		expect((await service.sendToDevices([device], failed("slide")))[0]?.status).toBe(
			"session_limited",
		);
		clock.set(T0 + HOUR);
		expect((await service.sendToDevices([device], failed("slide")))[0]?.status).toBe("sent");
	});

	test("a full category bucket holds a session that already has alerts, not one that has none", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		// 10 sessions with 2 alerts each fill the 20-a-hour bucket.
		for (let s = 0; s < 10; s++) await repeat(service, clock, device, failed(s), 2);
		clock.set(T0 + 1000 * SEC);
		expect((await service.sendToDevices([device], failed(0)))[0]?.status).toBe("category_limited");
		expect((await service.sendToDevices([device], failed("brand-new")))[0]?.status).toBe("sent");
	});

	test("even new sessions stop at twice the bucket", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		const results: string[] = [];
		for (let s = 0; s < CATEGORY_LIMIT_PER_HOUR * NEW_SESSION_CEILING_MULTIPLE + 3; s++) {
			results.push(
				(await service.sendToDevices([device], failed(`fresh-${s}`)))[0]?.status ?? "none",
			);
		}
		expect(results.filter((r) => r === "sent")).toHaveLength(
			CATEGORY_LIMIT_PER_HOUR * NEW_SESSION_CEILING_MULTIPLE,
		);
		expect(results.at(-1)).toBe("category_limited");
	});

	test("fabricated sessions can't silence a different session's permission_wait", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		// Six invented sessions each push as much as they are allowed: 60 alerts against a 40-an-hour bucket.
		for (let round = 0; round < TIME_SENSITIVE_SESSION_LIMIT_PER_HOUR; round++) {
			for (let s = 0; s < 6; s++)
				await service.sendToDevices([device], permission(`fabricated-${s}`));
			clock.advance(DEDUPE_WINDOW_MS + SEC);
		}
		clock.set(T0 + 1000 * SEC);
		const sentSoFar = relay.seen.length;
		expect(sentSoFar).toBe(TIME_SENSITIVE_LIMIT_PER_HOUR); // the bucket is full
		expect((await service.sendToDevices([device], permission("the-real-one")))[0]?.status).toBe(
			"sent",
		);
		expect(relay.seen).toHaveLength(sentSoFar + 1);
	});

	test("what bounds it: enough fabricated sessions to pass twice the bucket do silence a new one", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		for (let s = 0; s < TIME_SENSITIVE_LIMIT_PER_HOUR * NEW_SESSION_CEILING_MULTIPLE; s++) {
			await service.sendToDevices([device], permission(`flood-${s}`));
		}
		expect((await service.sendToDevices([device], permission("late")))[0]?.status).toBe(
			"category_limited",
		);
	});

	test("traffic in the other categories can't use up the decision categories' bucket", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice({
			prefs: { categories: { SESSION_COMPLETED: true, LAUNCH_STATUS: true } },
		});
		const { service } = makeService(liveClient(relay.url));
		const actionRequest = (n: number): PushEvent => ({
			type: "action_request_opened",
			actionRequestId: `ar-${n}`,
			actionKind: "k",
		});
		for (let n = 0; n < CATEGORY_LIMIT_PER_HOUR * NEW_SESSION_CEILING_MULTIPLE + 5; n++) {
			await service.sendToDevices([device], actionRequest(n));
			await service.sendToDevices([device], { type: "session_completed", sessionId: `done-${n}` });
		}
		expect((await service.sendToDevices([device], permission("needs-you")))[0]?.status).toBe(
			"sent",
		);
		expect(
			(
				await service.sendToDevices([device], {
					type: "hitl_opened",
					sessionId: "s",
					hitlId: "h",
					proposalId: "p",
				})
			)[0]?.status,
		).toBe("sent");
	});

	test("the decision categories' bucket is bigger than an ordinary one", () => {
		expect(TIME_SENSITIVE_LIMIT_PER_HOUR).toBeGreaterThan(CATEGORY_LIMIT_PER_HOUR);
		expect(TIME_SENSITIVE_SESSION_LIMIT_PER_HOUR).toBeGreaterThan(SESSION_LIMIT_PER_HOUR);
	});

	test("another category or another device is not held by a session's use", async () => {
		const relay = startMockRelay();
		const a = await makeDevice();
		const b = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		await repeat(service, clock, a.device, failed("shared"), SESSION_LIMIT_PER_HOUR);
		expect((await service.sendToDevices([a.device], failed("shared")))[0]?.status).toBe(
			"session_limited",
		);
		expect((await service.sendToDevices([b.device], failed("shared")))[0]?.status).toBe("sent");
		expect(
			(await service.sendToDevices([a.device], { type: "stuck", sessionId: "sess-f-shared" }))[0]
				?.status,
		).toBe("sent");
	});

	test("a deduped repeat uses no place", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		await service.sendToDevices([device], failed("d"));
		for (let i = 0; i < 30; i++) await service.sendToDevices([device], failed("d"));
		clock.advance(DEDUPE_WINDOW_MS + SEC);
		const rest = await repeat(service, clock, device, failed("d"), SESSION_LIMIT_PER_HOUR - 1);
		expect(rest).toEqual(Array(SESSION_LIMIT_PER_HOUR - 1).fill("sent"));
	});

	describe("places are kept only for a push that reached the phone", () => {
		const attemptsThen = async (answer: () => Response) => {
			const relay = startMockRelay(answer);
			const { device } = await makeDevice();
			const ctx = makeService(liveClient(relay.url));
			return { relay, device, ...ctx };
		};

		test("an outage gives back the dedupe place and the quota places", async () => {
			const down = await attemptsThen(() => jsonResponse(503, {}));
			const event = failed("outage");
			const first = await down.service.sendToDevices([down.device], event);
			const again = await down.service.sendToDevices([down.device], event); // inside the dedupe window
			expect(statuses([...first, ...again])).toEqual(["unavailable", "unavailable"]);
			// Five failed attempts in one session didn't use its 5 places up.
			for (let i = 0; i < SESSION_LIMIT_PER_HOUR + 2; i++) {
				const [o] = await down.service.sendToDevices([down.device], event);
				expect(o?.status, `attempt ${i}`).toBe("unavailable");
				down.clock.advance(DEDUPE_WINDOW_MS + SEC);
			}
		});

		test("a spent relay budget gives them back too", async () => {
			const spent = await attemptsThen(() => jsonResponse(429, { budget: "alert" }));
			const event = failed("budget");
			for (let i = 0; i < SESSION_LIMIT_PER_HOUR + 2; i++) {
				const [o] = await spent.service.sendToDevices([spent.device], event);
				expect(o?.status, `attempt ${i}`).toBe("budget_limited");
			}
		});

		test("so does a payload that could not be sealed", async () => {
			const relay = startMockRelay();
			const { device } = await makeDevice({ publicKey: "AAAA" });
			const { service } = makeService(liveClient(relay.url));
			const event = failed("unsealable");
			for (let i = 0; i < SESSION_LIMIT_PER_HOUR + 2; i++) {
				expect((await service.sendToDevices([device], event))[0]?.status).toBe("invalid");
			}
			expect(service.stats().dedupeKeys).toBe(0);
		});

		test("after the outage ends the same event goes out at once", async () => {
			let up = false;
			const relay = startMockRelay(() => (up ? accepted() : jsonResponse(503, {})));
			const { device } = await makeDevice();
			const { service } = makeService(liveClient(relay.url));
			const event = permission("recovers");
			expect((await service.sendToDevices([device], event))[0]?.status).toBe("unavailable");
			up = true;
			expect((await service.sendToDevices([device], event))[0]?.status).toBe("sent");
			expect((await service.sendToDevices([device], event))[0]?.status).toBe("deduped");
		});

		test("a relay rejection is not given back: the same bad request is not retried every time", async () => {
			const bad = await attemptsThen(() => jsonResponse(400, { error: "invalid_envelope" }));
			const event = failed("rejected");
			expect((await bad.service.sendToDevices([bad.device], event))[0]?.status).toBe("rejected");
			expect((await bad.service.sendToDevices([bad.device], event))[0]?.status).toBe("deduped");
		});
	});
});

describe("what the relay says back", () => {
	const one = async (handler: Parameters<typeof startMockRelay>[0]) => {
		const relay = startMockRelay(handler);
		const { device } = await makeDevice();
		const ctx = makeService(liveClient(relay.url));
		const [outcome] = await ctx.service.sendToDevices([device], permissionWait());
		return { outcome, device, ...ctx };
	};

	test("gone:device revokes that device only", async () => {
		const relay = startMockRelay((body) =>
			(body.envelope as RelayEnvelope).d.endsWith("1")
				? jsonResponse(410, { gone: "device" })
				: accepted(),
		);
		const gone = await makeDevice({ relayDeviceId: "relayDevice000000000001" });
		const fine = await makeDevice({ relayDeviceId: "relayDevice000000000002" });
		const { service, calls } = makeService(liveClient(relay.url));
		const outcomes = await service.sendToDevices([gone.device, fine.device], permissionWait());
		expect(outcomes.map((o) => o.status)).toEqual(["gone", "sent"]);
		expect(calls).toEqual([`deviceGone:${gone.device.id}`]);
	});

	test("a 401 tells the owner of the send token, and nothing is revoked on its own", async () => {
		const out = await one(() => jsonResponse(401, { error: "unauthorized" }));
		expect(out.outcome?.status).toBe("unauthorized");
		expect(out.calls).toEqual([`tokenRejected:${out.device.id}`]);
	});

	test("a spent budget drops the push and reports the wait", async () => {
		const out = await one(() => jsonResponse(429, { budget: "alert" }, { "retry-after": "12" }));
		expect(out.outcome).toEqual({
			deviceId: out.device.id,
			status: "budget_limited",
			retryAfterSec: 12,
		});
		expect(out.calls).toEqual([]);
	});

	test("a rejection, an outage and an open breaker are reported and revoke nothing", async () => {
		const rejected = await one(() => jsonResponse(400, { error: "invalid_envelope" }));
		expect(rejected.outcome).toEqual({
			deviceId: rejected.device.id,
			status: "rejected",
			httpStatus: 400,
			error: "invalid_envelope",
		});
		const down = await one(() => jsonResponse(503, {}));
		expect(down.outcome?.status).toBe("unavailable");
		expect(down.calls).toEqual([]);

		const relay = startMockRelay(() => jsonResponse(503, {}));
		const { device } = await makeDevice();
		const clock = makeClock();
		const client = new RelayClient({ relayUrl: relay.url, clock, logger: makeLogger().logger });
		const { service } = makeService(client, { clock });
		for (let i = 0; i < 5; i++) await service.sendToDevices([device], permissionWait());
		const refused = await service.sendToDevices([device], permissionWait());
		expect(refused[0]?.status).toBe("unavailable");
		expect(relay.seen).toHaveLength(5);
	});

	test("a revocation sink that throws does not lose the outcome or crash the batch", async () => {
		const relay = startMockRelay(() => jsonResponse(410, { gone: "device" }));
		const a = await makeDevice();
		const b = await makeDevice();
		const log = makeLogger();
		const service = new PushService({
			relay: liveClient(relay.url),
			readSendToken: unstoreToken,
			revocations: {
				deviceGone: () => {
					throw new Error("db down");
				},
				activityGone: () => undefined,
				tokenRejected: () => undefined,
			},
			logger: log.logger,
			clock: makeClock(),
		});
		const outcomes = await service.sendToDevices([a.device, b.device], permissionWait());
		expect(outcomes.map((o) => o.status)).toEqual(["gone", "gone"]);
		expect(log.lines.some((l) => l.includes("revocation failed"))).toBe(true);
	});

	test("a device whose identity can't be put in a payload, or whose key is bad, is reported and nothing is posted", async () => {
		const relay = startMockRelay();
		const badKid = await makeDevice({ kid: "has spaces!" });
		const badKey = await makeDevice({ publicKey: Buffer.alloc(65, 4).toString("base64url") });
		const { service } = makeService(liveClient(relay.url));
		const outcomes = await service.sendToDevices([badKid.device, badKey.device], permissionWait());
		expect(outcomes).toEqual([
			{ deviceId: badKid.device.id, status: "invalid", reason: "invalid_device_identity" },
			{ deviceId: badKey.device.id, status: "invalid", reason: "invalid_public_key" },
		]);
		expect(relay.seen).toHaveLength(0);
	});

	test("a very long name and text are trimmed to fit and the push still goes out", async () => {
		const relay = startMockRelay();
		const { device, open } = await makeDevice({ prefs: { includeAgentText: true } });
		const { service, lines } = makeService(liveClient(relay.url));
		const [outcome] = await service.sendToDevices(
			[device],
			permissionWait({ sessionName: "n".repeat(5000), text: "t".repeat(5000) }),
		);
		expect(outcome?.status).toBe("sent");
		const payload = await open(relay.seen[0]?.body.envelope as RelayEnvelope);
		expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(2400);
		expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
		expect(lines.some((l) => l.includes("trimmed"))).toBe(false); // the schema caps both members long before the byte limit
	});
});

describe("logs", () => {
	test("carry device ids, types and counts, and never a token, a key, an envelope or a payload", async () => {
		const failing = startMockRelay((body) => {
			const d = (body.envelope as RelayEnvelope).d;
			return d.endsWith("1")
				? jsonResponse(503, {})
				: d.endsWith("2")
					? jsonResponse(429, { budget: "alert" }, { "retry-after": "3" })
					: d.endsWith("3")
						? jsonResponse(401, {})
						: jsonResponse(410, { gone: "device" });
		});
		const devices = await Promise.all(
			[1, 2, 3, 4].map((n) =>
				makeDevice({
					relayDeviceId: `relayDevice00000000000${n}`,
					prefs: { includeAgentText: true },
				}),
			),
		);
		const log = makeLogger();
		const { service } = makeService(liveClient(failing.url, makeClock()), { logger: log.logger });
		await service.sendToDevices(
			devices.map((d) => d.device),
			permissionWait({
				sessionId: "sess-LOGSECRET",
				sessionName: "LOGSECRET-NAME",
				text: "LOGSECRET-TEXT",
			}),
		);
		const text = log.lines.join("\n");
		expect(text.length).toBeGreaterThan(0);
		for (const d of devices) {
			for (const secret of [
				plainToken(d.device),
				d.device.sendTokenCiphertext,
				d.device.publicKey,
				d.device.relayDeviceId,
				d.device.kid,
			]) {
				expect(text.includes(secret), `a log line contained ${secret.slice(0, 14)}`).toBe(false);
			}
		}
		for (const secret of ["LOGSECRET", "Bearer", "envelope", "ciphertext"])
			expect(text.includes(secret)).toBe(false);
	});
});

describe("Live Activity updates", () => {
	const state = {
		status: "waiting",
		statusSince: 1_760_000_000,
		toolCount: 4,
		trace: new Array(24).fill(1),
	};

	test("posts a liveactivity request with its own members and the device's send token", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		const outcome = await service.sendActivityUpdate(device, {
			slot: "slot-1",
			generation: 3,
			event: "update",
			contentState: state,
			staleDate: 1_760_000_900,
		});
		expect(outcome).toMatchObject({ deviceId: device.id, slot: "slot-1", status: "sent" });
		expect(relay.seen[0]?.headers.get("authorization")).toBe(`Bearer ${plainToken(device)}`);
		expect(relay.seen[0]?.body).toEqual({
			kind: "liveactivity",
			slot: "slot-1",
			generation: 3,
			event: "update",
			contentState: state,
			staleDate: 1_760_000_900,
		});
	});

	test("gone:activity ends that activity only; gone:device revokes the device", async () => {
		let answer: "activity" | "device" = "activity";
		const relay = startMockRelay(() => jsonResponse(410, { gone: answer }));
		const { device } = await makeDevice();
		const { service, calls } = makeService(liveClient(relay.url));
		expect(
			await service.sendActivityUpdate(device, {
				slot: "slot-1",
				generation: 1,
				event: "update",
				contentState: state,
			}),
		).toMatchObject({ status: "activity_gone" });
		expect(calls).toEqual([`activityGone:${device.id}:slot-1`]);
		answer = "device";
		expect(
			await service.sendActivityUpdate(device, {
				slot: "slot-2",
				generation: 1,
				event: "update",
				contentState: state,
			}),
		).toMatchObject({ status: "device_gone" });
		expect(calls).toEqual([`activityGone:${device.id}:slot-1`, `deviceGone:${device.id}`]);
	});

	test("updates for one slot that are still waiting merge: the newest wins, and an end is never overwritten", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const relay = startMockRelay(async (body) => {
			if (body.slot === "slot-block") await gate;
			return accepted();
		});
		const blockers = await Promise.all(
			Array.from({ length: ACTIVITY_CONCURRENCY }, () => makeDevice()),
		);
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		// Occupy both activity workers so the next updates have to wait.
		const held = blockers.map((b) =>
			service.sendActivityUpdate(b.device, {
				slot: "slot-block",
				generation: 1,
				event: "update",
				contentState: state,
			}),
		);
		await new Promise((r) => setTimeout(r, 40));

		const first = service.sendActivityUpdate(device, {
			slot: "s",
			generation: 1,
			event: "update",
			contentState: { ...state, toolCount: 1 },
		});
		const second = service.sendActivityUpdate(device, {
			slot: "s",
			generation: 1,
			event: "update",
			contentState: { ...state, toolCount: 2 },
		});
		const ended = service.sendActivityUpdate(device, {
			slot: "s",
			generation: 1,
			event: "end",
			contentState: { ...state, toolCount: 3 },
		});
		const late = service.sendActivityUpdate(device, {
			slot: "s",
			generation: 1,
			event: "update",
			contentState: { ...state, toolCount: 4 },
		});
		expect((await late).status).toBe("coalesced"); // an update after a waiting end is dropped
		release();
		await Promise.all(held);
		const results = await Promise.all([first, second, ended]);
		expect(results.every((r) => r.status === "sent")).toBe(true);
		const toS = relay.seen.filter((s) => s.body.slot === "s");
		expect(toS).toHaveLength(1);
		expect(toS[0]?.body).toMatchObject({ event: "end", contentState: { toolCount: 3 } });
	});

	test("a device is held to the relay's own rate: a burst of 10, then refused until it refills", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		const send = (i: number) =>
			service.sendActivityUpdate(device, {
				slot: `slot-${i}`,
				generation: 1,
				event: "update",
				contentState: state,
			});
		const outcomes: string[] = [];
		for (let i = 0; i < ACTIVITY_BURST + 2; i++) outcomes.push((await send(i)).status);
		expect(outcomes.slice(0, ACTIVITY_BURST).every((s) => s === "sent")).toBe(true);
		expect(outcomes.slice(ACTIVITY_BURST)).toEqual(["rate_limited", "rate_limited"]);
		clock.advance(2 * SEC); // 30 a minute is one every two seconds
		expect((await send(100)).status).toBe("sent");
		expect((await send(101)).status).toBe("rate_limited");
	});

	test("a budget answer is reported", async () => {
		const relay = startMockRelay(() =>
			jsonResponse(429, { budget: "activity" }, { "retry-after": "2" }),
		);
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		expect(
			await service.sendActivityUpdate(device, {
				slot: "s",
				generation: 1,
				event: "update",
				contentState: state,
			}),
		).toMatchObject({ status: "budget_limited", retryAfterSec: 2 });
	});
});

describe("alerts and Live Activities do not share a queue (H-G)", () => {
	test("a saturated Live Activity line does not delay an alert", async () => {
		let releaseActivities: () => void = () => undefined;
		const gate = new Promise<void>((r) => {
			releaseActivities = r;
		});
		const relay = startMockRelay(async (body) => {
			if (body.kind === "liveactivity") await gate; // the relay is stuck on every activity
			return accepted();
		});
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		const state = {
			status: "working",
			statusSince: 1_760_000_000,
			toolCount: 1,
			trace: new Array(24).fill(0),
		};

		// Far more activity work than the workers can take: 2 running, the rest waiting.
		const activityDevices = await Promise.all(Array.from({ length: 12 }, () => makeDevice()));
		const pending = activityDevices.map((a) =>
			service.sendActivityUpdate(a.device, {
				slot: "s",
				generation: 1,
				event: "update",
				contentState: state,
			}),
		);
		await new Promise((r) => setTimeout(r, 60));
		expect(service.stats().activitiesInFlight).toBe(ACTIVITY_CONCURRENCY);
		expect(service.stats().activitiesWaiting).toBeGreaterThan(0);

		const started = Date.now();
		const [alert] = await service.sendToDevices([device], permissionWait());
		expect(alert?.status).toBe("sent");
		expect(Date.now() - started).toBeLessThan(500);
		expect(relay.seen.some((s) => s.body.kind === "alert")).toBe(true);

		releaseActivities();
		await Promise.all(pending);
	});

	test("the Live Activity line is bounded: beyond its limit new work is refused, not queued forever", async () => {
		const never = new Promise<never>(() => undefined);
		const poster: RelayPoster = {
			postAlert: async () => ({ kind: "accepted", pushId: null }),
			postLiveActivity: () => never,
		};
		const { service } = makeService(poster);
		const state = { status: "working" };
		const results = await Promise.race([
			Promise.all(
				Array.from({ length: ACTIVITY_CONCURRENCY + ACTIVITY_MAX_PENDING + 20 }, async (_, i) => {
					const { device } = { device: { ...(await makeDevice()).device, id: `bulk-${i}` } };
					return service.sendActivityUpdate(device, {
						slot: "s",
						generation: 1,
						event: "update",
						contentState: state,
					});
				}),
			).catch(() => []),
			new Promise<string>((r) => setTimeout(() => r("timeout"), 300)),
		]);
		void results; // the hung ones never resolve; the refused ones did, which is what stats shows
		expect(service.stats().activitiesInFlight).toBe(ACTIVITY_CONCURRENCY);
		expect(service.stats().activitiesWaiting).toBe(ACTIVITY_MAX_PENDING);
	});

	test("and alerts keep flowing with the Live Activity line full", async () => {
		const never = new Promise<never>(() => undefined);
		const poster: RelayPoster = {
			postAlert: async () => ({ kind: "accepted", pushId: "p" }),
			postLiveActivity: () => never,
		};
		const { service } = makeService(poster);
		const { device } = await makeDevice();
		for (let i = 0; i < 30; i++)
			void service.sendActivityUpdate(
				{ ...device, id: `bulk-${i}` },
				{ slot: "s", generation: 1, event: "update", contentState: {} },
			);
		const [alert] = await service.sendToDevices([device], permissionWait());
		expect(alert?.status).toBe("sent");
	});
});

describe("the stored send token", () => {
	test("is read right before each post, once per post, and the plain token is never logged", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const reads: string[] = [];
		const { service, lines } = makeService(liveClient(relay.url), {
			readSendToken: (stored) => {
				reads.push(stored);
				return unstoreToken(stored);
			},
		});
		await service.sendToDevices([device], permissionWait());
		await service.sendActivityUpdate(device, {
			slot: "s",
			generation: 1,
			event: "update",
			contentState: {},
		});
		expect(reads).toEqual([device.sendTokenCiphertext, device.sendTokenCiphertext]);
		expect(relay.seen.map((s) => s.headers.get("authorization"))).toEqual([
			`Bearer ${plainToken(device)}`,
			`Bearer ${plainToken(device)}`,
		]);
		expect(lines.join("\n")).not.toContain(plainToken(device));
	});

	test("a revoked device (empty token) is no target: skipped, nothing read or posted, no dedupe or limit used", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice({ sendTokenCiphertext: "" });
		let reads = 0;
		const { service } = makeService(liveClient(relay.url), {
			readSendToken: () => {
				reads++;
				return "x";
			},
		});
		const event = permissionWait({ sessionId: "sess-revoked" });
		expect(await service.sendToDevices([device], event)).toEqual([
			{ deviceId: device.id, status: "skipped", reason: "no_target" },
		]);
		expect(
			await service.sendActivityUpdate(device, {
				slot: "s",
				generation: 1,
				event: "update",
				contentState: {},
			}),
		).toEqual({ deviceId: device.id, slot: "s", status: "skipped", reason: "no_target" });
		expect(reads).toBe(0);
		expect(relay.seen).toHaveLength(0);
		expect(service.stats().dedupeKeys).toBe(0);
	});

	test("a token that cannot be read is reported once, never retried, and nothing is posted", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice({ sendTokenCiphertext: "garbage-not-ours" });
		const { service, lines, calls } = makeService(liveClient(relay.url));
		expect((await service.sendToDevices([device], permissionWait()))[0]).toEqual({
			deviceId: device.id,
			status: "invalid",
			reason: "send_token_unreadable",
		});
		expect(
			await service.sendActivityUpdate(device, {
				slot: "s",
				generation: 1,
				event: "update",
				contentState: {},
			}),
		).toEqual({
			deviceId: device.id,
			slot: "s",
			status: "skipped",
			reason: "send_token_unreadable",
		});
		expect(relay.seen).toHaveLength(0);
		expect(calls).toEqual([]);
		expect(lines.join("\n")).not.toContain("garbage-not-ours");
	});

	test("a reader that returns an empty string counts as unreadable", async () => {
		const relay = startMockRelay();
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url), { readSendToken: () => "" });
		expect((await service.sendToDevices([device], permissionWait()))[0]?.status).toBe("invalid");
		expect(relay.seen).toHaveLength(0);
	});
});

describe("a push is only a hint (D27)", () => {
	test("a decision event carries ids and a hash to re-check, and no member that reads as an instruction or a verdict", async () => {
		const relay = startMockRelay();
		const { device, open } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		await service.sendToDevices([device], {
			type: "hitl_opened",
			sessionId: "s",
			hitlId: "h",
			proposalId: "p",
			promptHash: "b".repeat(64),
		});
		const payload = await open(relay.seen[0]?.body.envelope as RelayEnvelope);
		const keys = Object.keys(payload).sort();
		expect(keys).toEqual([
			"cat",
			"hitlId",
			"il",
			"kid",
			"pid",
			"promptHash",
			"proposalId",
			"ref",
			"sid",
			"t",
			"ts",
			"v",
		]);
		for (const key of keys)
			expect(key).not.toMatch(/approve|decline|decision|allow|grant|action$|command|prompt$|url/i);
	});
});

describe("a 401 revokes only when the relay said it", () => {
	const html401 = () =>
		new Response("<html>sign in</html>", { status: 401, headers: { "content-type": "text/html" } });
	const ev = (n: number): PushEvent => ({ type: "permission_wait", sessionId: `sess-401-${n}` });

	test("the relay's own 401 revokes at once", async () => {
		const relay = startMockRelay(() => jsonResponse(401, { error: "unauthorized" }));
		const { device } = await makeDevice();
		const { service, calls } = makeService(liveClient(relay.url));
		expect((await service.sendToDevices([device], ev(1)))[0]?.status).toBe("unauthorized");
		expect(calls).toEqual([`tokenRejected:${device.id}`]);
	});

	test("a proxy's 401 never revokes, however many times it repeats", async () => {
		const relay = startMockRelay(html401);
		const { device } = await makeDevice();
		const { service, calls } = makeService(liveClient(relay.url, { failureThreshold: 1000 }));
		expect((await service.sendToDevices([device], ev(1)))[0]?.status).toBe("unauthorized");
		for (let n = 2; n <= 6; n++) await service.sendToDevices([device], ev(n));
		expect(calls).toEqual([]);
	});

	test("an unconfirmed 401 opens the relay breaker, so the next sends are not even posted", async () => {
		const relay = startMockRelay(html401);
		const { device } = await makeDevice();
		const client = liveClient(relay.url);
		const { service, calls } = makeService(client);
		await service.sendToDevices([device], ev(1));
		expect(client.circuitOpen).toBe(true);
		const seenAfterFirst = relay.seen.length;
		const outcome = (await service.sendToDevices([device], ev(2)))[0];
		expect(outcome?.status).toBe("unavailable");
		expect(relay.seen.length).toBe(seenAfterFirst);
		expect(calls).toEqual([]);
	});

	test("the same rule holds for Live Activity updates", async () => {
		const relay = startMockRelay(html401);
		const { device } = await makeDevice();
		const { service, calls } = makeService(liveClient(relay.url, { failureThreshold: 1000 }));
		const update = { slot: "s", generation: 1, event: "update" as const, contentState: {} };
		await service.sendActivityUpdate(device, update);
		await service.sendActivityUpdate(device, update);
		await service.sendActivityUpdate(device, update);
		expect(calls).toEqual([]);
	});

	test("the relay's own 401 on a Live Activity update still revokes", async () => {
		const relay = startMockRelay(() => jsonResponse(401, { error: "unauthorized" }));
		const { device } = await makeDevice();
		const { service, calls } = makeService(liveClient(relay.url));
		await service.sendActivityUpdate(device, {
			slot: "s",
			generation: 1,
			event: "update",
			contentState: {},
		});
		expect(calls).toEqual([`tokenRejected:${device.id}`]);
	});
});

describe("Retry-After is honoured (a not-before per device and budget)", () => {
	const ev = (n: number): PushEvent => ({ type: "permission_wait", sessionId: `sess-hold-${n}` });

	test("after a 429 with Retry-After the device's alerts are held without calling the relay", async () => {
		let limited = true;
		const relay = startMockRelay(() =>
			limited ? jsonResponse(429, { budget: "alert" }, { "retry-after": "30" }) : accepted(),
		);
		const { device } = await makeDevice();
		const { service, clock } = makeService(liveClient(relay.url));
		expect((await service.sendToDevices([device], ev(1)))[0]).toEqual({
			deviceId: device.id,
			status: "budget_limited",
			retryAfterSec: 30,
		});
		limited = false;
		clock.advance(10 * SEC);
		expect((await service.sendToDevices([device], ev(2)))[0]).toEqual({
			deviceId: device.id,
			status: "budget_limited",
			retryAfterSec: 20,
		});
		expect(relay.seen).toHaveLength(1);
		clock.advance(20 * SEC);
		expect((await service.sendToDevices([device], ev(3)))[0]?.status).toBe("sent");
	});

	test("a hold uses no dedupe or quota place, and is per device", async () => {
		const relay = startMockRelay((body) =>
			(body.envelope as RelayEnvelope).d.endsWith("1")
				? jsonResponse(429, { budget: "alert" }, { "retry-after": "60" })
				: accepted(),
		);
		const slow = await makeDevice({ relayDeviceId: "relayDevice000000000001" });
		const fine = await makeDevice({ relayDeviceId: "relayDevice000000000002" });
		const { service } = makeService(liveClient(relay.url));
		await service.sendToDevices([slow.device], ev(1));
		await service.sendToDevices([slow.device], ev(2));
		expect(service.stats().dedupeKeys).toBe(0);
		expect((await service.sendToDevices([fine.device], ev(3)))[0]?.status).toBe("sent");
	});

	test("an alert budget hold doesn't hold Live Activities, nor the other way round", async () => {
		const relay = startMockRelay((body) =>
			body.kind === "alert"
				? jsonResponse(429, { budget: "alert" }, { "retry-after": "60" })
				: accepted(),
		);
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		await service.sendToDevices([device], ev(1));
		const update = { slot: "s", generation: 1, event: "update" as const, contentState: {} };
		expect(await service.sendActivityUpdate(device, update)).toMatchObject({ status: "sent" });

		const relay2 = startMockRelay((body) =>
			body.kind === "liveactivity"
				? jsonResponse(429, { budget: "activity" }, { "retry-after": "60" })
				: accepted(),
		);
		const other = await makeDevice();
		const ctx = makeService(liveClient(relay2.url));
		expect(await ctx.service.sendActivityUpdate(other.device, update)).toMatchObject({
			status: "budget_limited",
			retryAfterSec: 60,
		});
		const callsBefore = relay2.seen.length;
		expect(await ctx.service.sendActivityUpdate(other.device, update)).toMatchObject({
			status: "budget_limited",
		});
		expect(relay2.seen).toHaveLength(callsBefore);
		expect((await ctx.service.sendToDevices([other.device], ev(9)))[0]?.status).toBe("sent");
	});

	test("a 429 without Retry-After holds nothing", async () => {
		const relay = startMockRelay(() => jsonResponse(429, { budget: "alert" }));
		const { device } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		await service.sendToDevices([device], ev(1));
		await service.sendToDevices([device], ev(2));
		expect(relay.seen).toHaveLength(2);
	});
});

describe("the alert line: two lanes by relay priority", () => {
	const blocker = () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		return { gate, release };
	};
	const job = (log: string[], name: string, gate: Promise<void>) => async () => {
		await gate;
		log.push(name);
		return name;
	};

	test("a needs-you job waiting is served before earlier lower-priority ones", async () => {
		const pool = new WorkPool(1, 10);
		const { gate, release } = blocker();
		const log: string[] = [];
		const all = [
			pool.run(job(log, "running", gate), 1),
			pool.run(job(log, "low-1", gate), 1),
			pool.run(job(log, "low-2", gate), 1),
			pool.run(job(log, "high-1", gate), 0),
			pool.run(job(log, "high-2", gate), 0),
		];
		release();
		await Promise.all(all);
		expect(log).toEqual(["running", "high-1", "high-2", "low-1", "low-2"]);
	});

	test("a full line drops the oldest lower-priority job for a higher one, not the newcomer", async () => {
		const pool = new WorkPool(1, 2);
		const { gate, release } = blocker();
		const log: string[] = [];
		const running = pool.run(job(log, "running", gate), 1);
		const low1 = pool.run(job(log, "low-1", gate), 1);
		const low2 = pool.run(job(log, "low-2", gate), 1);
		const high = pool.run(job(log, "high", gate), 0);
		expect(await low1).toBe("queue_full");
		release();
		expect(await Promise.all([running, low2, high])).toEqual(["running", "low-2", "high"]);
		expect(log).toEqual(["running", "high", "low-2"]);
	});

	test("with nothing lower to drop the newcomer is the one refused", async () => {
		const pool = new WorkPool(1, 2);
		const { gate, release } = blocker();
		const log: string[] = [];
		const all = [
			pool.run(job(log, "running", gate), 0),
			pool.run(job(log, "high-1", gate), 0),
			pool.run(job(log, "high-2", gate), 0),
		];
		expect(await pool.run(job(log, "high-3", gate), 0)).toBe("queue_full");
		expect(await pool.run(job(log, "low", gate), 1)).toBe("queue_full");
		release();
		await Promise.all(all);
		expect(log).toEqual(["running", "high-1", "high-2"]);
	});

	test("a lower-priority newcomer never displaces anything", async () => {
		const pool = new WorkPool(1, 1);
		const { gate, release } = blocker();
		const log: string[] = [];
		const running = pool.run(job(log, "running", gate), 1);
		const waiting = pool.run(job(log, "low-waiting", gate), 1);
		expect(await pool.run(job(log, "low-new", gate), 1)).toBe("queue_full");
		release();
		await Promise.all([running, waiting]);
		expect(log).toEqual(["running", "low-waiting"]);
	});
});

describe("the service queues alerts by relay priority", () => {
	test("when one worker frees up, the next job is the needs-you alert queued later, not the quiet one queued earlier", async () => {
		const releases: (() => void)[] = [];
		let arrivals = 0;
		const relay = startMockRelay(async () => {
			if (++arrivals <= ALERT_CONCURRENCY) {
				await new Promise<void>((resolve) => releases.push(resolve));
			}
			return accepted();
		});
		const busy = await Promise.all(
			Array.from({ length: ALERT_CONCURRENCY }, (_, i) => makeDevice({ userId: `busy-${i}` })),
		);
		const quiet = await makeDevice({
			userId: "quiet",
			prefs: { categories: { SESSION_COMPLETED: true } },
		});
		const urgent = await makeDevice({ userId: "urgent" });
		const { service } = makeService(liveClient(relay.url));
		const running = busy.map((b) => service.sendToDevices([b.device], permissionWait()));
		while (relay.seen.length < ALERT_CONCURRENCY) await new Promise((r) => setTimeout(r, 5));

		const lowFirst = service.sendToDevices([quiet.device], {
			type: "session_completed",
			sessionId: "sess-quiet",
		});
		const highLater = service.sendToDevices([urgent.device], permissionWait());
		await new Promise((r) => setTimeout(r, 30));
		// Free exactly one worker: whatever the pool starts next is the one it prefers.
		releases[0]?.();
		while (relay.seen.length < ALERT_CONCURRENCY + 1) await new Promise((r) => setTimeout(r, 5));
		expect(relay.seen[ALERT_CONCURRENCY]?.body.priority).toBe("needs-you");
		for (const release of releases) release();
		await Promise.all([...running, lowFirst, highLater]);
		expect(relay.seen.slice(ALERT_CONCURRENCY).map((s) => s.body.priority)).toEqual([
			"needs-you",
			"quiet",
		]);
	});
});

describe("labels go through the redactor too (names, agent, machine)", () => {
	test("a secret in a session name, agent or machine never reaches the plaintext", async () => {
		const secret = "AKIAIOSFODNN7EXAMPLE";
		const relay = startMockRelay();
		const { device, open } = await makeDevice();
		const { service } = makeService(liveClient(relay.url));
		await service.sendToDevices(
			[device],
			permissionWait({
				sessionName: `deploy ${secret}`,
				agent: `agent-${secret}`,
				machine: `host-${secret}`,
			}),
		);
		const payload = await open(relay.seen[0]?.body.envelope as RelayEnvelope);
		expect(JSON.stringify(payload)).not.toContain(secret);
		expect(payload.sname).toContain("deploy");
	});
});

describe("reading the stored send token does not block the event loop", () => {
	const savedKey = config.secretsKey;
	beforeAll(() => {
		config.secretsKey = "event-loop-test-secrets-key";
	});
	afterAll(() => {
		config.secretsKey = savedKey;
	});

	/** The longest gap between two ticks of a 1 ms timer while `work` runs. */
	async function longestStall(work: () => Promise<unknown>): Promise<number> {
		let last = performance.now();
		let worst = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			worst = Math.max(worst, now - last);
			last = now;
		}, 1);
		try {
			await work();
		} finally {
			clearInterval(timer);
		}
		return worst;
	}

	test("N cold sends (a fresh salt each) leave the loop responsive; warm sends skip scrypt", async () => {
		const relay = startMockRelay();
		const devices = await Promise.all(
			Array.from({ length: 8 }, async (_, i) => {
				const { device } = await makeDevice({ userId: `u-${i}` });
				device.sendTokenCiphertext = encryptSecret(`token-${i}`);
				return device;
			}),
		);
		const { service } = makeService(liveClient(relay.url), { readSendToken: decryptSecretAsync });
		const sendAll = (tag: string) =>
			Promise.all(
				devices.map((d, i) =>
					service.sendToDevices([d], { type: "permission_wait", sessionId: `${tag}-${i}` }),
				),
			);

		// One synchronous derivation costs about this much; the gate is a fraction of it.
		const t0 = performance.now();
		decryptSecret(encryptSecret("calibrate"));
		const syncCost = performance.now() - t0;

		const cold = { stall: 0, ms: 0 };
		const start = performance.now();
		cold.stall = await longestStall(async () => {
			const outcomes = await sendAll("cold");
			expect(outcomes.every(([o]) => o?.status === "sent")).toBe(true);
		});
		cold.ms = performance.now() - start;
		expect(cold.stall).toBeLessThan(Math.max(15, syncCost * 0.5));

		const warmStart = performance.now();
		const outcomes = await sendAll("warm");
		const warmMs = performance.now() - warmStart;
		expect(outcomes.every(([o]) => o?.status === "sent")).toBe(true);
		expect(warmMs).toBeLessThan(cold.ms / 2);
		expect(
			relay.seen
				.map((s) => s.headers.get("authorization"))
				.slice(-8)
				.sort(),
		).toEqual(devices.map((_, i) => `Bearer token-${i}`).sort());
	}, 60_000);
});
