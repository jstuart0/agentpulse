/**
 * Exclude rule x team mode, on the supervisor routes.
 *
 * The supervisor's report gate talks to the real app through its injected
 * request function (the routes a real supervisor calls), in solo and in team
 * mode, and these tests pin what the ownership model makes of what the gate
 * does:
 *
 *  - the one contentless closing report for a session that becomes excluded
 *    does not create a row that doesn't exist, passes the owner-of-record and
 *    host-of-record checks for an owned session, and sets or changes no owner;
 *  - a launch refused because its directory is excluded leaves exactly what a
 *    launch refused for the host's trusted roots leaves, and another team
 *    member reading the launch learns nothing the other refusal wouldn't tell;
 *  - the heartbeat flag on a member-owned host is host data like any other:
 *    visible to every signed-in user, and it changes nothing about ownership.
 *
 * Nothing leaves the process. They run on whichever database the suite is
 * pointed at (SQLite by default, Postgres under DATABASE_URL).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { mapLaunchRequest } = await import("../services/launch-validator.js");
const { createLaunchDispatcher } = await import("../../supervisor/launch-dispatch.js");
const { PrelaunchError } = await import("../../supervisor/services/prelaunch-actions.js");
const { createReportGate, LAUNCH_REFUSED_MESSAGE, LAUNCH_REFUSED_CODE } = await import(
	"../../supervisor/services/report-gate.js"
);

const originalDisableAuth = config.disableAuth;

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
	await getDb().delete(events);
	await getDb().delete(managedSessions);
	await getDb().delete(sessions);
	await getDb().delete(launchRequests);
}
beforeEach(reset);
afterEach(reset);

type Supervisor = { id: string; credential: string };

/** A host registered through the real route; `ownerUserId` is the user whose enrollment token it used. */
async function registerHost(ownerUserId: string | null): Promise<Supervisor> {
	const { token } = await createSupervisorEnrollmentToken(
		`xo-${crypto.randomUUID()}`,
		null,
		null,
		ownerUserId,
	);
	const id = crypto.randomUUID();
	const res = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "xo-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken: token,
			id,
		}),
	});
	expect(res.status).toBe(200);
	return {
		id,
		credential: ((await res.json()) as { supervisorCredential: string }).supervisorCredential,
	};
}

function world() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ap-xo-supervisor-")));
	const trusted = join(home, "trusted");
	const work = join(trusted, "secret-project");
	const open = join(trusted, "open-project");
	mkdirSync(work, { recursive: true });
	mkdirSync(open, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	let version = 0;
	const writeRules = (lines: string[]) => {
		const file = join(home, ".agentpulse", "exclude");
		writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
		version++;
		const at = new Date(Date.now() + version * 1000);
		utimesSync(file, at, at);
	};
	return {
		home,
		trusted,
		work,
		open,
		writeRules,
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
}

/** What the gate posted, for the sequence assertions. */
type Posted = { path: string; body: unknown };

function gateFor(w: ReturnType<typeof world>, supervisor: Supervisor, posted: Posted[] = []) {
	const request = async (path: string, options?: RequestInit) => {
		posted.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined });
		const res = await app.request(`/api/v1${path}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisor.credential,
			},
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
		return res.json();
	};
	return createReportGate({
		request,
		supervisorId: supervisor.id,
		home: w.home,
		now: () => Date.now(),
		log: () => {},
	});
}

const sessionRow = async (id: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];
const managedRow = async (id: string) =>
	(await getDb().select().from(managedSessions).where(eq(managedSessions.sessionId, id)))[0];
const eventCount = async (id: string) =>
	(await getDb().select().from(events).where(eq(events.sessionId, id))).length;

async function readJson(path: string, headers: Headers) {
	const res = await app.request(`/api/v1${path}`, { headers });
	expect({ path, status: res.status }).toEqual({ path, status: 200 });
	return res.json();
}

/**
 * A managed session as the first report creates it. In team mode the session's
 * owner is the host's owner; `launchRequester` names a different member on the
 * launch record, to show that the closing report cannot hand the session to them.
 */
async function reportManagedSession(
	gate: ReturnType<typeof gateFor>,
	supervisor: Supervisor,
	w: ReturnType<typeof world>,
	sessionId: string,
	launchRequester: string | null,
) {
	await seedOwnedLaunch(sessionId, supervisor.id);
	if (launchRequester) {
		await getDb()
			.update(launchRequests)
			.set({ requestedByUserId: launchRequester })
			.where(eq(launchRequests.launchCorrelationId, sessionId));
	}
	gate.noteCwd(sessionId, w.work);
	await gate.reportState({
		sessionId,
		agentType: "claude_code",
		cwd: w.work,
		model: "model-xyz",
		desiredThreadTitle: "a private title",
		status: "active",
		managedState: "headless",
		metadata: { note: "private note" },
	});
	await gate.reportEvents(sessionId, [
		{ eventType: "HeadlessTaskStarted", category: "system_event", content: "started" },
	]);
}

for (const mode of ["solo", "team"] as const) {
	describe(`${mode}: a managed session whose directory becomes excluded`, () => {
		async function setup() {
			if (mode === "team") await setStoredMode("team");
			const host = await seedLocalUser("xo-host-owner");
			const requester = await seedLocalUser("xo-launch-requester");
			// Solo hosts are enrolled with no user; a team host belongs to its enroller.
			const supervisor = await registerHost(mode === "team" ? host.id : null);
			return { host, requester, supervisor };
		}

		test("the closing report passes the owner-of-record and host-of-record checks, creates nothing, and leaves the owner exactly as it was", async () => {
			const w = world();
			try {
				const { host, requester, supervisor } = await setup();
				const gate = gateFor(w, supervisor);
				const sessionId = `xo-${crypto.randomUUID()}`;
				await reportManagedSession(gate, supervisor, w, sessionId, requester.id);

				const before = await sessionRow(sessionId);
				const managedBefore = await managedRow(sessionId);
				const eventsBefore = await eventCount(sessionId);
				const expectedOwner = mode === "team" ? host.id : null;
				expect(before?.ownerUserId).toBe(expectedOwner);
				expect(managedBefore?.supervisorId).toBe(supervisor.id);

				w.writeRules([join(w.home, "trusted")]);
				await gate.scan();

				const after = await sessionRow(sessionId);
				// The report was accepted (a rejected one would leave the session live).
				expect(after?.status).toBe("completed");
				expect((await managedRow(sessionId))?.managedState).toBe("stopped");
				expect((await managedRow(sessionId))?.supervisorId).toBe(supervisor.id);
				// Nothing was set or changed: not the owner, not the key, not anything it had.
				expect(after?.ownerUserId).toBe(expectedOwner);
				expect(after?.ingestKeyId).toBe(before?.ingestKeyId);
				expect(after?.cwd).toBe(before?.cwd);
				expect(after?.displayName).toBe(before?.displayName);
				expect(after?.metadata).toEqual(before?.metadata);
				expect(await eventCount(sessionId)).toBe(eventsBefore);

				if (mode === "team") {
					// In the owner's view it is finished, not working or waiting.
					const headers = await cookieHeadersFor(host.id);
					const completed = (await readJson(
						"/sessions?owner=me&tab=completed&limit=100",
						headers,
					)) as { sessions: Array<{ sessionId: string }> };
					expect(completed.sessions.map((s) => s.sessionId)).toContain(sessionId);
					const stats = (await readJson("/sessions/stats?owner=me", headers)) as {
						operational: { working: number; waiting: number };
					};
					expect(stats.operational.working).toBe(0);
					expect(stats.operational.waiting).toBe(0);
				}
			} finally {
				w.cleanup();
			}
		});

		test("a session that was never reported leaves no session row, no managed row and no events, and no owner is made for it", async () => {
			const w = world();
			try {
				const { requester, supervisor } = await setup();
				const gate = gateFor(w, supervisor);
				const sessionId = `xo-${crypto.randomUUID()}`;
				await seedOwnedLaunch(sessionId, supervisor.id);
				await getDb()
					.update(launchRequests)
					.set({ requestedByUserId: requester.id })
					.where(eq(launchRequests.launchCorrelationId, sessionId));
				w.writeRules([join(w.home, "trusted")]);

				gate.noteCwd(sessionId, w.work);
				await gate.reportState({
					sessionId,
					cwd: w.work,
					status: "active",
					managedState: "headless",
				});
				await gate.reportEvents(sessionId, [
					{ eventType: "x", category: "system_event", content: "private" },
				]);
				await gate.scan();

				expect(await sessionRow(sessionId)).toBeUndefined();
				expect(await managedRow(sessionId)).toBeUndefined();
				expect(await eventCount(sessionId)).toBe(0);
			} finally {
				w.cleanup();
			}
		});
	});
}

describe("team mode: an excluded launch's refusal", () => {
	const SECRET_ROOTS_PATH = "/private/secret/dir";

	type Launch = ReturnType<typeof mapLaunchRequest>;

	async function seedLaunch(
		supervisor: Supervisor,
		requesterId: string,
		cwd: string,
		correlationId: string,
		withActions: boolean,
	): Promise<Launch> {
		const [row] = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: correlationId,
				agentType: "claude_code",
				cwd,
				requestedLaunchMode: "headless",
				requestedSupervisorId: supervisor.id,
				claimedBySupervisorId: supervisor.id,
				requestedByUserId: requesterId,
				status: "claimed",
				launchSpec: withActions
					? { prelaunchActions: [{ kind: "scaffold_workarea", path: cwd }] }
					: {},
			})
			.returning();
		return mapLaunchRequest(row as never);
	}

	function dispatcherFor(
		w: ReturnType<typeof world>,
		supervisor: Supervisor,
		posted: Posted[],
		opts: { prelaunchRefusesRoots?: boolean } = {},
	) {
		const ran: string[] = [];
		const never = async () => {
			ran.push("provider");
			throw new Error("a refused launch must not reach a provider");
		};
		const dispatch = createLaunchDispatcher({
			gate: gateFor(w, supervisor, posted),
			trustedRoots: [w.trusted],
			providers: {
				launchManagedCodex: never,
				launchClaudeHeadless: never,
				launchClaudeInteractive: never,
			} as never,
			executePrelaunchActions: (async () => {
				ran.push("prelaunch");
				if (opts.prelaunchRefusesRoots) {
					throw new PrelaunchError(
						LAUNCH_REFUSED_CODE,
						`Path ${SECRET_ROOTS_PATH} is not under any trusted root.`,
						SECRET_ROOTS_PATH,
					);
				}
			}) as never,
			log: () => {},
			warn: () => {},
		});
		return { dispatch, ran };
	}

	/** What another member sees when they open the launch. */
	async function seenBy(viewer: Headers, launchId: string) {
		const body = (await readJson(`/launches/${launchId}`, viewer)) as { launchRequest: Launch };
		return body.launchRequest;
	}

	const refusalFields = (l: Launch) => ({
		status: l.status,
		error: l.error,
		providerLaunchMetadata: l.providerLaunchMetadata,
		pid: l.pid,
		agentType: l.agentType,
		requestedLaunchMode: l.requestedLaunchMode,
	});

	test("with or without prelaunch actions it is one fixed status, and it is the same one a trusted-roots refusal leaves, as another member sees it", async () => {
		await setStoredMode("team");
		const requester = await seedLocalUser("xo-requester");
		const member = await seedLocalUser("xo-member");
		const memberView = await cookieHeadersFor(member.id);
		const w = world();
		try {
			const supervisor = await registerHost(requester.id);

			// Rules exist for both cases (a trusted-roots refusal while rules exist is the generic one too).
			w.writeRules([w.work]);

			const noActions = await seedLaunch(supervisor, requester.id, w.work, "xo-no-actions", false);
			const noActionsPosted: Posted[] = [];
			const noActionsRun = dispatcherFor(w, supervisor, noActionsPosted);
			await noActionsRun.dispatch(noActions);

			const withActions = await seedLaunch(supervisor, requester.id, w.work, "xo-actions", true);
			const withActionsPosted: Posted[] = [];
			const withActionsRun = dispatcherFor(w, supervisor, withActionsPosted);
			await withActionsRun.dispatch(withActions);

			const rootsRefused = await seedLaunch(supervisor, requester.id, w.open, "xo-roots", true);
			const rootsPosted: Posted[] = [];
			const rootsRun = dispatcherFor(w, supervisor, rootsPosted, { prelaunchRefusesRoots: true });
			await rootsRun.dispatch(rootsRefused);

			// The path names the launch; everything else about what was posted must match.
			const shape = (posted: Posted[], launch: Launch) =>
				posted.map((p) => ({ ...p, path: p.path.replace(launch.id, ":launch") }));

			// Excluded: one status, whatever the launch carried; nothing ran.
			expect(noActionsPosted).toHaveLength(1);
			expect(shape(withActionsPosted, withActions)).toEqual(shape(noActionsPosted, noActions));
			expect(noActionsRun.ran).toEqual([]);
			expect(withActionsRun.ran).toEqual([]);
			// Trusted-roots refusal: launching first (as always), then the same final status.
			expect(rootsPosted).toHaveLength(2);
			const finalRoots = shape(rootsPosted, rootsRefused).at(-1);
			const onlyExcluded = shape(noActionsPosted, noActions)[0];
			expect(finalRoots).toEqual(onlyExcluded);
			expect(JSON.stringify(finalRoots)).toBe(JSON.stringify(onlyExcluded));

			const seenNoActions = await seenBy(memberView, noActions.id);
			const seenWithActions = await seenBy(memberView, withActions.id);
			const seenRoots = await seenBy(memberView, rootsRefused.id);
			expect(refusalFields(seenNoActions)).toEqual(refusalFields(seenRoots));
			expect(refusalFields(seenWithActions)).toEqual(refusalFields(seenRoots));
			expect(seenRoots.status).toBe("failed");
			expect(seenRoots.error).toBe(LAUNCH_REFUSED_MESSAGE);
			expect(Object.keys(seenNoActions).sort()).toEqual(Object.keys(seenRoots).sort());

			// Whatever the refusal stored says nothing about why: no rule, no rules directory, no word for it.
			for (const seen of [seenNoActions, seenWithActions]) {
				const stored = JSON.stringify([
					seen.status,
					seen.error,
					seen.providerLaunchMetadata,
					seen.validationSummary,
					seen.metadata,
				]);
				expect(stored.toLowerCase()).not.toContain("exclu");
				expect(stored).not.toContain("secret-project");
				expect(stored).not.toContain(w.home);
				expect(stored).not.toContain(SECRET_ROOTS_PATH);
			}
			// And the member sees no more about the excluded launch than about the other one: the same keys.
			expect(Object.keys(seenWithActions).sort()).toEqual(Object.keys(seenRoots).sort());
		} finally {
			w.cleanup();
		}
	});

	test("the refusal changes nothing about the launch's owner, the session list or the host's owner", async () => {
		await setStoredMode("team");
		const requester = await seedLocalUser("xo-requester-2");
		const w = world();
		try {
			const supervisor = await registerHost(requester.id);
			w.writeRules([w.work]);
			const launch = await seedLaunch(supervisor, requester.id, w.work, "xo-owner", true);
			await dispatcherFor(w, supervisor, []).dispatch(launch);

			const [launchRow] = await getDb()
				.select()
				.from(launchRequests)
				.where(eq(launchRequests.id, launch.id));
			expect(launchRow?.requestedByUserId).toBe(requester.id);
			expect(launchRow?.status).toBe("failed");
			expect(await sessionRow("xo-owner")).toBeUndefined();
			const [host] = await getDb()
				.select()
				.from(supervisors)
				.where(eq(supervisors.id, supervisor.id));
			expect(host?.ownerUserId).toBe(requester.id);
		} finally {
			w.cleanup();
		}
	});
});

describe("team mode: the heartbeat flag on a member-owned host", () => {
	function heartbeat(supervisor: Supervisor, body?: string) {
		return app.request(`/api/v1/supervisors/${supervisor.id}/heartbeat`, {
			method: "POST",
			headers: {
				"X-AgentPulse-Supervisor-Token": supervisor.credential,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body }),
		});
	}

	type HostDto = { id: string; ownerUserId: string | null; excludeRulesState?: string | null };

	async function listAs(userId: string): Promise<HostDto[]> {
		const body = (await readJson("/admin/supervisors", await cookieHeadersFor(userId))) as {
			supervisors: HostDto[];
		};
		return body.supervisors;
	}

	test("every signed-in user sees it on the host list, and the owner field is the same for all of them", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("xo-hb-owner");
		const member = await seedLocalUser("xo-hb-member");
		const admin = await seedLocalUser("xo-hb-admin", "admin");
		const supervisor = await registerHost(owner.id);

		expect(
			(await heartbeat(supervisor, JSON.stringify({ excludeRulesState: "invalid" }))).status,
		).toBe(200);

		for (const viewer of [owner, member, admin]) {
			const host = (await listAs(viewer.id)).find((h) => h.id === supervisor.id);
			expect({ viewer: viewer.id, state: host?.excludeRulesState }).toEqual({
				viewer: viewer.id,
				state: "invalid",
			});
			expect(host?.ownerUserId).toBe(owner.id);
		}
		const [stored] = await getDb()
			.select()
			.from(supervisors)
			.where(eq(supervisors.id, supervisor.id));
		expect(stored?.ownerUserId).toBe(owner.id);

		// A heartbeat with no body clears it for everybody, and still changes no owner.
		expect((await heartbeat(supervisor)).status).toBe(200);
		for (const viewer of [owner, member, admin]) {
			const host = (await listAs(viewer.id)).find((h) => h.id === supervisor.id);
			expect(host?.excludeRulesState ?? null).toBeNull();
			expect(host?.ownerUserId).toBe(owner.id);
		}
	});

	test("an unowned host and a second member's host are unaffected by the first host's flag", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("xo-hb-owner-2");
		const other = await seedLocalUser("xo-hb-other");
		const flagged = await registerHost(owner.id);
		const clean = await registerHost(other.id);
		const unowned = await registerHost(null);

		await heartbeat(flagged, JSON.stringify({ excludeRulesState: "invalid" }));

		const hosts = await listAs(other.id);
		const byId = new Map(hosts.map((h) => [h.id, h]));
		expect(byId.get(flagged.id)?.excludeRulesState).toBe("invalid");
		expect(byId.get(clean.id)?.excludeRulesState ?? null).toBeNull();
		expect(byId.get(unowned.id)?.excludeRulesState ?? null).toBeNull();
		expect(byId.get(flagged.id)?.ownerUserId).toBe(owner.id);
		expect(byId.get(clean.id)?.ownerUserId).toBe(other.id);
		expect(byId.get(unowned.id)?.ownerUserId).toBeNull();
	});

	test("re-registering the host clears the flag in the same write and leaves its owner alone", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("xo-hb-owner-3");
		const supervisor = await registerHost(owner.id);
		await heartbeat(supervisor, JSON.stringify({ excludeRulesState: "invalid" }));
		expect((await listAs(owner.id)).find((h) => h.id === supervisor.id)?.excludeRulesState).toBe(
			"invalid",
		);

		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisor.credential,
			},
			body: JSON.stringify({
				id: supervisor.id,
				hostName: "xo-host",
				platform: "linux",
				arch: "x64",
				version: "1.0.1",
			}),
		});
		expect(res.status).toBe(200);
		const host = (await listAs(owner.id)).find((h) => h.id === supervisor.id);
		expect(host?.excludeRulesState ?? null).toBeNull();
		expect(host?.ownerUserId).toBe(owner.id);
	});
});
