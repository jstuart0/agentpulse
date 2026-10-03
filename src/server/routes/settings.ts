import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { InvalidScopeError, SCOPE_MANAGE, createApiKey, parseScopes } from "../auth/api-key.js";
import type { AuthUser } from "../auth/middleware.js";
import { requireAuth } from "../auth/middleware.js";
import { OwnerDisabledError, OwnerNotFoundError } from "../auth/owner-state.js";
import { getRequestActor, isHumanAdmin, requireOperatorScope } from "../auth/route-scope-policy.js";
import { getDb } from "../db/client.js";
import { apiKeys, sessions, settings } from "../db/schema/index.js";
import { logAdminAction } from "../services/audit-log.js";
import { NotOwnerError, assertCanRevokeKey, assertCanViewKey } from "../services/authorization.js";
import { tryConsumeKeyMint } from "../services/key-mint-limit.js";
import {
	HumanAdminRequiredForOwnerError,
	KeyHasOwnerError,
	KeyNotManageError,
	applyApiKeyPatch,
	getAdminServiceKeyIds,
	getServiceKeyIds,
	isServiceKeyRow,
	listAdminServiceKey,
	revokeApiKey,
} from "../services/service-keys.js";
import { ProtectedSettingError, upsertSetting } from "../services/settings-service.js";
import { getTelemetryDiagnostics, sendTelemetryNow } from "../services/telemetry.js";
import {
	WorkspaceValidationError,
	getWorkspaceSettings,
	setWorkspaceSettings,
} from "../services/workspace/feature.js";

const settingsRouter = new Hono();
settingsRouter.use("*", requireAuth());
// All settings routes are operator-only (H-1, H-2): ingest keys must not
// read or write settings, workspace defaults, or API-key management.
// Deliberately manage-only (no route here is in OBSERVE_READ_PATHS).
settingsRouter.use("*", requireOperatorScope());

const INSTANCE_SETTING_PREFIX = "instance.";
// The one user-settable key a member may write in team mode; the others are an admin's.
const MEMBER_WRITABLE_SETTING = "theme";

// GET /api/v1/settings - Get all settings
settingsRouter.get("/settings", async (c) => {
	const rows = await getDb().select().from(settings);
	const result: Record<string, unknown> = {};
	for (const row of rows) {
		// The instance rows (the mode, the kept admin service keys) are not for
		// clients: the mode is read from /instance, the kept list from the
		// `adminService` flag on a key, for admins only.
		if (row.key.startsWith(INSTANCE_SETTING_PREFIX)) continue;
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

	// Team mode: the theme stays a member's; every other key is an admin's.
	if (key !== MEMBER_WRITABLE_SETTING) {
		const actor = await getRequestActor(c);
		if (actor.mode === "team" && actor.role !== "admin") {
			return c.json({ error: "admin_required" }, 403);
		}
	}

	try {
		await upsertSetting(key, value);
	} catch (err) {
		if (err instanceof ProtectedSettingError) {
			return c.json({ error: "key_not_user_settable", key: err.key }, 403);
		}
		throw err;
	}

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
		workspace?: {
			defaultRoot?: unknown;
			templateClaudeMd?: unknown;
			gitInit?: unknown;
		};
		gitClone?: {
			allowSshUrls?: unknown;
			allowLocalUrls?: unknown;
			defaultDepth?: unknown;
			timeoutSeconds?: unknown;
		};
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	// Narrow each field type before handing to the service. The service does
	// the semantic validation (path shape, depth/timeout bounds) — here we
	// just gate type errors so the service layer doesn't have to second-guess
	// `unknown`.
	const update: {
		defaultRoot?: string;
		templateClaudeMd?: string;
		gitInit?: boolean;
		gitClone?: {
			allowSshUrls?: boolean;
			allowLocalUrls?: boolean;
			defaultDepth?: number | null;
			timeoutSeconds?: number;
		};
	} = {};

	const ws = body.workspace;
	if (ws !== undefined) {
		if (ws === null || typeof ws !== "object") {
			return c.json({ error: "workspace must be an object" }, 400);
		}
		if (ws.defaultRoot !== undefined) {
			if (typeof ws.defaultRoot !== "string") {
				return c.json({ error: "workspace.defaultRoot must be a string" }, 400);
			}
			update.defaultRoot = ws.defaultRoot;
		}
		if (ws.templateClaudeMd !== undefined) {
			if (typeof ws.templateClaudeMd !== "string") {
				return c.json({ error: "workspace.templateClaudeMd must be a string" }, 400);
			}
			update.templateClaudeMd = ws.templateClaudeMd;
		}
		if (ws.gitInit !== undefined) {
			if (typeof ws.gitInit !== "boolean") {
				return c.json({ error: "workspace.gitInit must be a boolean" }, 400);
			}
			update.gitInit = ws.gitInit;
		}
	}

	const gc = body.gitClone;
	if (gc !== undefined) {
		if (gc === null || typeof gc !== "object") {
			return c.json({ error: "gitClone must be an object" }, 400);
		}
		const gitClone: {
			allowSshUrls?: boolean;
			allowLocalUrls?: boolean;
			defaultDepth?: number | null;
			timeoutSeconds?: number;
		} = {};
		if (gc.allowSshUrls !== undefined) {
			if (typeof gc.allowSshUrls !== "boolean") {
				return c.json({ error: "gitClone.allowSshUrls must be a boolean" }, 400);
			}
			gitClone.allowSshUrls = gc.allowSshUrls;
		}
		if (gc.allowLocalUrls !== undefined) {
			if (typeof gc.allowLocalUrls !== "boolean") {
				return c.json({ error: "gitClone.allowLocalUrls must be a boolean" }, 400);
			}
			gitClone.allowLocalUrls = gc.allowLocalUrls;
		}
		if (gc.defaultDepth !== undefined) {
			if (gc.defaultDepth !== null && typeof gc.defaultDepth !== "number") {
				return c.json({ error: "gitClone.defaultDepth must be a number or null" }, 400);
			}
			gitClone.defaultDepth = gc.defaultDepth as number | null;
		}
		if (gc.timeoutSeconds !== undefined) {
			if (typeof gc.timeoutSeconds !== "number") {
				return c.json({ error: "gitClone.timeoutSeconds must be a number" }, 400);
			}
			gitClone.timeoutSeconds = gc.timeoutSeconds;
		}
		update.gitClone = gitClone;
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

/** Whose allowance a key mint counts against: the person (their cookie and keys share it), else the key. */
function keyMintSubject(authUser: AuthUser): string {
	if (authUser.userId !== null) return `user:${authUser.userId}`;
	return `key:${authUser.keyId ?? "anonymous"}`;
}

// GET /api/v1/api-keys - List API keys (without the actual key). Solo: all of
// them, as always. Team: your own; an admin sees every key, and ?owner=<user id>
// or ?owner=service narrows the list.
settingsRouter.get("/api-keys", async (c) => {
	const actor = await getRequestActor(c);
	const sees = actor.mode === "team" && actor.role !== "admin" ? "own" : "all";
	const ownerFilter = actor.mode === "team" && sees === "all" ? c.req.query("owner") : undefined;
	if (sees === "own" && actor.userId === null) return c.json({ keys: [] });

	const rows = await getDb()
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			keyPrefix: apiKeys.keyPrefix,
			isActive: apiKeys.isActive,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
			scopes: apiKeys.scopes,
			ownerUserId: apiKeys.ownerUserId,
			createdByUserId: apiKeys.createdByUserId,
		})
		.from(apiKeys)
		.where(
			sees === "own"
				? eq(apiKeys.ownerUserId, actor.userId as string)
				: ownerFilter === "service"
					? isNull(apiKeys.ownerUserId)
					: ownerFilter
						? eq(apiKeys.ownerUserId, ownerFilter)
						: undefined,
		)
		.orderBy(apiKeys.createdAt);

	const kept = await getAdminServiceKeyIds();
	const plain = await getServiceKeyIds();
	const keys = rows.map((k) => ({
		...k,
		scopes: parseScopes(k.scopes),
		adminService: kept.includes(k.id),
		serviceKey: isServiceKeyRow(k, { admin: kept, plain }),
	}));
	return c.json({ keys });
});

// GET /api/v1/api-keys/:id - One key (without the secret), for its owner or an admin;
// a member asking for anyone else's gets the same 404 as for a key that doesn't exist.
settingsRouter.get("/api-keys/:id", async (c) => {
	const id = c.req.param("id");
	try {
		await assertCanViewKey(await getRequestActor(c), id);
	} catch (err) {
		// "Not yours" answers exactly as "doesn't exist", so a member can't probe key ids.
		if (err instanceof NotOwnerError) return c.json({ error: "API key not found" }, 404);
		throw err;
	}
	const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
	if (!row) return c.json({ error: "API key not found" }, 404);

	const [service] = await getDb()
		.select({ count: sql<number>`count(*)`.mapWith(Number) })
		.from(sessions)
		.where(and(eq(sessions.ingestKeyId, id), isNull(sessions.ownerUserId)));
	const kept = await getAdminServiceKeyIds();
	const plain = await getServiceKeyIds();
	return c.json({
		key: {
			id: row.id,
			name: row.name,
			keyPrefix: row.keyPrefix,
			isActive: row.isActive,
			createdAt: row.createdAt,
			lastUsedAt: row.lastUsedAt,
			scopes: parseScopes(row.scopes),
			ownerUserId: row.ownerUserId,
			createdByUserId: row.createdByUserId,
			adminService: kept.includes(row.id),
			serviceKey: isServiceKeyRow(row, { admin: kept, plain }),
		},
		serviceSessionCount: service?.count ?? 0,
	});
});

// POST /api/v1/api-keys - Create a new API key, owned by whoever minted it.
//
// `service: true` makes a key with no owner (the creator is still recorded) and
// needs an admin; a service key that can manage also needs a human admin and
// is kept as an admin service key. A caller with no user id (DISABLE_AUTH, a
// service key) always produces a service key, and in team mode must be an admin.
settingsRouter.post("/api-keys", async (c: Context) => {
	const { name, scopes, service } = await c.req.json<{
		name: string;
		scopes?: string[];
		service?: boolean;
	}>();

	if (!name || name.trim().length === 0) {
		return c.json({ error: "Name is required" }, 400);
	}

	const authUser = c.get("authUser") as AuthUser;
	if (!tryConsumeKeyMint(keyMintSubject(authUser))) {
		c.header("Retry-After", "60");
		return c.json({ error: "rate_limited" }, 429);
	}
	const actor = await getRequestActor(c);
	const wantsService = service === true;
	const callerHasNoUser = authUser.userId === null;
	const canManage = (scopes ?? []).includes(SCOPE_MANAGE);
	if (wantsService && actor.role !== "admin") return c.json({ error: "admin_required" }, 403);
	if (!wantsService && callerHasNoUser && actor.mode === "team" && actor.role !== "admin") {
		return c.json({ error: "admin_required" }, 403);
	}
	// A key never mints a service key: a key-minted key belongs to the caller's
	// owner (or to nobody, if the caller has none) and is never more than that.
	if (wantsService && !isHumanAdmin(authUser)) {
		return c.json({ error: "human_admin_required" }, 403);
	}
	const keptAsAdminService = wantsService && canManage;

	try {
		const { key, id } = await createApiKey(name.trim(), scopes, authUser.userId, {
			service: wantsService,
			withinTransaction:
				wantsService && canManage ? (tx, keyId) => listAdminServiceKey(keyId, tx) : undefined,
		});

		return c.json({
			id,
			key, // Only returned once on creation
			name: name.trim(),
			scopes: scopes ?? ["ingest"],
			ownerUserId: wantsService ? null : authUser.userId,
			// Whether the key is kept as an admin service key. An ownerless key a
			// service key minted is not: in team mode it acts as a member.
			adminService: keptAsAdminService,
			message: "Save this key -- it will not be shown again.",
		});
	} catch (err) {
		if (err instanceof InvalidScopeError) {
			return c.json({ error: "invalid_scope", value: err.value }, 400);
		}
		if (err instanceof OwnerDisabledError) {
			return c.json({ error: "user_disabled" }, 409);
		}
		throw err;
	}
});

// PATCH /api/v1/api-keys/:id - An admin's change: { ownerUserId | null,
// attributeSessions?, adminService?, serviceKey? }. Setting adminService needs a
// human admin; serviceKey (keep an ownerless key as a plain service key) any admin.
settingsRouter.patch("/api-keys/:id", async (c: Context) => {
	const id = c.req.param("id");
	const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
	if (body === null || typeof body !== "object") return c.json({ error: "invalid_patch" }, 400);

	const hasOwner = "ownerUserId" in body;
	const owner = body.ownerUserId;
	const attributeSessions = body.attributeSessions;
	const adminService = body.adminService;
	const serviceKey = body.serviceKey;
	const ownerOk = !hasOwner || owner === null || typeof owner === "string";
	const flagsOk =
		(attributeSessions === undefined || typeof attributeSessions === "boolean") &&
		(adminService === undefined || typeof adminService === "boolean") &&
		(serviceKey === undefined || typeof serviceKey === "boolean");
	const changesSomething = hasOwner || adminService !== undefined || serviceKey !== undefined;
	// Keeping a key as an admin service key is only meaningful for a key with no
	// owner, so an owner together with adminService is refused; clearing the
	// owner together with adminService: true is how a kept key stays kept.
	const conflicting = hasOwner && owner !== null && adminService !== undefined;
	const attributesWithoutOwner =
		attributeSessions !== undefined && !(hasOwner && typeof owner === "string");
	if (!ownerOk || !flagsOk || !changesSomething || conflicting || attributesWithoutOwner) {
		return c.json({ error: "invalid_patch" }, 400);
	}

	const authUser = c.get("authUser") as AuthUser;
	if (adminService !== undefined && !isHumanAdmin(authUser)) {
		return c.json({ error: "human_admin_required" }, 403);
	}

	try {
		const result = await applyApiKeyPatch(
			id,
			{
				...(hasOwner ? { ownerUserId: owner as string | null } : {}),
				attributeSessions: attributeSessions as boolean | undefined,
				adminService: adminService as boolean | undefined,
				serviceKey: serviceKey as boolean | undefined,
			},
			isHumanAdmin(authUser),
		);
		if (!result.found) return c.json({ error: "API key not found" }, 404);
		logAdminAction("api_key_updated", await getRequestActor(c), {
			keyId: id,
			...(hasOwner ? { ownerUserId: owner } : {}),
			...(adminService !== undefined ? { adminService } : {}),
			...(serviceKey !== undefined ? { serviceKey } : {}),
			attributedSessions: result.attributedSessions,
		});
		return c.json({
			ok: true,
			attributedSessions: result.attributedSessions,
			adminService: result.adminService,
			serviceKey: result.serviceKey,
		});
	} catch (err) {
		if (err instanceof OwnerNotFoundError) return c.json({ error: "user_not_found" }, 404);
		if (err instanceof OwnerDisabledError) return c.json({ error: "user_disabled" }, 409);
		if (err instanceof KeyHasOwnerError) return c.json({ error: "key_has_owner" }, 409);
		if (err instanceof KeyNotManageError) return c.json({ error: "key_not_manage" }, 409);
		if (err instanceof HumanAdminRequiredForOwnerError) {
			return c.json({ error: "human_admin_required" }, 403);
		}
		throw err;
	}
});

// DELETE /api/v1/api-keys/:id - Revoke an API key. Solo: anyone, as always.
// Team: the key's owner or an admin; a service key is an admin's. "Not yours"
// answers exactly as "doesn't exist" (404), so a member can't probe key ids.
settingsRouter.delete("/api-keys/:id", async (c) => {
	const id = c.req.param("id");
	try {
		await assertCanRevokeKey(await getRequestActor(c), id);
	} catch (err) {
		if (err instanceof NotOwnerError) return c.json({ error: "API key not found" }, 404);
		throw err;
	}

	if (!(await revokeApiKey(id))) {
		return c.json({ error: "API key not found" }, 404);
	}

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
