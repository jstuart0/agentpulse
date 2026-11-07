/**
 * Taking over an observed Codex session (AGEN-115). A person picks a stopped, hand-started session and the
 * machine it ran on; this service writes the rows that make that machine's supervisor the session's owner of
 * record and queues the `resume` action it will run. It starts no process and never touches the session row.
 *
 * Interface: `bindObservedSession(sessionId, { targetSupervisorId, sameMachineConfirmed }, actor)` returns the
 * queued action and the carrier launch's id, or throws `BindRefusal`. Invariants: at most one launch row and
 * one managed row per session id; nothing is written on a refusal; no AI executor calls it (a person's act).
 * What it hides: which rows make up a takeover, their order, and the precedence of the refusals.
 *
 * Every read in the locked body goes through `tx`, with no other await in it. The pre-reads outside the lock
 * only choose the cheapest refusal; each fact is read again inside it.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { SESSION_IDLE_TIMEOUT_MS, isLaunchable } from "../../shared/constants.js";
import { privilegeCliArgs } from "../../shared/launch-privileges.js";
import {
	CLAUDE_FORK_DEADLINE_MS,
	CLAUDE_TAKEOVER,
	CLAUDE_TAKEOVER_PRIVILEGES,
	RESUMES_SESSIONS,
	type ResumeActionMetadata,
	TAKEOVER_PRIVILEGES,
	buildClaudeResumeActionMetadata,
	buildResumeActionMetadata,
	isResumableSessionId,
} from "../../shared/session-resume.js";
import type {
	ControlAction,
	LaunchSpec,
	SessionTemplateInput,
	SupervisorRecord,
} from "../../shared/types.js";
import type { Actor, InstanceModeName } from "../auth/actor.js";
import { awaitSeamInsideAdminLock, withAdminLock } from "../db/admin-lock.js";
import { getDb } from "../db/client.js";
import { apiKeys, controlActions, managedSessions, sessions } from "../db/schema/index.js";
import { jsonExtractText } from "../db/sql-helpers.js";
import { requestWsRevalidation } from "../ws/revalidation.js";
import { logAdminAction } from "./audit-log.js";
import { mayBindToHost, refuseBindSession } from "./authorization.js";
import { BindRefusal } from "./bind-refusal.js";
import {
	isClaudeTakeoverLaunch,
	launchOwnedBySessionOwner,
	mapControlAction,
	resolveManagedLaunch,
	takeControlLock,
} from "./control-actions.js";
import { getMode } from "./instance-mode.js";
import {
	ENFORCES_LAUNCH_PRIVILEGES,
	buildLaunchSpec,
	isWithinTrustedRoot,
	validateAgainstSupervisor,
} from "./launch-compatibility.js";
import { notifySessionUpdated } from "./notifier.js";
import {
	SessionAlreadyBoundError,
	claimObservedSession,
	findLaunchRowByCorrelationId,
	findManagedRowForThread,
	readHostState,
	resolveSessionOwner,
} from "./session-ownership.js";
import { STUCK_WORKING_RECOVERY_MS } from "./session-tracker.js";
import { readTrustedRoots, withCapabilityDefaults } from "./supervisor-capabilities.js";
import { getSupervisor } from "./supervisor-registry.js";
import { normalizeTemplateInput, validateTemplateInput } from "./template-preview.js";
import { parseDbTimestamp } from "./util/db-time.js";

export interface BindInput {
	targetSupervisorId: string;
	/** The person's statement that this is the machine the session ran on, and that it has ended there. */
	sameMachineConfirmed: boolean;
}

export type BindStep = "checked" | "claimed" | "locked" | "action";

/** Test seams: a clock, a hook between the pre-reads and the lock, and a hook after each write inside it. */
export interface BindDeps {
	now?: () => number;
	beforeLock?: () => Promise<void>;
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	afterStep?: (step: BindStep, tx: any) => Promise<void>;
}

export interface BindResult {
	action: ControlAction;
	launchRequestId: string;
}

const MAX_TEMPLATE_NAME = 120;

type SessionRow = Pick<
	typeof sessions.$inferSelect,
	| "sessionId"
	| "agentType"
	| "cwd"
	| "displayName"
	| "ownerUserId"
	| "ingestKeyId"
	| "isWorking"
	| "isArchived"
	| "lastActivityAt"
	| "metadata"
>;

async function readSession(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	sessionId: string,
): Promise<SessionRow | null> {
	const [row] = await db
		.select({
			sessionId: sessions.sessionId,
			agentType: sessions.agentType,
			cwd: sessions.cwd,
			displayName: sessions.displayName,
			ownerUserId: sessions.ownerUserId,
			ingestKeyId: sessions.ingestKeyId,
			isWorking: sessions.isWorking,
			isArchived: sessions.isArchived,
			lastActivityAt: sessions.lastActivityAt,
			metadata: sessions.metadata,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row ?? null;
}

function templateFor(session: SessionRow, cwd: string): SessionTemplateInput {
	const label = session.displayName?.trim() || `session ${session.sessionId.slice(0, 8)}`;
	const claude = session.agentType === "claude_code";
	const privileges = claude ? CLAUDE_TAKEOVER_PRIVILEGES : TAKEOVER_PRIVILEGES;
	return normalizeTemplateInput({
		name: `Take over: ${label}`.slice(0, MAX_TEMPLATE_NAME),
		agentType: claude ? "claude_code" : "codex_cli",
		cwd,
		baseInstructions: "",
		taskPrompt: "",
		model: null,
		approvalPolicy: privileges.approvalPolicy,
		sandboxMode: privileges.sandboxMode,
		env: {},
	});
}

/** The candidate directory is only ever a guess: it must be absolute and inside the host's trusted roots. */
function judgeCandidateCwd(cwd: string | null, trustedRoots: string[]): string {
	if (cwd === null || cwd === "") throw new BindRefusal("cwd_unknown");
	if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd))
		throw new BindRefusal("cwd_not_trusted");
	if (!isWithinTrustedRoot(cwd, trustedRoots)) throw new BindRefusal("cwd_not_trusted");
	return cwd;
}

/**
 * Can this host run a takeover at all? A supervisor that doesn't advertise both features is too old
 * (`host_upgrade_required`); one that does but has no usable Codex or no managed Codex mode can't run
 * Codex whatever its version (`host_cannot_run_codex`). The directory was judged by the caller.
 */
function refuseIfHostCannotRun(template: SessionTemplateInput, host: SupervisorRecord): void {
	const features = host.capabilities.features ?? [];
	if (template.agentType === "claude_code") {
		// A Claude takeover needs its own feature, advertised only where `claude` resolves (T14); a Claude-only
		// host has no Codex feature and doesn't need one.
		if (!features.includes(CLAUDE_TAKEOVER)) throw new BindRefusal("host_cannot_run_claude");
		// Supported on macOS only so far (the host's protocol gate refuses elsewhere); refused here, not queued.
		if (host.capabilities.os !== "macos") throw new BindRefusal("host_cannot_run_claude");
		if (validateAgainstSupervisor(template, host, "headless").errors.length > 0) {
			throw new BindRefusal("host_cannot_run_claude");
		}
		return;
	}
	if (!features.includes(RESUMES_SESSIONS) || !features.includes(ENFORCES_LAUNCH_PRIVILEGES)) {
		throw new BindRefusal("host_upgrade_required");
	}
	if (validateAgainstSupervisor(template, host, "managed_codex").errors.length > 0) {
		throw new BindRefusal("host_cannot_run_codex");
	}
}

function hasLivePermissionWait(metadata: unknown): boolean {
	const wait = (metadata as { permissionWait?: { ids?: unknown; anon?: unknown } } | null)
		?.permissionWait;
	if (!wait) return false;
	return (
		(Array.isArray(wait.ids) && wait.ids.length > 0) ||
		(typeof wait.anon === "number" && wait.anon > 0)
	);
}

/**
 * The server's half of "has the original stopped?". The clock is this server's own, so a hook can delay a
 * takeover but never shorten the wait; `SessionEnd`, `endedAt` and `status` are claims a hook can forge and
 * aren't consulted. A live process idle at its prompt sends nothing, so this can't tell it from a stopped
 * one: the host's writer lock is what prevents a fork (the dialog and CLAUDE.md say so).
 */
function refuseIfRecentlyActive(session: SessionRow, nowMs: number): void {
	if (session.isWorking) throw new BindRefusal("session_active");
	const last = parseDbTimestamp(session.lastActivityAt);
	if (last === null || !Number.isFinite(last)) throw new BindRefusal("session_active");
	const age = nowMs - last;
	if (age < SESSION_IDLE_TIMEOUT_MS) throw new BindRefusal("session_active");
	// A permission wait is never cleared by the sweep, so it counts as live only while it is recent.
	if (hasLivePermissionWait(session.metadata) && age < STUCK_WORKING_RECOVERY_MS) {
		throw new BindRefusal("session_active");
	}
}

/**
 * A member's takeover needs the session's recorded ingest key to belong to someone who owns the target host.
 * An admin isn't subject to it. This stops an admin-reassigned session, or a row a service key reported,
 * from being taken over by a member; it does NOT stop a member forging a row with their own key for a
 * thread that belongs to someone sharing their OS account (D5's stated residual).
 */
async function refuseUnlessKeyBelongsToHostOwner(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	session: SessionRow,
	hostOwnerUserId: string | null,
): Promise<void> {
	let keyOwner: string | null = null;
	if (session.ingestKeyId !== null) {
		const [key] = await tx
			.select({ ownerUserId: apiKeys.ownerUserId })
			.from(apiKeys)
			.where(eq(apiKeys.id, session.ingestKeyId))
			.limit(1);
		keyOwner = key?.ownerUserId ?? null;
	}
	if (keyOwner === null || hostOwnerUserId === null || keyOwner !== hostOwnerUserId) {
		throw new BindRefusal("session_key_mismatch");
	}
}

/** The rows have committed: a failure to announce it must not turn the answer into a 500. */
async function announceCommitted(sessionId: string, launchRequestId: string): Promise<void> {
	try {
		const [row] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (row) notifySessionUpdated(row);
		await requestWsRevalidation();
	} catch (error) {
		console.error(
			JSON.stringify({
				kind: "session_bound_notify_failed",
				level: "error",
				sessionId,
				launchRequestId,
				error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
			}),
		);
	}
}

interface ClaudeForkInput {
	fresh: SessionRow;
	cwd: string;
	host: { id: string; hostName: string };
	actor: Actor;
	intendedOwner: string | null;
	assignOwner: boolean;
	now: () => number;
	seam: (step: BindStep, tx: unknown) => Promise<void>;
}

/**
 * The write of a Claude takeover (AGEN-117 T5), in the bind's lock: one `resume` action on the observed
 * session S that names the fork N the server mints now, and nothing else. No session row, no launch, no
 * managed row and no lock: those appear when the host's verified success report settles. S is refused
 * `already_managed` while a takeover of it is open, or the newest one that succeeded names a fork still alive.
 */
async function queueClaudeFork(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	input: ClaudeForkInput,
) {
	const { fresh, cwd, host, actor, now } = input;
	const sessionId = fresh.sessionId;
	const history: Array<{ status: string; metadata: unknown }> = await tx
		.select({ status: controlActions.status, metadata: controlActions.metadata })
		.from(controlActions)
		.where(
			and(
				eq(controlActions.sessionId, sessionId),
				eq(controlActions.actionType, "resume"),
				isNotNull(jsonExtractText(controlActions.metadata, "$.forkSessionId")),
				inArray(controlActions.status, ["queued", "running", "succeeded"]),
			),
		)
		.orderBy(desc(controlActions.createdAt));
	if (history.some((row) => row.status !== "succeeded")) throw new BindRefusal("already_managed");
	const newest = history[0]?.metadata as { forkSessionId?: unknown } | undefined;
	if (typeof newest?.forkSessionId === "string") {
		const [fork] = await tx
			.select({ state: managedSessions.managedState })
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, newest.forkSessionId))
			.limit(1);
		if (fork && ["pending", "managed", "degraded"].includes(fork.state)) {
			throw new BindRefusal("already_managed");
		}
	}
	await input.seam("checked", tx);

	const forkSessionId = crypto.randomUUID();
	const carrierLaunchId = crypto.randomUUID();
	const controlActionId = crypto.randomUUID();
	const timestamp = new Date(now()).toISOString();
	const metadata = buildClaudeResumeActionMetadata({
		resumeKind: "takeover",
		threadId: sessionId,
		candidateCwd: cwd,
		expectedEnforcedArgs: privilegeCliArgs(
			"claude_code",
			CLAUDE_TAKEOVER_PRIVILEGES.approvalPolicy,
			CLAUDE_TAKEOVER_PRIVILEGES.sandboxMode,
		),
		boundByUserId: actor.userId,
		sessionName: fresh.displayName,
		forkSessionId,
		carrierLaunchId,
		targetSupervisorId: host.id,
		hostName: host.hostName,
		intendedOwner: input.intendedOwner,
		ownerAtBind: fresh.ownerUserId ?? null,
		assignOwner: input.assignOwner,
		forkDeadlineAt: new Date(now() + CLAUDE_FORK_DEADLINE_MS).toISOString(),
	});
	const [row] = await tx
		.insert(controlActions)
		.values({
			id: controlActionId,
			sessionId,
			launchRequestId: null,
			actionType: "resume",
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
			status: "queued",
			metadata,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();
	await input.seam("action", tx);
	return {
		action: mapControlAction(row),
		launchRequestId: carrierLaunchId,
		hostId: host.id,
		intendedOwner: null as string | null,
		forkOf: forkSessionId as string | null,
	};
}

export async function bindObservedSession(
	sessionId: string,
	input: BindInput,
	actor: Actor,
	deps: BindDeps = {},
): Promise<BindResult> {
	const now = deps.now ?? Date.now;
	if (
		input.sameMachineConfirmed !== true ||
		typeof input.targetSupervisorId !== "string" ||
		input.targetSupervisorId === ""
	) {
		throw new BindRefusal("invalid_body");
	}
	const mode: InstanceModeName = actor.mode ?? (await getMode());

	// ── pre-reads, cheapest refusal first ──
	const session = await readSession(getDb(), sessionId);
	const authority = refuseBindSession(
		actor,
		mode,
		session ? { ownerUserId: session.ownerUserId ?? null } : null,
	);
	if (authority !== null || session === null)
		throw new BindRefusal(authority ?? "session_not_found");
	if (session.isArchived) throw new BindRefusal("session_not_found");
	// Codex and Claude Code can be taken over; anything else (Copilot, an unknown type) is the same refusal.
	if (
		!isLaunchable(session.agentType) ||
		(session.agentType !== "codex_cli" && session.agentType !== "claude_code")
	) {
		throw new BindRefusal("agent_not_supported");
	}
	if (!isResumableSessionId(sessionId)) throw new BindRefusal("session_id_unsupported");
	if (session.cwd === null || session.cwd === "") throw new BindRefusal("cwd_unknown");

	const host = await getSupervisor(input.targetSupervisorId);
	const hostVerdict = mayBindToHost(
		actor,
		mode,
		session.ownerUserId ?? null,
		host ? { ownerUserId: host.ownerUserId ?? null, enrollmentState: host.enrollmentState } : null,
	);
	if (hostVerdict !== null || host === null) throw new BindRefusal(hostVerdict ?? "host_gone");

	const candidateCwd = judgeCandidateCwd(session.cwd, host.trustedRoots);
	const template = templateFor(session, candidateCwd);
	if (validateTemplateInput(template).errors.length > 0) throw new BindRefusal("cwd_not_trusted");
	refuseIfHostCannotRun(template, host);

	await deps.beforeLock?.();

	// ── the lock: every fact again, on tx ──
	const afterStep = deps.afterStep;
	const seam = (step: BindStep, tx: unknown) =>
		awaitSeamInsideAdminLock(
			afterStep ? (reached: BindStep) => afterStep(reached, tx) : null,
			step,
		);
	const committed = await withAdminLock(async (tx) => {
		const hostNow = await readHostState(tx, host.id, now());
		if (hostNow.state === "gone") throw new BindRefusal("host_gone");
		if (hostNow.state === "offline") throw new BindRefusal("host_offline");
		const fresh = await readSession(tx, sessionId);
		const freshAuthority = refuseBindSession(
			actor,
			mode,
			fresh ? { ownerUserId: fresh.ownerUserId ?? null } : null,
		);
		if (freshAuthority !== null || fresh === null) {
			throw new BindRefusal(freshAuthority ?? "session_not_found");
		}
		const freshHostVerdict = mayBindToHost(actor, mode, fresh.ownerUserId ?? null, {
			ownerUserId: hostNow.ownerUserId,
			enrollmentState: hostNow.enrollmentState,
		});
		if (freshHostVerdict !== null) throw new BindRefusal(freshHostVerdict);
		if (fresh.isArchived) throw new BindRefusal("session_not_found");
		if (fresh.agentType !== session.agentType) throw new BindRefusal("agent_not_supported");
		const trustedRoots = readTrustedRoots(hostNow.trustedRoots);
		const cwd = judgeCandidateCwd(fresh.cwd, trustedRoots);
		// The fresh host row, judged exactly as the pre-read judged the first one: it may have been
		// downgraded or reconfigured since.
		refuseIfHostCannotRun(templateFor(fresh, cwd), {
			...host,
			capabilities: withCapabilityDefaults(hostNow.capabilities),
			trustedRoots,
		});
		if (mode === "team" && actor.role !== "admin") {
			await refuseUnlessKeyBelongsToHostOwner(tx, fresh, hostNow.ownerUserId);
		}
		refuseIfRecentlyActive(fresh, now());
		if (
			(await findManagedRowForThread(tx, sessionId)) !== null ||
			(await findLaunchRowByCorrelationId(sessionId, tx)) !== null
		) {
			throw new BindRefusal("already_managed");
		}

		// An unowned session gets an owner only when the takeover succeeds (D6), so a failed attempt leaves
		// nothing to undo. The launch row names who it will belong to, for the readers that scope by it.
		const intendedOwner = fresh.ownerUserId ?? hostNow.ownerUserId ?? actor.userId;
		const assignOwner = mode === "team" && fresh.ownerUserId === null && intendedOwner !== null;
		if (fresh.agentType === "claude_code") {
			return await queueClaudeFork(tx, {
				fresh,
				cwd,
				host: { ...host, id: host.id, hostName: host.hostName },
				actor,
				intendedOwner,
				assignOwner,
				now,
				seam,
			});
		}
		const launchRequestId = crypto.randomUUID();
		const controlActionId = crypto.randomUUID();
		const timestamp = new Date(now()).toISOString();
		const takeoverTemplate = templateFor(fresh, cwd);
		const launchSpec = {
			...buildLaunchSpec(takeoverTemplate, "managed_codex", host),
			launchCorrelationId: sessionId,
			templateName: takeoverTemplate.name,
		} as LaunchSpec;
		await seam("checked", tx);

		try {
			await claimObservedSession(tx, {
				launch: {
					id: launchRequestId,
					launchCorrelationId: sessionId,
					agentType: "codex_cli",
					cwd,
					baseInstructions: "",
					taskPrompt: "",
					model: null,
					approvalPolicy: TAKEOVER_PRIVILEGES.approvalPolicy,
					sandboxMode: TAKEOVER_PRIVILEGES.sandboxMode,
					requestedLaunchMode: "managed_codex",
					env: {},
					launchSpec: launchSpec as unknown as Record<string, unknown>,
					requestedBy: actor.label,
					// ATTRIBUTION, not "who asked" (D19): on a carrier row this is the session's intended owner, so
					// `canReadLaunch` shows it to them. No authorization decision may read it as the actor; the
					// person who pressed the button is `metadata.boundByUserId` and the audit line.
					requestedByUserId: intendedOwner,
					requestedSupervisorId: host.id,
					routingPolicy: "manual_target",
					resolvedSupervisorId: host.id,
					claimedBySupervisorId: host.id,
					status: "completed",
					metadata: { boundObservedSession: true, boundByUserId: actor.userId },
					createdAt: timestamp,
					updatedAt: timestamp,
				},
				managed: {
					sessionId,
					launchRequestId,
					supervisorId: host.id,
					providerThreadId: sessionId,
					managedState: "pending",
					hostName: host.hostName,
					hostAffinityReason: "taken_over",
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			});
		} catch (error) {
			if (error instanceof SessionAlreadyBoundError) throw new BindRefusal("already_managed");
			throw error;
		}
		await seam("claimed", tx);

		if (!(await takeControlLock(tx, sessionId, controlActionId, timestamp, now))) {
			throw new BindRefusal("already_managed");
		}
		await seam("locked", tx);

		const metadata: ResumeActionMetadata = buildResumeActionMetadata({
			resumeKind: "takeover",
			threadId: sessionId,
			cwd,
			approvalPolicy: TAKEOVER_PRIVILEGES.approvalPolicy,
			sandboxMode: TAKEOVER_PRIVILEGES.sandboxMode,
			expectedEnforcedArgs: privilegeCliArgs(
				"codex_cli",
				TAKEOVER_PRIVILEGES.approvalPolicy,
				TAKEOVER_PRIVILEGES.sandboxMode,
			),
			assignOwner,
			boundByUserId: actor.userId,
			sessionName: fresh.displayName,
		});
		const [row] = await tx
			.insert(controlActions)
			.values({
				id: controlActionId,
				sessionId,
				launchRequestId,
				actionType: "resume",
				requestedBy: actor.label,
				requestedByUserId: actor.userId,
				status: "queued",
				metadata,
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.returning();
		await seam("action", tx);
		return {
			action: mapControlAction(row),
			launchRequestId,
			hostId: host.id,
			intendedOwner: assignOwner ? intendedOwner : null,
			forkOf: null as string | null,
		};
	});

	// ── after commit ──
	if (committed.forkOf) {
		// The session's row is unchanged (T5): the action lives on it and the new session doesn't exist yet,
		// so `launchRequestId` names a carrier row that appears only at the settle. S is announced so a
		// dashboard re-reads its actions (AGEN-117 P5-I3).
		logAdminAction("session_bound", actor, {
			sessionId,
			supervisorId: committed.hostId,
			launchRequestId: committed.launchRequestId,
			forkSessionId: committed.forkOf,
		});
		await announceCommitted(sessionId, committed.launchRequestId);
		return { action: committed.action, launchRequestId: committed.launchRequestId };
	}
	logAdminAction("session_bound", actor, {
		sessionId,
		supervisorId: committed.hostId,
		launchRequestId: committed.launchRequestId,
		...(committed.intendedOwner !== null ? { intendedOwner: committed.intendedOwner } : {}),
	});
	await announceCommitted(sessionId, committed.launchRequestId);
	return { action: committed.action, launchRequestId: committed.launchRequestId };
}

/** The name of the observed session a fork came from, for the sentences that point back to it; null if it is gone or unnamed. */
async function forkSourceName(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	fork: SessionRow,
): Promise<string | null> {
	const sourceId = (fork.metadata as { forkedFromSessionId?: unknown } | null)?.forkedFromSessionId;
	if (typeof sourceId !== "string" || sourceId === "") return null;
	const [row]: Array<{ displayName: string | null }> = await tx
		.select({ displayName: sessions.displayName })
		.from(sessions)
		.where(eq(sessions.sessionId, sourceId))
		.limit(1);
	return row?.displayName ?? null;
}

/**
 * Recovery of a fork (AGEN-117 T13), in `queueSessionResume`'s lock: the same `resume` action, on N, which
 * the host runs under the mode its own record stored (nothing here names one, and nothing re-picks it).
 */
async function queueClaudeRecovery(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	input: {
		sessionId: string;
		fresh: SessionRow;
		launch: { id: string; cwd: string | null };
		managed: typeof managedSessions.$inferSelect;
		actor: Actor;
		now: () => number;
	},
) {
	const { sessionId, fresh, launch, managed, actor, now } = input;
	const hostId = await resolveSessionOwner(tx, sessionId);
	if (hostId === null) throw new BindRefusal("host_gone");
	const hostNow = await readHostState(tx, hostId, now());
	if (hostNow.state === "gone") throw new BindRefusal("host_gone");
	if (hostNow.state === "offline") throw new BindRefusal("host_offline");
	const trustedRoots = readTrustedRoots(hostNow.trustedRoots);
	const cwd = judgeCandidateCwd(launch.cwd, trustedRoots);
	const template = normalizeTemplateInput({
		name: "Resume",
		agentType: "claude_code",
		cwd,
		model: null,
		approvalPolicy: CLAUDE_TAKEOVER_PRIVILEGES.approvalPolicy,
		sandboxMode: CLAUDE_TAKEOVER_PRIVILEGES.sandboxMode,
		env: {},
	});
	refuseIfHostCannotRun(template, {
		id: hostId,
		hostName: managed.hostName ?? hostId,
		platform: "",
		arch: "",
		version: "",
		capabilities: withCapabilityDefaults(hostNow.capabilities),
		trustedRoots,
	} as SupervisorRecord);
	const controlActionId = crypto.randomUUID();
	const timestamp = new Date(now()).toISOString();
	if (!(await takeControlLock(tx, sessionId, controlActionId, timestamp, now))) {
		throw new BindRefusal("not_resumable");
	}
	const metadata = buildClaudeResumeActionMetadata({
		resumeKind: "recovery",
		threadId: sessionId,
		candidateCwd: cwd,
		expectedEnforcedArgs: privilegeCliArgs(
			"claude_code",
			CLAUDE_TAKEOVER_PRIVILEGES.approvalPolicy,
			CLAUDE_TAKEOVER_PRIVILEGES.sandboxMode,
		),
		boundByUserId: actor.userId,
		sessionName: fresh.displayName,
		sourceName: await forkSourceName(tx, fresh),
	});
	const [row] = await tx
		.insert(controlActions)
		.values({
			id: controlActionId,
			sessionId,
			launchRequestId: launch.id,
			actionType: "resume",
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
			status: "queued",
			metadata,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();
	return { action: mapControlAction(row), launchRequestId: launch.id, hostId };
}

/**
 * Resumes a managed Codex session whose process is gone (AGEN-115, recovery): the same `resume` action a
 * takeover queues, for a row the host reported (or registration stamped) `degraded`, with the privileges
 * and directory its own launch recorded. Authority is the session's (`refuseBindSession`); the host is the
 * launch's own, so there is no host-owner check. Refused, with nothing queued, unless the row is degraded,
 * its thread id is a UUID, the launch is Codex and consistent with the owner of record, and that host is
 * live, current and still allows the directory.
 */
export async function queueSessionResume(
	sessionId: string,
	actor: Actor,
	deps: Pick<BindDeps, "now" | "beforeLock"> = {},
): Promise<BindResult> {
	const now = deps.now ?? Date.now;
	const mode: InstanceModeName = actor.mode ?? (await getMode());
	const session = await readSession(getDb(), sessionId);
	const authority = refuseBindSession(
		actor,
		mode,
		session ? { ownerUserId: session.ownerUserId ?? null } : null,
	);
	if (authority !== null || session === null)
		throw new BindRefusal(authority ?? "session_not_found");
	if (session.isArchived) throw new BindRefusal("session_not_found");

	await deps.beforeLock?.();

	const committed = await withAdminLock(async (tx) => {
		// Authority is judged again on what the lock sees: an admin may have reassigned the session since the
		// pre-read, and the former owner's recovery must not queue.
		const fresh = await readSession(tx, sessionId);
		const freshAuthority = refuseBindSession(
			actor,
			mode,
			fresh ? { ownerUserId: fresh.ownerUserId ?? null } : null,
		);
		if (freshAuthority !== null || fresh === null) {
			throw new BindRefusal(freshAuthority ?? "session_not_found");
		}
		if (fresh.isArchived) throw new BindRefusal("session_not_found");
		const [managed] = await tx
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId))
			.limit(1);
		if (!managed || managed.managedState !== "degraded") throw new BindRefusal("not_resumable");
		const threadId = managed.providerThreadId;
		if (typeof threadId !== "string" || !isResumableSessionId(threadId)) {
			throw new BindRefusal("not_resumable");
		}
		const launch = await resolveManagedLaunch(tx, sessionId, managed.launchRequestId);
		if (
			!launch ||
			launch.launchCorrelationId !== sessionId ||
			(launch.agentType !== "codex_cli" && launch.agentType !== "claude_code") ||
			!(await launchOwnedBySessionOwner(tx, sessionId, launch))
		) {
			throw new BindRefusal("not_resumable");
		}
		if (launch.agentType === "claude_code") {
			// Only a fork this feature made is resumed (T13); a launched Claude session never is.
			if (
				!isClaudeTakeoverLaunch(launch) ||
				!(fresh.metadata as Record<string, unknown> | null)?.forkedFromSessionId ||
				threadId !== sessionId
			) {
				throw new BindRefusal("not_resumable");
			}
			return await queueClaudeRecovery(tx, {
				sessionId,
				fresh,
				launch,
				managed,
				actor,
				now,
			});
		}

		const hostId = await resolveSessionOwner(tx, sessionId);
		if (hostId === null) throw new BindRefusal("host_gone");
		const hostNow = await readHostState(tx, hostId, now());
		if (hostNow.state === "gone") throw new BindRefusal("host_gone");
		if (hostNow.state === "offline") throw new BindRefusal("host_offline");
		const trustedRoots = readTrustedRoots(hostNow.trustedRoots);
		const cwd = judgeCandidateCwd(launch.cwd, trustedRoots);
		const template = normalizeTemplateInput({
			name: "Resume",
			agentType: "codex_cli",
			cwd,
			model: null,
			approvalPolicy: launch.approvalPolicy as SessionTemplateInput["approvalPolicy"],
			sandboxMode: launch.sandboxMode as SessionTemplateInput["sandboxMode"],
			env: {},
		});
		refuseIfHostCannotRun(template, {
			id: hostId,
			hostName: managed.hostName ?? hostId,
			platform: "",
			arch: "",
			version: "",
			capabilities: withCapabilityDefaults(hostNow.capabilities),
			trustedRoots,
		} as SupervisorRecord);

		const controlActionId = crypto.randomUUID();
		const timestamp = new Date(now()).toISOString();
		if (!(await takeControlLock(tx, sessionId, controlActionId, timestamp, now))) {
			throw new BindRefusal("not_resumable");
		}
		const metadata: ResumeActionMetadata = buildResumeActionMetadata({
			resumeKind: "recovery",
			threadId,
			cwd,
			approvalPolicy: template.approvalPolicy ?? null,
			sandboxMode: template.sandboxMode ?? null,
			expectedEnforcedArgs: privilegeCliArgs(
				"codex_cli",
				template.approvalPolicy,
				template.sandboxMode,
			),
			boundByUserId: actor.userId,
			sessionName: managed.desiredThreadTitle ?? fresh.displayName,
		});
		const [row] = await tx
			.insert(controlActions)
			.values({
				id: controlActionId,
				sessionId,
				launchRequestId: launch.id,
				actionType: "resume",
				requestedBy: actor.label,
				requestedByUserId: actor.userId,
				status: "queued",
				metadata,
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.returning();
		return { action: mapControlAction(row), launchRequestId: launch.id as string, hostId };
	});

	logAdminAction("session_resumed", actor, {
		sessionId,
		supervisorId: committed.hostId,
		launchRequestId: committed.launchRequestId,
	});
	await announceCommitted(sessionId, committed.launchRequestId);
	return { action: committed.action, launchRequestId: committed.launchRequestId };
}
