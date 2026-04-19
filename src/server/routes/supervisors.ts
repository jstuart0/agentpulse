import { Hono } from "hono";
import type {
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	SupervisorRegistrationInput,
} from "../../shared/types.js";
import {
	getSupervisor,
	heartbeatSupervisor,
	listSupervisors,
	registerSupervisor,
} from "../services/supervisor-registry.js";
import {
	claimNextLaunchRequest,
	linkObservedSessionToLaunch,
	updateLaunchDispatchStatus,
} from "../services/launch-dispatch.js";
import {
	appendManagedSessionEvents,
	listManagedSessionsNeedingSync,
	upsertManagedSessionState,
} from "../services/managed-session-state.js";
import { broadcast, broadcastToSession } from "../ws/handler.js";
import { getSession } from "../services/session-tracker.js";

const supervisorsRouter = new Hono();

supervisorsRouter.get("/supervisors", async (c) => {
	const supervisors = await listSupervisors();
	return c.json({ supervisors, total: supervisors.length });
});

supervisorsRouter.get("/supervisors/:id", async (c) => {
	const supervisor = await getSupervisor(c.req.param("id"));
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	return c.json({ supervisor });
});

supervisorsRouter.post("/supervisors/register", async (c) => {
	const body = await c.req.json<SupervisorRegistrationInput>();
	if (!body.hostName || !body.platform || !body.arch || !body.version) {
		return c.json({ error: "Missing required supervisor fields" }, 400);
	}
	const result = await registerSupervisor(body);
	return c.json(result);
});

supervisorsRouter.post("/supervisors/:id/heartbeat", async (c) => {
	const supervisor = await heartbeatSupervisor(c.req.param("id"));
	if (!supervisor) return c.json({ error: "Supervisor not found" }, 404);
	return c.json({ supervisor });
});

supervisorsRouter.post("/supervisors/:id/launches/claim", async (c) => {
	const launchRequest = await claimNextLaunchRequest(c.req.param("id"));
	return c.json({ launchRequest: launchRequest ?? null });
});

supervisorsRouter.post("/supervisors/:id/launches/:launchId/status", async (c) => {
	const body = await c.req.json<{
		status: "launching" | "awaiting_session" | "running" | "failed" | "cancelled";
		error?: string | null;
		pid?: number | null;
		providerLaunchMetadata?: Record<string, unknown> | null;
	}>();
	const launchRequest = await updateLaunchDispatchStatus({
		supervisorId: c.req.param("id"),
		launchId: c.req.param("launchId"),
		status: body.status,
		error: body.error,
		pid: body.pid,
		providerLaunchMetadata: body.providerLaunchMetadata ?? null,
	});
	if (!launchRequest) return c.json({ error: "Launch request not found" }, 404);
	return c.json({ launchRequest });
});

supervisorsRouter.post("/supervisors/:id/managed-session-state", async (c) => {
	const body = await c.req.json<ManagedSessionStateInput>();
	if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
	const result = await upsertManagedSessionState(c.req.param("id"), body);
	await linkObservedSessionToLaunch(body.sessionId, c.req.param("id"));
	broadcast("session_updated", { session: result.session });
	return c.json(result);
});

supervisorsRouter.post("/supervisors/:id/managed-sessions/:sessionId/events", async (c) => {
	const body = await c.req.json<{ events: ManagedSessionEventInput[] }>();
	const inserted = await appendManagedSessionEvents(c.req.param("sessionId"), body.events ?? []);
	const session = await getSession(c.req.param("sessionId"));
	if (session) {
		broadcast("session_updated", { session });
		for (const event of inserted) {
			broadcastToSession(c.req.param("sessionId"), "new_event", event);
		}
	}
	return c.json({ events: inserted });
});

supervisorsRouter.get("/supervisors/:id/provider-sync", async (c) => {
	const managedSessions = await listManagedSessionsNeedingSync(c.req.param("id"));
	return c.json({ managedSessions });
});

export { supervisorsRouter };
