import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cleanHostText } from "../../shared/clean-host-text.js";
import {
	CLAUDE_APPROVALS_SERVER_FEATURE,
	CODEX_APPROVALS_SERVER_FEATURE,
	CODEX_APPROVAL_LIMITS,
} from "../../shared/codex-approvals.js";
import { CLAUDE_TURN_CONTROL } from "../../shared/constants.js";
import { FORK_TOOL_DETAIL, FORK_TOOL_DETAIL_LIMITS } from "../../shared/fork-tool-calls.js";
import { DELIVERY_ID_HEADER, REPLAY_HEADER } from "../../shared/hook-headers.js";
import { privilegeCliArgs } from "../../shared/launch-privileges.js";
import {
	MANAGED_REPORT_BODY_LIMIT_BYTES,
	MAX_EVENT_CONTENT_CHARS,
} from "../../shared/managed-report-limits.js";
import type {
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	SessionEvent,
	SupervisorRegistrationInput,
} from "../../shared/types.js";
import type { AuthUser } from "../auth/middleware.js";
import { requireAuth, requireScope, requireSupervisorAuth } from "../auth/middleware.js";
import { OwnerDisabledError, OwnerNotFoundError } from "../auth/owner-state.js";
import { getRequestActor, requireRolePolicy } from "../auth/route-scope-policy.js";
import {
	consumeEnrollmentToken,
	createSupervisorEnrollmentToken,
	extractSupervisorToken,
	verifyEnrollmentToken,
	verifySupervisorCredential,
} from "../auth/supervisor-auth.js";
import { config } from "../config.js";
import { logAdminAction } from "../services/audit-log.js";
import {
	AdminRequiredError,
	HostNotFoundError,
	NotOwnerError,
	assertCanEnrollHost,
	assertCanIssueHostToken,
	assertCanManageHost,
	isHostTokenCreatorStillAllowed,
} from "../services/authorization.js";
import {
	ApprovalRefusal,
	closeApprovalsForRestartedHost,
	parseApprovalReport,
	parseApprovalSync,
	recordApprovalRequest,
	syncApprovals,
} from "../services/codex-approvals.js";
import {
	claimNextControlAction,
	failOpenForkActionsOfRestartedHost,
	failRunningClaudePromptsOfRestartedHost,
	updateControlAction,
} from "../services/control-actions.js";
import { parseDeliveryId } from "../services/event-dedup.js";
import {
	ForkToolDetailRefusal,
	forkToolDetailAvailable,
	parseForkToolCallsReport,
	recordForkToolCalls,
} from "../services/fork-tool-detail.js";
import {
	claimNextLaunchRequest,
	failRunningHeadlessLaunchesOfRestartedHost,
	updateLaunchDispatchStatus,
} from "../services/launch-dispatch.js";
import { associateObservedSession } from "../services/launch-dispatch.js";
import { cleanMachineName } from "../services/machine-name.js";
import {
	ReservedEventTypeError,
	appendManagedSessionDelivery,
	appendManagedSessionEvents,
	degradeClaudeForksOfRestartedHost,
	degradeCodexSessionsOfRestartedHost,
	listManagedSessionsNeedingSync,
	upsertManagedSessionState,
} from "../services/managed-session-state.js";
import { notifySessionEvents, notifySessionUpdated } from "../services/notifier.js";
import { REPLAY_RETRY_AFTER_SECONDS, tryAcquireReplay } from "../services/replay-limiter.js";
import {
	SessionOwnershipError,
	assertSupervisorCanWriteSession,
} from "../services/session-ownership.js";
import { broadcastSweptSessions, getSession } from "../services/session-tracker.js";
import { parseRegistrationShape } from "../services/supervisor-capabilities.js";
import {
	readHeartbeatBody,
	recordHeartbeatExcludeState,
} from "../services/supervisor-exclude-state.js";
import { parseOutboxState } from "../services/supervisor-outbox-state.js";
import {
	enrollSupervisor,
	getSupervisor,
	heartbeatSupervisor,
	listSupervisors,
	registerSupervisor,
	revokeHost,
	setSupervisorOwner,
} from "../services/supervisor-registry.js";
import { FixedWindowCounter } from "../services/util/fixed-window-counter.js";
import { sha256Hex } from "../services/util/hash.js";

// ── Dashboard-management router (requireAuth) ─────────────────────────────────
// Mounted at /api/v1/admin/supervisors — falls through to the forwardauth
// catch-all IngressRoute rule so SSO sessions carry live IdP revocation.
// /api/v1/admin/* is intentionally NOT in the IngressRoute exemption list.

const supervisorsAdminRouter = new Hono();

// Gate the entire admin router: must be authenticated AND carry the "manage" scope.
// forwardauth/local sessions pass requireScope unconditionally; only api_key callers
// are checked for the "manage" capability.
supervisorsAdminRouter.use("*", requireAuth());
supervisorsAdminRouter.use("*", requireScope("manage"));
// The bundle already applies the role policy before this router; mounting it
// here too keeps the router safe if it is ever mounted elsewhere (the policy
// judges a request once).
supervisorsAdminRouter.use("*", requireRolePolicy());

supervisorsAdminRouter.get("/supervisors", async (c) => {
	const supervisors = await listSupervisors();
	return c.json({ supervisors, total: supervisors.length });
});

supervisorsAdminRouter.get("/supervisors/:id", async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const supervisor = await getSupervisor(supervisorId);
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	return c.json({ supervisor });
});

supervisorsAdminRouter.post("/supervisors/enroll", async (c: Context) => {
	const body = await c.req.json<{
		name?: string;
		expiresAt?: string | null;
		supervisorId?: string | null;
	}>();
	try {
		await assertCanEnrollHost(await getRequestActor(c));
	} catch (err) {
		if (err instanceof AdminRequiredError) return c.json({ error: "admin_required" }, 403);
		throw err;
	}
	const scopedHostId = body.supervisorId ?? null;
	if (scopedHostId) {
		const refusal = await refuseUnlessMayIssueHostToken(c, scopedHostId);
		if (refusal) return refusal;
	}
	const authUser = c.get("authUser") as AuthUser | undefined;
	const result = await createSupervisorEnrollmentToken(
		body.name?.trim() || "supervisor",
		body.expiresAt ?? null,
		scopedHostId,
		authUser?.userId ?? null,
	);
	return c.json(result, 201);
});

// PATCH /api/v1/admin/supervisors/:id - { ownerUserId | null }. An admin hands
// a host to a user, or takes its owner away. Judged by the role policy.
supervisorsAdminRouter.patch("/supervisors/:id", async (c: Context) => {
	const supervisorId = c.req.param("id") ?? "";
	const body = (await c.req.json().catch(() => null)) as { ownerUserId?: unknown } | null;
	const owner = body?.ownerUserId;
	if (body === null || !("ownerUserId" in body) || (owner !== null && typeof owner !== "string")) {
		return c.json({ error: "invalid_patch" }, 400);
	}
	try {
		const result = await setSupervisorOwner(supervisorId, owner);
		if (!result.found) return c.json({ error: "Supervisor not found" }, 404);
		logAdminAction("supervisor_owner_changed", await getRequestActor(c), {
			supervisorId,
			from: result.from,
			to: result.to,
		});
		return c.json({ ok: true, ownerUserId: result.to });
	} catch (err) {
		if (err instanceof OwnerNotFoundError) return c.json({ error: "user_not_found" }, 404);
		if (err instanceof OwnerDisabledError) return c.json({ error: "user_disabled" }, 409);
		throw err;
	}
});

// Rotating and revoking a host: solo as always; team, the host's owner or an
// admin (a host with no owner is an admin's). Owning a host never decides who
// may launch on it.
async function refuseUnlessMayManageHost(
	c: Context,
	supervisorId: string,
): Promise<Response | null> {
	try {
		await assertCanManageHost(await getRequestActor(c), supervisorId);
		return null;
	} catch (err) {
		if (err instanceof NotOwnerError) return c.json({ error: "not_owner" }, 403);
		throw err;
	}
}

// A token scoped to a host re-keys it: the host's owner or an admin, and a
// revoked host is an admin's. Solo as always.
async function refuseUnlessMayIssueHostToken(
	c: Context,
	supervisorId: string,
): Promise<Response | null> {
	try {
		await assertCanIssueHostToken(await getRequestActor(c), supervisorId);
		return null;
	} catch (err) {
		if (err instanceof HostNotFoundError) return c.json({ error: "Supervisor not found" }, 404);
		if (err instanceof NotOwnerError) return c.json({ error: "not_owner" }, 403);
		if (err instanceof AdminRequiredError) return c.json({ error: "admin_required" }, 403);
		throw err;
	}
}

supervisorsAdminRouter.post("/supervisors/:id/rotate", async (c: Context) => {
	const supervisorId = c.req.param("id") ?? "";
	const supervisor = await getSupervisor(supervisorId);
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	const refusal = await refuseUnlessMayIssueHostToken(c, supervisorId);
	if (refusal) return refusal;
	const body = await c.req.json<{ expiresAt?: string | null }>();
	const authUser = c.get("authUser") as AuthUser | undefined;
	const result = await createSupervisorEnrollmentToken(
		`rotate:${supervisor.hostName}`,
		body.expiresAt ?? null,
		supervisorId,
		authUser?.userId ?? null,
	);
	return c.json(result, 201);
});

supervisorsAdminRouter.post("/supervisors/:id/revoke", async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const refusal = await refuseUnlessMayManageHost(c, supervisorId);
	if (refusal) return refusal;
	await revokeHost(supervisorId);
	return c.json({ ok: true });
});

// ── Machine-agent router (requireSupervisorAuth / enrollment-token) ───────────
// Mounted at /api/v1/supervisors — edge-public (exempt from forwardauth).
// Each endpoint carries explicit in-process auth; supervisor agents running on
// remote machines cannot hold an SSO session.

const supervisorsAgentRouter = new Hono();

/** What this server can do for a supervisor (D14). Sent on register and heartbeat; absent means off. */
const SERVER_FEATURES = [
	CODEX_APPROVALS_SERVER_FEATURE,
	CLAUDE_APPROVALS_SERVER_FEATURE,
	CLAUDE_TURN_CONTROL,
] as const;

/**
 * The features this server offers right now. `fork_tool_detail` (AGEN-123) is offered only while the secrets
 * key that encrypts the detail is set, so a host never sends text a server can't keep safely.
 */
function currentServerFeatures(): string[] {
	return [...SERVER_FEATURES, ...(forkToolDetailAvailable() ? [FORK_TOOL_DETAIL] : [])];
}

/**
 * A supervisor registered again, so its previous process (and the app-servers it ran) is gone: its open
 * approvals close. A failure here must not fail the registration (the credential may already be issued and
 * the enrollment token spent); the rows are then closed by the host's absence from the next sync and by
 * their expiry.
 */
async function closeRestartedHostApprovals(supervisorId: string): Promise<void> {
	try {
		await closeApprovalsForRestartedHost(supervisorId);
	} catch {
		console.error("[supervisors] could not close a restarted host's approvals");
	}
}

/**
 * The same registration, for the host's Codex sessions: their app-servers are gone, so they leave
 * `managed` and stop reading as working, and prompts still waiting for them fail. A failure here
 * must not fail the registration either. The changed sessions are announced after the commit.
 */
async function degradeRestartedHostSessions(supervisorId: string): Promise<void> {
	let forks: string[] = [];
	try {
		// A takeover still being made on the old process is over; its forks are gone with that process.
		await failOpenForkActionsOfRestartedHost(supervisorId);
		forks = await degradeClaudeForksOfRestartedHost(supervisorId);
	} catch {
		console.error("[supervisors] could not degrade a restarted host's Claude forks");
	}
	try {
		const changed = await degradeCodexSessionsOfRestartedHost(supervisorId);
		// Batched, and not awaited: the supervisor's registration has 15 s, and an announcement is not worth it.
		void broadcastSweptSessions([...forks, ...changed]).catch(() => {
			console.error("[supervisors] could not announce a restarted host's sessions");
		});
	} catch {
		console.error("[supervisors] could not degrade a restarted host's Codex sessions");
		if (forks.length > 0) void broadcastSweptSessions(forks).catch(() => {});
	}
}

/**
 * The same registration, for the host's Claude turns: a headless launch still `running` and a Claude prompt
 * still `running` belong to a process that is gone, and each would hold its session's turn guard shut. They
 * fail with fixed words so the session can take a prompt again without waiting on anything. A failure here
 * must not fail the registration either.
 */
async function failRestartedHostClaudeTurns(supervisorId: string): Promise<void> {
	try {
		await failRunningHeadlessLaunchesOfRestartedHost(supervisorId);
	} catch {
		console.error("[supervisors] could not free a restarted host's headless launches");
	}
	try {
		await failRunningClaudePromptsOfRestartedHost(supervisorId);
	} catch {
		console.error("[supervisors] could not free a restarted host's Claude prompts");
	}
}

// Registration is reachable before any credential check, so its body is capped.
const REGISTER_BODY_LIMIT_BYTES = 64 * 1024;

// The shape of capabilities and trusted roots is only checked once the caller
// has proved who it is, and before the enrollment token is spent.
const invalidShape = (input: SupervisorRegistrationInput) => {
	const shape = parseRegistrationShape(input);
	if (!shape.ok) return shape.body;
	input.capabilities = shape.capabilities;
	input.trustedRoots = shape.trustedRoots;
	return null;
};

const registerBodyLimit = bodyLimit({
	maxSize: REGISTER_BODY_LIMIT_BYTES,
	onError: (c) => c.json({ error: "payload_too_large" }, 413),
});

supervisorsAgentRouter.post("/supervisors/register", registerBodyLimit, async (c) => {
	const body = await c.req.json<SupervisorRegistrationInput | null>().catch((err: unknown) => {
		// Only malformed JSON is the caller's mistake to report here; anything
		// else, such as the body limit aborting an oversized read, must propagate.
		if (!(err instanceof SyntaxError)) throw err;
		return null;
	});
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return c.json({ error: "Request body must be a JSON object" }, 400);
	}
	const registrationInput: SupervisorRegistrationInput = { ...body };
	const cleanedHostName = cleanMachineName(
		typeof registrationInput.hostName === "string" ? registrationInput.hostName : null,
	);
	if (
		!cleanedHostName ||
		!registrationInput.platform ||
		!registrationInput.arch ||
		!registrationInput.version
	) {
		return c.json({ error: "Missing required supervisor fields" }, 400);
	}
	registrationInput.hostName = cleanedHostName;

	let credential: { id: string; supervisorId: string; name: string } | null = null;
	// The enrollment token's creator, threaded into registerSupervisor below
	// so a brand-new supervisor is owned by whoever enrolled it.
	// registerSupervisor only ever applies this on first enrollment — a
	// rotation token also carries a creator here, but re-registration of an
	// existing supervisor (rotation included) never changes or fills the
	// owner. A credential-based re-registration (the common case after the
	// first register) carries no creator concept and leaves this null, which
	// is moot either way for an existing row.
	let enrollmentCreatedByUserId: string | null = null;
	let consumedEnrollment = false;
	if (!config.disableAuth) {
		const token = extractSupervisorToken({
			get: (name: string) => c.req.header(name) ?? null,
		});
		if (token) {
			credential = await verifySupervisorCredential(token);
		}
		if (credential) {
			if (registrationInput.id && credential.supervisorId !== registrationInput.id) {
				return c.json(
					{ error: "Supervisor credential does not match requested supervisor id" },
					403,
				);
			}
			// A credential speaks for its own host only; without an id the upsert
			// would insert a new, unowned host row.
			registrationInput.id = credential.supervisorId;
		} else if (registrationInput.enrollmentToken) {
			const verifiedEnrollment = await verifyEnrollmentToken(registrationInput.enrollmentToken);
			if (!verifiedEnrollment) return c.json({ error: "Invalid enrollment token" }, 401);
			if (verifiedEnrollment.supervisorId) {
				if (registrationInput.id && registrationInput.id !== verifiedEnrollment.supervisorId) {
					return c.json({ error: "Enrollment token is scoped to a different supervisor" }, 403);
				}
				registrationInput.id = verifiedEnrollment.supervisorId;
				// Judged again now: the host may have changed hands, been revoked, or
				// its token's creator demoted since the token was minted.
				const stillAllowed = await isHostTokenCreatorStillAllowed({
					createdByUserId: verifiedEnrollment.createdByUserId,
					hostId: registrationInput.id,
				});
				if (!stillAllowed) return c.json({ error: "Enrollment token is no longer valid" }, 409);
			} else if (registrationInput.id) {
				// Unscoped enrollment token + explicit supervisor id = slot-takeover vector.
				// registerSupervisor upserts on id and revokeSupervisorCredential would revoke
				// the victim's live credential, handing a fresh one to the caller.
				// Block it here; the legitimate re-keying path is the scoped /admin/supervisors/:id/rotate
				// endpoint, which issues an enrollment token scoped to the specific supervisor.
				const existing = await getSupervisor(registrationInput.id);
				if (existing) {
					return c.json({ error: "supervisor_exists_use_rotate" }, 409);
				}
			}
			const shapeError = invalidShape(registrationInput);
			if (shapeError) return c.json(shapeError, 400);
			const consumed = await consumeEnrollmentToken(registrationInput.enrollmentToken);
			if (!consumed) return c.json({ error: "Enrollment token is no longer valid" }, 409);
			enrollmentCreatedByUserId = verifiedEnrollment.createdByUserId;
			consumedEnrollment = true;
		} else {
			return c.json(
				{ error: "Supervisor registration requires enrollment token or credential" },
				401,
			);
		}
	}
	if (!consumedEnrollment) {
		const shapeError = invalidShape(registrationInput);
		if (shapeError) return c.json(shapeError, 400);
	}
	try {
		const registered = credential
			? await registerSupervisor(registrationInput)
			: await enrollSupervisor(registrationInput, enrollmentCreatedByUserId);
		await closeRestartedHostApprovals(registered.supervisor.id);
		await degradeRestartedHostSessions(registered.supervisor.id);
		await failRestartedHostClaudeTurns(registered.supervisor.id);
		return c.json({ ...registered, serverFeatures: currentServerFeatures() });
	} catch (err) {
		if (err instanceof OwnerDisabledError) {
			return c.json({ error: "Enrollment token is no longer valid" }, 409);
		}
		throw err;
	}
});

supervisorsAgentRouter.post("/supervisors/:id/heartbeat", requireSupervisorAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const body = await readHeartbeatBody(c);
	await recordHeartbeatExcludeState(supervisorId, body);
	const supervisor = await heartbeatSupervisor(supervisorId, parseOutboxState(body));
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	return c.json({ supervisor, serverFeatures: currentServerFeatures() });
});

supervisorsAgentRouter.post(
	"/supervisors/:id/launches/claim",
	requireSupervisorAuth(),
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const launchRequest = await claimNextLaunchRequest(supervisorId);
		return c.json({
			launchRequest: launchRequest
				? {
						...launchRequest,
						expectedEnforcedArgs: privilegeCliArgs(
							launchRequest.agentType,
							launchRequest.approvalPolicy,
							launchRequest.sandboxMode,
						),
					}
				: null,
		});
	},
);

supervisorsAgentRouter.post(
	"/supervisors/:id/launches/:launchId/status",
	requireSupervisorAuth(),
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const launchId = c.req.param("launchId") ?? "";
		const body = await c.req.json<{
			status: "launching" | "awaiting_session" | "running" | "completed" | "failed" | "cancelled";
			error?: string | null;
			pid?: number | null;
			providerLaunchMetadata?: Record<string, unknown> | null;
		}>();
		const launchRequest = await updateLaunchDispatchStatus({
			supervisorId,
			launchId,
			status: body.status,
			error: body.error,
			pid: body.pid,
			providerLaunchMetadata: body.providerLaunchMetadata ?? null,
		});
		if (!launchRequest) return c.json({ error: "Launch request not found" }, 404);
		return c.json({ launchRequest });
	},
);

/** A report body is a status line or a batch of events: 2 MiB is far above any real one. */
const managedReportBodyLimit = bodyLimit({
	maxSize: MANAGED_REPORT_BODY_LIMIT_BYTES,
	onError: (c) => c.json({ error: "payload_too_large" }, 413),
});

/**
 * A report sent late, from a supervisor's offline queue, carries the replay header. At most
 * MAX_CONCURRENT_REPLAYS are worked on at once per process and MAX_REPLAYS_PER_SUPERVISOR from one
 * supervisor; the rest are told to come back, which a supervisor treats as back-pressure and
 * retries. A live report is never refused. The slot is taken by the handler after the credential
 * check and after the body has been read and validated, so neither an unauthenticated caller nor a
 * slow or malformed upload can hold one. Returns the release, or null when refused.
 */
function admitReplay(late: boolean, supervisorId: string): (() => void) | null {
	return late ? tryAcquireReplay(supervisorId) : () => undefined;
}

function replayBusy(c: Context) {
	c.header("Retry-After", String(REPLAY_RETRY_AFTER_SECONDS));
	return c.json({ error: "busy" }, 503);
}

const MAX_EVENT_TYPE_CHARS = 256;
const MAX_EVENT_SHORT_FIELD_CHARS = 256;
const MAX_SESSION_ID_CHARS = 1024;

const isPlainObject = (v: unknown) =>
	typeof v === "object" &&
	v !== null &&
	!Array.isArray(v) &&
	Object.getPrototypeOf(v) === Object.prototype;
const isBoundedString = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

/** True when one event of a managed batch has a field of the wrong type or size. */
function isMalformedManagedEvent(e: unknown): boolean {
	if (!isPlainObject(e)) return true;
	const event = e as Record<string, unknown>;
	if (!isBoundedString(event.eventType, MAX_EVENT_TYPE_CHARS) || event.eventType === "")
		return true;
	if (event.content != null && !isBoundedString(event.content, MAX_EVENT_CONTENT_CHARS))
		return true;
	for (const field of ["category", "toolName"] as const) {
		if (event[field] != null && !isBoundedString(event[field], MAX_EVENT_SHORT_FIELD_CHARS)) {
			return true;
		}
	}
	return event.rawPayload != null && !isPlainObject(event.rawPayload);
}

/** The parsed JSON object, or null when the text isn't a JSON object. */
function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

supervisorsAgentRouter.post(
	"/supervisors/:id/managed-session-state",
	requireSupervisorAuth(),
	managedReportBodyLimit,
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const late = c.req.header(REPLAY_HEADER) === "1";
		const body = parseJsonObject(await c.req.text()) as ManagedSessionStateInput | null;
		if (!body) return c.json({ error: "invalid_body" }, 400);
		if (body.sessionId !== undefined && !isBoundedString(body.sessionId, MAX_SESSION_ID_CHARS)) {
			return c.json({ error: "invalid_body" }, 400);
		}
		if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
		const release = admitReplay(late, supervisorId);
		if (!release) return replayBusy(c);
		try {
			const result = await upsertManagedSessionState(supervisorId, body, { replay: late });
			await associateObservedSession({ sessionId: body.sessionId, supervisorId });
			// upsertManagedSessionState's own return is the pre-association
			// snapshot — if the association just set this session's owner,
			// that result is stale. Re-read before responding and
			// broadcasting so both carry the owner this same call set.
			const freshSession = await getSession(body.sessionId);
			const freshResult = freshSession ? { ...result, session: freshSession } : result;
			notifySessionUpdated(freshResult.session, { late });
			return c.json(freshResult);
		} catch (err) {
			if (err instanceof SessionOwnershipError) {
				console.warn("[supervisors] session write rejected", {
					supervisorId,
					sessionId: body.sessionId,
					reason: err.reason,
				});
				return c.json({ error: "session_not_owned" }, 403);
			}
			throw err;
		} finally {
			release();
		}
	},
);

supervisorsAgentRouter.post(
	"/supervisors/:id/managed-sessions/:sessionId/events",
	requireSupervisorAuth(),
	managedReportBodyLimit,
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const sessionId = c.req.param("sessionId") ?? "";
		const late = c.req.header(REPLAY_HEADER) === "1";
		const text = await c.req.text();
		const body = parseJsonObject(text) as { events?: unknown } | null;
		const batch = body?.events ?? [];
		if (!body || !Array.isArray(batch) || batch.some(isMalformedManagedEvent)) {
			return c.json({ error: "invalid_body" }, 400);
		}
		const release = admitReplay(late, supervisorId);
		if (!release) return replayBusy(c);
		const incoming = batch as ManagedSessionEventInput[];
		// A well-formed delivery id makes the batch idempotent (a receipt is written with
		// the rows); without one, or with a malformed one, the batch is handled as it
		// always was.
		const deliveryId = parseDeliveryId(c.req.header(DELIVERY_ID_HEADER));
		try {
			let inserted: SessionEvent[];
			if (deliveryId) {
				const result = await appendManagedSessionDelivery(
					supervisorId,
					sessionId,
					incoming,
					{
						deliveryId,
						bodyDigest: sha256Hex(text),
					},
					undefined,
					{ late },
				);
				// A delivery already received changed nothing: there is nothing to announce.
				if (result.replay) return c.json({ events: [] });
				inserted = result.events;
			} else {
				inserted = await appendManagedSessionEvents(supervisorId, sessionId, incoming, { late });
			}
			const session = await getSession(sessionId);
			if (session) {
				notifySessionUpdated(session, { late });
				notifySessionEvents(sessionId, inserted, { late });
			}
			return c.json({ events: inserted });
		} catch (err) {
			if (err instanceof ReservedEventTypeError) {
				return c.json({ error: "reserved_event_type" }, 400);
			}
			if (err instanceof SessionOwnershipError) {
				console.warn("[supervisors] session write rejected", {
					supervisorId,
					sessionId,
					reason: err.reason,
				});
				return c.json({ error: "session_not_owned" }, 403);
			}
			throw err;
		} finally {
			release();
		}
	},
);

/** In memory, per replica, like the other limiters. */
const approvalSyncLimiter = new FixedWindowCounter(60_000);
const approvalReportLimiter = new FixedWindowCounter(60_000);
const APPROVAL_RETRY_AFTER_SECONDS = 5;

const approvalReportBodyLimit = bodyLimit({
	maxSize: CODEX_APPROVAL_LIMITS.reportBodyBytes,
	onError: (c) => c.json({ error: "payload_too_large" }, 413),
});
const approvalSyncBodyLimit = bodyLimit({
	maxSize: CODEX_APPROVAL_LIMITS.syncBodyBytes,
	onError: (c) => c.json({ error: "payload_too_large" }, 413),
});

function approvalRateLimited(c: Context) {
	c.header("Retry-After", String(APPROVAL_RETRY_AFTER_SECONDS));
	return c.json({ error: "rate_limited" }, 429);
}

/** A refusal is a fixed code; nothing the agent wrote is ever in an answer. */
const APPROVAL_REFUSAL_STATUS: Record<string, 400 | 403 | 409> = {
	session_unknown: 409,
	too_many_pending: 409,
	session_stopping: 409,
	identity_conflict: 409,
	session_not_owned: 403,
	invalid_body: 400,
};

// A supervisor reports a Codex approval request (or a higher revision of one). Never queued by the
// supervisor, so it is never a replay.
supervisorsAgentRouter.post(
	"/supervisors/:id/managed-sessions/:sessionId/approvals",
	requireSupervisorAuth(),
	approvalReportBodyLimit,
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const sessionId = c.req.param("sessionId") ?? "";
		if (!approvalReportLimiter.tryConsume(supervisorId, CODEX_APPROVAL_LIMITS.reportPerMinute)) {
			return approvalRateLimited(c);
		}
		const report = parseApprovalReport(parseJsonObject(await c.req.text()));
		if (!report) return c.json({ error: "invalid_body" }, 400);
		try {
			await assertSupervisorCanWriteSession(supervisorId, sessionId);
			const { created, response } = await recordApprovalRequest(supervisorId, sessionId, report);
			return c.json(response, created ? 201 : 200);
		} catch (err) {
			if (err instanceof SessionOwnershipError) return c.json({ error: "session_not_owned" }, 403);
			if (err instanceof ApprovalRefusal) {
				return c.json({ error: err.code }, APPROVAL_REFUSAL_STATUS[err.code] ?? 409);
			}
			throw err;
		}
	},
);

/** In memory, per replica, like the other limiters. Per host: a runaway fork is bounded per session as well. */
const toolCallsReportLimiter = new FixedWindowCounter(60_000);
const TOOL_CALLS_RETRY_AFTER_SECONDS = 5;
const toolCallsBodyLimit = bodyLimit({
	maxSize: FORK_TOOL_DETAIL_LIMITS.reportBodyBytes,
	onError: (c) => c.json({ error: "payload_too_large" }, 413),
});

// A supervisor reports what a fork's tool calls ran (AGEN-123). Never queued by the supervisor. Refusals are
// fixed codes; nothing the agent wrote is ever in an answer.
supervisorsAgentRouter.post(
	"/supervisors/:id/managed-sessions/:sessionId/tool-calls",
	requireSupervisorAuth(),
	toolCallsBodyLimit,
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const sessionId = c.req.param("sessionId") ?? "";
		if (
			!toolCallsReportLimiter.tryConsume(supervisorId, FORK_TOOL_DETAIL_LIMITS.reportsPerMinute)
		) {
			c.header("Retry-After", String(TOOL_CALLS_RETRY_AFTER_SECONDS));
			return c.json({ error: "rate_limited" }, 429);
		}
		const report = parseForkToolCallsReport(parseJsonObject(await c.req.text()));
		if (!report) return c.json({ error: "invalid_body" }, 400);
		try {
			return c.json(await recordForkToolCalls(supervisorId, sessionId, report.calls), 201);
		} catch (err) {
			if (err instanceof SessionOwnershipError) return c.json({ error: "session_not_owned" }, 403);
			if (err instanceof ForkToolDetailRefusal) {
				return c.json({ error: err.code }, err.code === "detail_unavailable" ? 503 : 409);
			}
			throw err;
		}
	},
);

// The host's poll: what it holds, what happened to what it answered; back come the answers to issue.
// Holds no control lock. Ownership is judged for every id from the authenticated host.
supervisorsAgentRouter.post(
	"/supervisors/:id/approvals/sync",
	requireSupervisorAuth(),
	approvalSyncBodyLimit,
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		if (!approvalSyncLimiter.tryConsume(supervisorId, CODEX_APPROVAL_LIMITS.syncPerMinute)) {
			return approvalRateLimited(c);
		}
		const body = parseApprovalSync(parseJsonObject(await c.req.text()));
		if (!body) return c.json({ error: "invalid_body" }, 400);
		return c.json(await syncApprovals(supervisorId, body));
	},
);

supervisorsAgentRouter.get("/supervisors/:id/provider-sync", requireSupervisorAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const managedSessions = await listManagedSessionsNeedingSync(supervisorId);
	return c.json({ managedSessions });
});

supervisorsAgentRouter.post(
	"/supervisors/:id/control-actions/claim",
	requireSupervisorAuth(),
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const action = await claimNextControlAction(supervisorId);
		return c.json({ action });
	},
);

supervisorsAgentRouter.post(
	"/supervisors/:id/control-actions/:actionId/status",
	requireSupervisorAuth(),
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const actionId = c.req.param("actionId") ?? "";
		const body = await c.req.json<{
			status: "running" | "succeeded" | "failed";
			error?: string | null;
			metadata?: Record<string, unknown> | null;
			accepted?: boolean;
			provedCwd?: unknown;
			permissionMode?: unknown;
			applied?: unknown;
		}>();
		// A report names its status, and it must be a real one.
		if (!["running", "succeeded", "failed"].includes(body.status)) {
			return c.json({ error: "invalid_status" }, 400);
		}
		const action = await updateControlAction({
			actionId,
			supervisorId,
			status: body.status,
			error: cleanHostText(body.error),
			metadata: body.metadata ?? null,
			accepted: body.accepted === true,
			provedCwd: body.provedCwd,
			permissionMode: body.permissionMode,
			applied: body.applied,
		});
		if (!action) return c.json({ error: "Control action not found" }, 404);
		return c.json({ action });
	},
);

export { supervisorsAgentRouter, supervisorsAdminRouter };
