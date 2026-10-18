import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuthUser, requireAuth } from "../auth/middleware.js";
import {
	callerHasManageScope,
	getRequestActor,
	refuseBadOrigin,
	requireOperatorScope,
} from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import { NotOwnerError, assertCanManageDevice } from "../services/authorization.js";
import {
	type DeviceCaller,
	DeviceConflictError,
	type DeviceFilter,
	DeviceKeyMismatchError,
	DeviceKeyRequiredError,
	DeviceLimitError,
	DeviceOwnedByAnotherError,
	DeviceRemovedError,
	InvalidDeviceError,
	SecretsKeyMissingError,
	getDeviceById,
	isActivePairingMintedKey,
	listDevices,
	parsePatch,
	parseRegistration,
	registerDevice,
	revokeDeviceRow,
	toDeviceDtoOne,
	toDeviceDtos,
	tryConsumeDeviceTest,
	tryConsumeRegistration,
	updateDevice,
} from "../services/mobile-devices-service.js";
import { getPushDevice } from "../services/push/device-source.js";
import { getPushRuntime } from "../services/push/dispatch.js";
import { pushAvailability } from "../services/push/push-runtime.js";
import type { AlertOutcome } from "../services/push/push-service.js";
import { revokeApiKey } from "../services/service-keys.js";

/** A body is a few short fields plus a small prefs object. */
const MAX_BODY_BYTES = 16 * 1024;

const devicesRouter = new Hono();
devicesRouter.use("*", requireAuth());
// respond and manage keys reach these (SCOPE_GRANTS.respond); observe does not.
devicesRouter.use("*", requireOperatorScope());

function caller(c: Context): DeviceCaller {
	const authUser = c.get("authUser") as AuthUser;
	return {
		userId: authUser.userId,
		keyId: authUser.keyId,
		isManage: callerHasManageScope(authUser),
	};
}

const limitBody = bodyLimit({
	maxSize: MAX_BODY_BYTES,
	onError: (c) => c.json({ error: "invalid_request", field: "body" }, 400),
});

async function readJson(c: Context): Promise<unknown> {
	return c.req.json().catch(() => null);
}

/**
 * The caller's device with this id, or the response to give instead. Someone
 * else's device answers exactly as a missing one, so ids can't be probed. A
 * respond key (which cannot manage) reaches only the phones registered with that
 * same key, in every mode: removing or changing another key's phone, which would
 * revoke another key's access, needs manage or a signed-in person.
 */
async function ownDevice(c: Context) {
	const device = await getDeviceById(c.req.param("id") ?? "");
	if (!device) return { refusal: c.json({ error: "not_found" }, 404) } as const;
	const who = caller(c);
	try {
		await assertCanManageDevice(await getRequestActor(c), device, who.keyId);
	} catch (err) {
		if (err instanceof NotOwnerError)
			return { refusal: c.json({ error: "not_found" }, 404) } as const;
		throw err;
	}
	if (!who.isManage && device.apiKeyId !== who.keyId) {
		return { refusal: c.json({ error: "own_device_only" }, 403) } as const;
	}
	return { device } as const;
}

// POST /api/v1/devices - register this phone, or refresh its registration.
// `api_key_id` is the key making the call. 201 when new, 200 when it already
// existed for this person; 409 when that phone is registered to someone else,
// was removed with this key, or is paired under another key.
devicesRouter.post("/devices", limitBody, async (c: Context) => {
	const refusal = refuseBadOrigin(c);
	if (refusal) return refusal;
	const who = caller(c);
	if (who.keyId && !tryConsumeRegistration(who.keyId)) {
		c.header("Retry-After", "3600");
		return c.json({ error: "rate_limited" }, 429);
	}
	try {
		const registration = await parseRegistration(await readJson(c));
		const { device, created } = await registerDevice(registration, who);
		return c.json(await toDeviceDtoOne(device), created ? 201 : 200);
	} catch (err) {
		if (err instanceof InvalidDeviceError) {
			return c.json({ error: "invalid_request", field: err.field }, 400);
		}
		if (err instanceof DeviceKeyRequiredError) return c.json({ error: "key_required" }, 400);
		if (err instanceof SecretsKeyMissingError) return c.json({ error: "secrets_key_missing" }, 503);
		if (err instanceof DeviceOwnedByAnotherError) return c.json({ error: "device_owned" }, 409);
		if (err instanceof DeviceRemovedError) return c.json({ error: "device_removed" }, 409);
		if (err instanceof DeviceKeyMismatchError) return c.json({ error: "device_key_mismatch" }, 409);
		if (err instanceof DeviceConflictError) return c.json({ error: "device_conflict" }, 409);
		if (err instanceof DeviceLimitError) {
			return c.json({ error: "device_limit", scope: err.scope }, 409);
		}
		throw err;
	}
});

/**
 * Whose phones a GET lists. A respond key sees the phones registered with that
 * key. A manage key or a signed-in person sees all of them in solo mode (where
 * everyone shares everything, and can manage any), and their own in team mode
 * (an ownerless manage key: its own key's).
 */
async function visibleDevices(c: Context): Promise<DeviceFilter | null> {
	const who = caller(c);
	if (config.disableAuth) return { all: true };
	if (!who.isManage) return who.keyId ? { keyId: who.keyId } : null;
	const actor = await getRequestActor(c);
	if (actor.mode === "solo") return { all: true };
	if (who.userId) return { userId: who.userId };
	return who.keyId ? { keyId: who.keyId } : null;
}

// GET /api/v1/devices - the caller's live phones. Never carries a push credential.
devicesRouter.get("/devices", async (c: Context) => {
	const filter = await visibleDevices(c);
	const devices = filter ? await listDevices(filter) : [];
	c.header("Cache-Control", "no-store");
	return c.json({ devices: await toDeviceDtos(devices) });
});

// PATCH /api/v1/devices/:id - { deviceName?, prefs? }; prefs replace the old ones.
devicesRouter.patch("/devices/:id", limitBody, async (c: Context) => {
	const refusal = refuseBadOrigin(c);
	if (refusal) return refusal;
	const own = await ownDevice(c);
	if ("refusal" in own) return own.refusal;
	try {
		const updated = await updateDevice(own.device.id, parsePatch(await readJson(c)));
		if (!updated) return c.json({ error: "not_found" }, 404);
		return c.json(await toDeviceDtoOne(updated));
	} catch (err) {
		if (err instanceof InvalidDeviceError) {
			return c.json({ error: "invalid_request", field: err.field }, 400);
		}
		throw err;
	}
});

// DELETE /api/v1/devices/:id - revoke a phone. Its key is deactivated too, but
// only if a pairing code produced it: a key someone pasted into the app is theirs.
// The phone and the key are revoked in one transaction (the key's revocation
// revokes its devices on that transaction), so neither can be left half done; a
// second call finishes the job if a paired key is somehow still active.
devicesRouter.delete("/devices/:id", async (c: Context) => {
	const refusal = refuseBadOrigin(c);
	if (refusal) return refusal;
	const own = await ownDevice(c);
	if ("refusal" in own) return own.refusal;
	const { device } = own;

	const keyToRevoke = (await isActivePairingMintedKey(device.apiKeyId)) ? device.apiKeyId : null;
	let keyRevoked = false;
	if (keyToRevoke) {
		keyRevoked = await revokeApiKey(keyToRevoke, {
			withinTransaction: device.revokedAt
				? undefined
				: (tx) => revokeDeviceRow(device.id, "deleted", tx),
		});
	}
	if (!device.revokedAt && !keyRevoked) await revokeDeviceRow(device.id, "deleted");
	return c.json({ ok: true, keyRevoked });
});

// POST /api/v1/devices/:id/test - a test push, 5 a minute per device and 10 per
// person. A request that is refused (not yours, revoked, over a limit) spends no
// budget. Push not set up on this server (no relay, or no secrets key) answers 503.
devicesRouter.post("/devices/:id/test", async (c: Context) => {
	const refusal = refuseBadOrigin(c);
	if (refusal) return refusal;
	const own = await ownDevice(c);
	if ("refusal" in own) return own.refusal;
	if (own.device.revokedAt) return c.json({ error: "not_found" }, 404);
	const who = caller(c);
	if (!tryConsumeDeviceTest(own.device.id, who.userId ?? who.keyId ?? "anonymous")) {
		c.header("Retry-After", "60");
		return c.json({ error: "rate_limited" }, 429);
	}
	const runtime = getPushRuntime();
	if (!runtime || !pushAvailability().available) return c.json({ error: "push_unavailable" }, 503);
	const pushDevice = await getPushDevice(own.device.id);
	if (!pushDevice) return c.json({ error: "not_found" }, 404);
	const [outcome] = await runtime.service.sendToDevices([pushDevice], {
		type: "device_test",
		testId: crypto.randomUUID(),
	});
	return testResponse(c, outcome);
});

/** What the relay's answer means to the person who pressed "Send test". */
function testResponse(c: Context, outcome: AlertOutcome | undefined) {
	switch (outcome?.status) {
		case "sent":
			return c.json({ ok: true, ...(outcome.pushId ? { pushId: outcome.pushId } : {}) });
		case "gone":
			return c.json({ error: "device_gone" }, 404);
		case "budget_limited": {
			if (outcome.retryAfterSec !== null) c.header("Retry-After", String(outcome.retryAfterSec));
			return c.json({ error: "rate_limited" }, 429);
		}
		case "category_limited":
		case "session_limited":
		case "deduped":
			c.header("Retry-After", "60");
			return c.json({ error: "rate_limited" }, 429);
		case "unavailable":
		case "queue_full":
			return c.json({ error: "push_unavailable" }, 503);
		default:
			return c.json({ error: "push_failed", reason: outcome?.status ?? "unknown" }, 502);
	}
}

export { devicesRouter };
