import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { LaunchRequestInput } from "../../shared/types.js";
import { db } from "../db/client.js";
import { launchRequests } from "../db/schema.js";
import { createValidatedLaunchRequest, mapLaunchRequest } from "../services/launch-validator.js";

const launchesRouter = new Hono();

launchesRouter.get("/launches", async (c) => {
	const rows = await db.select().from(launchRequests).orderBy(desc(launchRequests.createdAt));
	return c.json({
		launches: rows.map(mapLaunchRequest),
		total: rows.length,
	});
});

launchesRouter.get("/launches/:id", async (c) => {
	const [row] = await db
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, c.req.param("id")))
		.limit(1);
	if (!row) return c.json({ error: "Launch request not found" }, 404);
	return c.json({ launchRequest: mapLaunchRequest(row) });
});

launchesRouter.post("/launches", async (c) => {
	try {
		const body = await c.req.json<LaunchRequestInput>();
		const result = await createValidatedLaunchRequest(body);
		return c.json(result, result.launchRequest.status === "validated" ? 201 : 200);
	} catch (error) {
		if (error instanceof HTTPException) {
			return c.json({ error: error.message }, error.status);
		}
		return c.json(
			{ error: error instanceof Error ? error.message : "Launch validation failed" },
			400,
		);
	}
});

export { launchesRouter };
