import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type {
	ManagedSessionEventInput,
	ManagedSessionStateInput,
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
import { claimNextControlAction, updateControlAction } from "../services/control-actions.js";
import { claimNextLaunchRequest, updateLaunchDispatchStatus } from "../services/launch-dispatch.js";
import { associateObservedSession } from "../services/launch-dispatch.js";
import {
	appendManagedSessionEvents,
	listManagedSessionsNeedingSync,
	upsertManagedSessionState,
} from "../services/managed-session-state.js";
import { notifySessionEvents, notifySessionUpdated } from "../services/notifier.js";
import { SessionOwnershipError } from "../services/session-ownership.js";
import { getSession } from "../services/session-tracker.js";
import { parseRegistrationShape } from "../services/supervisor-capabilities.js";
import { recordHeartbeatExcludeState } from "../services/supervisor-exclude-state.js";
import {
	enrollSupervisor,
	getSupervisor,
	heartbeatSupervisor,
	listSupervisors,
	registerSupervisor,
	revokeHost,
	setSupervisorOwner,
} from "../services/supervisor-registry.js";

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
	if (
		!registrationInput.hostName ||
		!registrationInput.platform ||
		!registrationInput.arch ||
		!registrationInput.version
	) {
		return c.json({ error: "Missing required supervisor fields" }, 400);
	}

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
		if (!credential) {
			return c.json(await enrollSupervisor(registrationInput, enrollmentCreatedByUserId));
		}
		return c.json(await registerSupervisor(registrationInput));
	} catch (err) {
		if (err instanceof OwnerDisabledError) {
			return c.json({ error: "Enrollment token is no longer valid" }, 409);
		}
		throw err;
	}
});

supervisorsAgentRouter.post("/supervisors/:id/heartbeat", requireSupervisorAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	await recordHeartbeatExcludeState(c, supervisorId);
	const supervisor = await heartbeatSupervisor(supervisorId);
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	return c.json({ supervisor });
});

supervisorsAgentRouter.post(
	"/supervisors/:id/launches/claim",
	requireSupervisorAuth(),
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const launchRequest = await claimNextLaunchRequest(supervisorId);
		return c.json({ launchRequest: launchRequest ?? null });
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

supervisorsAgentRouter.post(
	"/supervisors/:id/managed-session-state",
	requireSupervisorAuth(),
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const body = await c.req.json<ManagedSessionStateInput>();
		if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
		try {
			const result = await upsertManagedSessionState(supervisorId, body);
			await associateObservedSession({ sessionId: body.sessionId, supervisorId });
			// upsertManagedSessionState's own return is the pre-association
			// snapshot — if the association just set this session's owner,
			// that result is stale. Re-read before responding and
			// broadcasting so both carry the owner this same call set.
			const freshSession = await getSession(body.sessionId);
			const freshResult = freshSession ? { ...result, session: freshSession } : result;
			notifySessionUpdated(freshResult.session);
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
		}
	},
);

supervisorsAgentRouter.post(
	"/supervisors/:id/managed-sessions/:sessionId/events",
	requireSupervisorAuth(),
	async (c) => {
		const supervisorId = c.req.param("id") ?? "";
		const sessionId = c.req.param("sessionId") ?? "";
		const body = await c.req.json<{ events: ManagedSessionEventInput[] }>();
		try {
			const inserted = await appendManagedSessionEvents(supervisorId, sessionId, body.events ?? []);
			const session = await getSession(sessionId);
			if (session) {
				notifySessionUpdated(session);
				notifySessionEvents(sessionId, inserted);
			}
			return c.json({ events: inserted });
		} catch (err) {
			if (err instanceof SessionOwnershipError) {
				console.warn("[supervisors] session write rejected", {
					supervisorId,
					sessionId,
					reason: err.reason,
				});
				return c.json({ error: "session_not_owned" }, 403);
			}
			throw err;
		}
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
		}>();
		const action = await updateControlAction({
			actionId,
			supervisorId,
			status: body.status,
			error: body.error,
			metadata: body.metadata ?? null,
		});
		if (!action) return c.json({ error: "Control action not found" }, 404);
		return c.json({ action });
	},
);

export { supervisorsAgentRouter, supervisorsAdminRouter };
