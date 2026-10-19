/**
 * Who can read launch requests, and what a launch DTO from /launches leaves out.
 *
 * Team mode: a member lists and fetches only the launches they requested; an admin
 * reads all (including unattributed ones); a foreign or unattributed launch answers
 * 404 to a member, exactly like a missing one. Solo mode and auth-disabled: everyone
 * with the manage scope reads all. Every caller, in every mode, gets no claimToken,
 * and list rows carry env keys but not env values.
 *
 * Also covers the create route's idempotency status codes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { launchRequests, supervisors } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

const originalDisableAuth = config.disableAuth;
const SECRET = "s3cret-value-do-not-leak";

beforeAll(async () => {
	await initializeDatabase();
});
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = false;
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
}
beforeEach(reset);
afterEach(reset);

async function seedLaunch(label: string, requestedByUserId: string | null) {
	const id = crypto.randomUUID();
	await getDb()
		.insert(launchRequests)
		.values({
			id,
			launchCorrelationId: crypto.randomUUID(),
			agentType: "claude_code",
			cwd: "/tmp/x",
			taskPrompt: label,
			approvalPolicy: "manual",
			env: { API_TOKEN: SECRET },
			claimToken: `claim-${label}`,
			launchSpec: { env: { API_TOKEN: SECRET }, providerConfig: { cliArgs: [] } },
			requestedByUserId,
		});
	return id;
}

interface Row {
	id: string;
	taskPrompt: string;
	claimToken: string | null;
	env: Record<string, string>;
	launchSpec: { env: Record<string, string> };
	effectivePrivileges: { approvalPolicy: { effective: string } } | null;
}

async function list(headers: Headers) {
	const res = await app.request("/api/v1/launches", { headers });
	expect(res.status).toBe(200);
	return (await res.json()) as { launches: Row[]; total: number };
}

async function detail(id: string, headers: Headers) {
	return app.request(`/api/v1/launches/${id}`, { headers });
}

const prompts = (body: { launches: Row[] }) => body.launches.map((l) => l.taskPrompt).sort();

async function teamWorld() {
	await setStoredMode("team");
	const me = await seedLocalUser("lo-me");
	const other = await seedLocalUser("lo-other");
	const admin = await seedLocalUser("lo-admin", "admin");
	const ids = {
		mine: await seedLaunch("mine", me.id),
		theirs: await seedLaunch("theirs", other.id),
		unowned: await seedLaunch("unowned", null),
	};
	return {
		ids,
		me: await cookieHeadersFor(me.id),
		other: await cookieHeadersFor(other.id),
		admin: await cookieHeadersFor(admin.id),
		meId: me.id,
		adminId: admin.id,
	};
}

describe("team mode: GET /launches", () => {
	test("a member lists only their own launches", async () => {
		const w = await teamWorld();
		const body = await list(w.me);
		expect(prompts(body)).toEqual(["mine"]);
		expect(body.total).toBe(1);
		expect(prompts(await list(w.other))).toEqual(["theirs"]);
	});

	test("an admin lists everyone's, including unattributed launches", async () => {
		const w = await teamWorld();
		const body = await list(w.admin);
		expect(prompts(body)).toEqual(["mine", "theirs", "unowned"]);
		expect(body.total).toBe(3);
	});

	test("a key owned by a member lists that member's; an ownerless manage key lists none; a key owned by an admin lists all", async () => {
		const w = await teamWorld();
		const owned = await seedKey("lo-owned", ["manage"], w.meId);
		expect(prompts(await list(bearerHeaders(owned.key)))).toEqual(["mine"]);
		const ownerless = await seedKey("lo-ownerless", ["manage"], null);
		expect((await list(bearerHeaders(ownerless.key))).launches).toEqual([]);
		const adminKey = await seedKey("lo-admin-key", ["manage"], w.adminId);
		expect(prompts(await list(bearerHeaders(adminKey.key)))).toEqual(["mine", "theirs", "unowned"]);
	});

	test("an ownerless manage key kept on the admin service key list lists all", async () => {
		const w = await teamWorld();
		const key = await seedKey("lo-kept-admin", ["manage"], null);
		await setAdminServiceKeyList([key.id]);
		expect(prompts(await list(bearerHeaders(key.key)))).toEqual(["mine", "theirs", "unowned"]);
		expect(w.ids.mine).toBeTruthy();
	});
});

describe("team mode: GET /launches/:id", () => {
	test("own: 200; someone else's and unattributed: 404 for a member, same body as a missing id", async () => {
		const w = await teamWorld();
		expect((await detail(w.ids.mine, w.me)).status).toBe(200);
		const missing = await detail(crypto.randomUUID(), w.me);
		expect(missing.status).toBe(404);
		for (const id of [w.ids.theirs, w.ids.unowned]) {
			const res = await detail(id, w.me);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual(await missing.clone().json());
		}
	});

	test("an admin reads any launch", async () => {
		const w = await teamWorld();
		for (const id of Object.values(w.ids)) expect((await detail(id, w.admin)).status).toBe(200);
	});

	test("the detail never carries the claim token", async () => {
		const w = await teamWorld();
		for (const [headers, id] of [
			[w.me, w.ids.mine],
			[w.admin, w.ids.theirs],
		] as const) {
			const body = (await (await detail(id, headers)).json()) as { launchRequest: Row };
			expect(body.launchRequest.claimToken).toBeNull();
			expect(JSON.stringify(body)).not.toContain("claim-");
		}
	});
});

describe("solo mode and auth disabled", () => {
	test("solo: every manage caller reads every launch", async () => {
		await setStoredMode("solo");
		const user = await seedLocalUser("lo-solo");
		const a = await seedLaunch("a", user.id);
		await seedLaunch("b", null);
		const key = await seedKey("lo-solo-key", ["manage"], null);
		expect(prompts(await list(bearerHeaders(key.key)))).toEqual(["a", "b"]);
		expect(prompts(await list(await cookieHeadersFor(user.id)))).toEqual(["a", "b"]);
		expect((await detail(a, bearerHeaders(key.key))).status).toBe(200);
	});

	test("auth disabled: everything is readable", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		await seedLaunch("a", null);
		await seedLaunch("b", "someone");
		expect(prompts(await list(new Headers()))).toEqual(["a", "b"]);
	});
});

describe("what list rows leave out", () => {
	test("no claim token and no env values, in the row or its spec, for an admin or an owner, in either mode", async () => {
		for (const mode of ["solo", "team"] as const) {
			await reset();
			await setStoredMode(mode);
			const user = await seedLocalUser("lo-redact", "admin");
			await seedLaunch("r", user.id);
			const body = await list(await cookieHeadersFor(user.id));
			const [row] = body.launches;
			expect(row.claimToken, mode).toBeNull();
			expect(row.env, mode).toEqual({ API_TOKEN: "[redacted]" });
			expect(row.launchSpec.env, mode).toEqual({ API_TOKEN: "[redacted]" });
			expect(JSON.stringify(body), mode).not.toContain(SECRET);
			expect(JSON.stringify(body), mode).not.toContain("claim-");
		}
	});

	test("rows carry the effective privileges derived from the recorded settings", async () => {
		await setStoredMode("solo");
		const user = await seedLocalUser("lo-eff");
		await seedLaunch("e", user.id);
		const [row] = (await list(await cookieHeadersFor(user.id))).launches;
		expect(row.effectivePrivileges?.approvalPolicy.effective).toBe("default");
	});
});

describe("POST /launches idempotency", () => {
	async function seedHost() {
		const now = new Date().toISOString();
		await getDb()
			.insert(supervisors)
			.values({
				id: "lo-host",
				hostName: "lo-host",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: {
					version: 1,
					agentTypes: ["claude_code"],
					launchModes: ["headless"],
					os: "linux",
					terminalSupport: [],
					features: ["enforces_launch_privileges"],
					executables: {
						claude: { available: true, command: "claude", resolvedPath: "/bin/claude" },
					},
				},
				trustedRoots: ["/tmp"],
				status: "connected",
				lastHeartbeatAt: now,
				heartbeatLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				createdAt: now,
				updatedAt: now,
			} as never);
	}

	function body(clientRequestId: string, approvalPolicy: string | null = "manual") {
		const template = {
			name: "t",
			agentType: "claude_code",
			cwd: "/tmp/lo",
			baseInstructions: "",
			taskPrompt: "go",
			model: "m",
			approvalPolicy,
			sandboxMode: null,
			env: { API_TOKEN: SECRET },
		};
		return JSON.stringify({
			template,
			requestedLaunchMode: "headless",
			requestedSupervisorId: "lo-host",
			launchSpec: { version: 1, providerConfig: { command: "claude", cliArgs: [] } },
			metadata: { clientRequestId },
		});
	}

	async function post(headers: Headers, payload: string) {
		const h = new Headers(headers);
		h.set("Content-Type", "application/json");
		return app.request("/api/v1/launches", { method: "POST", headers: h, body: payload });
	}

	test("first create is 201, a repeat is 200 with the same launch and no second row; no claim token either time", async () => {
		await setStoredMode("solo");
		await seedHost();
		const user = await seedLocalUser("lo-post");
		const headers = await cookieHeadersFor(user.id);
		const first = await post(headers, body("req-1"));
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as { launchRequest: Row; idempotentReplay?: boolean };
		expect(firstBody.idempotentReplay).toBeUndefined();
		const second = await post(headers, body("req-1"));
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as { launchRequest: Row; idempotentReplay?: boolean };
		expect(secondBody.idempotentReplay).toBe(true);
		expect(secondBody.launchRequest.id).toBe(firstBody.launchRequest.id);
		expect(secondBody.launchRequest.claimToken).toBeNull();
		expect(await getDb().select().from(launchRequests)).toHaveLength(1);
	});

	test("the same id with different privileges is 409; a refused policy is 400", async () => {
		await setStoredMode("solo");
		await seedHost();
		const user = await seedLocalUser("lo-post2");
		const headers = await cookieHeadersFor(user.id);
		expect((await post(headers, body("req-2"))).status).toBe(201);
		const conflict = await post(headers, body("req-2", "untrusted"));
		expect(conflict.status).toBe(409);
		const refused = await post(headers, body("req-3", "auto"));
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toContain("Approval policy 'auto'");
	});
});

describe("GET /launches paging and SQL scoping", () => {
	test("limit, offset, hasMore and a total that counts only what the caller may read", async () => {
		await setStoredMode("team");
		const me = await seedLocalUser("lo-page");
		const other = await seedLocalUser("lo-page-other");
		for (let i = 0; i < 5; i++) await seedLaunch(`mine-${i}`, me.id);
		for (let i = 0; i < 3; i++) await seedLaunch(`theirs-${i}`, other.id);
		const headers = await cookieHeadersFor(me.id);
		const page1 = (await (await app.request("/api/v1/launches?limit=2", { headers })).json()) as {
			launches: Row[];
			total: number;
			hasMore: boolean;
			limit: number;
			offset: number;
		};
		expect(page1).toMatchObject({ total: 5, hasMore: true, limit: 2, offset: 0 });
		expect(page1.launches).toHaveLength(2);
		const page3 = (await (
			await app.request("/api/v1/launches?limit=2&offset=4", { headers })
		).json()) as typeof page1;
		expect(page3.launches).toHaveLength(1);
		expect(page3.hasMore).toBe(false);
		const seen = new Set<string>();
		for (const offset of [0, 2, 4]) {
			const page = (await (
				await app.request(`/api/v1/launches?limit=2&offset=${offset}`, { headers })
			).json()) as typeof page1;
			for (const row of page.launches) seen.add(row.taskPrompt);
		}
		expect([...seen].sort()).toEqual(["mine-0", "mine-1", "mine-2", "mine-3", "mine-4"]);
	});

	test("the default page is 50 and the cap is 200; a bad value is a 400", async () => {
		await setStoredMode("solo");
		const user = await seedLocalUser("lo-cap");
		const headers = await cookieHeadersFor(user.id);
		const body = (await (await app.request("/api/v1/launches", { headers })).json()) as {
			limit: number;
		};
		expect(body.limit).toBe(50);
		const big = (await (await app.request("/api/v1/launches?limit=9999", { headers })).json()) as {
			limit: number;
		};
		expect(big.limit).toBe(200);
		for (const q of ["limit=0", "limit=abc", "offset=-1", "limit=1.5"]) {
			expect((await app.request(`/api/v1/launches?${q}`, { headers })).status, q).toBe(400);
		}
	});

	test("a caller with no readable scope gets an empty page, not an error", async () => {
		await setStoredMode("team");
		await seedLaunch("x", "someone");
		const ownerless = await seedKey("lo-none", ["manage"], null);
		const body = (await (
			await app.request("/api/v1/launches", { headers: bearerHeaders(ownerless.key) })
		).json()) as {
			launches: Row[];
			total: number;
		};
		expect(body).toMatchObject({ launches: [], total: 0 });
	});
});

describe("POST /launches: client prelaunch actions", () => {
	test("a launchSpec with prelaunchActions is refused with 400 before anything is stored", async () => {
		await setStoredMode("solo");
		const user = await seedLocalUser("lo-pre");
		const headers = new Headers(await cookieHeadersFor(user.id));
		headers.set("Content-Type", "application/json");
		const res = await app.request("/api/v1/launches", {
			method: "POST",
			headers,
			body: JSON.stringify({
				template: { name: "t", agentType: "claude_code", cwd: "/tmp/lo", taskPrompt: "go" },
				requestedLaunchMode: "headless",
				routingPolicy: "first_capable_host",
				launchSpec: {
					version: 1,
					prelaunchActions: [
						{ kind: "clone_repo", url: "https://example.com/x.git", path: "/tmp/lo" },
					],
					providerConfig: { command: "claude", cliArgs: [] },
				},
			}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("prelaunchActions");
		expect(await getDb().select().from(launchRequests)).toHaveLength(0);
	});
});
