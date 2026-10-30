/**
 * Who may do what to which session's HITL request, snooze, delivery and control lock: a generated
 * grid of callers x entry points x targets x modes, with the expected outcome written out as a
 * LITERAL table. Nothing here computes an expectation with `canReadSession` or any other production
 * predicate: the tables below are the specification, and the production rule has to match them.
 *
 * A "deny" cell asserts the refusal (403 with the right code), that the state snapshot is byte-for-byte
 * what it was before, and that no `inbox_changed` frame went out. An "allow" cell asserts the effect.
 * The two inbox reads (E8, E9) don't refuse: for them "deny" means the target's item is absent from a 200.
 *
 * Callers: respond key owned by a member / by an admin / ownerless; manage key owned by a member /
 * ownerless and kept as an admin service key / ownerless and not kept; ingest key; observe key;
 * member and admin cookie; member and admin SSO (forwardauth) session; a supervisor credential; no
 * credential at all; and, in solo only, DISABLE_AUTH.
 *
 * Entry points: E1 proposal decision, E2 inbox decide, E3 batch by hitlIds, E4 batch by sessionIds,
 * E6 retry, E7 delivery read,
 * E8 inbox read, E9 snoozes read, E10 snooze, E11 unsnooze by id, E12 unsnooze by target, E13 the
 * `inbox_changed` frame, and the session-changing routes M4a prompt, M4b stop, M4c watcher PUT,
 * M4d watcher DELETE, M4e control-actions read, M4f retry. E1a and E2a are the approve variants of E1 and
 * E2 (an approve queues a control action and makes a delivery), and E8b is the stuck/risky inbox read.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
	setUserRoleDirectly,
} from "../test-utils/team-fixtures.js";

setDefaultTimeout(180_000);
const TIMEOUT = 180_000;

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const {
	aiActionRequests,
	aiHitlDeliveries,
	aiHitlRequests,
	aiInboxSnoozes,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
	watcherConfigs,
	watcherProposals,
} = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { enableAiRuntime, seedFinishedTurn, seedProposalWithHitl, seedProvider } = await import(
	"../test-utils/watcher-fixtures.js"
);
const { decideHitl, hashPrompt } = await import("../services/ai/hitl-decision-service.js");
const { snoozeItem } = await import("../services/ai/inbox-snooze-service.js");
const { upsertWatcherConfig } = await import("../services/ai/watcher-config-service.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");
const { resolveSsoUser } = await import("../services/user-identity.js");
const { issueSession, SESSION_COOKIE_NAME } = await import("../services/local-auth-service.js");
const intelligence = await import("../services/ai/intelligence-service.js");
const { awaitInboxBroadcastsForTest } = await import("../services/notifier.js");
const { OWNER_CHECKED_ROUTES } = await import("../auth/route-scope-policy.js");
const { handleWsClose, handleWsOpen, sendHeartbeats } = await import("../ws/handler.js");

const PROMPT = "Run the full test suite and fix what fails.";
const SUPERVISOR = "mx-sup";
const PROMPT_SECRET = "mx-prompt-secret";
const ENV_SECRET = "mx-env-secret";

// ── Callers ────────────────────────────────────────────────────────────────

type CallerName =
	| "respondMember"
	| "respondAdmin"
	| "respondOwnerless"
	| "manageMember"
	| "manageKeptAdmin"
	| "manageNotKept"
	| "ingestKey"
	| "observeKey"
	| "cookieMember"
	| "cookieAdmin"
	| "ssoMember"
	| "ssoAdmin"
	| "supervisor"
	| "noCredential"
	| "disableAuth";

const CALLERS: CallerName[] = [
	"respondMember",
	"respondAdmin",
	"respondOwnerless",
	"manageMember",
	"manageKeptAdmin",
	"manageNotKept",
	"ingestKey",
	"observeKey",
	"cookieMember",
	"cookieAdmin",
	"ssoMember",
	"ssoAdmin",
	"supervisor",
	"noCredential",
	"disableAuth",
];

/** Who stands behind a caller, for the ownership rule: a member (alice), an admin, or nobody. */
const IDENTITY: Record<CallerName, "alice" | "admin" | "nobody" | "unreachable"> = {
	respondMember: "alice",
	respondAdmin: "admin",
	respondOwnerless: "nobody",
	manageMember: "alice",
	manageKeptAdmin: "admin",
	manageNotKept: "nobody",
	ingestKey: "unreachable",
	observeKey: "unreachable",
	cookieMember: "alice",
	cookieAdmin: "admin",
	ssoMember: "alice",
	ssoAdmin: "admin",
	supervisor: "unreachable",
	noCredential: "unreachable",
	disableAuth: "unreachable",
};

/** How an unreachable caller is turned away: by the scope gate (403) or by authentication (401). */
const UNREACHABLE_STATUS: Partial<Record<CallerName, number>> = {
	ingestKey: 403,
	observeKey: 403,
	supervisor: 401,
	noCredential: 401,
};

type Entry =
	| "E1 decision"
	| "E2 inbox decide"
	| "E3 batch hitlIds"
	| "E4 batch sessionIds"
	| "E6 retry"
	| "E7 delivery read"
	| "E8 inbox read"
	| "E9 snoozes read"
	| "E10 snooze"
	| "E11 unsnooze by id"
	| "E12 unsnooze by target"
	| "M4a prompt"
	| "M4b stop"
	| "M4c watcher PUT"
	| "M4d watcher DELETE"
	| "E1a decision approve"
	| "E2a inbox decide approve"
	| "E8b inbox read stuck/risky"
	| "M4e control-actions read"
	| "M4f retry"
	| "M4g session detail";

const ENTRIES: Entry[] = [
	"E1 decision",
	"E2 inbox decide",
	"E3 batch hitlIds",
	"E4 batch sessionIds",
	"E6 retry",
	"E7 delivery read",
	"E8 inbox read",
	"E9 snoozes read",
	"E10 snooze",
	"E11 unsnooze by id",
	"E12 unsnooze by target",
	"M4a prompt",
	"M4b stop",
	"M4c watcher PUT",
	"M4d watcher DELETE",
	"E1a decision approve",
	"E2a inbox decide approve",
	"E8b inbox read stuck/risky",
	"M4e control-actions read",
	"M4f retry",
	"M4g session detail",
];

/** The routes each entry exercises, for the coverage check at the end. */
const ENTRY_ROUTES: Record<Entry, string[]> = {
	"E1 decision": ["POST /ai/proposals/:id/decision"],
	"E2 inbox decide": ["POST /ai/inbox/hitl/:id/decide"],
	"E3 batch hitlIds": ["POST /ai/inbox/batch-decline"],
	"E4 batch sessionIds": ["POST /ai/inbox/batch-decline"],
	"E6 retry": ["POST /ai/proposals/:id/delivery/retry"],
	"E7 delivery read": ["GET /ai/proposals/:id/delivery"],
	"E8 inbox read": ["GET /ai/inbox"],
	"E9 snoozes read": ["GET /ai/inbox/snoozes"],
	"E10 snooze": ["POST /ai/inbox/snooze"],
	"E11 unsnooze by id": ["DELETE /ai/inbox/snooze/:id"],
	"E12 unsnooze by target": ["DELETE /ai/inbox/snooze"],
	"M4a prompt": ["POST /sessions/:sessionId/prompt"],
	"M4b stop": ["POST /sessions/:sessionId/stop"],
	"M4c watcher PUT": ["PUT /ai/sessions/:sessionId/watcher"],
	"M4d watcher DELETE": ["DELETE /ai/sessions/:sessionId/watcher"],
	"E1a decision approve": ["POST /ai/proposals/:id/decision"],
	"E2a inbox decide approve": ["POST /ai/inbox/hitl/:id/decide"],
	"E8b inbox read stuck/risky": ["GET /ai/inbox"],
	"M4e control-actions read": ["GET /sessions/:sessionId/control-actions"],
	"M4f retry": ["POST /sessions/:sessionId/retry"],
	// not an owner-checked route: the session itself is shared, and the embed of its control actions is the owner's
	"M4g session detail": [],
};

/**
 * Entries a respond key can't reach at all (manage-only routes): the scope gate answers 403
 * insufficient_scope before any ownership is looked at.
 */
const RESPOND_CANNOT_REACH: ReadonlySet<Entry> = new Set([
	"E2 inbox decide",
	"E3 batch hitlIds",
	"E4 batch sessionIds",
	"M4a prompt",
	"M4b stop",
	"M4c watcher PUT",
	"M4d watcher DELETE",
	"E2a inbox decide approve",
	"M4e control-actions read",
	"M4f retry",
]);
const RESPOND_CALLERS: ReadonlySet<CallerName> = new Set([
	"respondMember",
	"respondAdmin",
	"respondOwnerless",
]);

// ── Targets ────────────────────────────────────────────────────────────────

type Target = "alices" | "bobs" | "unowned" | "norow";
const TARGETS: Target[] = ["alices", "bobs", "unowned", "norow"];

/**
 * Team mode: may this identity change/see a session owned like this? THE TABLE. Rows: who stands behind
 * the caller. Columns: alices, bobs, unowned. (A target with no row is judged separately below.)
 */
const TEAM_MAY: Record<
	"alice" | "admin" | "nobody",
	Record<"alices" | "bobs" | "unowned", boolean>
> = {
	alice: { alices: true, bobs: false, unowned: true },
	admin: { alices: true, bobs: true, unowned: true },
	nobody: { alices: false, bobs: false, unowned: false },
};

// ── Environment ────────────────────────────────────────────────────────────

interface World {
	keyIds: { respondMember: string; respondAdmin: string; respondOwnerless: string };
	headers: Record<Exclude<CallerName, "disableAuth">, Headers>;
	aliceId: string;
	adminId: string;
}
let world: World;
let providerId = "";
const originalDisableAuth = config.disableAuth;

async function wipeDomain() {
	await getDb().delete(aiActionRequests);
	await getDb().delete(aiInboxSnoozes);
	await getDb().delete(aiHitlDeliveries);
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(watcherConfigs);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
	await getDb().delete(events);
	await getDb().delete(sessions);
}

async function buildWorld(mode: "solo" | "team"): Promise<World> {
	await resetIdentityState();
	await clearInstanceSettings();
	await wipeDomain();
	// Alice and the admin are SSO identities, so one person is both the cookie caller and the SSO caller
	// and "alice's session" means the same thing to each.
	const person = async (label: string, role: "user" | "admin") => {
		const resolved = await resolveSsoUser({
			provider: "authentik",
			subject: `mx-${label}`,
			source: "uid",
			username: label,
		});
		if (role === "admin") await setUserRoleDirectly(resolved.id, "admin");
		return resolved;
	};
	const alice = await person("alice", "user");
	await seedLocalUser("mx-bob");
	const admin = await person("admin", "admin");
	const minted: Record<string, string> = {};
	const keyed = async (label: string, scopes: string[], owner: string | null) => {
		const made = await seedKey(`mx-${label}`, scopes, owner);
		minted[label] = made.id;
		return made.key;
	};
	const kept = await seedKey("mx-kept", ["manage"], null);
	await setAdminServiceKeyList([kept.id]);
	await setStoredMode(mode);
	await enableAiRuntime();
	providerId = await seedProvider();

	// The same people signed in through forwardauth.
	const sso = async (label: string, id: string) => {
		const { token } = await issueSession({
			userId: id,
			authSource: "forwardauth",
			ssoSubject: `mx-${label}`,
			ssoUsername: label,
			provider: "authentik",
		});
		return new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${token}` });
	};

	// A real host credential.
	const hostId = crypto.randomUUID();
	await getDb()
		.insert(supervisors)
		.values({ id: hostId, hostName: "mx-host", platform: "linux", arch: "x64", version: "0" });
	const credential = await createSupervisorCredential(hostId, "mx-credential");
	await getDb().delete(supervisors).where(eq(supervisors.id, hostId)); // keep the token, drop the row
	const hostToken = (credential as unknown as { token?: string }).token ?? "aps_invalid";

	const respondMember = bearerHeaders(await keyed("respond-alice", ["respond"], alice.id));
	const respondAdmin = bearerHeaders(await keyed("respond-admin", ["respond"], admin.id));
	const respondOwnerless = bearerHeaders(await keyed("respond-loose", ["respond"], null));
	return {
		aliceId: alice.id,
		adminId: admin.id,
		keyIds: {
			respondMember: minted["respond-alice"] as string,
			respondAdmin: minted["respond-admin"] as string,
			respondOwnerless: minted["respond-loose"] as string,
		},
		headers: {
			respondMember,
			respondAdmin,
			respondOwnerless,
			manageMember: bearerHeaders(await keyed("manage-alice", ["manage"], alice.id)),
			manageKeptAdmin: bearerHeaders(kept.key),
			manageNotKept: bearerHeaders(await keyed("manage-loose", ["manage"], null)),
			ingestKey: bearerHeaders(await keyed("ingest", ["ingest"], null)),
			observeKey: bearerHeaders(await keyed("observe", ["observe"], null)),
			cookieMember: await cookieHeadersFor(alice.id),
			cookieAdmin: await cookieHeadersFor(admin.id),
			ssoMember: await sso("alice", alice.id),
			ssoAdmin: await sso("admin", admin.id),
			supervisor: bearerHeaders(hostToken),
			noCredential: new Headers(),
		},
	};
}

// ── Seeding one cell ───────────────────────────────────────────────────────

interface Cell {
	sessionId: string;
	hitlId: string;
	proposalId: string;
	snoozeId: string | null;
}

const OWNER_OF: Record<Target, "alice" | "bob" | null> = {
	alices: "alice",
	bobs: "bob",
	unowned: null,
	norow: null,
};

async function seedCell(entry: Entry, target: Target): Promise<Cell> {
	await wipeDomain();
	const sessionId = `mx-${target}`;
	const owner = OWNER_OF[target];
	if (target === "norow") {
		return {
			sessionId: "mx-norow",
			hitlId: "mx-no-hitl",
			proposalId: "mx-no-proposal",
			snoozeId: null,
		};
	}
	const ownerUserId = owner === "alice" ? world.aliceId : owner === "bob" ? bobId : null;
	await getDb().insert(sessions).values({
		sessionId,
		displayName: sessionId,
		agentType: "claude_code",
		status: "active",
		lastActivityAt: new Date().toISOString(),
		metadata: {},
		ownerUserId,
	});
	const managed = [
		"E6 retry",
		"E7 delivery read",
		"M4a prompt",
		"M4b stop",
		"E1a decision approve",
		"E2a inbox decide approve",
		"M4e control-actions read",
		"M4f retry",
	].includes(entry);
	if (managed) {
		await getDb()
			.insert(supervisors)
			.values({
				id: SUPERVISOR,
				hostName: "h",
				platform: "linux",
				arch: "x64",
				version: "0",
				enrollmentState: "active",
				heartbeatLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				// A retry is judged as a new launch, so the host has to be one that could take it.
				trustedRoots: ["/tmp"],
				capabilities: {
					version: 1,
					agentTypes: ["claude_code"],
					launchModes: ["headless", "interactive_terminal"],
					os: "linux",
					terminalSupport: ["xterm"],
					features: ["enforces_launch_privileges"],
					executables: {
						claude: { available: true, command: "claude", resolvedPath: "/bin/claude" },
					},
				},
			} as never)
			.onConflictDoNothing();
		const { launchId } = await seedOwnedLaunch(sessionId, SUPERVISOR);
		const now = new Date().toISOString();
		await getDb().insert(managedSessions).values({
			sessionId,
			launchRequestId: launchId,
			supervisorId: SUPERVISOR,
			managedState: "managed",
			createdAt: now,
			updatedAt: now,
		});
	}
	if (entry === "M4e control-actions read" || entry === "M4g session detail") {
		// an action as the queue stores it: the prompt that was sent and the launch's environment
		const now = new Date().toISOString();
		await getDb()
			.insert(controlActions)
			.values({
				sessionId,
				actionType: "prompt",
				requestedBy: "mx",
				status: "queued",
				metadata: { prompt: PROMPT_SECRET, env: { MX_ENV: ENV_SECRET } },
				createdAt: now,
				updatedAt: now,
			});
	}
	const turn = await seedFinishedTurn(sessionId);
	const { proposalId, hitlId } = await seedProposalWithHitl({
		sessionId,
		providerId,
		prompt: PROMPT,
		turnKey: turn.turnKey,
		triggerEventId: turn.stopId,
	});
	let snoozeId: string | null = null;
	if (["E9 snoozes read", "E11 unsnooze by id", "E12 unsnooze by target"].includes(entry)) {
		snoozeId = (
			await snoozeItem({ kind: "hitl", targetId: hitlId, until: new Date(Date.now() + 3_600_000) })
		).id;
	}
	if (entry === "E6 retry" || entry === "E7 delivery read") {
		// Approved by the system itself (a solo admin context), so the delivery exists whoever asks later.
		await decideHitl(
			{ kind: "hitl", hitlId },
			"approve",
			{ promptHash: hashPrompt(PROMPT) },
			{
				actor: { userId: null, label: "system", role: "admin", mode: "solo" },
				source: "session",
				keyId: null,
				scopes: [],
				canCustomPrompt: true,
			},
		);
		if (entry === "E6 retry") {
			await getDb()
				.update(managedSessions)
				.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });
		}
	}
	if (entry === "M4d watcher DELETE" || entry === "M4c watcher PUT") {
		await upsertWatcherConfig({ sessionId, providerId: "p", enabled: false });
	}
	return { sessionId, hitlId, proposalId, snoozeId };
}

let bobId = "";
async function lookupBobId(): Promise<string> {
	const { users } = await import("../db/schema/index.js");
	const rows = await getDb().select({ id: users.id, username: users.username }).from(users);
	return rows.find((r) => r.username.startsWith("mx-bob"))?.id ?? "";
}

// ── Requests ───────────────────────────────────────────────────────────────

async function request(entry: Entry, cell: Cell, headers: Headers): Promise<Response> {
	const call = (method: string, path: string, body?: unknown) =>
		app.request(
			`/api/v1${path}`,
			body === undefined ? { method, headers } : jsonRequest(method, body, headers),
		);
	const { sessionId, hitlId, proposalId, snoozeId } = cell;
	switch (entry) {
		case "E1 decision":
			return call("POST", `/ai/proposals/${proposalId}/decision`, { action: "decline" });
		case "E2 inbox decide":
			return call("POST", `/ai/inbox/hitl/${hitlId}/decide`, { action: "decline" });
		case "E3 batch hitlIds":
			return call("POST", "/ai/inbox/batch-decline", { hitlIds: [hitlId] });
		case "E4 batch sessionIds":
			return call("POST", "/ai/inbox/batch-decline", { sessionIds: [sessionId] });
		case "E6 retry":
			return call("POST", `/ai/proposals/${proposalId}/delivery/retry`, { confirm: true });
		case "E7 delivery read":
			return call("GET", `/ai/proposals/${proposalId}/delivery`);
		case "E8 inbox read":
			return call("GET", "/ai/inbox?kinds=hitl");
		case "E1a decision approve":
			return call("POST", `/ai/proposals/${proposalId}/decision`, {
				action: "approve",
				promptHash: hashPrompt(PROMPT),
			});
		case "E2a inbox decide approve":
			return call("POST", `/ai/inbox/hitl/${hitlId}/decide`, {
				action: "approve",
				promptHash: hashPrompt(PROMPT),
			});
		case "E8b inbox read stuck/risky":
			return call("GET", "/ai/inbox?kinds=stuck,risky");
		case "M4e control-actions read":
			return call("GET", `/sessions/${sessionId}/control-actions`);
		case "M4f retry":
			return call("POST", `/sessions/${sessionId}/retry`, {});
		case "M4g session detail":
			return call("GET", `/sessions/${sessionId}`);
		case "E9 snoozes read":
			return call("GET", "/ai/inbox/snoozes");
		case "E10 snooze":
			return call("POST", "/ai/inbox/snooze", {
				kind: "hitl",
				targetId: hitlId,
				durationMs: 60_000,
			});
		case "E11 unsnooze by id":
			return call("DELETE", `/ai/inbox/snooze/${snoozeId ?? "mx-no-snooze"}`);
		case "E12 unsnooze by target":
			return call("DELETE", `/ai/inbox/snooze?kind=hitl&targetId=${hitlId}`);
		case "M4a prompt":
			return call("POST", `/sessions/${sessionId}/prompt`, { prompt: "hello" });
		case "M4b stop":
			return call("POST", `/sessions/${sessionId}/stop`, {});
		case "M4c watcher PUT":
			return call("PUT", `/ai/sessions/${sessionId}/watcher`, { enabled: true });
		case "M4d watcher DELETE":
			return call("DELETE", `/ai/sessions/${sessionId}/watcher`);
	}
}

// ── State snapshot and effects ─────────────────────────────────────────────

async function snapshot(): Promise<string> {
	const db = getDb();
	const hitl = (await db.select().from(aiHitlRequests)).map((r) => [r.id, r.status]).sort();
	const deliveries = (await db.select().from(aiHitlDeliveries))
		.map((r) => [r.id, r.attempt, r.controlActionId])
		.sort();
	const actions = (await db.select().from(controlActions))
		.map((r) => [r.id, r.status, r.actionType])
		.sort();
	const locks = (await db.select().from(managedSessions))
		.map((r) => [r.sessionId, r.activeControlActionId])
		.sort();
	const snoozes = (await db.select().from(aiInboxSnoozes))
		.map((r) => [r.id, r.snoozedUntil])
		.sort();
	const watchers = (await db.select().from(watcherConfigs))
		.map((r) => [r.sessionId, r.enabled])
		.sort();
	const proposalStates = (await db.select().from(watcherProposals))
		.map((r) => [r.id, r.state])
		.sort();
	const actionRequests = (await db.select().from(aiActionRequests))
		.map((r) => [r.id, r.status])
		.sort();
	const launches = (await db.select().from(launchRequests)).map((r) => r.id).sort();
	const eventCount = (await db.select().from(events)).length;
	return JSON.stringify({
		hitl,
		deliveries,
		actions,
		locks,
		snoozes,
		watchers,
		proposalStates,
		actionRequests,
		launches,
		eventCount,
	});
}

/** What an allowed call must have done, written per entry. */
async function assertEffect(entry: Entry, cell: Cell, res: Response, label: string) {
	const db = getDb();
	const hitlStatus = async () =>
		(await db.select().from(aiHitlRequests).where(eq(aiHitlRequests.id, cell.hitlId)))[0]?.status;
	const snoozes = () => db.select().from(aiInboxSnoozes);
	switch (entry) {
		case "E1 decision":
		case "E2 inbox decide":
		case "E3 batch hitlIds":
			expect({ label, status: await hitlStatus() }).toEqual({ label, status: "declined" });
			break;
		case "E4 batch sessionIds":
			expect({ label, status: await hitlStatus() }).toEqual({ label, status: "superseded" });
			break;
		case "E1a decision approve":
		case "E2a inbox decide approve":
			expect({ label, status: await hitlStatus() }).toEqual({ label, status: "applied" });
			expect({ label, deliveries: (await db.select().from(aiHitlDeliveries)).length }).toEqual({
				label,
				deliveries: 1,
			});
			expect({ label, actions: (await db.select().from(controlActions)).length }).toEqual({
				label,
				actions: 1,
			});
			break;
		case "E8b inbox read stuck/risky": {
			const body = (await res.json()) as { items: Array<{ id: string }> };
			expect({ label, seen: body.items.some((i) => i.id === `stuck:${cell.sessionId}`) }).toEqual({
				label,
				seen: true,
			});
			break;
		}
		case "M4g session detail":
		case "M4e control-actions read": {
			const text = JSON.stringify(await res.json());
			// the owner sees the prompt that was sent; nobody sees the environment it was sent with
			expect({
				label,
				prompt: text.includes(PROMPT_SECRET),
				env: text.includes(ENV_SECRET),
			}).toEqual({
				label,
				prompt: true,
				env: false,
			});
			break;
		}
		case "M4f retry": {
			const text = JSON.stringify(await res.json());
			// the clone is made, and what it was cloned with is not in the answer
			expect({ label, launches: (await db.select().from(launchRequests)).length }).toEqual({
				label,
				launches: 2,
			});
			expect({
				label,
				leaksEnv: text.includes('"env"'),
				leaksClaim: text.includes("claimToken"),
			}).toEqual({
				label,
				leaksEnv: false,
				leaksClaim: false,
			});
			break;
		}
		case "E6 retry":
			expect({ label, actions: (await db.select().from(controlActions)).length }).toEqual({
				label,
				actions: 2,
			});
			break;
		case "E7 delivery read":
			expect({ label, body: (await res.json()) as unknown }).toMatchObject({
				label,
				body: { state: "queued" },
			});
			break;
		case "E8 inbox read": {
			const body = (await res.json()) as { items: Array<{ id: string }> };
			expect({ label, seen: body.items.some((i) => i.id === cell.hitlId) }).toEqual({
				label,
				seen: true,
			});
			break;
		}
		case "E9 snoozes read": {
			const body = (await res.json()) as { snoozes: Array<{ id: string }> };
			expect({ label, seen: body.snoozes.some((s) => s.id === cell.snoozeId) }).toEqual({
				label,
				seen: true,
			});
			break;
		}
		case "E10 snooze":
			expect({ label, rows: (await snoozes()).length }).toEqual({ label, rows: 1 });
			break;
		case "E11 unsnooze by id":
		case "E12 unsnooze by target":
			expect({ label, rows: (await snoozes()).length }).toEqual({ label, rows: 0 });
			break;
		case "M4a prompt":
		case "M4b stop":
			expect({ label, actions: (await db.select().from(controlActions)).length }).toEqual({
				label,
				actions: 1,
			});
			break;
		case "M4c watcher PUT":
			expect({
				label,
				enabled: (
					await db.select().from(watcherConfigs).where(eq(watcherConfigs.sessionId, cell.sessionId))
				)[0]?.enabled,
			}).toEqual({ label, enabled: true });
			break;
		case "M4d watcher DELETE":
			expect({
				label,
				rows: (
					await db.select().from(watcherConfigs).where(eq(watcherConfigs.sessionId, cell.sessionId))
				).length,
			}).toEqual({ label, rows: 0 });
			expect({ label, status: await hitlStatus() }).toEqual({ label, status: "superseded" });
			break;
	}
}

const FILTERS_INSTEAD_OF_REFUSING: ReadonlySet<Entry> = new Set([
	"E8 inbox read",
	"E9 snoozes read",
	"E8b inbox read stuck/risky",
	"M4g session detail",
]);

// ── Expected outcome of a cell: the literal grid ──────────────────────────

type Outcome =
	| { kind: "allow" }
	| { kind: "ownerDeny" } // 403 not_owner
	| { kind: "scopeDeny" } // 403 insufficient_scope
	| { kind: "authDeny"; status: number }
	| { kind: "noop" } // allowed, and there was nothing to change
	| { kind: "notFound"; status: 400 | 404 } // reached the handler, nothing there (the exact status)
	| { kind: "empty200" } // reached the handler, nothing there, and nothing to refuse
	| { kind: "filtered" }; // a read that answers 200 without the target's item

function expected(
	mode: "solo" | "team",
	caller: CallerName,
	entry: Entry,
	target: Target,
): Outcome {
	const identity = IDENTITY[caller];
	if (entry === "M4g session detail") return sessionDetailOutcome(mode, caller, identity, target);
	if (identity === "unreachable") {
		if (caller === "disableAuth")
			return mode === "solo" ? reachedOutcome(mode, "admin", entry, target) : { kind: "allow" };
		return caller in UNREACHABLE_STATUS && UNREACHABLE_STATUS[caller] === 401
			? { kind: "authDeny", status: 401 }
			: { kind: "scopeDeny" };
	}
	if (RESPOND_CALLERS.has(caller) && RESPOND_CANNOT_REACH.has(entry)) return { kind: "scopeDeny" };
	return reachedOutcome(mode, identity, entry, target);
}

/**
 * The session itself is readable by everyone who can read sessions (team reads are shared by design);
 * what is withheld is the embed of its control actions (the prompts sent and the launch environment),
 * which only the owner, an admin, and solo see, and only a key with manage is offered at all.
 */
function sessionDetailOutcome(
	mode: "solo" | "team",
	caller: CallerName,
	identity: (typeof IDENTITY)[CallerName],
	target: Target,
): Outcome {
	if (identity === "unreachable") {
		if (caller === "disableAuth") {
			return target === "norow" ? { kind: "notFound", status: 404 } : { kind: "allow" };
		}
		if (caller === "ingestKey") return { kind: "scopeDeny" };
		if (caller === "supervisor" || caller === "noCredential") {
			return { kind: "authDeny", status: 401 };
		}
		// an observe key reads the session but is never offered the embed
		return target === "norow" ? { kind: "notFound", status: 404 } : { kind: "filtered" };
	}
	if (target === "norow") return { kind: "notFound", status: 404 };
	if (RESPOND_CALLERS.has(caller)) return { kind: "filtered" }; // no manage scope: no embed
	if (mode === "solo") return { kind: "allow" };
	const may =
		TEAM_MAY[identity][target === "alices" ? "alices" : target === "bobs" ? "bobs" : "unowned"];
	return may ? { kind: "allow" } : { kind: "filtered" };
}

function reachedOutcome(
	mode: "solo" | "team",
	identity: "alice" | "admin" | "nobody",
	entry: Entry,
	target: Target,
): Outcome {
	if (target === "norow") {
		// Nothing to find. Decisions and the delivery routes say so; a snooze on a target that is not a
		// session's is an admin's in team mode; the session routes find no managed session.
		switch (entry) {
			case "E1 decision":
			case "E1a decision approve":
			case "E2 inbox decide":
			case "E2a inbox decide approve":
			case "E6 retry":
			case "E7 delivery read":
			case "E11 unsnooze by id":
			case "M4c watcher PUT":
			case "M4d watcher DELETE":
				return { kind: "notFound", status: 404 };
			case "E3 batch hitlIds":
			case "E4 batch sessionIds":
				return { kind: "noop" }; // closes nothing; there is nothing to refuse
			case "E8 inbox read":
			case "E8b inbox read stuck/risky":
			case "E9 snoozes read":
				return { kind: "filtered" };
			case "E10 snooze":
			case "E12 unsnooze by target":
				return mode === "solo" || identity === "admin" ? { kind: "allow" } : { kind: "ownerDeny" };
			case "M4e control-actions read":
				return { kind: "empty200" };
			case "M4a prompt":
			case "M4b stop":
			case "M4f retry":
				return { kind: "notFound", status: 400 }; // the session isn't managed: nothing to queue or clone
		}
	}
	if (mode === "solo") return { kind: "allow" };
	const may =
		TEAM_MAY[identity][target === "alices" ? "alices" : target === "bobs" ? "bobs" : "unowned"];
	if (may) return { kind: "allow" };
	return FILTERS_INSTEAD_OF_REFUSING.has(entry) ? { kind: "filtered" } : { kind: "ownerDeny" };
}

// ── The grid ───────────────────────────────────────────────────────────────

let cellCount = 0;

function headersFor(caller: CallerName): Headers {
	return caller === "disableAuth" ? new Headers() : world.headers[caller];
}

async function runCell(mode: "solo" | "team", caller: CallerName, entry: Entry, target: Target) {
	const label = `${mode}/${caller}/${entry}/${target}`;
	const outcome = expected(mode, caller, entry, target);
	const cell = await seedCell(entry, target);
	const before = await snapshot();
	(config as Record<string, unknown>).disableAuth = caller === "disableAuth";
	let res: Response;
	try {
		res = await request(entry, cell, headersFor(caller));
	} finally {
		(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	}
	await awaitInboxBroadcastsForTest();
	cellCount += 1;

	switch (outcome.kind) {
		case "allow":
			expect({ label, status: res.status < 300 }).toEqual({ label, status: true });
			await assertEffect(entry, cell, res, label);
			break;
		case "empty200":
			expect({ label, status: res.status }).toEqual({ label, status: 200 });
			expect({ label, body: await res.json() }).toEqual({ label, body: { controlActions: [] } });
			expect({ label, same: (await snapshot()) === before }).toEqual({ label, same: true });
			break;
		case "noop":
			expect({ label, status: res.status }).toEqual({ label, status: 200 });
			expect({ label, body: await res.json() }).toMatchObject({ label, body: { closed: 0 } });
			expect({ label, same: (await snapshot()) === before }).toEqual({ label, same: true });
			break;
		case "ownerDeny": {
			expect({ label, status: res.status }).toEqual({ label, status: 403 });
			expect({ label, body: await res.json() }).toMatchObject({
				label,
				body: { error: "not_owner" },
			});
			expect({ label, same: (await snapshot()) === before }).toEqual({ label, same: true });
			break;
		}
		case "scopeDeny":
			expect({ label, status: res.status }).toEqual({ label, status: 403 });
			expect({ label, body: await res.json() }).toMatchObject({
				label,
				body: { error: "insufficient_scope" },
			});
			expect({ label, same: (await snapshot()) === before }).toEqual({ label, same: true });
			break;
		case "authDeny":
			expect({ label, status: res.status }).toEqual({ label, status: outcome.status });
			expect({ label, same: (await snapshot()) === before }).toEqual({ label, same: true });
			break;
		case "notFound":
			expect({ label, status: res.status }).toEqual({ label, status: outcome.status });
			expect({ label, same: (await snapshot()) === before }).toEqual({ label, same: true });
			break;
		case "filtered": {
			expect({ label, status: res.status }).toEqual({ label, status: 200 });
			const text = JSON.stringify(await res.json());
			const marker =
				entry === "E8b inbox read stuck/risky"
					? `stuck:${cell.sessionId}`
					: entry === "M4g session detail"
						? PROMPT_SECRET
						: cell.hitlId;
			expect({ label, itemShown: text.includes(marker) }).toEqual({ label, itemShown: false });
			expect({ label, same: (await snapshot()) === before }).toEqual({ label, same: true });
			break;
		}
	}
}

for (const mode of ["team", "solo"] as const) {
	describe(`the authorization matrix, ${mode} mode`, () => {
		let stuck: { mockRestore(): void };
		beforeAll(async () => {
			await initializeDatabase();
			world = await buildWorld(mode);
			bobId = await lookupBobId();
			// Every session reads as stuck, so the inbox's stuck/risky filter is the only thing deciding who sees it.
			stuck = spyOn(intelligence, "intelligenceForSession").mockImplementation((async () => ({
				health: "stuck",
				reasonCode: "mx_stuck",
				evidence: [],
			})) as never);
		}, TIMEOUT);
		afterEach(() => {
			(config as Record<string, unknown>).disableAuth = originalDisableAuth;
		});
		afterAll(async () => {
			stuck.mockRestore();
			(config as Record<string, unknown>).disableAuth = originalDisableAuth;
			await wipeDomain();
			await resetIdentityState();
			await clearInstanceSettings();
			await upsertSetting("ai.enabled", false, { allowProtected: true });
		}, TIMEOUT);

		for (const entry of ENTRIES) {
			test(
				`${entry}: every caller x every target`,
				async () => {
					for (const caller of CALLERS) {
						// DISABLE_AUTH can't be combined with team mode (team requires auth), so it has no team cells.
						if (caller === "disableAuth" && mode === "team") continue;
						for (const target of TARGETS) await runCell(mode, caller, entry, target);
					}
				},
				TIMEOUT,
			);
		}
	});
}

// ── E13: inbox_changed frames ──────────────────────────────────────────────

interface Frame {
	type: string;
}
async function openSocket(identity: {
	userId: string | null;
	keyId: string | null;
	scopes: string[];
}) {
	const raw: string[] = [];
	const ws = {
		data: { ...identity, profile: identity.scopes.includes("manage") ? "web" : "mobile" },
		send: (m: string) => raw.push(m),
		close: () => undefined,
	};
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	await handleWsOpen(ws as any);
	return {
		frames: () => raw.map((m) => JSON.parse(m) as Frame),
		// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
		close: () => handleWsClose(ws as any),
	};
}

for (const mode of ["team", "solo"] as const) {
	describe(`E13 inbox_changed, ${mode} mode`, () => {
		beforeAll(async () => {
			await initializeDatabase();
			world = await buildWorld(mode);
			bobId = await lookupBobId();
		}, TIMEOUT);

		/** Who hears a change to a session owned like this, written out. */
		const HEARS_TEAM: Record<
			"respondMember" | "respondAdmin" | "respondOwnerless" | "webSocket",
			Record<"alices" | "bobs" | "unowned", boolean>
		> = {
			respondMember: { alices: true, bobs: false, unowned: true },
			respondAdmin: { alices: true, bobs: true, unowned: true },
			respondOwnerless: { alices: false, bobs: false, unowned: false },
			webSocket: { alices: true, bobs: true, unowned: true },
		};

		for (const target of ["alices", "bobs", "unowned"] as const) {
			test(
				`a decision on ${target}'s session: each socket hears it exactly when the table says; a refused one is silent`,
				async () => {
					const keys = world.headers;
					const sockets = {
						respondMember: await openSocket({
							userId: world.aliceId,
							keyId: world.keyIds.respondMember,
							scopes: ["respond"],
						}),
						respondAdmin: await openSocket({
							userId: world.adminId,
							keyId: world.keyIds.respondAdmin,
							scopes: ["respond"],
						}),
						respondOwnerless: await openSocket({
							userId: null,
							keyId: world.keyIds.respondOwnerless,
							scopes: ["respond"],
						}),
						webSocket: await openSocket({ userId: null, keyId: null, scopes: ["manage"] }),
					};
					try {
						const changes = (socket: { frames: () => Frame[] }) =>
							socket.frames().filter((f) => f.type === "inbox_changed").length;
						const beats = (socket: { frames: () => Frame[] }) =>
							socket.frames().filter((f) => f.type === "heartbeat").length;
						const counts = () =>
							Object.fromEntries(
								Object.entries(sockets).map(([name, s]) => [name, [changes(s), beats(s)]]),
							) as Record<string, [number, number]>;

						// 1. a REFUSED decision (an ingest key) sends nothing. Seeding opens a request, which is
						// itself announced, so the count is taken after it settles; the heartbeat that follows is
						// the sentinel that proves every socket was live and in order.
						const refusedCell = await seedCell("E1 decision", target);
						await awaitInboxBroadcastsForTest();
						const base = counts();
						const refused = await request("E1 decision", refusedCell, keys.ingestKey);
						await awaitInboxBroadcastsForTest();
						sendHeartbeats();
						expect(refused.status).toBe(403);
						const afterRefusal = counts();
						for (const name of Object.keys(sockets)) {
							expect({ name, frames: afterRefusal[name] }).toEqual({
								name,
								frames: [
									(base[name] as [number, number])[0],
									(base[name] as [number, number])[1] + 1,
								],
							});
						}

						// 1b. an OWNER-denied decision (team mode: a member deciding someone else's) sends nothing either
						if (mode === "team" && target === "bobs") {
							const deniedCell = await seedCell("E1 decision", target);
							await awaitInboxBroadcastsForTest();
							const baseDenied = counts();
							const denied = await request("E1 decision", deniedCell, keys.cookieMember);
							await awaitInboxBroadcastsForTest();
							sendHeartbeats();
							expect(denied.status).toBe(403);
							expect(await denied.json()).toMatchObject({ error: "not_owner" });
							const afterDenied = counts();
							for (const name of Object.keys(sockets)) {
								expect({ name, frames: afterDenied[name] }).toEqual({
									name,
									frames: [
										(baseDenied[name] as [number, number])[0],
										(baseDenied[name] as [number, number])[1] + 1,
									],
								});
							}
						}

						// 2. a cookie-driven ADMIN decision is heard exactly as the table says
						const cell = await seedCell("E1 decision", target);
						await awaitInboxBroadcastsForTest();
						const before = counts();
						const allowed = await request("E1 decision", cell, keys.cookieAdmin);
						await awaitInboxBroadcastsForTest();
						sendHeartbeats();
						expect(allowed.status).toBe(200);
						const after = counts();
						for (const name of Object.keys(sockets)) {
							const should =
								mode === "solo" ? true : HEARS_TEAM[name as keyof typeof HEARS_TEAM][target];
							expect({
								mode,
								target,
								name,
								heard: (after[name] as [number, number])[0] - (before[name] as [number, number])[0],
								live: (after[name] as [number, number])[1] - (before[name] as [number, number])[1],
							}).toEqual({ mode, target, name, heard: should ? 1 : 0, live: 1 });
						}
					} finally {
						for (const socket of Object.values(sockets)) socket.close();
					}
				},
				TIMEOUT,
			);
		}

		test("an action-request change (admins only) is heard by an admin's respond socket and the dashboard, never a member's", async () => {
			const { createActionRequest } = await import("../services/ai/action-requests-service.js");
			const member = await openSocket({
				userId: world.aliceId,
				keyId: world.keyIds.respondMember,
				scopes: ["respond"],
			});
			const admin = await openSocket({
				userId: world.adminId,
				keyId: world.keyIds.respondAdmin,
				scopes: ["respond"],
			});
			try {
				await createActionRequest({
					kind: "session_stop",
					question: "Stop?",
					payload: { sessionId: "mx-alices", sessionDisplayName: "x" } as never,
					origin: "web",
				});
				await awaitInboxBroadcastsForTest();
				sendHeartbeats();
				const heard = (s: { frames: () => Frame[] }) =>
					s.frames().filter((f) => f.type === "inbox_changed").length;
				expect({ member: heard(member), admin: heard(admin) }).toEqual({
					member: mode === "solo" ? 1 : 0,
					admin: 1,
				});
				await getDb().delete((await import("../db/schema/index.js")).aiActionRequests);
			} finally {
				member.close();
				admin.close();
			}
		});
	});
}

// ── Coverage: every owner-checked route is exercised somewhere ─────────────

describe("coverage", () => {
	const SERVER = join(import.meta.dir, "..");
	/**
	 * Owner-checked routes this matrix does not exercise, each with the suite that does and a marker that
	 * suite must still contain. A route added to OWNER_CHECKED_ROUTES is in neither list until someone
	 * places it, which fails this test; a suite that is renamed or loses its marker fails it too.
	 */
	const COVERED_ELSEWHERE: Record<string, { file: string; marker: string }> = {
		"POST /ai/ask/threads/:id/cancel": { file: "routes/ask-detached.test.ts", marker: "cancel" },
		"POST /ai/action-requests/:id/decide": {
			file: "routes/action-request-approval.test.ts",
			marker: "action-requests",
		},
		"POST /sessions/:sessionId/acknowledge": {
			file: "routes/sessions-respond-ack.test.ts",
			marker: "acknowledge",
		},
		"DELETE /sessions/:sessionId/acknowledge": {
			file: "routes/sessions-respond-ack.test.ts",
			marker: "acknowledge",
		},
		"PUT /sessions/:sessionId/archive": {
			file: "routes/sessions-team-gate.test.ts",
			marker: "archive",
		},
		"PUT /sessions/:sessionId/rename": {
			file: "routes/sessions-team-gate.test.ts",
			marker: "rename",
		},
		"PUT /sessions/:sessionId/pin": { file: "routes/sessions-team-gate.test.ts", marker: "/pin" },
		"PUT /sessions/:sessionId/notes": {
			file: "routes/sessions-team-gate.test.ts",
			marker: "notes",
		},
		"PUT /sessions/:sessionId/claude-md": {
			file: "routes/sessions-team-gate.test.ts",
			marker: "claude-md",
		},
		"DELETE /sessions/:sessionId": { file: "routes/sessions-team-gate.test.ts", marker: "DELETE" },
		"PUT /sessions/:sessionId/native-name": {
			file: "routes/sessions-native-name-scope.test.ts",
			marker: "native-name",
		},
		"GET /api-keys/:id": { file: "routes/api-keys-team.test.ts", marker: "api-keys" },
		"DELETE /api-keys/:id": { file: "routes/api-keys-team.test.ts", marker: "api-keys" },
		"POST /api-keys": { file: "routes/api-keys-team.test.ts", marker: "api-keys" },
		"PUT /settings": { file: "routes/settings-team.test.ts", marker: "settings" },
		"POST /admin/supervisors/:id/rotate": {
			file: "routes/supervisors-team.test.ts",
			marker: "rotate",
		},
		"POST /admin/supervisors/:id/revoke": {
			file: "routes/supervisors-team.test.ts",
			marker: "revoke",
		},
		"POST /devices": { file: "routes/devices.test.ts", marker: "/devices" },
		"PATCH /devices/:id": { file: "routes/devices.test.ts", marker: "PATCH" },
		"DELETE /devices/:id": { file: "routes/devices.test.ts", marker: "DELETE" },
		"POST /devices/:id/test": { file: "routes/devices.test.ts", marker: "/test" },
		"POST /devices/:id/activities": {
			file: "services/push/live-activity-routes.test.ts",
			marker: "activities",
		},
		"DELETE /devices/:id/activities/:sessionId": {
			file: "services/push/live-activity-routes.test.ts",
			marker: "activities",
		},
		// A Telegram chat is not one of this grid's callers: channels.ts judges the chat and the channel's owner
		// (channels-hitl.test.ts, channels-ownership.test.ts).
		"GET /channels/:id": { file: "routes/channels-ownership.test.ts", marker: "GET" },
		"GET /channels/:id/stats": { file: "routes/channels-ownership.test.ts", marker: "/stats" },
		"DELETE /channels/:id": { file: "routes/channels-ownership.test.ts", marker: "DELETE" },
		"PATCH /channels/:id/config": { file: "routes/channels-ownership.test.ts", marker: "/config" },
		"POST /channels/:id/test": { file: "routes/channels-ownership.test.ts", marker: "/test" },
		"POST /channels/:id/relink": { file: "routes/channels-ownership.test.ts", marker: "relink" },
		"GET /ai/ask/threads": {
			file: "routes/ask-thread-owner.test.ts",
			// the respond-key rows (admin, solo, owner, ownerless; D74) live in the second describe
			marker: "a respond key lists only the threads it asked",
		},
		"GET /ai/ask/threads/:id": {
			file: "routes/ask-thread-owner.test.ts",
			marker: "read (GET /ai/ask/threads/:id)",
		},
		"DELETE /ai/ask/threads/:id": {
			file: "routes/ask-thread-owner.test.ts",
			marker: "archive (DELETE /ai/ask/threads/:id)",
		},
	};

	test("every route in OWNER_CHECKED_ROUTES is either an entry of the matrix or named as covered by another suite", () => {
		const inMatrix = new Set(Object.values(ENTRY_ROUTES).flat());
		const unplaced = [...OWNER_CHECKED_ROUTES].filter(
			(route) => !inMatrix.has(route) && !(route in COVERED_ELSEWHERE),
		);
		expect(unplaced).toEqual([]);
		// and nothing named here has gone missing from the policy
		const stale = [...inMatrix, ...Object.keys(COVERED_ELSEWHERE)].filter(
			(route) => !OWNER_CHECKED_ROUTES.has(route),
		);
		expect(stale).toEqual([]);
	});

	test("every suite named as covering a route exists and still mentions what it is named for", () => {
		const problems: string[] = [];
		for (const [route, { file, marker }] of Object.entries(COVERED_ELSEWHERE)) {
			const path = join(SERVER, file);
			if (!existsSync(path)) problems.push(`${route}: ${file} is gone`);
			else if (!readFileSync(path, "utf8").includes(marker))
				problems.push(`${route}: ${file} no longer mentions '${marker}'`);
		}
		expect(problems).toEqual([]);
	});

	test("the shape of the matrix is pinned: callers, entries, targets, and entries <-> routes", () => {
		expect(CALLERS).toHaveLength(15);
		expect(ENTRIES).toHaveLength(21);
		expect(TARGETS).toHaveLength(4);
		expect(Object.keys(ENTRY_ROUTES).sort()).toEqual([...ENTRIES].sort());
		expect(new Set(ENTRIES).size).toBe(ENTRIES.length);
	});

	test("the matrix exercised a real population of cells: exactly entries x targets x callers, with no DISABLE_AUTH cell in team mode", () => {
		// 21 entries x 4 targets x (14 callers in team mode + 15 in solo)
		expect(cellCount).toBe(21 * 4 * (14 + 15));
		expect(cellCount).toBe(2436);
	});

	test("hashPrompt is the same function the decisions check (guards the import used by this file)", () => {
		expect(hashPrompt(PROMPT)).toBe(
			"4d43c48e2ed117498f546bbc902aec050ce7142aa40ea3546bbcafd3cc6ed2c6",
		);
	});
});
