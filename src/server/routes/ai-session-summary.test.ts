/**
 * AGEN-69 phase 6: the summary routes, their scope classification and the per-caller limiter
 * (TC-6.1 to 6.20; the route-shape tests are TC-6.5r1 to 6.5r4, the additions TC-6.21 to 6.24).
 *
 * The real `app`, real auth fixtures for every kind of caller, the real service and registry,
 * and the stub provider behind it (nothing inside the repo is mocked except where a test says
 * so). Every test that starts a generation settles it before it ends (C-5).
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import {
	FAILED_VIEW_FIXTURES,
	REFUSAL_BODY_FIXTURES,
	SUMMARY_VIEW_FIXTURES,
	type Shape,
	failedWith,
	shapeOf,
} from "../../shared/__fixtures__/session-summary-view/index.js";
import {
	SUMMARY_ATTEMPT_STATUSES,
	SUMMARY_BLOCK_REASONS,
	SUMMARY_ERROR_CODES,
	SUMMARY_REFUSAL_CODES,
} from "../../shared/session-summary-view.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import type { StubGate } from "../test-utils/llm-stub-server.js";
import {
	bearerHeaders,
	cookieHeadersFor,
	disableUserDirectly,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { aiSessionSummaries, apiKeys, llmProviders, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { config } = await import("../config.js");
const H = await import("../test-utils/summary-service-harness.js");
const svc = await import("../services/session-summary-service.js");
const limit = await import("../services/session-summary-limit.js");
const { setShuttingDown } = await import("../drain-state.js");
const { setLabsFlag } = await import("../services/labs-service.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");
const { OWN_TURN_MAX_WAITING, runInOwnTurn } = await import("../util/own-turn.js");
const {
	INTENTIONALLY_MANAGE_ONLY,
	OBSERVE_READ_PATHS,
	ALWAYS_ADMIN_ROUTES,
	TEAM_ADMIN_ROUTES,
	OWNER_CHECKED_ROUTES,
	INGEST_WRITABLE_ROUTES,
} = await import("../auth/route-scope-policy.js");
const { toDbTimestamp } = await import("../services/util/db-time.js");

const MOUNTS = ["/api/v1", "/app-api/v1"] as const;
type Mount = (typeof MOUNTS)[number];
const GET_ROUTE = "/ai/sessions/:sessionId/summary";
const POST_ROUTE = "POST /ai/sessions/:sessionId/summary";

const originalDisableAuth = config.disableAuth;
const originalAiEnabled = config.aiEnabled;
const MODE_ENV = "AGENTPULSE_MODE";
const originalModeEnv = process.env[MODE_ENV];
const SID = "rt-s1";

let stub: ReturnType<typeof H.startStub>;
const startedSessions = new Set<string>();
const openGates: StubGate[] = [];

beforeAll(async () => {
	await initializeDatabase();
	stub = H.startStub();
});
afterAll(async () => {
	await stub.stop();
});

async function waitForGenerations(): Promise<void> {
	for (const gate of openGates.splice(0)) gate.release();
	for (const id of startedSessions) {
		await H.until(async () => {
			const row = await H.readSummaryRow(id);
			return !row || row.attemptStatus !== "generating";
		}, 20_000);
	}
	startedSessions.clear();
	await H.until(() => svc._summaryGenerationCountForTest() === 0, 20_000);
}

async function resetAll(): Promise<void> {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	(config as Record<string, unknown>).aiEnabled = originalAiEnabled;
	if (originalModeEnv === undefined) delete process.env[MODE_ENV];
	else process.env[MODE_ENV] = originalModeEnv;
	limit._setSummaryLimitClockForTest(null);
	limit._resetSummaryLimitForTest();
	await resetIdentityState();
	await H.resetWorld(stub);
}

beforeEach(async () => {
	await resetAll();
	await H.enableAi();
	await H.seedProvider(stub);
});
afterEach(async () => {
	await waitForGenerations();
	await resetAll();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const pathFor = (mount: Mount, id: string) =>
	`${mount}/ai/sessions/${encodeURIComponent(id)}/summary`;

interface Answered {
	status: number;
	text: string;
	json: Record<string, unknown> | null;
	retryAfter: string | null;
}

async function call(
	method: "GET" | "POST",
	id: string,
	headers: Headers = new Headers(),
	mount: Mount = MOUNTS[0],
	init: { body?: string } = {},
): Promise<Answered> {
	const res = await app.request(pathFor(mount, id), { method, headers, ...init });
	const text = await res.text();
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { status: res.status, text, json, retryAfter: res.headers.get("Retry-After") };
}

const get = (id: string, headers?: Headers, mount?: Mount) => call("GET", id, headers, mount);
const post = (id: string, headers?: Headers, mount?: Mount) => {
	startedSessions.add(id);
	return call("POST", id, headers, mount);
};

const ok = (cite: number[]) => ({ text: H.answer(cite), stop: "stop", usage: H.STUB_USAGE });
const scriptOk = (cite: number[]) => stub.script("openai", ok(cite));
function scriptGated(cite: number[]): StubGate {
	const gate = stub.createGate();
	openGates.push(gate);
	stub.script("openai", { ...ok(cite), gate });
	return gate;
}

/** Disable auth for the DISABLE_AUTH operator rows. */
function disableAuth(): Headers {
	(config as Record<string, unknown>).disableAuth = true;
	return new Headers();
}

async function authedMember(label = "rt-member"): Promise<{ id: string; headers: Headers }> {
	const user = await seedLocalUser(label, "user");
	return { id: user.id, headers: await cookieHeadersFor(user.id) };
}

async function setKeyScopes(id: string, scopes: string[]): Promise<void> {
	await getDb()
		.update(apiKeys)
		.set({ scopes: JSON.stringify(scopes) })
		.where(eq(apiKeys.id, id));
}

/** A session with enough activity, and the id of its newest event. */
async function activeSession(id: string, owner?: string): Promise<number> {
	const { editId } = await H.seedActiveSession(id, owner ? { ownerUserId: owner } : {});
	return editId;
}

async function seedHostCredential(): Promise<Headers> {
	const hostId = crypto.randomUUID();
	await getDb()
		.insert(supervisors)
		.values({ id: hostId, hostName: "rt-host", platform: "linux", arch: "x64", version: "0" });
	const credential = await createSupervisorCredential(hostId, "rt-host-credential");
	return bearerHeaders(credential.token);
}

/** Holds the own-turn queue full: one job running behind a gate and the ceiling's worth waiting. */
async function fillQueue() {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = false;
	const running = runInOwnTurn(async () => {
		started = true;
		await gate;
	});
	while (!started) await new Promise((resolve) => setImmediate(resolve));
	const waiting = Array.from({ length: OWN_TURN_MAX_WAITING }, () =>
		runInOwnTurn(async () => undefined),
	);
	return async () => {
		release();
		await Promise.all([running, ...waiting]);
	};
}

// ── TC-6.1: the caller matrix ────────────────────────────────────────────────

interface Want {
	status: number;
	error?: string;
}
interface CallerRow {
	name: string;
	team: boolean;
	headers: () => Promise<Headers>;
	/** The session belongs to this user (team rows: someone else's). */
	foreignOwner?: boolean;
	get: Want;
	post: Want;
}
const OPEN: { get: Want; post: Want } = { get: { status: 200 }, post: { status: 202 } };
const refused = (status: number, error: string) => ({
	get: { status, error },
	post: { status, error },
});

const CALLER_ROWS: CallerRow[] = [
	{ name: "DISABLE_AUTH operator", team: false, headers: async () => disableAuth(), ...OPEN },
	{
		name: "no credentials",
		team: false,
		headers: async () => new Headers(),
		...refused(401, "Unauthorized"),
	},
	{
		name: "solo cookie user",
		team: false,
		headers: async () => (await authedMember("solo-user")).headers,
		...OPEN,
	},
	{
		name: "solo owned manage key",
		team: false,
		headers: async () => {
			const user = await seedLocalUser("solo-owner", "user");
			return bearerHeaders((await seedKey("solo-owned", ["manage"], user.id)).key);
		},
		...OPEN,
	},
	{
		name: "solo ownerless manage key",
		team: false,
		headers: async () => bearerHeaders((await seedKey("solo-service", ["manage"])).key),
		...OPEN,
	},
	{
		name: "solo wildcard key",
		team: false,
		headers: async () => {
			const { id, key } = await seedKey("solo-star", ["manage"]);
			await setKeyScopes(id, ["*"]);
			return bearerHeaders(key);
		},
		...OPEN,
	},
	{
		name: "observe-only key",
		team: false,
		headers: async () => bearerHeaders((await seedKey("solo-observe", ["observe"])).key),
		...refused(403, "insufficient_scope"),
	},
	{
		name: "ingest-only key",
		team: false,
		headers: async () => bearerHeaders((await seedKey("solo-ingest", ["ingest"])).key),
		...refused(403, "insufficient_scope"),
	},
	{
		name: "host (supervisor) credential",
		team: false,
		headers: seedHostCredential,
		...refused(401, "Unauthorized"),
	},
	{
		name: "disabled user's cookie",
		team: false,
		headers: async () => {
			const user = await seedLocalUser("disabled-user", "user");
			const headers = await cookieHeadersFor(user.id);
			await disableUserDirectly(user.id);
			return headers;
		},
		...refused(401, "Unauthorized"),
	},
	{
		name: "must-change-password user's cookie",
		team: false,
		headers: async () => {
			const user = await seedLocalUser("must-change", "user", { mustChangePassword: true });
			return cookieHeadersFor(user.id);
		},
		...refused(403, "password_change_required"),
	},
	{
		name: "owned key whose owner must change the password",
		team: false,
		headers: async () => {
			const user = await seedLocalUser("must-change-key", "user", { mustChangePassword: true });
			return bearerHeaders((await seedKey("mc-owned", ["manage"], user.id)).key);
		},
		...refused(403, "password_change_required"),
	},
	{
		name: "team member on another member's session",
		team: true,
		foreignOwner: true,
		headers: async () => (await authedMember("team-member")).headers,
		...OPEN,
	},
	{
		name: "team admin on another member's session",
		team: true,
		foreignOwner: true,
		headers: async () => {
			const admin = await seedLocalUser("team-admin", "admin");
			return cookieHeadersFor(admin.id);
		},
		...OPEN,
	},
	{
		name: "team member's owned manage key",
		team: true,
		foreignOwner: true,
		headers: async () => {
			const user = await seedLocalUser("team-key-owner", "user");
			return bearerHeaders((await seedKey("team-owned", ["manage"], user.id)).key);
		},
		...OPEN,
	},
	{
		name: "team ownerless manage key (a member, not a kept admin key)",
		team: true,
		foreignOwner: true,
		headers: async () => bearerHeaders((await seedKey("team-service", ["manage"])).key),
		...OPEN,
	},
	{
		name: "team observe-only key",
		team: true,
		foreignOwner: true,
		headers: async () => bearerHeaders((await seedKey("team-observe", ["observe"])).key),
		...refused(403, "insufficient_scope"),
	},
	{
		name: "team must-change-password member",
		team: true,
		foreignOwner: true,
		headers: async () => {
			const user = await seedLocalUser("team-must-change", "user", { mustChangePassword: true });
			return cookieHeadersFor(user.id);
		},
		...refused(403, "password_change_required"),
	},
];

describe("the caller matrix, on both mounts", () => {
	for (const row of CALLER_ROWS) {
		for (const mount of MOUNTS) {
			test(`TC-6.1 ${row.name} on ${mount}: GET ${row.get.status}${row.get.error ? ` ${row.get.error}` : ""}, POST ${row.post.status}${row.post.error ? ` ${row.post.error}` : ""}`, async () => {
				if (row.team) await setStoredMode("team");
				const owner = row.foreignOwner ? await seedLocalUser("session-owner", "user") : null;
				const getId = `rt-m-get-${crypto.randomUUID().slice(0, 8)}`;
				const postId = `rt-m-post-${crypto.randomUUID().slice(0, 8)}`;
				await activeSession(getId, owner?.id);
				const postEdit = await activeSession(postId, owner?.id);
				const headers = await row.headers();
				if (row.post.status === 202) scriptOk([postEdit]);

				const read = await get(getId, headers, mount);
				expect({ status: read.status, error: read.json?.error }).toEqual({
					status: row.get.status,
					error: row.get.error,
				});
				if (row.get.status === 200) expect(read.json).toHaveProperty("attempt");

				const write = await post(postId, headers, mount);
				expect({ status: write.status, error: write.json?.error }).toEqual({
					status: row.post.status,
					error: row.post.error,
				});
				if (row.post.status === 202) {
					expect(write.json).toEqual({
						attempt: { status: "generating", startedAt: expect.any(String), joined: false },
					});
				}
			});
		}
	}
});

// ── TC-6.2 / 6.15 / 6.19: gates, their order, and what stays readable ─────────

describe("gates", () => {
	const setups: Record<string, () => Promise<void>> = {
		"build off": async () => {
			(config as Record<string, unknown>).aiEnabled = false;
		},
		"runtime off": async () => H.setAiSetting("ai.enabled", false),
		paused: async () => H.setAiSetting("ai.killSwitch", true),
		"flag off": async () => {
			await setLabsFlag("sessionSummary", false);
		},
	};

	const expected: Record<string, { get: Want; post: Want }> = {
		"build off": {
			get: { status: 404, error: "ai_disabled" },
			post: { status: 404, error: "ai_disabled" },
		},
		"runtime off": { get: { status: 200 }, post: { status: 409, error: "ai_disabled" } },
		paused: { get: { status: 200 }, post: { status: 409, error: "ai_paused" } },
		"flag off": {
			get: { status: 409, error: "session_summary_disabled" },
			post: { status: 409, error: "session_summary_disabled" },
		},
	};

	for (const [gate, setup] of Object.entries(setups)) {
		for (const mount of MOUNTS) {
			test(`TC-6.19 ${gate} on ${mount}: the gate's own code is reachable on each route`, async () => {
				await activeSession(SID);
				const headers = disableAuth();
				await setup();
				const read = await get(SID, headers, mount);
				expect({ status: read.status, error: read.json?.error }).toEqual({
					status: expected[gate].get.status,
					error: expected[gate].get.error,
				});
				const write = await post(SID, headers, mount);
				expect({ status: write.status, error: write.json?.error }).toEqual({
					status: expected[gate].post.status,
					error: expected[gate].post.error,
				});
			});
		}
	}

	test("TC-6.2 GET answers 200 with AI runtime-off or paused, only the POST is refused; build-off is 404 on both", async () => {
		const editId = await activeSession(SID);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: editId - 1 });
		const headers = disableAuth();
		for (const state of ["runtime off", "paused"]) {
			await resetAiState();
			await setups[state]();
			const read = await get(SID, headers);
			expect({ state, status: read.status }).toEqual({ state, status: 200 });
			const write = await post(SID, headers);
			const want = expected[state].post;
			expect([state, write.status, write.json?.error]).toEqual([state, want.status, want.error]);
		}
	});

	test("TC-6.2 the order of the POST gates: build, then runtime-active, then the flag, then origin", async () => {
		await activeSession(SID);
		const headers = disableAuth();
		headers.set("Host", "summary.example.test");
		headers.set("Origin", "http://evil.example.test");

		await setLabsFlag("sessionSummary", false);
		await H.setAiSetting("ai.enabled", false);
		const runtimeBeforeFlag = await post(SID, headers);
		expect(runtimeBeforeFlag.json?.error).toBe("ai_disabled");
		expect(runtimeBeforeFlag.status).toBe(409);

		(config as Record<string, unknown>).aiEnabled = false;
		const buildBeforeAll = await post(SID, headers);
		expect([buildBeforeAll.status, buildBeforeAll.json?.error]).toEqual([404, "ai_disabled"]);

		(config as Record<string, unknown>).aiEnabled = originalAiEnabled;
		await H.enableAi({ labsFlag: false });
		const flagBeforeOrigin = await post(SID, headers);
		expect([flagBeforeOrigin.status, flagBeforeOrigin.json?.error]).toEqual([
			409,
			"session_summary_disabled",
		]);

		await setLabsFlag("sessionSummary", true);
		const originLast = await post(SID, headers);
		expect([originLast.status, originLast.json?.error]).toEqual([403, "bad_origin"]);
	});

	test("TC-6.2 an observe or ingest key is 403 insufficient_scope whatever the AI state, the flag and the id", async () => {
		await activeSession(SID);
		const observe = bearerHeaders((await seedKey("gate-observe", ["observe"])).key);
		const ingest = bearerHeaders((await seedKey("gate-ingest", ["ingest"])).key);
		for (const state of ["ok", "build off", "runtime off", "paused", "flag off"]) {
			await resetAiState();
			if (state !== "ok") await setups[state]();
			for (const id of [SID, "does-not-exist"]) {
				for (const headers of [observe, ingest]) {
					for (const mount of MOUNTS) {
						const read = await get(id, headers, mount);
						const write = await post(id, headers, mount);
						expect({ state, id, read: [read.status, read.json?.error] }).toEqual({
							state,
							id,
							read: [403, "insufficient_scope"],
						});
						expect({ state, id, write: [write.status, write.json?.error] }).toEqual({
							state,
							id,
							write: [403, "insufficient_scope"],
						});
					}
				}
			}
		}
	});

	test("TC-6.15 with runtime-off and with the kill switch on, a stored summary is still readable and the POST is refused", async () => {
		const editId = await activeSession(SID);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: editId - 1 });
		const headers = disableAuth();
		for (const [setting, code] of [
			["runtime off", "ai_disabled"],
			["paused", "ai_paused"],
		] as const) {
			await resetAiState();
			await setups[setting]();
			const read = await get(SID, headers);
			expect(read.status).toBe(200);
			expect((read.json?.stored as { summary: { overview: string } }).summary.overview).toBe(
				"Added the summary tab and fixed the flaky poll test.",
			);
			const write = await post(SID, headers);
			expect([write.status, write.json?.error]).toEqual([409, code]);
		}
	});

	test("TC-6.7 turning the flag on and off changes both routes on both mounts at once", async () => {
		const editId = await activeSession(SID);
		const headers = disableAuth();
		await setLabsFlag("sessionSummary", false);
		for (const mount of MOUNTS) {
			expect((await get(SID, headers, mount)).json?.error).toBe("session_summary_disabled");
			expect((await post(SID, headers, mount)).json?.error).toBe("session_summary_disabled");
		}
		await setLabsFlag("sessionSummary", true);
		scriptOk([editId]);
		expect((await get(SID, headers, MOUNTS[1])).status).toBe(200);
		expect((await post(SID, headers, MOUNTS[1])).status).toBe(202);
		await waitForGenerations();
		await setLabsFlag("sessionSummary", false);
		for (const mount of MOUNTS) {
			expect((await get(SID, headers, mount)).status).toBe(409);
			expect((await post(SID, headers, mount)).status).toBe(409);
		}
	});

	test("TC-6.18 /ai/status answers 200 with build false when AI is not built in, never 404", async () => {
		(config as Record<string, unknown>).aiEnabled = false;
		const res = await app.request("/api/v1/ai/status", { headers: disableAuth() });
		expect(res.status).toBe(200);
		expect((await res.json()) as { build: boolean }).toMatchObject({ build: false });
	});
});

async function resetAiState(): Promise<void> {
	(config as Record<string, unknown>).aiEnabled = originalAiEnabled;
	await H.enableAi();
}

// ── TC-6.3 / 6.5r3: refusals, status, shape and header ───────────────────────

async function expectRefusal(
	code: (typeof SUMMARY_REFUSAL_CODES)[number],
	answered: Answered,
): Promise<void> {
	const fixture = REFUSAL_BODY_FIXTURES[code];
	expect(answered.status).toBe(fixture.status);
	expect(shapeOf(JSON.parse(answered.text))).toEqual(shapeOf(fixture.body));
	expect(answered.json?.error).toBe(code);
	const seconds = answered.json?.retryAfterSeconds;
	if ("retryAfterSeconds" in fixture.body) {
		expect(Number.isInteger(seconds)).toBe(true);
		expect(seconds as number).toBeGreaterThanOrEqual(1);
		expect(answered.retryAfter).toBe(String(seconds));
	} else {
		expect(answered.retryAfter).toBeNull();
	}
	expect(SUMMARY_REFUSAL_CODES).toContain(answered.json?.error as never);
}

describe("every refusal body, with the fixture's status", () => {
	test("TC-6.5r3 ai_disabled (runtime off, 409; build off, 404)", async () => {
		await activeSession(SID);
		const headers = disableAuth();
		await H.setAiSetting("ai.enabled", false);
		await expectRefusal("ai_disabled", await post(SID, headers));
		(config as Record<string, unknown>).aiEnabled = false;
		const built = await post(SID, headers);
		expect(built.status).toBe(404);
		expect(shapeOf(JSON.parse(built.text))).toEqual(
			shapeOf(REFUSAL_BODY_FIXTURES.ai_disabled.body),
		);
	});

	test("TC-6.5r3 ai_paused", async () => {
		await activeSession(SID);
		await H.setAiSetting("ai.killSwitch", true);
		await expectRefusal("ai_paused", await post(SID, disableAuth()));
	});

	test("TC-6.5r3 session_summary_disabled", async () => {
		await activeSession(SID);
		await setLabsFlag("sessionSummary", false);
		await expectRefusal("session_summary_disabled", await post(SID, disableAuth()));
	});

	test("TC-6.5r3 summary_rate_limited", async () => {
		const headers = disableAuth();
		for (let i = 0; i < 6; i++) await post("nope", headers);
		await expectRefusal("summary_rate_limited", await post("nope", headers));
	});

	test("TC-6.5r3 shutting_down", async () => {
		await activeSession(SID);
		setShuttingDown("test");
		await expectRefusal("shutting_down", await post(SID, disableAuth()));
	});

	test("TC-6.5r3 session_not_found (GET and POST)", async () => {
		const headers = disableAuth();
		await expectRefusal("session_not_found", await get("nope", headers));
		await expectRefusal("session_not_found", await post("nope", headers));
	});

	test("TC-6.5r3 too_little_activity", async () => {
		await H.seedSession(SID);
		await H.seedEvents(SID, [H.ack()]);
		await expectRefusal("too_little_activity", await post(SID, disableAuth()));
	});

	test("TC-6.5r3 busy from a full process (retry 5) and from a full scan queue (retry 1)", async () => {
		const headers = disableAuth();
		const [a, b, c] = ["rt-busy-a", "rt-busy-b", "rt-busy-c"];
		const gates: StubGate[] = [];
		for (const id of [a, b]) {
			const edit = await activeSession(id);
			gates.push(scriptGated([edit]));
			expect((await post(id, headers)).status).toBe(202);
			await H.withDeadline(gates[gates.length - 1].arrived);
		}
		await activeSession(c);
		const full = await post(c, headers);
		await expectRefusal("busy", full);
		expect(full.json?.retryAfterSeconds).toBe(5);
		await waitForGenerations();

		await activeSession("rt-busy-scan");
		const drain = await fillQueue();
		try {
			const scan = await Promise.race([
				post("rt-busy-scan", headers),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
			]);
			if (scan === null) throw new Error("the POST waited behind a full scan queue");
			expect(scan.status).toBe(503);
			expect(scan.json).toEqual({ error: "busy", retryAfterSeconds: 1 });
			expect(scan.retryAfter).toBe("1");
		} finally {
			await drain();
		}
	});

	test("TC-6.5r3 no_provider", async () => {
		await activeSession(SID);
		await getDb().delete(llmProviders);
		await expectRefusal("no_provider", await post(SID, disableAuth()));
	});

	test("TC-6.5r3 provider_key_unreadable", async () => {
		await activeSession(SID);
		await getDb()
			.update(llmProviders)
			.set({ credentialCiphertext: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0" });
		await expectRefusal("provider_key_unreadable", await post(SID, disableAuth()));
	});

	test("TC-6.5r3 summary_cooldown", async () => {
		const editId = await activeSession(SID);
		await H.seedReadySummary(SID, {
			throughEventId: editId,
			firstEventId: editId - 1,
			startedAt: toDbTimestamp(new Date()),
		});
		await expectRefusal("summary_cooldown", await post(SID, disableAuth()));
	});

	test("TC-6.5r3 caller_generation_running (team mode)", async () => {
		await setStoredMode("team");
		const member = await authedMember("cgr");
		const e1 = await activeSession("rt-cgr-1");
		await activeSession("rt-cgr-2");
		const gate = scriptGated([e1]);
		expect((await post("rt-cgr-1", member.headers)).status).toBe(202);
		await H.withDeadline(gate.arrived);
		await expectRefusal("caller_generation_running", await post("rt-cgr-2", member.headers));
	});

	test("TC-6.5r3 spend_cap_reached", async () => {
		await activeSession(SID);
		await H.setDaySpend(499);
		const answered = await post(SID, disableAuth());
		await expectRefusal("spend_cap_reached", answered);
		expect(answered.json?.spentCents).toBe(499);
	});

	test("TC-6.5r3 the fixture table has every code, and no code is left untested", () => {
		expect(Object.keys(REFUSAL_BODY_FIXTURES).sort()).toEqual([...SUMMARY_REFUSAL_CODES].sort());
	});
});

describe("answers of the started and joined POST, and the GET busy", () => {
	test("TC-6.3 a started and a joined POST both answer 202 with the same shape", async () => {
		const headers = disableAuth();
		const editId = await activeSession(SID);
		const gate = scriptGated([editId]);
		const started = await post(SID, headers);
		await H.withDeadline(gate.arrived);
		const joined = await post(SID, headers);
		expect([started.status, joined.status]).toEqual([202, 202]);
		expect(started.json?.attempt).toMatchObject({ status: "generating", joined: false });
		expect(joined.json?.attempt).toMatchObject({ status: "generating", joined: true });
		expect(shapeOf(JSON.parse(joined.text))).toEqual(shapeOf(JSON.parse(started.text)));
		expect(started.retryAfter).toBeNull();
	});

	test("TC-6.3 a GET behind a full scan queue is 503 busy with Retry-After 1", async () => {
		await activeSession(SID);
		const headers = disableAuth();
		const drain = await fillQueue();
		try {
			const answered = await Promise.race([
				get(SID, headers),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
			]);
			if (answered === null) throw new Error("the GET waited behind a full scan queue");
			expect(answered.status).toBe(503);
			expect(answered.json).toEqual({ error: "busy", retryAfterSeconds: 1 });
			expect(answered.retryAfter).toBe("1");
		} finally {
			await drain();
		}
	});
});

// ── TC-6.4: the whole round trip ─────────────────────────────────────────────

describe("a generation seen through the routes", () => {
	test("TC-6.4 202, then generating while the provider is held, then ready after release", async () => {
		const headers = disableAuth();
		const editId = await activeSession(SID);
		const gate = scriptGated([editId]);
		expect((await post(SID, headers)).status).toBe(202);
		await H.withDeadline(gate.arrived);
		const during = await get(SID, headers);
		expect((during.json?.attempt as { status: string }).status).toBe("generating");
		expect(during.json?.stored).toBeNull();
		gate.release();
		await H.until(async () => {
			const view = await get(SID, headers);
			return (view.json?.attempt as { status: string }).status !== "generating";
		}, 20_000);
		const after = await get(SID, headers);
		expect((after.json?.attempt as { status: string }).status).toBe("idle");
		expect(after.json?.throughEventId).toBe(editId);
		expect((after.json?.stored as { summary: { overview: string } }).summary.overview).toBe(
			"Added retry to the uploader.",
		);
	});
});

// ── TC-6.5r1 / r2 / r4: the GET body against the fixtures ────────────────────

describe("the GET body has the fixture's shape", () => {
	const headers = () => disableAuth();
	async function viewShape(): Promise<{ answered: Answered; shape: Shape }> {
		const answered = await get(SID, headers());
		expect(answered.status).toBe(200);
		return { answered, shape: shapeOf(JSON.parse(answered.text)) };
	}
	const shapeOfFixture = (name: keyof typeof SUMMARY_VIEW_FIXTURES) =>
		shapeOf(JSON.parse(JSON.stringify(SUMMARY_VIEW_FIXTURES[name])));

	const scenarios: Record<
		string,
		{
			fixture: keyof typeof SUMMARY_VIEW_FIXTURES;
			seed: () => Promise<void>;
			/** Where a real view legitimately differs from the fixture (see the notes at the entry). */
			adjust?: (fixture: Record<string, unknown>) => Record<string, unknown>;
		}
	> = {
		empty: { fixture: "empty", seed: async () => void (await activeSession(SID)) },
		ready: {
			fixture: "ready",
			seed: async () => {
				const edit = await activeSession(SID);
				await H.seedReadySummary(SID, { throughEventId: edit, firstEventId: edit - 1 });
			},
		},
		stale: {
			fixture: "stale",
			seed: async () => {
				const edit = await activeSession(SID);
				await H.seedReadySummary(SID, { throughEventId: edit, firstEventId: edit - 1 });
				await H.seedEvents(SID, [H.edit("src/a.ts"), H.edit("src/b.ts")]);
			},
		},
		cooldown: {
			fixture: "cooldown",
			// The cooldown is derived from `attempt.startedAt`, so a real cooldown view always has one;
			// the committed fixture leaves it null (reported as a fixture inaccuracy).
			adjust: (fixture) => ({
				...fixture,
				attempt: { status: "idle", startedAt: "2026-10-04T11:59:43.000Z", errorCode: null },
			}),
			seed: async () => {
				const edit = await activeSession(SID);
				await H.seedReadySummary(SID, {
					throughEventId: edit,
					firstEventId: edit - 1,
					startedAt: toDbTimestamp(new Date()),
				});
			},
		},
		evidence_shrunk: {
			fixture: "evidence_shrunk",
			seed: async () => {
				const edit = await activeSession(SID);
				await H.seedReadySummary(SID, { throughEventId: edit, firstEventId: edit - 100 });
			},
		},
		retention: {
			fixture: "retention",
			seed: async () => {
				const edit = await activeSession(SID);
				await H.seedReadySummary(SID, { throughEventId: edit, firstEventId: edit - 1 });
				await H.setAiSetting("eventsRetentionDays", 30);
			},
		},
		no_provider: {
			fixture: "no_provider",
			seed: async () => {
				await activeSession(SID);
				await getDb().delete(llmProviders);
			},
		},
		spend_cap: {
			fixture: "spend_cap",
			seed: async () => {
				await activeSession(SID);
				await H.setDaySpend(499);
			},
		},
		too_little_activity: {
			fixture: "too_little_activity",
			seed: async () => {
				await H.seedSession(SID);
				await H.seedEvents(SID, [H.ack()]);
			},
		},
		failed_ai_inactive: {
			fixture: "failed_ai_inactive",
			seed: async () => {
				const edit = await activeSession(SID);
				await H.seedSummaryRow(SID, {
					generatedAt: toDbTimestamp(new Date(Date.now() - 600_000)),
					throughEventId: edit,
					attemptStatus: "failed",
					attemptStartedAt: toDbTimestamp(new Date(Date.now() - 300_000)),
					attemptErrorCode: "ai_inactive",
					summary: H.storedSummary({ firstEventId: edit - 1 }).summary,
					provenance: H.storedSummary({ firstEventId: edit - 1 }).provenance,
				});
			},
		},
	};

	for (const [name, { fixture, seed, adjust }] of Object.entries(scenarios)) {
		test(`TC-6.5r1 ${name}: the body's shape equals the fixture's`, async () => {
			await seed();
			const { answered, shape } = await viewShape();
			const want = adjust
				? shapeOf(adjust(JSON.parse(JSON.stringify(SUMMARY_VIEW_FIXTURES[fixture]))))
				: shapeOfFixture(fixture);
			expect(shape).toEqual(want);
			const view = answered.json as {
				attempt: { status: string; errorCode: string | null };
				blocked: string | null;
			};
			expect(SUMMARY_ATTEMPT_STATUSES).toContain(view.attempt.status as never);
			if (view.blocked !== null) expect(SUMMARY_BLOCK_REASONS).toContain(view.blocked as never);
			if (view.attempt.errorCode !== null)
				expect(SUMMARY_ERROR_CODES).toContain(view.attempt.errorCode as never);
		});
	}

	test("TC-6.5r1 generating: a held generation has the generating fixture's shape", async () => {
		const edit = await activeSession(SID);
		const gate = scriptGated([edit]);
		expect((await post(SID, headers())).status).toBe(202);
		await H.withDeadline(gate.arrived);
		const { shape } = await viewShape();
		expect(shape).toEqual(shapeOfFixture("generating"));
	});

	for (const code of SUMMARY_ERROR_CODES) {
		test(`TC-6.5r2 a failed attempt with code ${code} has the failed fixture's shape`, async () => {
			await activeSession(SID);
			await H.seedSummaryRow(SID, {
				attemptStatus: "failed",
				attemptStartedAt: toDbTimestamp(new Date(Date.now() - 300_000)),
				attemptErrorCode: code,
			});
			const { answered, shape } = await viewShape();
			expect(shape).toEqual(shapeOf(JSON.parse(JSON.stringify(FAILED_VIEW_FIXTURES[code]))));
			expect((answered.json?.attempt as { errorCode: string }).errorCode).toBe(code);
			expect(shapeOf(JSON.parse(JSON.stringify(failedWith(code))))).toEqual(shape);
		});
	}

	test("TC-6.5r2 a real failed run (the provider answers badly) reads back as a failed view", async () => {
		const edit = await activeSession(SID);
		void edit;
		stub.script("openai", { text: "", stop: "stop", status: 500, errorBody: "boom" });
		const write = await post(SID, headers());
		expect(write.status).toBe(202);
		await H.until(async () => {
			const row = await H.readSummaryRow(SID);
			return row?.attemptStatus === "failed";
		}, 20_000);
		const { answered, shape } = await viewShape();
		// A run that just failed is inside the cooldown, which the failed fixtures (an older attempt) do not carry.
		expect(shape).toEqual(
			shapeOf({
				...JSON.parse(JSON.stringify(FAILED_VIEW_FIXTURES.provider_error)),
				blocked: "summary_cooldown",
				cooldownSeconds: 29,
			}),
		);
		expect(SUMMARY_ERROR_CODES).toContain(
			(answered.json?.attempt as { errorCode: string }).errorCode as never,
		);
	});

	test("TC-6.5r4 no AI-state key anywhere in a view (the web reads that from /ai/status)", async () => {
		await activeSession(SID);
		const { answered } = await viewShape();
		const keys = new Set<string>();
		const walk = (value: unknown) => {
			if (Array.isArray(value)) value.forEach(walk);
			else if (value && typeof value === "object")
				for (const [k, v] of Object.entries(value)) {
					keys.add(k);
					walk(v);
				}
		};
		walk(answered.json);
		for (const forbidden of ["aiEnabled", "aiActive", "aiPaused", "killSwitch", "ai", "paused"])
			expect(keys.has(forbidden)).toBe(false);
	});
});

// ── TC-6.22: body sizes ──────────────────────────────────────────────────────

describe("body sizes", () => {
	test("TC-6.22 a generating body is at most 2 KB and a large honest ready body at most 64 KB and one at every cap at most 128 KB", async () => {
		const headers = disableAuth();
		const edit = await activeSession(SID);
		const gate = scriptGated([edit]);
		expect((await post(SID, headers)).status).toBe(202);
		await H.withDeadline(gate.arrived);
		const generating = await get(SID, headers);
		expect(generating.text.length).toBeLessThanOrEqual(2048);
		await waitForGenerations();
		await getDb().delete(aiSessionSummaries).where(eq(aiSessionSummaries.sessionId, SID));

		const base = H.storedSummary({ firstEventId: edit - 1 });
		const cap = (n: number) => ({
			text: "x".repeat(600),
			evidence: Array.from({ length: 12 }, (_, i) => `E${n + i}`),
			unverified: false,
		});
		const modest = (n: number) => ({
			text: `${"detail ".repeat(36)}${n}`.slice(0, 250),
			evidence: ["E1", "E2", "E3"],
			unverified: false,
		});
		const many = <T>(count: number, f: (n: number) => T) =>
			Array.from({ length: count }, (_, i) => f(i));
		const validation = (count: number, size: number) =>
			many(count, (n) => ({
				what: "v".repeat(Math.min(size, 200)),
				result: "passed",
				detail: "d".repeat(size),
				evidence: cap(n).evidence,
				adjusted: false,
			}));
		const honest = {
			...base.summary,
			overview: "o".repeat(1200),
			accomplishments: many(8, modest),
			changes: many(8, (n) => ({ ...modest(n), kind: "modified" })),
			decisions: many(8, (n) => ({ ...modest(n), why: "w".repeat(200) })),
			validation: validation(8, 200),
			problems: many(8, modest),
			unfinished: many(8, modest),
			nextActions: many(5, modest),
			handoff: "h".repeat(2000),
		};
		// What phase 5 measured as "at the schema's caps": three sections full, the rest honest.
		const phase5Max = {
			...base.summary,
			overview: "o".repeat(1200),
			accomplishments: many(20, cap),
			changes: many(8, (n) => ({ ...modest(n), kind: "modified" })),
			decisions: many(8, (n) => ({ ...modest(n), why: "w".repeat(200) })),
			validation: validation(8, 200),
			problems: many(20, cap),
			unfinished: many(20, cap),
			nextActions: many(5, modest),
			handoff: "h".repeat(4000),
		};
		// Every section at its true cap (20 items of 600 characters, why/detail too): recorded, not asserted.
		const trueMax = {
			...phase5Max,
			changes: many(20, (n) => ({ ...cap(n), kind: "modified" })),
			decisions: many(20, (n) => ({ ...cap(n), why: "w".repeat(600) })),
			validation: validation(20, 600),
			nextActions: many(5, cap),
		};
		const evidence = Object.fromEntries(
			Array.from({ length: 150 }, (_, i) => [
				`E${i + 1}`,
				{ kind: "edit", at: "2026-10-04T10:04:00.000Z", count: 3 },
			]),
		);
		const bytesWith = async (summary: unknown): Promise<number> => {
			await getDb().delete(aiSessionSummaries).where(eq(aiSessionSummaries.sessionId, SID));
			await getDb()
				.insert(aiSessionSummaries)
				.values({
					sessionId: SID,
					generatedAt: toDbTimestamp(new Date()),
					throughEventId: edit,
					summary: summary as never,
					provenance: { ...base.provenance, evidence } as never,
				});
			const ready = await get(SID, headers);
			expect(ready.status).toBe(200);
			return ready.text.length;
		};
		const honestBytes = await bytesWith(honest);
		const threeFull = await bytesWith(phase5Max);
		const trueBytes = await bytesWith(trueMax);
		console.log(
			`[perf] ${JSON.stringify({ label: "ready view bytes", honest: honestBytes, threeSectionsAtCap: threeFull, everySectionAtItsCap: trueBytes, ruledLimit: 65536 })}`,
		);
		// The ruling's 64 KB holds for a large honest summary. The schema's own item caps allow far
		// more (spec finding, reported): the ceiling asserted at the caps is twice the ruled number.
		expect(honestBytes).toBeLessThanOrEqual(64 * 1024);
		expect(trueBytes).toBeLessThanOrEqual(128 * 1024);
	});
});

// ── TC-6.6: one answer on both mounts ────────────────────────────────────────

describe("both mounts", () => {
	test("TC-6.6 a GET and a POST give the same result on /api/v1 and /app-api/v1", async () => {
		const headers = disableAuth();
		const edit = await activeSession(SID);
		await H.seedReadySummary(SID, { throughEventId: edit, firstEventId: edit - 1 });
		const [a, b] = await Promise.all(MOUNTS.map((m) => get(SID, headers, m)));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(JSON.parse(a.text)).toEqual(JSON.parse(b.text));

		const refusals = [];
		for (const mount of MOUNTS) refusals.push(await post("nope", headers, mount));
		expect(refusals[0].status).toBe(404);
		expect(refusals[1].status).toBe(404);
		expect(refusals[1].json).toEqual(refusals[0].json);

		const starts = [];
		for (const [i, mount] of MOUNTS.entries()) {
			const id = `rt-mount-${i}`;
			scriptOk([await activeSession(id)]);
			starts.push(await post(id, headers, mount));
			await waitForGenerations();
		}
		expect(starts.map((s) => s.status)).toEqual([202, 202]);
		expect(shapeOf(starts[1].json)).toEqual(shapeOf(starts[0].json));
	});
});

// ── TC-6.8: classification ───────────────────────────────────────────────────

describe("classification", () => {
	test("TC-6.8 the GET is in INTENTIONALLY_MANAGE_ONLY once and in no other set; the POST is in none; both are registered on both mounts; OWNER_CHECKED_ROUTES stays 16", () => {
		expect(INTENTIONALLY_MANAGE_ONLY.has(GET_ROUTE)).toBe(true);
		expect(OBSERVE_READ_PATHS.has(GET_ROUTE)).toBe(false);
		for (const set of [TEAM_ADMIN_ROUTES, OWNER_CHECKED_ROUTES, INGEST_WRITABLE_ROUTES]) {
			expect(set.has(POST_ROUTE)).toBe(false);
			expect(set.has(`GET ${GET_ROUTE}`)).toBe(false);
		}
		expect(ALWAYS_ADMIN_ROUTES.has(POST_ROUTE)).toBe(false);
		expect(ALWAYS_ADMIN_ROUTES.has(`GET ${GET_ROUTE}`)).toBe(false);
		expect(OWNER_CHECKED_ROUTES.size).toBe(16);

		const registered = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
		for (const mount of MOUNTS) {
			expect(registered.has(`GET ${mount}${GET_ROUTE}`)).toBe(true);
			expect(registered.has(`POST ${mount}${GET_ROUTE}`)).toBe(true);
		}
		const sets = [OBSERVE_READ_PATHS, INTENTIONALLY_MANAGE_ONLY].filter((s) => s.has(GET_ROUTE));
		expect(sets.length).toBe(1);
	});
});

// ── TC-6.9 / 6.10 / 6.11: bodies, ids, archived ──────────────────────────────

describe("inputs", () => {
	test("TC-6.9 a POST with a 10 MB body or malformed JSON behaves like an empty POST", async () => {
		const headers = disableAuth();
		const ids = ["rt-body-empty", "rt-body-big", "rt-body-bad"];
		const answers: Answered[] = [];
		const bodies: Array<string | undefined> = [
			undefined,
			"x".repeat(10 * 1024 * 1024),
			"{not json",
		];
		for (const [i, id] of ids.entries()) {
			scriptOk([await activeSession(id)]);
			const h = new Headers(headers);
			h.set("Content-Type", "application/json");
			startedSessions.add(id);
			answers.push(await call("POST", id, h, MOUNTS[0], { body: bodies[i] }));
			await waitForGenerations();
			limit._resetSummaryLimitForTest();
		}
		expect(answers.map((a) => a.status)).toEqual([202, 202, 202]);
		expect(shapeOf(answers[1].json)).toEqual(shapeOf(answers[0].json));
		expect(shapeOf(answers[2].json)).toEqual(shapeOf(answers[0].json));
	});

	test("TC-6.10 a 300-char id, an encoded slash and a unicode id are 404, never 500", async () => {
		const headers = disableAuth();
		for (const id of ["a".repeat(300), "a/b", "résumé-会話-🙂"]) {
			const read = await get(id, headers);
			const write = await post(id, headers);
			expect({ id: id.length, read: read.status, write: write.status }).toEqual({
				id: id.length,
				read: 404,
				write: 404,
			});
		}
		const raw = await app.request("/api/v1/ai/sessions/a%2Fb/summary", { headers });
		expect(raw.status).toBe(404);
		const rawPost = await app.request("/api/v1/ai/sessions/a%2Fb/summary", {
			method: "POST",
			headers,
		});
		expect(rawPost.status).toBe(404);
	});

	test("TC-6.11 an archived session can be read and summarized", async () => {
		const headers = disableAuth();
		await H.seedSession("rt-archived", { isArchived: true });
		const [promptId, editId] = await H.seedEvents("rt-archived", [
			H.prompt("Add retry."),
			H.edit("src/x.ts"),
		]);
		void promptId;
		scriptOk([editId]);
		expect((await get("rt-archived", headers)).status).toBe(200);
		expect((await post("rt-archived", headers)).status).toBe(202);
	});
});

// ── TC-6.12 / 6.13 / 6.14 / 6.16 / 6.17: limiter, origin, audit, shutdown ────

describe("the per-caller limit", () => {
	test("TC-6.12 the seventh POST in a minute is 429 summary_rate_limited; another caller is unaffected; the window resets", async () => {
		let now = 1_000_000;
		limit._setSummaryLimitClockForTest(() => now);
		const first = await authedMember("lim-a");
		const second = await authedMember("lim-b");
		for (let i = 0; i < 6; i++) expect((await post("nope", first.headers)).status).toBe(404);
		const seventh = await post("nope", first.headers);
		expect([seventh.status, seventh.json?.error]).toEqual([429, "summary_rate_limited"]);
		expect(Number(seventh.retryAfter)).toBeGreaterThanOrEqual(1);
		expect(Number(seventh.retryAfter)).toBeLessThanOrEqual(60);
		expect(seventh.json?.retryAfterSeconds).toBe(Number(seventh.retryAfter));
		expect((await post("nope", second.headers)).status).toBe(404);
		now += 60_000;
		expect((await post("nope", first.headers)).status).toBe(404);
	});

	test("TC-6.16 buckets: a user's cookie and owned key share one, a key has its own, DISABLE_AUTH has one", async () => {
		const user = await seedLocalUser("bucket-user", "user");
		const cookie = await cookieHeadersFor(user.id);
		const ownedKey = bearerHeaders((await seedKey("bucket-owned", ["manage"], user.id)).key);
		for (let i = 0; i < 3; i++) await post("nope", cookie);
		for (let i = 0; i < 3; i++) await post("nope", ownedKey);
		expect((await post("nope", cookie)).json?.error).toBe("summary_rate_limited");
		expect((await post("nope", ownedKey)).json?.error).toBe("summary_rate_limited");

		const serviceKeyA = bearerHeaders((await seedKey("bucket-a", ["manage"])).key);
		const serviceKeyB = bearerHeaders((await seedKey("bucket-b", ["manage"])).key);
		for (let i = 0; i < 6; i++) await post("nope", serviceKeyA);
		expect((await post("nope", serviceKeyA)).json?.error).toBe("summary_rate_limited");
		expect((await post("nope", serviceKeyB)).json?.error).toBe("session_not_found");

		const operator = disableAuth();
		for (let i = 0; i < 6; i++) await post("nope", operator);
		expect((await post("nope", operator)).json?.error).toBe("summary_rate_limited");
	});

	test("TC-6.16 a limited request reserves nothing, reads no summary row, and is limited before shutting_down and 404", async () => {
		const headers = disableAuth();
		await activeSession(SID);
		for (let i = 0; i < 6; i++) await post("nope", headers);
		setShuttingDown("test");
		const before = await H.snapshotSpend(SID);
		const { result, statements } = await H.captureStatements(() => post(SID, headers));
		expect(result.json?.error).toBe("summary_rate_limited");
		const touched = statements.filter((s) =>
			/ai_session_summaries|ai_daily_spend|from\s+"?events"?|from\s+"?sessions"?/i.test(s.text),
		);
		expect(touched.map((s) => s.text)).toEqual([]);
		const delta = await H.spendDelta(before);
		expect(delta.day).toBe(0);
		expect(await H.readSummaryRow(SID)).toBeUndefined();
	});

	test("TC-6.16 a request refused by a gate, the flag or the origin does not consume a token", async () => {
		const headers = disableAuth();
		await activeSession(SID);
		await setLabsFlag("sessionSummary", false);
		for (let i = 0; i < 9; i++) {
			expect((await post(SID, headers)).json?.error).toBe("session_summary_disabled");
		}
		await H.setAiSetting("ai.killSwitch", true);
		for (let i = 0; i < 9; i++) expect((await post(SID, headers)).json?.error).toBe("ai_paused");
		await H.enableAi();
		const foreign = new Headers(headers);
		foreign.set("Host", "summary.example.test");
		foreign.set("Origin", "http://evil.example.test");
		for (let i = 0; i < 9; i++) expect((await post(SID, foreign)).json?.error).toBe("bad_origin");
		const editId = (await H.seedEvents(SID, [H.edit("src/y.ts")]))[0];
		scriptOk([editId]);
		expect((await post(SID, headers)).status).toBe(202);
	});

	test("TC-6.16 a request the service then refuses does consume a token", async () => {
		const headers = disableAuth();
		await H.seedSession(SID);
		await H.seedEvents(SID, [H.ack()]);
		for (let i = 0; i < 6; i++)
			expect((await post(SID, headers)).json?.error).toBe("too_little_activity");
		expect((await post(SID, headers)).json?.error).toBe("summary_rate_limited");
	});
});

describe("origin, audit, shutdown", () => {
	test("TC-6.13 a present foreign Origin is refused on the POST; an absent or same Origin passes; the GET ignores Origin", async () => {
		const editId = await activeSession(SID);
		const base = disableAuth();
		const foreign = new Headers(base);
		foreign.set("Host", "summary.example.test");
		foreign.set("Origin", "http://evil.example.test");
		const refusedPost = await post(SID, foreign);
		expect([refusedPost.status, refusedPost.json?.error]).toEqual([403, "bad_origin"]);
		expect(await H.readSummaryRow(SID)).toBeUndefined();
		expect((await get(SID, foreign)).status).toBe(200);

		const same = new Headers(base);
		same.set("Host", "summary.example.test");
		same.set("Origin", "http://summary.example.test");
		scriptOk([editId]);
		expect((await post(SID, same)).status).toBe(202);
		await waitForGenerations();
		limit._resetSummaryLimitForTest();
		await H.deleteSession(SID);
		const id2 = "rt-origin-2";
		scriptOk([await activeSession(id2)]);
		expect((await post(id2, base)).status).toBe(202);
	});

	test("TC-6.14 exactly one session_summary_requested line per started request, none for refusals and joins, no session text", async () => {
		const user = await seedLocalUser("audit-user", "user");
		const headers = await cookieHeadersFor(user.id);
		const editId = await activeSession(SID);
		const logs = H.captureLogs();
		try {
			const gate = scriptGated([editId]);
			expect((await post(SID, headers)).status).toBe(202);
			await H.withDeadline(gate.arrived);
			expect((await post(SID, headers)).status).toBe(202);
			await post("nope", headers);
			await setLabsFlag("sessionSummary", false);
			await post(SID, headers);
			await waitForGenerations();
		} finally {
			logs.restore();
		}
		const lines = logs.lines.filter((l) => l.includes("session_summary_requested"));
		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(entry).toMatchObject({
			kind: "session_summary_requested",
			by: user.id,
			actor: "user",
			sessionId: SID,
			providerKind: "openai",
			model: "gpt-5-mini",
		});
		expect(lines[0]).not.toContain("Add retry to the uploader");
		expect(lines[0]).not.toContain("local-user");
	});

	test("TC-6.14 the audit line names the real actor for a key and for DISABLE_AUTH", async () => {
		const key = await seedKey("audit-key", ["manage"]);
		const editId = await activeSession(SID);
		const second = await activeSession("rt-audit-2");
		const logs = H.captureLogs();
		try {
			scriptOk([editId]);
			expect((await post(SID, bearerHeaders(key.key))).status).toBe(202);
			await waitForGenerations();
			scriptOk([second]);
			expect((await post("rt-audit-2", disableAuth())).status).toBe(202);
			await waitForGenerations();
		} finally {
			logs.restore();
		}
		const entries = logs.lines
			.filter((l) => l.includes("session_summary_requested"))
			.map((l) => JSON.parse(l) as { actor: string; by: string | null });
		expect(entries.map((e) => e.actor)).toEqual(["api_key", "anonymous"]);
		expect(entries.map((e) => e.by)).toEqual([null, null]);
	});

	test("TC-6.17 while shutting down the POST is 503 shutting_down before any read; the GET is unaffected", async () => {
		const headers = disableAuth();
		const editId = await activeSession(SID);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: editId - 1 });
		setShuttingDown("test");
		const { result, statements } = await H.captureStatements(() => post(SID, headers));
		expect([result.status, result.json?.error, result.retryAfter]).toEqual([
			503,
			"shutting_down",
			"5",
		]);
		const reads = statements.filter((s) =>
			/ai_session_summaries|from\s+"?events"?|from\s+"?sessions"?|llm_providers/i.test(s.text),
		);
		expect(reads.map((s) => s.text)).toEqual([]);
		expect((await get(SID, headers)).status).toBe(200);
	});
});

// ── TC-6.20: the subject of a caller ─────────────────────────────────────────

describe("who counts as the same caller", () => {
	test("TC-6.20 team: two members each run one; the same member twice, by cookie or by owned key, is refused; a service key's subject is its key id", async () => {
		await setStoredMode("team");
		const a = await authedMember("subj-a");
		const b = await authedMember("subj-b");
		const ids = ["rt-subj-1", "rt-subj-2", "rt-subj-3", "rt-subj-4"];
		const edits = [];
		for (const id of ids) edits.push(await activeSession(id));

		const gateA = scriptGated([edits[0]]);
		expect((await post(ids[0], a.headers)).status).toBe(202);
		await H.withDeadline(gateA.arrived);
		const gateB = scriptGated([edits[1]]);
		expect((await post(ids[1], b.headers)).status).toBe(202);
		await H.withDeadline(gateB.arrived);

		await waitForGenerations();
		const again = scriptGated([edits[2]]);
		expect((await post(ids[2], a.headers)).status).toBe(202);
		await H.withDeadline(again.arrived);
		const ownedKey = bearerHeaders((await seedKey("subj-key", ["manage"], a.id)).key);
		const byKey = await post(ids[3], ownedKey);
		expect([byKey.status, byKey.json?.error]).toEqual([409, "caller_generation_running"]);
		const byCookie = await post(ids[3], a.headers);
		expect([byCookie.status, byCookie.json?.error]).toEqual([409, "caller_generation_running"]);
	});

	test("TC-6.20 team: an ownerless service key is its own subject (key 1 twice is refused, key 2 may run)", async () => {
		await setStoredMode("team");
		const k1 = bearerHeaders((await seedKey("svc-1", ["manage"])).key);
		const k2 = bearerHeaders((await seedKey("svc-2", ["manage"])).key);
		const edits = [];
		for (const id of ["rt-svc-1", "rt-svc-2", "rt-svc-3"]) edits.push(await activeSession(id));
		const g1 = scriptGated([edits[0]]);
		expect((await post("rt-svc-1", k1)).status).toBe(202);
		await H.withDeadline(g1.arrived);
		const refusedSecond = await post("rt-svc-2", k1);
		expect([refusedSecond.status, refusedSecond.json?.error]).toEqual([
			409,
			"caller_generation_running",
		]);
		const g2 = scriptGated([edits[2]]);
		expect((await post("rt-svc-3", k2)).status).toBe(202);
		await H.withDeadline(g2.arrived);
	});

	test("TC-6.20 solo and DISABLE_AUTH: the same caller may hold both slots, with no per-caller refusal", async () => {
		const operator = disableAuth();
		const [e1, e2] = [await activeSession("rt-solo-1"), await activeSession("rt-solo-2")];
		const g1 = scriptGated([e1]);
		expect((await post("rt-solo-1", operator)).status).toBe(202);
		await H.withDeadline(g1.arrived);
		const g2 = scriptGated([e2]);
		expect((await post("rt-solo-2", operator)).status).toBe(202);
		await H.withDeadline(g2.arrived);

		await waitForGenerations();
		(config as Record<string, unknown>).disableAuth = originalDisableAuth;
		const member = await authedMember("solo-two");
		const [e3, e4] = [await activeSession("rt-solo-3"), await activeSession("rt-solo-4")];
		const g3 = scriptGated([e3]);
		expect((await post("rt-solo-3", member.headers)).status).toBe(202);
		await H.withDeadline(g3.arrived);
		const g4 = scriptGated([e4]);
		expect((await post("rt-solo-4", member.headers)).status).toBe(202);
		await H.withDeadline(g4.arrived);
	});
});

// ── TC-6.21 / 6.23 / 6.24: nothing leaks; errors are generic; no unhandled rejection ─

describe("what a response never carries", () => {
	test("TC-6.21 no attempt token, owner id, key id, ingest key id, provider id, name, base URL, reservation or key in any body", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("sentinel-owner", "user");
		const callerKey = await seedKey("sentinel-caller", ["manage"]);
		const ingestKey = await seedKey("sentinel-ingest", ["ingest"]);
		const editId = await activeSession(SID, owner.id);
		await getDb()
			.update(sessions)
			.set({ ingestKeyId: ingestKey.id })
			.where(eq(sessions.sessionId, SID));
		const [provider] = await getDb().select().from(llmProviders);
		const headers = bearerHeaders(callerKey.key);

		const bodies: string[] = [];
		const record = (a: Answered) => bodies.push(a.text);
		record(await get(SID, headers));
		const gate = scriptGated([editId]);
		record(await post(SID, headers));
		await H.withDeadline(gate.arrived);
		record(await get(SID, headers));
		record(await post(SID, headers));
		record(await post("nope", headers));
		record(await get("nope", headers));
		gate.release();
		await waitForGenerations();
		record(await get(SID, headers));
		await setLabsFlag("sessionSummary", false);
		record(await get(SID, headers));
		record(await post(SID, headers));
		await H.enableAi();
		await H.setDaySpend(499);
		await H.deleteSession(SID);
		await activeSession(SID, owner.id);
		record(await post(SID, headers));

		const row = await H.readSummaryRow(SID);
		const forbidden = [
			"attempt_token",
			"attemptToken",
			"ingest_key_id",
			"ingestKeyId",
			"ownerUserId",
			"owner_user_id",
			"reservation",
			owner.id,
			callerKey.id,
			ingestKey.id,
			provider.id,
			provider.name,
			stub.origin,
			stub.hostname,
			H.KEY,
			"baseUrl",
			"credential",
		];
		expect(bodies.length).toBeGreaterThan(8);
		for (const text of bodies) {
			for (const needle of forbidden) {
				expect({ needle, found: text.includes(needle) }).toEqual({ needle, found: false });
			}
			if (row?.attemptToken) expect(text.includes(row.attemptToken)).toBe(false);
		}
	});

	test("TC-6.23 an unexpected failure answers a generic 500 with no error text, SQL or provider text", async () => {
		const headers = disableAuth();
		await activeSession(SID);
		const logs = H.captureLogs();
		const read = spyOn(svc, "getSessionSummaryView").mockRejectedValue(
			new Error("SELECT secret FROM provider WHERE key = 'sk-leak'"),
		);
		const write = spyOn(svc, "requestSummaryGeneration").mockRejectedValue(
			new Error("provider said: sk-leak-from-provider"),
		);
		try {
			for (const answered of [await get(SID, headers), await post(SID, headers)]) {
				expect(answered.status).toBe(500);
				expect(answered.text).not.toContain("SELECT");
				expect(answered.text).not.toContain("sk-leak");
				expect(answered.text).not.toContain("provider said");
			}
		} finally {
			read.mockRestore();
			write.mockRestore();
			logs.restore();
		}
	});

	test("TC-6.24 a started generation that fails leaves no unhandled rejection", async () => {
		const headers = disableAuth();
		await activeSession(SID);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		const logs = H.captureLogs();
		try {
			stub.script("openai", { text: "", stop: "stop", status: 500, errorBody: "boom" });
			expect((await post(SID, headers)).status).toBe(202);
			await waitForGenerations();
			await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			logs.restore();
			process.off("unhandledRejection", onRejection);
		}
		expect(rejections).toEqual([]);
		expect((await H.readSummaryRow(SID))?.attemptStatus).toBe("failed");
	});
});
