import { Hono } from "hono";
import type {
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	SupervisorRegistrationInput,
} from "../../shared/types.js";
import { requireAuth, requireSupervisorAuth } from "../auth/middleware.js";
import {
	consumeEnrollmentToken,
	createSupervisorCredential,
	createSupervisorEnrollmentToken,
	extractSupervisorToken,
	revokeSupervisorCredential,
	verifyEnrollmentToken,
	verifySupervisorCredential,
} from "../auth/supervisor-auth.js";
import { config } from "../config.js";
import {
	getSupervisor,
	heartbeatSupervisor,
	listSupervisors,
	registerSupervisor,
	revokeSupervisor,
} from "../services/supervisor-registry.js";
import {
	claimNextLaunchRequest,
	updateLaunchDispatchStatus,
} from "../services/launch-dispatch.js";
import {
	appendManagedSessionEvents,
	listManagedSessionsNeedingSync,
	upsertManagedSessionState,
} from "../services/managed-session-state.js";
import { notifySessionEvents, notifySessionUpdated } from "../services/notifier.js";
import { getSession } from "../services/session-tracker.js";
import { claimNextControlAction, updateControlAction } from "../services/control-actions.js";
import { enrichObservedSession } from "../services/correlation-enricher.js";

const supervisorsRouter = new Hono();

supervisorsRouter.get("/supervisors", requireAuth(), async (c) => {
	const supervisors = await listSupervisors();
	return c.json({ supervisors, total: supervisors.length });
});

supervisorsRouter.get("/supervisors/:id", requireAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const supervisor = await getSupervisor(supervisorId);
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	return c.json({ supervisor });
});

supervisorsRouter.post("/supervisors/enroll", requireAuth(), async (c) => {
	const body = await c.req.json<{ name?: string; expiresAt?: string | null; supervisorId?: string | null }>();
	const result = await createSupervisorEnrollmentToken(
		body.name?.trim() || "supervisor",
		body.expiresAt ?? null,
		body.supervisorId ?? null,
	);
	return c.json(result, 201);
});

supervisorsRouter.post("/supervisors/:id/rotate", requireAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const supervisor = await getSupervisor(supervisorId);
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	const body = await c.req.json<{ expiresAt?: string | null }>();
	const result = await createSupervisorEnrollmentToken(
		`rotate:${supervisor.hostName}`,
		body.expiresAt ?? null,
		supervisorId,
	);
	return c.json(result, 201);
});

supervisorsRouter.post("/supervisors/register", async (c) => {
	const body = await c.req.json<SupervisorRegistrationInput>();
	const registrationInput: SupervisorRegistrationInput = { ...body };
	if (!registrationInput.hostName || !registrationInput.platform || !registrationInput.arch || !registrationInput.version) {
		return c.json({ error: "Missing required supervisor fields" }, 400);
	}

	let credential: { id: string; supervisorId: string; name: string } | null = null;
	if (!config.disableAuth) {
		const token = extractSupervisorToken({
			get: (name: string) => c.req.header(name) ?? null,
		});
		if (token) {
			credential = await verifySupervisorCredential(token);
		}
		if (credential) {
			if (registrationInput.id && credential.supervisorId !== registrationInput.id) {
				return c.json({ error: "Supervisor credential does not match requested supervisor id" }, 403);
			}
		} else if (registrationInput.enrollmentToken) {
			const verifiedEnrollment = await verifyEnrollmentToken(registrationInput.enrollmentToken);
			if (!verifiedEnrollment) return c.json({ error: "Invalid enrollment token" }, 401);
			if (verifiedEnrollment.supervisorId) {
				if (registrationInput.id && registrationInput.id !== verifiedEnrollment.supervisorId) {
					return c.json({ error: "Enrollment token is scoped to a different supervisor" }, 403);
				}
				registrationInput.id = verifiedEnrollment.supervisorId;
			}
			const consumed = await consumeEnrollmentToken(registrationInput.enrollmentToken);
			if (!consumed) return c.json({ error: "Enrollment token is no longer valid" }, 409);
		} else {
			return c.json({ error: "Supervisor registration requires enrollment token or credential" }, 401);
		}
	}
	const result = await registerSupervisor(registrationInput);
	if (!credential) {
		await revokeSupervisorCredential(result.supervisor.id);
		const issued = await createSupervisorCredential(
			result.supervisor.id,
			`supervisor:${result.supervisor.hostName}`,
		);
		return c.json({
			...result,
			supervisorCredential: issued.token,
		});
	}
	return c.json(result);
});

supervisorsRouter.post("/supervisors/:id/revoke", requireAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	await revokeSupervisor(supervisorId);
	await revokeSupervisorCredential(supervisorId);
	return c.json({ ok: true });
});

supervisorsRouter.post("/supervisors/:id/heartbeat", requireSupervisorAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const supervisor = await heartbeatSupervisor(supervisorId);
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	return c.json({ supervisor });
});

supervisorsRouter.post("/supervisors/:id/launches/claim", requireSupervisorAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const launchRequest = await claimNextLaunchRequest(supervisorId);
	return c.json({ launchRequest: launchRequest ?? null });
});

supervisorsRouter.post("/supervisors/:id/launches/:launchId/status", requireSupervisorAuth(), async (c) => {
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
});

supervisorsRouter.post("/supervisors/:id/managed-session-state", requireSupervisorAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const body = await c.req.json<ManagedSessionStateInput>();
	if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
	const result = await upsertManagedSessionState(supervisorId, body);
	await enrichObservedSession(body.sessionId, supervisorId);
	notifySessionUpdated(result.session);
	return c.json(result);
});

supervisorsRouter.post("/supervisors/:id/managed-sessions/:sessionId/events", requireSupervisorAuth(), async (c) => {
	const sessionId = c.req.param("sessionId") ?? "";
	const body = await c.req.json<{ events: ManagedSessionEventInput[] }>();
	const inserted = await appendManagedSessionEvents(sessionId, body.events ?? []);
	const session = await getSession(sessionId);
	if (session) {
		notifySessionUpdated(session);
		notifySessionEvents(sessionId, inserted);
	}
	return c.json({ events: inserted });
});

supervisorsRouter.get("/supervisors/:id/provider-sync", requireSupervisorAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const managedSessions = await listManagedSessionsNeedingSync(supervisorId);
	return c.json({ managedSessions });
});

supervisorsRouter.post("/supervisors/:id/control-actions/claim", requireSupervisorAuth(), async (c) => {
	const supervisorId = c.req.param("id") ?? "";
	const action = await claimNextControlAction(supervisorId);
	return c.json({ action });
});

supervisorsRouter.post("/supervisors/:id/control-actions/:actionId/status", requireSupervisorAuth(), async (c) => {
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
});

export { supervisorsRouter };
