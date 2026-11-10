import { and, eq, ne, sql } from "drizzle-orm";
import { forkFirstRowContent } from "../../shared/claude-fork-copy.js";
import {
	CLAUDE_TAKEOVER_PRIVILEGES,
	type ClaudeForkMode,
	FORK_OPTIONS_CONSENT_KEY,
	FORK_OPTIONS_OFF,
	type ResumeFailureKind,
	SESSION_RESUMED_EVENT_TYPE,
	clampAppliedToRequested,
	forkOptionsAreOff,
	forkOptionsRequested,
	isClaudeForkMode,
	isResumableSessionId,
	parseAppliedForkOptions,
	parseForkOptionsRequest,
} from "../../shared/session-resume.js";
import type { LaunchSpec, SupervisorRecord } from "../../shared/types.js";
import type { Actor } from "../auth/actor.js";
import { assertOwnerAssignable } from "../auth/owner-state.js";
import { config } from "../config.js";
import { events, apiKeys, controlActions, sessions, users } from "../db/schema/index.js";
import { jsonExtractText } from "../db/sql-helpers.js";
import { mayBindSession, mayBindToHost, mayUseForkOptionsOnHost } from "./authorization.js";
/**
 * The server's half of a Claude takeover (AGEN-117 T5, T6): the host has forked the observed session S into a
 * new conversation N, verified it, and reports success. Nothing about N exists until this runs. In the
 * caller's transaction it re-judges every fact the bind judged (the binder's authority, the host, S's owner,
 * the intended owner, the directory the host proved, the mode it reports) and only then writes N's session
 * row, the carrier launch and the managed row, and N's first timeline row. Any failed judgement or conflict
 * returns a failure kind and writes nothing; the caller fails the action (the host then kills the child).
 *
 * S's row is never written. A leaf of the control-action settle: it flips no action and announces nothing.
 */
import { redactShortForStorage } from "./ingest-redaction.js";
import { getModeOn } from "./instance-mode.js";
import { buildLaunchSpec, isWithinTrustedRoot } from "./launch-compatibility.js";
import {
	SessionAlreadyBoundError,
	claimObservedSession,
	readHostState,
} from "./session-ownership.js";
import { readTrustedRoots } from "./supervisor-capabilities.js";
import { normalizeTemplateInput } from "./template-preview.js";

/** A conflict found after a write: the caller's transaction must roll back, then fail the action on its own. */
export class ForkSettleRollback extends Error {
	constructor(readonly kind: ResumeFailureKind) {
		super(`fork settle rolled back: ${kind}`);
		this.name = "ForkSettleRollback";
	}
}

export interface ForkSettleReport {
	provedCwd: unknown;
	permissionMode: unknown;
	/** What the host says it applied of the fork options. Judged for shape; absent from a host older than the options. */
	applied?: unknown;
}

export type ForkSettleResult =
	| { ok: true; forkId: string; sourceId: string }
	| { ok: false; kind: ResumeFailureKind };

interface ForkAction {
	id: string;
	sessionId: string | null;
	metadata?: unknown;
}

const str = (value: unknown): string | null =>
	typeof value === "string" && value !== "" ? value : null;

/** Whether `inner` is `outer` or below it. Both are absolute paths the host and server have already shaped. */
function insideOrEqual(inner: string, outer: string): boolean {
	const base = outer.endsWith("/") ? outer.slice(0, -1) : outer;
	return inner === outer || inner === base || inner.startsWith(`${base}/`);
}

async function binderActor(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	boundByUserId: string | null,
	mode: "solo" | "team",
): Promise<Actor | null> {
	if (boundByUserId === null) {
		// A takeover with no person behind it is a solo, auth-off one; in team mode nobody could have pressed it.
		return mode === "solo" ? { userId: null, label: "anonymous", role: "admin", mode } : null;
	}
	const [user] = await tx
		.select({ role: users.role, disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, boundByUserId))
		.limit(1);
	if (!user || user.disabledAt !== null) return null;
	return {
		userId: boundByUserId,
		label: "user",
		role: user.role === "admin" ? "admin" : "member",
		mode,
	};
}

async function keyOwnerOf(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	keyId: string | null,
): Promise<string | null> {
	if (keyId === null) return null;
	const [key] = await tx
		.select({ ownerUserId: apiKeys.ownerUserId })
		.from(apiKeys)
		.where(eq(apiKeys.id, keyId))
		.limit(1);
	return key?.ownerUserId ?? null;
}

/** The name N is shown under: S's, with a count when S has been continued before. */
async function forkDisplayName(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	sourceId: string,
	base: string,
	thisActionId: string,
): Promise<string> {
	const rows: Array<{ id: string }> = await tx
		.select({ id: controlActions.id })
		.from(controlActions)
		.where(
			and(
				eq(controlActions.sessionId, sourceId),
				eq(controlActions.actionType, "resume"),
				eq(controlActions.status, "succeeded"),
				ne(controlActions.id, thisActionId),
				sql`${jsonExtractText(controlActions.metadata, "$.forkSessionId")} is not null`,
			),
		);
	const label = rows.length === 0 ? "(continued)" : `(continued ${rows.length + 1})`;
	return `${base} ${label}`.slice(0, 200);
}

export async function settleClaudeTakeover(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	action: ForkAction,
	report: ForkSettleReport,
	nowMs: number,
): Promise<ForkSettleResult> {
	const meta = (action.metadata ?? {}) as Record<string, unknown>;
	const sourceId = action.sessionId;
	const forkId = str(meta.forkSessionId);
	const carrierId = str(meta.carrierLaunchId);
	const hostId = str(meta.targetSupervisorId);
	const candidate = str(meta.candidateCwd);
	if (
		sourceId === null ||
		forkId === null ||
		carrierId === null ||
		hostId === null ||
		!isResumableSessionId(sourceId) ||
		!isResumableSessionId(forkId) ||
		forkId === sourceId
	) {
		return { ok: false, kind: "settle_conflict" };
	}
	// The host is trusted for which mode and where, not for the shape of either.
	const mode: ClaudeForkMode | null = isClaudeForkMode(report.permissionMode)
		? report.permissionMode
		: null;
	const proved = str(report.provedCwd);
	if (mode === null || proved === null || !proved.startsWith("/") || candidate === null) {
		return { ok: false, kind: "rejected" };
	}

	// A share lock on S on Postgres: a delete of S can't commit between this read and the writes below.
	const sourceRead = tx
		.select({
			ownerUserId: sessions.ownerUserId,
			ingestKeyId: sessions.ingestKeyId,
			agentType: sessions.agentType,
			displayName: sessions.displayName,
			isArchived: sessions.isArchived,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, sourceId))
		.limit(1);
	const [source] = await (config.dialect === "postgres" ? sourceRead.for("share") : sourceRead);
	if (!source || source.isArchived || source.agentType !== "claude_code") {
		return { ok: false, kind: "settle_conflict" };
	}

	const instanceMode = await getModeOn(tx);
	const actor = await binderActor(
		tx,
		typeof meta.boundByUserId === "string" ? meta.boundByUserId : null,
		instanceMode,
	);
	if (actor === null) return { ok: false, kind: "ownership_changed" };
	const sourceOwner: string | null = source.ownerUserId ?? null;
	if (sourceOwner !== ((meta.ownerAtBind as string | null | undefined) ?? null)) {
		return { ok: false, kind: "ownership_changed" };
	}
	if (!mayBindSession(actor, instanceMode, { ownerUserId: sourceOwner })) {
		return { ok: false, kind: "ownership_changed" };
	}
	const host = await readHostState(tx, hostId, nowMs);
	if (host.state === "gone") return { ok: false, kind: "ownership_changed" };
	const hostVerdict = mayBindToHost(actor, instanceMode, sourceOwner, {
		ownerUserId: host.ownerUserId,
		enrollmentState: host.enrollmentState,
	});
	if (hostVerdict !== null) return { ok: false, kind: "ownership_changed" };
	// The options run the person's own configuration on the host: judged again, as the bind judged them.
	const requestedOptions = parseForkOptionsRequest(meta.forkOptions) ?? {};
	// What the host says it applied is held to what the bind asked for: an option nobody asked for is off, and
	// a request that was never made creates no consent (review codex-M1).
	const applied = clampAppliedToRequested(
		parseAppliedForkOptions(report.applied) ?? FORK_OPTIONS_OFF,
		requestedOptions,
	);
	if (
		forkOptionsRequested(requestedOptions) &&
		mayUseForkOptionsOnHost(actor, instanceMode, { ownerUserId: host.ownerUserId }) !== null
	) {
		return { ok: false, kind: "ownership_changed" };
	}

	// Parity with the bind: a member's takeover needs the key that reported S to belong to the host's owner.
	if (instanceMode === "team" && actor.role !== "admin") {
		const keyOwner = await keyOwnerOf(tx, source.ingestKeyId ?? null);
		if (keyOwner === null || host.ownerUserId === null || keyOwner !== host.ownerUserId) {
			return { ok: false, kind: "ownership_changed" };
		}
	}

	const roots = readTrustedRoots(host.trustedRoots);
	if (!isWithinTrustedRoot(proved, roots) || !insideOrEqual(candidate, proved)) {
		return { ok: false, kind: "cwd_mismatch" };
	}

	const assign = meta.assignOwner === true;
	const intended = str(meta.intendedOwner);
	if (assign) {
		if (intended === null) return { ok: false, kind: "ownership_changed" };
		try {
			await assertOwnerAssignable(tx, intended);
		} catch {
			return { ok: false, kind: "ownership_changed" };
		}
	}
	const owner = sourceOwner ?? (assign ? intended : null);

	const timestamp = new Date(nowMs).toISOString();
	const name = await forkDisplayName(
		tx,
		sourceId,
		redactShortForStorage(source.displayName?.trim() || `session ${sourceId.slice(0, 8)}`),
		action.id,
	);
	const inserted = await tx
		.insert(sessions)
		.values({
			sessionId: forkId,
			agentType: "claude_code",
			cwd: proved,
			displayName: name,
			ownerUserId: owner,
			status: "idle",
			isWorking: false,
			lastActivityAt: timestamp,
			metadata: {
				forkedFromSessionId: sourceId,
				forkPermissionBranch: mode,
				// Server-owned: what the host says it applied, or none (a host older than the options).
				forkOptions: applied,
				// The host owner who consented to the options, recorded when any run (H1).
				...(forkOptionsAreOff(applied) || host.ownerUserId === null
					? {}
					: { [FORK_OPTIONS_CONSENT_KEY]: host.ownerUserId }),
			},
		})
		.onConflictDoNothing()
		.returning({ id: sessions.id });
	if (inserted.length === 0) return { ok: false, kind: "settle_conflict" };

	const template = normalizeTemplateInput({
		name: `Continue: ${name}`.slice(0, 120),
		agentType: "claude_code",
		cwd: proved,
		baseInstructions: "",
		taskPrompt: "",
		model: null,
		approvalPolicy: CLAUDE_TAKEOVER_PRIVILEGES.approvalPolicy,
		sandboxMode: CLAUDE_TAKEOVER_PRIVILEGES.sandboxMode,
		env: {},
	});
	const launchSpec = {
		...buildLaunchSpec(template, "headless", {} as SupervisorRecord),
		launchCorrelationId: forkId,
		templateName: template.name,
	} as LaunchSpec;
	try {
		await claimObservedSession(tx, {
			launch: {
				id: carrierId,
				launchCorrelationId: forkId,
				agentType: "claude_code",
				cwd: proved,
				baseInstructions: "",
				taskPrompt: "",
				model: null,
				approvalPolicy: CLAUDE_TAKEOVER_PRIVILEGES.approvalPolicy,
				sandboxMode: CLAUDE_TAKEOVER_PRIVILEGES.sandboxMode,
				requestedLaunchMode: "headless",
				env: {},
				launchSpec: launchSpec as unknown as Record<string, unknown>,
				requestedBy: "takeover",
				// ATTRIBUTION, as for a Codex takeover (D19): the session's owner, never a decision input.
				requestedByUserId: owner,
				requestedSupervisorId: hostId,
				routingPolicy: "manual_target",
				resolvedSupervisorId: hostId,
				claimedBySupervisorId: hostId,
				status: "completed",
				metadata: {
					boundObservedSession: true,
					boundByUserId: actor.userId,
					sourceSessionId: sourceId,
					permissionBranch: mode,
				},
				createdAt: timestamp,
				updatedAt: timestamp,
			},
			managed: {
				sessionId: forkId,
				launchRequestId: carrierId,
				supervisorId: hostId,
				providerThreadId: forkId,
				providerSessionId: forkId,
				managedState: "managed",
				hostName: str(meta.hostName) ?? hostId,
				hostAffinityReason: "taken_over",
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		});
	} catch (error) {
		if (error instanceof SessionAlreadyBoundError) throw new ForkSettleRollback("settle_conflict");
		throw error;
	}
	await tx.insert(events).values({
		sessionId: forkId,
		eventType: SESSION_RESUMED_EVENT_TYPE,
		category: "system_event",
		source: "managed_control",
		// The source's name came from the agent (or a person); a key in it is masked before it is copied.
		content: forkFirstRowContent(
			mode,
			str(meta.hostName),
			source.displayName ? redactShortForStorage(source.displayName) : source.displayName,
		),
		isNoise: false,
		rawPayload: { resume_kind: "takeover", forked_from: sourceId },
		createdAt: timestamp,
	});
	return { ok: true, forkId, sourceId };
}
