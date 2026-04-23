import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createApiKey } from "../auth/api-key.js";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { apiKeys, settings } from "../db/schema.js";

const settingsRouter = new Hono();
settingsRouter.use("*", requireAuth());

// GET /api/v1/settings - Get all settings
settingsRouter.get("/settings", async (c) => {
	const rows = await db.select().from(settings);
	const result: Record<string, unknown> = {};
	for (const row of rows) {
		result[row.key] = row.value;
	}
	return c.json(result);
});

// PUT /api/v1/settings - Update a setting
settingsRouter.put("/settings", async (c) => {
	const { key, value } = await c.req.json<{ key: string; value: unknown }>();

	if (!key) {
		return c.json({ error: "Missing key" }, 400);
	}

	await db
		.insert(settings)
		.values({ key, value, updatedAt: new Date().toISOString() })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value, updatedAt: new Date().toISOString() },
		});

	return c.json({ ok: true });
});

// GET /api/v1/api-keys - List all API keys (without the actual key)
settingsRouter.get("/api-keys", async (c) => {
	const keys = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			keyPrefix: apiKeys.keyPrefix,
			isActive: apiKeys.isActive,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
		})
		.from(apiKeys)
		.orderBy(apiKeys.createdAt);

	return c.json({ keys });
});

// POST /api/v1/api-keys - Create a new API key
settingsRouter.post("/api-keys", async (c) => {
	const { name } = await c.req.json<{ name: string }>();

	if (!name || name.trim().length === 0) {
		return c.json({ error: "Name is required" }, 400);
	}

	const { key, id } = await createApiKey(name.trim());

	return c.json({
		id,
		key, // Only returned once on creation
		name: name.trim(),
		message: "Save this key -- it will not be shown again.",
	});
});

// DELETE /api/v1/api-keys/:id - Revoke an API key
settingsRouter.delete("/api-keys/:id", async (c) => {
	const id = c.req.param("id");

	const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);

	if (!existing) {
		return c.json({ error: "API key not found" }, 404);
	}

	await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, id));

	return c.json({ ok: true });
});

export { settingsRouter };
