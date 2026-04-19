import { Hono } from "hono";
import type { SupervisorRegistrationInput } from "../../shared/types.js";
import {
	getSupervisor,
	heartbeatSupervisor,
	listSupervisors,
	registerSupervisor,
} from "../services/supervisor-registry.js";
import { claimNextLaunchRequest, updateLaunchDispatchStatus } from "../services/launch-dispatch.js";

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
		status: "launching" | "awaiting_session" | "failed" | "cancelled";
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

export { supervisorsRouter };
