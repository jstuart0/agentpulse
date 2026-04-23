import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import {
	LABS_REGISTRY,
	type LabsFlag,
	getLabsFlags,
	setLabsFlag,
} from "../services/labs-service.js";

const labsRouter = new Hono();
labsRouter.use("*", requireAuth());

labsRouter.get("/labs/flags", async (c) => {
	const flags = await getLabsFlags();
	return c.json({ flags, registry: LABS_REGISTRY });
});

labsRouter.put("/labs/flags/:flag", async (c) => {
	const flag = c.req.param("flag") as LabsFlag;
	const known = LABS_REGISTRY.some((def) => def.key === flag);
	if (!known) return c.json({ error: `Unknown labs flag: ${flag}` }, 400);
	const body = await c.req.json<{ enabled: boolean }>();
	if (typeof body.enabled !== "boolean") {
		return c.json({ error: "enabled must be a boolean" }, 400);
	}
	const flags = await setLabsFlag(flag, body.enabled);
	return c.json({ flags });
});

export { labsRouter };
