import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createApiKey } from "../auth/api-key.js";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { apiKeys, settings } from "../db/schema.js";
import { getTelemetryDiagnostics, sendTelemetryNow } from "../services/telemetry.js";
import {
	WorkspaceValidationError,
	getWorkspaceSettings,
	setWorkspaceSettings,
} from "../services/workspace/feature.js";

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

// GET /api/v1/settings/workspace - Read workspace defaults (with fallbacks)
settingsRouter.get("/settings/workspace", async (c) => {
	const ws = await getWorkspaceSettings();
	return c.json(ws);
});

// PUT /api/v1/settings/workspace - Upsert any subset of workspace defaults
settingsRouter.put("/settings/workspace", async (c) => {
	let body: {
		defaultRoot?: unknown;
		templateClaudeMd?: unknown;
		gitInit?: unknown;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	// Narrow each field type before handing to the service. The service does
	// the semantic validation (path shape) — here we just gate type errors so
	// the service layer doesn't have to second-guess `unknown`.
	const update: {
		defaultRoot?: string;
		templateClaudeMd?: string;
		gitInit?: boolean;
	} = {};
	if (body.defaultRoot !== undefined) {
		if (typeof body.defaultRoot !== "string") {
			return c.json({ error: "defaultRoot must be a string" }, 400);
		}
		update.defaultRoot = body.defaultRoot;
	}
	if (body.templateClaudeMd !== undefined) {
		if (typeof body.templateClaudeMd !== "string") {
			return c.json({ error: "templateClaudeMd must be a string" }, 400);
		}
		update.templateClaudeMd = body.templateClaudeMd;
	}
	if (body.gitInit !== undefined) {
		if (typeof body.gitInit !== "boolean") {
			return c.json({ error: "gitInit must be a boolean" }, 400);
		}
		update.gitInit = body.gitInit;
	}

	try {
		const next = await setWorkspaceSettings(update);
		return c.json(next);
	} catch (err) {
		if (err instanceof WorkspaceValidationError) {
			return c.json({ error: err.message }, 400);
		}
		throw err;
	}
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

settingsRouter.get("/telemetry/status", async (c) => {
	const telemetry = await getTelemetryDiagnostics();
	return c.json({ telemetry });
});

settingsRouter.post("/telemetry/ping", async (c) => {
	const result = await sendTelemetryNow();
	if (!result.ok) {
		return c.json({ ok: false, error: result.error }, 502);
	}
	return c.json({ ok: true });
});

export { settingsRouter };
