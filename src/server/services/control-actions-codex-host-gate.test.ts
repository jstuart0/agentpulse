/**
 * AGEN-91 phase 3 (D7): a supervisor that predates `codex_follow_up_prompts` sends a Codex prompt down
 * the Claude path (it may spawn `claude --resume <uuid>` in the launch directory). The server therefore
 * never hands one over: it refuses at enqueue (`host_upgrade_required`) and, for a prompt queued before
 * the host re-registered or by an older server, fails it at claim time.
 *
 * Real database, real routes, real register route; nothing is mocked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import { CODEX_FOLLOW_UP_PROMPTS } from "../../shared/constants.js";
import { countDbCalls } from "../test-utils/db-call-counter.js";
import {
	clearSetting,
	enableAiRuntime,
	seedFinishedTurn,
	seedLiveManagedSession,
	seedProposalWithHitl,
	seedProvider,
	sha256,
} from "../test-utils/watcher-fixtures.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { app } = await import("../app.js");
const schema = await import("../db/schema/index.js");
const {
	aiHitlRequests,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	supervisorEnrollmentTokens,
	supervisors,
	watcherConfigs,
	watcherProposals,
} = schema;
const {
	HostUpgradeRequiredError,
	LaunchMismatchError,
	claimNextControlAction,
	enqueuePromptInTx,
	queuePromptAction,
} = await import("./control-actions.js");
const { promptDeliverability } = await import("./ai/prompt-deliverability.js");
const { AI_ACTOR, dispatchPrompt, resolveProposal } = await import("./ai/proposal-resolution.js");
const feature = await import("./ai/feature.js");
const { withAdminLock } = await import("../db/admin-lock.js");
const { deleteAllSupervisors } = await import("./__test_supervisors.js");

/** The sentence every reader of this refusal carries (the plan's copy, D7). */
const UPGRADE_COPY =
	"This session's host is running an older supervisor that can't send prompts to Codex. Update the supervisor on that host.";
const ACTOR = { userId: null, label: "user" } as const;
const originalDisableAuth = config.disableAuth;

const capsWith = (features: unknown) => ({
	version: 1,
	agentTypes: ["claude_code", "codex_cli"],
	launchModes: ["headless", "managed_codex"],
	os: "linux",
	terminalSupport: [],
	features,
});
const WITH_FEATURE = capsWith([CODEX_FOLLOW_UP_PROMPTS]);
const WITHOUT_FEATURE = capsWith([]);

let counter = 0;
let providerId = "";

beforeAll(() => initializeDatabase());
afterAll(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await reset();
});

async function reset() {
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(watcherConfigs);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(supervisorEnrollmentTokens);
	await deleteAllSupervisors();
	await clearSetting(feature.AI_KILL_SWITCH_KEY);
}
beforeEach(async () => {
	await reset();
	(config as Record<string, unknown>).disableAuth = true;
	await enableAiRuntime();
	providerId = await seedProvider();
});
afterEach(reset);

interface World {
	sessionId: string;
	supervisorId: string;
}

/** A managed session on a live host whose capabilities are exactly `caps` (any stored value, valid or not). */
async function world(
	agent: "codex_cli" | "claude_code",
	caps: unknown,
	over: { supervisor?: "live" | "offline" } = {},
): Promise<World> {
	counter += 1;
	const sessionId = `hg-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	const { supervisorId } = await seedLiveManagedSession(sessionId, { supervisor: over.supervisor });
	await setCaps(supervisorId, caps);
	await setAgent(sessionId, agent);
	return { sessionId, supervisorId };
}

async function setCaps(supervisorId: string, caps: unknown) {
	await getDb()
		.update(supervisors)
		.set({ capabilities: caps as Record<string, unknown> })
		.where(eq(supervisors.id, supervisorId));
}
async function setAgent(sessionId: string, agent: string, which: "both" | "launch" = "both") {
	if (which === "both") {
		await getDb().update(sessions).set({ agentType: agent }).where(eq(sessions.sessionId, sessionId));
	}
	await getDb()
		.update(launchRequests)
		.set({
			agentType: agent,
			requestedLaunchMode: agent === "codex_cli" ? "managed_codex" : "headless",
		})
		.where(eq(launchRequests.launchCorrelationId, sessionId));
}

const promptRows = (sessionId: string) =>
	getDb().select().from(controlActions).where(eq(controlActions.sessionId, sessionId));
const lockOf = async (sessionId: string) => {
	const [row] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	return { id: row?.activeControlActionId ?? null, expires: row?.controlLockExpiresAt ?? null };
};
const postPrompt = (sessionId: string, prompt = "next step") =>
	app.request(`/api/v1/sessions/${sessionId}/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt }),
	});

describe("POST /sessions/:id/prompt", () => {
	test("a Codex session on a host without the feature is 409 host_upgrade_required, with no action and no lock", async () => {
		const w = await world("codex_cli", WITHOUT_FEATURE);
		const res = await postPrompt(w.sessionId);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "host_upgrade_required", message: UPGRADE_COPY });
		expect(await promptRows(w.sessionId)).toEqual([]);
		expect(await lockOf(w.sessionId)).toEqual({ id: null, expires: null });
	});

	test("with the feature advertised it is 202", async () => {
		const w = await world("codex_cli", WITH_FEATURE);
		const res = await postPrompt(w.sessionId);
		expect(res.status).toBe(202);
		expect(await promptRows(w.sessionId)).toHaveLength(1);
	});

	test("a Claude session on the same old host is 202", async () => {
		const w = await world("claude_code", WITHOUT_FEATURE);
		expect((await postPrompt(w.sessionId)).status).toBe(202);
	});

	test("two concurrent prompts to the old host are both refused and leave no lock row", async () => {
		const w = await world("codex_cli", WITHOUT_FEATURE);
		const [a, b] = await Promise.all([postPrompt(w.sessionId, "one"), postPrompt(w.sessionId, "two")]);
		expect([a.status, b.status]).toEqual([409, 409]);
		expect(await promptRows(w.sessionId)).toEqual([]);
		expect(await lockOf(w.sessionId)).toEqual({ id: null, expires: null });
	});
});

describe("the check's place in the order and its fail-closed reading", () => {
	test("an offline host keeps its own refusal, and so does a removed one", async () => {
		const offline = await world("codex_cli", WITHOUT_FEATURE, { supervisor: "offline" });
		const offlineRes = await postPrompt(offline.sessionId);
		expect(offlineRes.status).toBe(409);
		expect(((await offlineRes.json()) as { error: string }).error).toBe("host_offline");

		const gone = await world("codex_cli", WITHOUT_FEATURE);
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked" })
			.where(eq(supervisors.id, gone.supervisorId));
		const goneRes = await postPrompt(gone.sessionId);
		expect(((await goneRes.json()) as { error: string }).error).toBe("host_gone");
	});

	test("a launch that disagrees with its session is launch_mismatch, before the host is asked", async () => {
		const w = await world("claude_code", WITHOUT_FEATURE);
		await setAgent(w.sessionId, "codex_cli", "launch");
		await expect(queuePromptAction(w.sessionId, "hi", ACTOR)).rejects.toBeInstanceOf(
			LaunchMismatchError,
		);
	});

	test("capabilities that are missing, malformed or misspelt lack the feature", async () => {
		const malformed: unknown[] = [
			{},
			[],
			"garbage",
			capsWith("codex_follow_up_prompts"),
			capsWith([CODEX_FOLLOW_UP_PROMPTS.slice(0, -1)]),
			capsWith([CODEX_FOLLOW_UP_PROMPTS.toUpperCase()]),
			capsWith({ [CODEX_FOLLOW_UP_PROMPTS]: true }),
			capsWith([1, null, CODEX_FOLLOW_UP_PROMPTS.length]),
			capsWith(null),
		];
		for (const caps of malformed) {
			const w = await world("codex_cli", caps);
			await expect(queuePromptAction(w.sessionId, "hi", ACTOR)).rejects.toBeInstanceOf(
				HostUpgradeRequiredError,
			);
			expect(await promptRows(w.sessionId)).toEqual([]);
		}
	});

	test("positive control: the same shapes with the real string are accepted", async () => {
		const w = await world("codex_cli", capsWith(["managed_codex", CODEX_FOLLOW_UP_PROMPTS]));
		const action = await queuePromptAction(w.sessionId, "hi", ACTOR);
		expect(action.status).toBe("queued");
	});

	test("the error carries the code and the copy", () => {
		const error = new HostUpgradeRequiredError();
		expect(error.code).toBe("host_upgrade_required");
		expect(error.message).toBe(UPGRADE_COPY);
	});
});

describe("statements", () => {
	test("a Claude prompt reads no capabilities: its count is the same on either host, and a Codex prompt costs more", async () => {
		const oldClaude = await world("claude_code", WITHOUT_FEATURE);
		const newClaude = await world("claude_code", WITH_FEATURE);
		const codex = await world("codex_cli", WITH_FEATURE);
		const count = (sessionId: string) =>
			countDbCalls(async () => {
				await queuePromptAction(sessionId, "measure", ACTOR);
			});
		await count(newClaude.sessionId); // warm
		await getDb().update(managedSessions).set({ activeControlActionId: null, controlLockExpiresAt: null });
		await getDb().delete(controlActions);
		const onOld = await count(oldClaude.sessionId);
		await getDb().update(managedSessions).set({ activeControlActionId: null, controlLockExpiresAt: null });
		await getDb().delete(controlActions);
		const onNew = await count(newClaude.sessionId);
		const forCodex = await count(codex.sessionId);
		expect(onOld).toBe(onNew);
		expect(forCodex).toBeGreaterThan(onNew);
	});

	test("the gate runs on the caller's transaction (inside the admin lock)", async () => {
		const w = await world("codex_cli", WITHOUT_FEATURE);
		const result = await withAdminLock((tx) =>
			enqueuePromptInTx(tx, {
				sessionId: w.sessionId,
				prompt: "hi",
				actor: ACTOR,
				controlActionId: crypto.randomUUID(),
			}),
		);
		expect(result).toEqual({ ok: false, reason: "host_upgrade_required" });
	});
});

describe("the AI send path and deliverability", () => {
	async function openRequest(w: World) {
		const turn = await seedFinishedTurn(w.sessionId);
		const ids = await seedProposalWithHitl({
			sessionId: w.sessionId,
			providerId,
			prompt: "Run the failing test and fix it",
			turnKey: turn.turnKey,
			triggerEventId: turn.stopId,
		});
		return { ...turn, ...ids };
	}
	const hitlStatus = async (id: string) =>
		(await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, id)))[0]?.status;

	test("dispatchPrompt refuses with prompt_not_deliverable / host_upgrade_required, not control_busy", async () => {
		const w = await world("codex_cli", WITHOUT_FEATURE);
		const turn = await seedFinishedTurn(w.sessionId);
		const refused = await dispatchPrompt(
			w.sessionId,
			{ kind: "human", text: "Run the tests" },
			ACTOR,
			{
				actorKind: "user",
				proposalId: crypto.randomUUID(),
				triggerEventId: turn.stopId,
				turnKey: turn.turnKey,
			},
		);
		expect(refused).toMatchObject({
			ok: false,
			status: 409,
			code: "prompt_not_deliverable",
			reason: "host_upgrade_required",
		});
		expect(await promptRows(w.sessionId)).toEqual([]);
	});

	test("an approval is refused, the request stays open, and after the host upgrades the retry sends", async () => {
		const w = await world("codex_cli", WITHOUT_FEATURE);
		const r = await openRequest(w);
		const approve = () =>
			resolveProposal({
				hitlId: r.hitlId,
				action: "approve",
				promptSha256: sha256("Run the failing test and fix it"),
				actor: ACTOR,
				actorKind: "user",
			});
		expect(await approve()).toMatchObject({
			ok: false,
			code: "prompt_not_deliverable",
			reason: "host_upgrade_required",
		});
		expect(await hitlStatus(r.hitlId)).toBe("awaiting_reply");
		expect(await promptRows(w.sessionId)).toEqual([]);

		await setCaps(w.supervisorId, WITH_FEATURE);
		expect(await approve()).toMatchObject({ ok: true });
		expect(await promptRows(w.sessionId)).toHaveLength(1);
	});

	test("promptDeliverability gives the same reason, and deliverable once the host has the feature", async () => {
		const w = await world("codex_cli", WITHOUT_FEATURE);
		expect(await promptDeliverability(w.sessionId)).toEqual({
			deliverable: false,
			reason: "host_upgrade_required",
		});
		await setCaps(w.supervisorId, WITH_FEATURE);
		expect(await promptDeliverability(w.sessionId)).toEqual({ deliverable: true });
	});

	test("a Claude session on the old host is deliverable", async () => {
		const w = await world("claude_code", WITHOUT_FEATURE);
		expect(await promptDeliverability(w.sessionId)).toEqual({ deliverable: true });
	});

	test("an offline host and a degraded session keep their own reasons", async () => {
		const offline = await world("codex_cli", WITHOUT_FEATURE, { supervisor: "offline" });
		expect(await promptDeliverability(offline.sessionId)).toEqual({
			deliverable: false,
			reason: "supervisor_offline",
		});
		const degraded = await world("codex_cli", WITHOUT_FEATURE);
		await getDb()
			.update(managedSessions)
			.set({ managedState: "degraded" })
			.where(eq(managedSessions.sessionId, degraded.sessionId));
		expect(await promptDeliverability(degraded.sessionId)).toEqual({
			deliverable: false,
			reason: "managed_state",
		});
	});
});

describe("the sentence the automatic path shows a person", () => {
	test("autoRefusalWhy reads the shared upgrade copy for this reason, on either code", async () => {
		const { autoRefusalWhy } = await import("./ai/continue-decision.js");
		const config = { continuationsUsed: 0, maxContinuations: 3 } as never;
		for (const code of ["auto_send_blocked", "prompt_not_deliverable"]) {
			expect(autoRefusalWhy({ code, reason: "host_upgrade_required" }, config)).toBe(UPGRADE_COPY);
		}
	});
});

// ── claim time ──────────────────────────────────────────────────────────────────────

/**
 * The register route, so a host really "re-registers without the feature": a fresh process of an old
 * supervisor sends capabilities with no `codex_follow_up_prompts`.
 */
async function enrollHost(name: string, features: string[]) {
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	});
	expect(enrolled.status).toBe(201);
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const body = await registerHost(name, features, { enrollmentToken });
	return { id: body.supervisor.id, token: body.supervisorCredential };
}
async function registerHost(
	name: string,
	features: string[],
	auth: { enrollmentToken?: string; credential?: string },
) {
	const res = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(auth.credential ? { "X-AgentPulse-Supervisor-Token": auth.credential } : {}),
		},
		body: JSON.stringify({
			hostName: name,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			...(auth.enrollmentToken ? { enrollmentToken: auth.enrollmentToken } : {}),
			capabilities: { ...WITHOUT_FEATURE, features },
			trustedRoots: ["/tmp"],
		}),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { supervisor: { id: string }; supervisorCredential: string };
}

/** What a server before this change wrote for a Codex prompt: the session's agent type, env and privileges. */
const oldFormMetadata = (agentType: string) => ({
	prompt: "queued by the old server",
	agentType,
	cwd: "/work/project",
	managedState: "managed",
	launchMode: agentType === "codex_cli" ? "managed_codex" : "headless",
	model: "m",
	approvalPolicy: "on-request",
	sandboxMode: "workspace-write",
	env: { SECRET: "x" },
});

describe("claimNextControlAction", () => {
	async function hostWorld(agent: "codex_cli" | "claude_code", features: string[]) {
		const host = await enrollHost(`claim-${++counter}`, features);
		const sessionId = `cl-${counter}-${crypto.randomUUID().slice(0, 6)}`;
		await getDb()
			.insert(sessions)
			.values({ sessionId, agentType: agent, status: "active", cwd: "/work/project" });
		const [launch] = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: sessionId,
				agentType: agent,
				cwd: "/work/project",
				requestedSupervisorId: host.id,
				claimedBySupervisorId: host.id,
				requestedLaunchMode: agent === "codex_cli" ? "managed_codex" : "headless",
				status: "running",
			})
			.returning();
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: launch?.id as string,
				supervisorId: host.id,
				managedState: "managed",
			});
		return { host, sessionId, launchId: launch?.id as string };
	}

	/** Queue a prompt directly, with the session's lock held for it, as the old server would have. */
	async function queueOldForm(
		sessionId: string,
		launchId: string,
		metadata: Record<string, unknown>,
		createdAt = new Date().toISOString(),
	) {
		const id = crypto.randomUUID();
		await getDb().insert(controlActions).values({
			id,
			sessionId,
			launchRequestId: launchId,
			actionType: "prompt",
			requestedBy: "user",
			status: "queued",
			metadata,
			createdAt,
			updatedAt: createdAt,
		});
		await getDb()
			.update(managedSessions)
			.set({
				activeControlActionId: id,
				controlLockExpiresAt: new Date(Date.now() + 90_000).toISOString(),
			})
			.where(eq(managedSessions.sessionId, sessionId));
		return id;
	}
	const actionById = async (id: string) =>
		(await getDb().select().from(controlActions).where(eq(controlActions.id, id)))[0];

	test("an old-form Codex prompt on a host that re-registered without the feature is failed, not handed over, and the lock is freed", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const id = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"));
		// The supervisor restarts as an older build.
		await registerHost(`claim-reregistered`, [], { credential: w.host.token });

		expect(await claimNextControlAction(w.host.id)).toBeNull();
		const row = await actionById(id);
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe(UPGRADE_COPY);
		expect(row?.finishedAt).toBeTruthy();
		expect(await lockOf(w.sessionId)).toEqual({ id: null, expires: null });
	});

	test("the claim route hands an old supervisor nothing, and moves on to the next action", async () => {
		const w = await hostWorld("codex_cli", []);
		const codexId = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"));
		const stop = await hostWorld("claude_code", []);
		const stopId = crypto.randomUUID();
		await getDb()
			.insert(controlActions)
			.values({
				id: stopId,
				sessionId: stop.sessionId,
				launchRequestId: stop.launchId,
				actionType: "stop",
				requestedBy: "user",
				status: "queued",
				metadata: {},
			});
		// The stop belongs to another host; give this host its own, later than the Codex prompt.
		await getDb()
			.update(managedSessions)
			.set({ supervisorId: w.host.id })
			.where(eq(managedSessions.sessionId, stop.sessionId));
		await getDb()
			.update(launchRequests)
			.set({ claimedBySupervisorId: w.host.id, requestedSupervisorId: w.host.id })
			.where(eq(launchRequests.id, stop.launchId));

		const claim = await app.request(`/api/v1/supervisors/${w.host.id}/control-actions/claim`, {
			method: "POST",
			headers: { "X-AgentPulse-Supervisor-Token": w.host.token },
		});
		const { action } = (await claim.json()) as { action: { id: string } | null };
		expect(action?.id).toBe(stopId);
		expect((await actionById(codexId))?.status).toBe("failed");
	});

	test("a Codex prompt on a host with the feature is claimed", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const id = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"));
		const claimed = await claimNextControlAction(w.host.id);
		expect(claimed?.id).toBe(id);
		expect(claimed?.status).toBe("running");
	});

	test("metadata that disagrees with the launch fails even on a host that has the feature", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const id = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("claude_code"));
		expect(await claimNextControlAction(w.host.id)).toBeNull();
		const row = await actionById(id);
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe(
			"This session's records don't match how it was launched, so nothing was sent.",
		);
		expect(await lockOf(w.sessionId)).toEqual({ id: null, expires: null });
	});

	test("a Claude launch whose metadata says Codex fails too", async () => {
		const w = await hostWorld("claude_code", [CODEX_FOLLOW_UP_PROMPTS]);
		const id = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"));
		expect(await claimNextControlAction(w.host.id)).toBeNull();
		expect((await actionById(id))?.status).toBe("failed");
	});

	test("a Claude prompt on the old host is claimed, with no capability read", async () => {
		const oldHost = await hostWorld("claude_code", []);
		const newHost = await hostWorld("claude_code", [CODEX_FOLLOW_UP_PROMPTS]);
		const oldId = await queueOldForm(oldHost.sessionId, oldHost.launchId, oldFormMetadata("claude_code"));
		await queueOldForm(newHost.sessionId, newHost.launchId, oldFormMetadata("claude_code"));
		const measure = (hostId: string) =>
			countDbCalls(async () => {
				await claimNextControlAction(hostId);
			});
		const onOld = await measure(oldHost.host.id);
		expect((await actionById(oldId))?.status).toBe("running");
		const onNew = await measure(newHost.host.id);
		expect(onOld).toBe(onNew);

		const codexHost = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		await queueOldForm(codexHost.sessionId, codexHost.launchId, oldFormMetadata("codex_cli"));
		expect(await measure(codexHost.host.id)).toBeGreaterThan(onNew);
	});

	test("with no launch row, metadata that says Codex is judged as Codex", async () => {
		const w = await hostWorld("codex_cli", []);
		const id = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"));
		await getDb().update(controlActions).set({ launchRequestId: null });
		await getDb().update(managedSessions).set({ launchRequestId: w.sessionId });
		await getDb().delete(launchRequests).where(eq(launchRequests.id, w.launchId));
		expect(await claimNextControlAction(w.host.id)).toBeNull();
		const row = await actionById(id);
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe(UPGRADE_COPY);
	});

	test("a pile of refused prompts is bounded per claim: it answers null and does not loop forever", async () => {
		const w = await hostWorld("codex_cli", []);
		const ids: string[] = [];
		for (let i = 0; i < 14; i += 1) {
			const createdAt = new Date(Date.now() - 20_000 + i).toISOString();
			ids.push(await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"), createdAt));
		}
		expect(await claimNextControlAction(w.host.id)).toBeNull();
		const rows = await Promise.all(ids.map(actionById));
		const failed = rows.filter((r) => r?.status === "failed").length;
		expect(failed).toBeGreaterThanOrEqual(10);
		expect(failed).toBeLessThan(14);
		expect(await claimNextControlAction(w.host.id)).toBeNull();
		expect((await Promise.all(ids.map(actionById))).every((r) => r?.status === "failed")).toBe(true);
	});

	test("a stop for a Codex session is never refused by the gate", async () => {
		const w = await hostWorld("codex_cli", []);
		const id = crypto.randomUUID();
		await getDb().insert(controlActions).values({
			id,
			sessionId: w.sessionId,
			launchRequestId: w.launchId,
			actionType: "stop",
			requestedBy: "user",
			status: "queued",
			metadata: {},
		});
		expect((await claimNextControlAction(w.host.id))?.id).toBe(id);
	});
});
