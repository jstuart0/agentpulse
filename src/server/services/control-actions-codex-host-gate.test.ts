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
	aiDispatchAudit,
	aiHitlDeliveries,
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
const { dispatchPrompt, resolveProposal } = await import("./ai/proposal-resolution.js");
const feature = await import("./ai/feature.js");
const { withAdminLock } = await import("../db/admin-lock.js");
const { decideHitl, retryDelivery } = await import("./ai/hitl-decision-service.js");
const { insertAuditIntent, markAuditSent } = await import("./ai/dispatch-audit-service.js");
const { deleteAllSupervisors } = await import("./__test_supervisors.js");

/** The sentence every reader of this refusal carries (the plan's copy, D7). */
const UPGRADE_COPY =
	"This session's host is running an older supervisor that can't send prompts to Codex. Update it, then start a new session for this work. Updating ends the sessions running there.";
/** A Codex session whose process ended when its host restarted (registration degrades it). */
const ENDED_COPY =
	"This session's process ended when its host restarted, so it can't take more prompts. Start a new session for this work.";
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
		await getDb()
			.update(sessions)
			.set({ agentType: agent })
			.where(eq(sessions.sessionId, sessionId));
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
		const [a, b] = await Promise.all([
			postPrompt(w.sessionId, "one"),
			postPrompt(w.sessionId, "two"),
		]);
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
		await getDb()
			.update(managedSessions)
			.set({ activeControlActionId: null, controlLockExpiresAt: null });
		await getDb().delete(controlActions);
		const onOld = await count(oldClaude.sessionId);
		await getDb()
			.update(managedSessions)
			.set({ activeControlActionId: null, controlLockExpiresAt: null });
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
		expect(
			autoRefusalWhy({ code: "prompt_not_deliverable", reason: "managed_state" }, config),
		).toBe(ENDED_COPY);
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
	auth: { enrollmentToken?: string; credential?: string; id?: string },
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
			...(auth.id ? { id: auth.id } : {}),
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

async function hostWorld(agent: "codex_cli" | "claude_code", features: string[]) {
	const hostName = `claim-${++counter}`;
	const host = { ...(await enrollHost(hostName, features)), hostName };
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
			// A headless Claude launch still running is the session's first turn, which takes no prompt.
			status: agent === "codex_cli" ? "running" : "completed",
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

describe("claimNextControlAction", () => {
	test("an old-form Codex prompt on a host that re-registered without the feature is failed, not handed over, and the lock is freed", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		// The supervisor restarts as an older build; registration already fails what was waiting for it.
		const again = await registerHost(w.host.hostName, [], {
			credential: w.host.token,
			id: w.host.id,
		});
		expect(again.supervisor.id).toBe(w.host.id);
		// A prompt in the old server's form arrives after that (an old server still running, or a late write).
		const id = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"));

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
				// The same ISO form queueOldForm writes, so the two sort by time and not by their separators.
				createdAt: new Date(Date.now() + 1_000).toISOString(),
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
		const oldId = await queueOldForm(
			oldHost.sessionId,
			oldHost.launchId,
			oldFormMetadata("claude_code"),
		);
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
			ids.push(
				await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"), createdAt),
			);
		}
		expect(await claimNextControlAction(w.host.id)).toBeNull();
		const rows = await Promise.all(ids.map(actionById));
		const failed = rows.filter((r) => r?.status === "failed").length;
		expect(failed).toBeGreaterThanOrEqual(10);
		expect(failed).toBeLessThan(14);
		expect(await claimNextControlAction(w.host.id)).toBeNull();
		expect((await Promise.all(ids.map(actionById))).every((r) => r?.status === "failed")).toBe(
			true,
		);
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

// ── review fixes ────────────────────────────────────────────────────────────────────

const manageCtx = {
	actor: { userId: null, label: "api_key", role: "admin", mode: "solo" },
	source: "api_key" as const,
	keyId: "key-manage",
	scopes: ["manage"],
	canCustomPrompt: true,
} as never;

async function openRequestFor(sessionId: string, prompt = "Run the failing test and fix it") {
	const turn = await seedFinishedTurn(sessionId);
	const ids = await seedProposalWithHitl({
		sessionId,
		providerId,
		prompt,
		turnKey: turn.turnKey,
		triggerEventId: turn.stopId,
	});
	return { ...turn, ...ids, prompt };
}

describe("C1: retrying a delivery after the host reported a Codex failure", () => {
	test("the failure report replaces the stored metadata, and the retry still queues the same prompt", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const r = await openRequestFor(w.sessionId);
		const approved = await decideHitl(
			{ kind: "proposal", proposalId: r.proposalId },
			"approve",
			{ promptHash: sha256(r.prompt) },
			manageCtx,
		);
		expect(approved.ok).toBe(true);
		const claimed = await claimNextControlAction(w.host.id);
		expect(claimed?.status).toBe("running");

		// What the supervisor's Codex branch reports: its own metadata replaces the stored one.
		const report = await app.request(
			`/api/v1/supervisors/${w.host.id}/control-actions/${claimed?.id}/status`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AgentPulse-Supervisor-Token": w.host.token,
				},
				body: JSON.stringify({
					status: "failed",
					error: "Codex hasn't ended its current turn. Send this again when it ends.",
					metadata: { mode: "managed_codex" },
				}),
			},
		);
		expect(report.status).toBe(200);
		expect((await actionById(claimed?.id as string))?.metadata).toEqual({ mode: "managed_codex" });

		const retried = await retryDelivery(r.proposalId, manageCtx);
		expect(retried).toMatchObject({ ok: true, state: "queued" });
		const queued = (await promptRows(w.sessionId)).filter((a) => a.status === "queued");
		expect(queued).toHaveLength(1);
		expect((queued[0]?.metadata as { prompt?: string }).prompt).toBe(r.prompt);
	});

	test("a retry whose audited text does not match the delivery's hash is still refused", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const r = await openRequestFor(w.sessionId);
		await decideHitl(
			{ kind: "proposal", proposalId: r.proposalId },
			"approve",
			{ promptHash: sha256(r.prompt) },
			manageCtx,
		);
		const claimed = await claimNextControlAction(w.host.id);
		await getDb()
			.update(controlActions)
			.set({ status: "failed", metadata: { mode: "managed_codex" } })
			.where(eq(controlActions.id, claimed?.id as string));
		// The delivery was approved for different text than the audit row now holds.
		await getDb()
			.update(aiHitlDeliveries)
			.set({ promptHash: sha256("another prompt") });
		const retried = await retryDelivery(r.proposalId, manageCtx);
		expect(retried).toMatchObject({ ok: false, refusal: { code: "not_retryable" } });
		expect(await promptRows(w.sessionId)).toHaveLength(1);
	});
});

describe("C2: a Codex session that is no longer continuable", () => {
	const degrade = (sessionId: string, state = "degraded") =>
		getDb()
			.update(managedSessions)
			.set({ managedState: state })
			.where(eq(managedSessions.sessionId, sessionId));

	test("POST /prompt is 409 managed_state_not_continuable with no action and no lock", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		await degrade(w.sessionId);
		const res = await postPrompt(w.sessionId);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: "managed_state_not_continuable",
			message: ENDED_COPY,
		});
		expect(await promptRows(w.sessionId)).toEqual([]);
		expect(await lockOf(w.sessionId)).toEqual({ id: null, expires: null });
	});

	test("an approval answers prompt_not_deliverable / managed_state and the request stays open", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const r = await openRequestFor(w.sessionId);
		await degrade(w.sessionId);
		const result = await resolveProposal({
			hitlId: r.hitlId,
			action: "approve",
			promptSha256: sha256(r.prompt),
			actor: ACTOR,
			actorKind: "user",
		});
		expect(result).toMatchObject({
			ok: false,
			status: 409,
			code: "prompt_not_deliverable",
			reason: "managed_state",
		});
		expect(
			(await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, r.hitlId)))[0]
				?.status,
		).toBe("awaiting_reply");
		expect(await promptRows(w.sessionId)).toEqual([]);
	});

	test("the order: offline, then gone, then mismatch, then upgrade, then this", async () => {
		const code = async (sessionId: string) =>
			((await (await postPrompt(sessionId)).json()) as { error: string }).error;

		const offline = await hostWorld("codex_cli", []);
		await degrade(offline.sessionId);
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(supervisors.id, offline.host.id));
		expect(await code(offline.sessionId)).toBe("host_offline");

		const gone = await hostWorld("codex_cli", []);
		await degrade(gone.sessionId);
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked" })
			.where(eq(supervisors.id, gone.host.id));
		expect(await code(gone.sessionId)).toBe("host_gone");

		const mismatch = await hostWorld("codex_cli", []);
		await degrade(mismatch.sessionId);
		await setAgent(mismatch.sessionId, "claude_code", "launch");
		await expect(queuePromptAction(mismatch.sessionId, "x", ACTOR)).rejects.toBeInstanceOf(
			LaunchMismatchError,
		);

		const old = await hostWorld("codex_cli", []);
		await degrade(old.sessionId);
		expect(await code(old.sessionId)).toBe("host_upgrade_required");

		const current = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		await degrade(current.sessionId);
		expect(await code(current.sessionId)).toBe("managed_state_not_continuable");
	});

	test("Claude is unchanged: a degraded Claude session still queues; a managed Codex session in its turn reaches the busy path", async () => {
		const claude = await hostWorld("claude_code", []);
		await degrade(claude.sessionId);
		expect((await postPrompt(claude.sessionId)).status).toBe(202);

		const codex = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		await getDb()
			.update(sessions)
			.set({ isWorking: true })
			.where(eq(sessions.sessionId, codex.sessionId));
		expect((await postPrompt(codex.sessionId)).status).toBe(202);
	});

	test("a real upgrade: the session launched before it is refused with the new copy; one launched after is sent", async () => {
		const before = await hostWorld("codex_cli", []);
		const r = await openRequestFor(before.sessionId);
		const approve = () =>
			resolveProposal({
				hitlId: r.hitlId,
				action: "approve",
				promptSha256: sha256(r.prompt),
				actor: ACTOR,
				actorKind: "user",
			});
		expect(await approve()).toMatchObject({ reason: "host_upgrade_required" });

		// The supervisor is upgraded and registers again, through the real route.
		await registerHost(before.host.hostName, [CODEX_FOLLOW_UP_PROMPTS], {
			credential: before.host.token,
			id: before.host.id,
		});
		expect(
			(await (await postPrompt(before.sessionId)).json()) as { error: string; message: string },
		).toEqual({ error: "managed_state_not_continuable", message: ENDED_COPY });
		expect(await approve()).toMatchObject({ ok: false, reason: "managed_state" });
		expect(await promptRows(before.sessionId)).toEqual([]);

		// A session launched after it, on the same host.
		const after = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		await getDb()
			.update(launchRequests)
			.set({ claimedBySupervisorId: before.host.id, requestedSupervisorId: before.host.id })
			.where(eq(launchRequests.id, after.launchId));
		await getDb()
			.update(managedSessions)
			.set({ supervisorId: before.host.id })
			.where(eq(managedSessions.sessionId, after.sessionId));
		expect((await postPrompt(after.sessionId)).status).toBe(202);
	});
});

describe("C4/C5/T-series: the claim", () => {
	test("C4: an action another claimer already took is not claimed twice", async () => {
		const w = await hostWorld("claude_code", []);
		const id = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("claude_code"));
		const [a, b] = await Promise.all([
			claimNextControlAction(w.host.id),
			claimNextControlAction(w.host.id),
		]);
		expect([a, b].filter((x) => x?.id === id)).toHaveLength(1);
	});

	test("C5: a prompt with no launch row fails closed unless it says claude_code", async () => {
		const orphan = async (metadata: Record<string, unknown> | null) => {
			const w = await hostWorld("claude_code", []);
			const id = await queueOldForm(w.sessionId, w.launchId, metadata ?? {});
			await getDb()
				.update(controlActions)
				.set({ launchRequestId: null, metadata: metadata as never });
			await getDb().update(managedSessions).set({ launchRequestId: w.sessionId });
			await getDb().delete(launchRequests).where(eq(launchRequests.id, w.launchId));
			return { w, id };
		};
		const bare = await orphan({});
		expect(await claimNextControlAction(bare.w.host.id)).toBeNull();
		expect((await actionById(bare.id))?.status).toBe("failed");
		expect(await lockOf(bare.w.sessionId)).toEqual({ id: null, expires: null });

		const claude = await orphan(oldFormMetadata("claude_code"));
		expect((await claimNextControlAction(claude.w.host.id))?.id).toBe(claude.id);
	});

	test("T1: with two hosts, the one without the feature fails and the one with it claims", async () => {
		const old = await hostWorld("codex_cli", []);
		const current = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const oldId = await queueOldForm(old.sessionId, old.launchId, oldFormMetadata("codex_cli"));
		const currentId = await queueOldForm(
			current.sessionId,
			current.launchId,
			oldFormMetadata("codex_cli"),
		);
		expect(await claimNextControlAction(old.host.id)).toBeNull();
		expect((await actionById(oldId))?.status).toBe("failed");
		expect((await claimNextControlAction(current.host.id))?.id).toBe(currentId);
	});

	test("T2: a refused prompt's `sent` audit row reads failed with expired_unclaimed", async () => {
		const w = await hostWorld("codex_cli", []);
		const id = await queueOldForm(w.sessionId, w.launchId, oldFormMetadata("codex_cli"));
		const auditId = await insertAuditIntent(getDb(), {
			sessionId: w.sessionId,
			sessionName: null,
			actorKind: "user",
			actorUserId: null,
			actorLabel: "user",
			promptSha256: sha256("p"),
			promptText: "p",
			controlActionId: id,
		});
		await markAuditSent(getDb(), auditId);
		expect(await claimNextControlAction(w.host.id)).toBeNull();
		const [row] = await getDb()
			.select()
			.from(aiDispatchAudit)
			.where(eq(aiDispatchAudit.id, auditId));
		expect(row).toMatchObject({ outcome: "failed", refusalCode: "expired_unclaimed" });
	});

	test("T3: refusing a queued prompt leaves a lock held by a different action alone", async () => {
		const w = await hostWorld("codex_cli", []);
		const refusedId = await queueOldForm(
			w.sessionId,
			w.launchId,
			oldFormMetadata("codex_cli"),
			new Date(Date.now() - 5_000).toISOString(),
		);
		const stopId = crypto.randomUUID();
		const lockExpires = new Date(Date.now() + 90_000).toISOString();
		await getDb().insert(controlActions).values({
			id: stopId,
			sessionId: w.sessionId,
			launchRequestId: w.launchId,
			actionType: "stop",
			requestedBy: "user",
			status: "queued",
			metadata: {},
			createdAt: new Date().toISOString(),
		});
		await getDb()
			.update(managedSessions)
			.set({ activeControlActionId: stopId, controlLockExpiresAt: lockExpires })
			.where(eq(managedSessions.sessionId, w.sessionId));
		expect((await claimNextControlAction(w.host.id))?.id).toBe(stopId);
		expect((await actionById(refusedId))?.status).toBe("failed");
		expect(await lockOf(w.sessionId)).toEqual({ id: stopId, expires: lockExpires });
	});

	test("T4: a Codex launch on an old host fails whatever the action's metadata says", async () => {
		for (const metadata of [{}, { prompt: "x" }]) {
			const w = await hostWorld("codex_cli", []);
			const id = await queueOldForm(w.sessionId, w.launchId, metadata);
			expect(await claimNextControlAction(w.host.id)).toBeNull();
			const row = await actionById(id);
			expect(row?.status).toBe("failed");
			expect(row?.error).toBe(UPGRADE_COPY);
		}
	});

	test("T5: a live lock on the old Codex session does not hide the upgrade reason", async () => {
		const w = await hostWorld("codex_cli", []);
		const turn = await seedFinishedTurn(w.sessionId);
		// Queued before the turn ended: a later one would make the dispatch's turn check say "moved on" first.
		await queueOldForm(
			w.sessionId,
			w.launchId,
			oldFormMetadata("codex_cli"),
			new Date(Date.now() - 3_600_000).toISOString(),
		);
		expect(await promptDeliverability(w.sessionId)).toEqual({
			deliverable: false,
			reason: "host_upgrade_required",
		});
		expect(((await (await postPrompt(w.sessionId)).json()) as { error: string }).error).toBe(
			"host_upgrade_required",
		);
		expect(
			await dispatchPrompt(w.sessionId, { kind: "human", text: "go" }, ACTOR, {
				actorKind: "user",
				proposalId: crypto.randomUUID(),
				triggerEventId: turn.stopId,
				turnKey: turn.turnKey,
			}),
		).toMatchObject({ ok: false, reason: "host_upgrade_required" });
	});

	test("T5: a prompt queued by this server for a host with the feature is claimed (round trip)", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const action = await queuePromptAction(w.sessionId, "go on", ACTOR);
		const claimed = await claimNextControlAction(w.host.id);
		expect(claimed?.id).toBe(action.id);
		expect(claimed?.status).toBe("running");
	});
});

describe("POST /prompt: the request has to be the page's own or a script's (review S1)", () => {
	const send = (sessionId: string, headers: Record<string, string>, body = '{"prompt":"go"}') =>
		app.request(`/api/v1/sessions/${sessionId}/prompt`, { method: "POST", headers, body });
	const JSON_TYPE = { "Content-Type": "application/json" };

	test("a foreign Origin is refused and nothing is queued", async () => {
		const w = await world("codex_cli", WITH_FEATURE);
		const res = await send(w.sessionId, { ...JSON_TYPE, Origin: "https://evil.example" });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("bad_origin");
		expect(await promptRows(w.sessionId)).toEqual([]);
	});

	test("with auth off, a rebound page (Origin equal to a Host that isn't loopback) is refused, and so is that Host with no Origin", async () => {
		const w = await world("codex_cli", WITH_FEATURE);
		const rebound = await send(w.sessionId, {
			...JSON_TYPE,
			Host: "rebind.example:3000",
			Origin: "http://rebind.example:3000",
		});
		expect(rebound.status).toBe(403);
		const noOrigin = await send(w.sessionId, { ...JSON_TYPE, Host: "rebind.example:3000" });
		expect(noOrigin.status).toBe(403);
		expect(await promptRows(w.sessionId)).toEqual([]);
		const loopback = await send(w.sessionId, { ...JSON_TYPE, Host: "127.0.0.1:3000" });
		expect(loopback.status).toBe(202);
	});

	test("a body that isn't declared JSON is refused, whatever its text", async () => {
		const w = await world("codex_cli", WITH_FEATURE);
		for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
			const res = await send(w.sessionId, { "Content-Type": type });
			expect(res.status, type).toBe(415);
		}
		const none = await send(w.sessionId, {});
		expect(none.status).toBe(415);
		expect(await promptRows(w.sessionId)).toEqual([]);
		const withCharset = await send(w.sessionId, {
			"Content-Type": "application/json; charset=utf-8",
		});
		expect(withCharset.status).toBe(202);
	});

	test("it holds for a Claude session too", async () => {
		const w = await world("claude_code", WITH_FEATURE);
		expect((await send(w.sessionId, { "Content-Type": "text/plain" })).status).toBe(415);
		expect((await send(w.sessionId, { ...JSON_TYPE, Origin: "https://evil.example" })).status).toBe(
			403,
		);
	});

	test("with auth on, a native client holding a key and sending no Origin still gets through", async () => {
		const { createApiKey } = await import("../auth/api-key.js");
		(config as Record<string, unknown>).disableAuth = false;
		const w = await world("codex_cli", WITH_FEATURE);
		const { key } = await createApiKey(`prompt-safety-${crypto.randomUUID()}`, ["manage"]);
		const res = await send(w.sessionId, { ...JSON_TYPE, Authorization: `Bearer ${key}` });
		expect(res.status).toBe(202);
		const foreign = await send(w.sessionId, {
			...JSON_TYPE,
			Authorization: `Bearer ${key}`,
			Origin: "https://evil.example",
		});
		expect(foreign.status).toBe(403);
	});
});

describe("POST /prompt while another action holds the lock (review M5)", () => {
	test("it is still a 400, now with a stable reason the page can read", async () => {
		const w = await world("codex_cli", WITH_FEATURE);
		expect((await postPrompt(w.sessionId, "one")).status).toBe(202);
		const second = await postPrompt(w.sessionId, "two");
		expect(second.status).toBe(400);
		expect(await second.json()).toEqual({
			error: "Another control action is already in progress for this session.",
			reason: "control_busy",
		});
	});
});

describe("a host's failure text is bounded and cleaned where it is stored (review S3)", () => {
	test("controls and bidi characters are stripped, the length is capped, and a non-string is dropped", async () => {
		const w = await hostWorld("codex_cli", [CODEX_FOLLOW_UP_PROMPTS]);
		const status = async (actionId: string, error: unknown) => {
			const res = await app.request(
				`/api/v1/supervisors/${w.host.id}/control-actions/${actionId}/status`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-AgentPulse-Supervisor-Token": w.host.token,
					},
					body: JSON.stringify({ status: "failed", error }),
				},
			);
			expect(res.status).toBe(200);
		};
		const first = await queuePromptAction(w.sessionId, "one", ACTOR);
		await claimNextControlAction(w.host.id);
		const hostile = `bad${String.fromCharCode(27)}[31m${String.fromCharCode(0x202e)}gnp.exe ${"x".repeat(900)}`;
		await status(first.id, hostile);
		const stored = (await actionById(first.id))?.error ?? "";
		expect(stored).toStartWith("bad [31mgnp.exe x");
		expect(
			Array.from(stored).some(
				(ch) => (ch.codePointAt(0) ?? 0) < 32 || (ch.codePointAt(0) ?? 0) === 0x202e,
			),
		).toBe(false);
		expect(Array.from(stored).length).toBeLessThanOrEqual(501);
		const second = await queuePromptAction(w.sessionId, "two", ACTOR);
		await claimNextControlAction(w.host.id);
		await status(second.id, { not: "a string" });
		expect((await actionById(second.id))?.error).toBeNull();
	});
});
