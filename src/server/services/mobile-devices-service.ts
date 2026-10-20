/**
 * Mobile devices: the phones registered with this server. A device row ties a
 * phone's push credentials to the API key it talks with and to that key's owner.
 *
 * Revocation lives here too. A device is revoked (revoked_at set, never deleted
 * at once, and its send token wiped) when its key stops being valid
 * (`onKeysDeactivated`), when its key is handed to someone else
 * (`onKeyOwnerChanged`: the phone must register again under the new owner), or when
 * it is deleted by hand. The first two are called by every writer that changes a
 * key, on the transaction that does it, so a key and its devices are never out of
 * step. Deleting a device also deactivates its key, but only when that key came from
 * a pairing code (retained pairing provenance): a key someone pasted into the app is
 * theirs and is never revoked by removing a phone.
 */
import { and, count, eq, inArray, isNull, lt } from "drizzle-orm";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { apiKeys, mobileDevices, pairingCodes } from "../db/schema/index.js";
import { requestWsRevalidation } from "../ws/revalidation.js";
import { decryptSecret, encryptSecretAsync } from "./ai/secrets.js";
import { cleanDisplayText } from "./util/clean-text.js";
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

type DeviceRow = typeof mobileDevices.$inferSelect;

/** Platforms a phone may register as: iOS today, Android reserved. */
export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export const DEVICE_ENVIRONMENTS = ["sandbox", "production", "development"] as const;
export type DeviceEnvironment = (typeof DEVICE_ENVIRONMENTS)[number];
/** What the sealed push payload's ids allow (push-payload.schema.json ShortId). A phone whose ids don't fit could never be pushed to, so registration refuses them. */
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
/** Printable ASCII, no spaces: what a relay token or key id is made of. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const MAX_TOKEN_LENGTH = 512;
const MAX_KID_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const MAX_VERSION_LENGTH = 32;
export const MAX_PREFS_BYTES = 4096;
/** Uncompressed P-256 point: 0x04 then X and Y, 32 bytes each. */
const P256_POINT_BYTES = 65;

/** Devices are purged this long after they were revoked. */
export const REVOKED_DEVICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class DeviceOwnedByAnotherError extends Error {
	constructor() {
		super("That device is registered to someone else.");
		this.name = "DeviceOwnedByAnotherError";
	}
}

/** The caller's phone was removed by hand with this same key; it must pair again to register. */
export class DeviceRemovedError extends Error {
	constructor() {
		super("That device was removed. Pair it again.");
		this.name = "DeviceRemovedError";
	}
}

/** The phone is paired under another key and the caller may not move it. */
export class DeviceKeyMismatchError extends Error {
	constructor() {
		super("That device is paired with a different key.");
		this.name = "DeviceKeyMismatchError";
	}
}

/** The row changed while the registration was being applied; the phone retries. */
export class DeviceConflictError extends Error {
	constructor() {
		super("That device changed while it was being registered. Try again.");
		this.name = "DeviceConflictError";
	}
}

export class DeviceLimitError extends Error {
	constructor(readonly scope: "key" | "user") {
		super(`Too many devices for this ${scope}.`);
		this.name = "DeviceLimitError";
	}
}

/** Push credentials are stored encrypted under AGENTPULSE_SECRETS_KEY; without it a phone can't register. */
export class SecretsKeyMissingError extends Error {
	constructor() {
		super("AGENTPULSE_SECRETS_KEY is not set.");
		this.name = "SecretsKeyMissingError";
	}
}

/** A device registers with its own API key; a caller with none (a browser session) has nothing to bind it to. */
export class DeviceKeyRequiredError extends Error {
	constructor() {
		super("A device registers with its own API key.");
		this.name = "DeviceKeyRequiredError";
	}
}

export class InvalidDeviceError extends Error {
	constructor(readonly field: string) {
		super(`invalid ${field}`);
		this.name = "InvalidDeviceError";
	}
}

export interface DeviceCaller {
	userId: string | null;
	keyId: string | null;
	/** Holds `manage` (or is a signed-in person): may move a paired phone between keys and remove other keys' phones. */
	isManage: boolean;
}

/** Live devices one key, and one person, may hold. */
export const MAX_DEVICES_PER_KEY = 10;
export const MAX_DEVICES_PER_USER = 20;

// ── Validation ───────────────────────────────────────────────────────────────

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
	try {
		const decoded = Buffer.from(input, "base64url");
		const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
		bytes.set(decoded);
		return bytes;
	} catch {
		return null;
	}
}

/**
 * True when `publicKey` (base64url) is an uncompressed P-256 point that lies on
 * the curve. The length and the 0x04 prefix are checked here (WebCrypto also
 * accepts compressed points); the curve check is the platform's import.
 */
export async function isValidP256PublicKey(publicKey: unknown): Promise<boolean> {
	if (typeof publicKey !== "string") return false;
	const bytes = base64UrlToBytes(publicKey);
	if (!bytes || bytes.length !== P256_POINT_BYTES || bytes[0] !== 0x04) return false;
	try {
		await crypto.subtle.importKey("raw", bytes, { name: "ECDH", namedCurve: "P-256" }, true, []);
		return true;
	} catch {
		return false;
	}
}

function requireText(value: unknown, field: string, max: number, pattern?: RegExp): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		throw new InvalidDeviceError(field);
	}
	if (pattern && !pattern.test(value)) throw new InvalidDeviceError(field);
	return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
	if (value === undefined || value === null) return null;
	const cleaned = cleanDisplayText(value, max);
	if (typeof value !== "string" || cleaned.length === 0) throw new InvalidDeviceError(field);
	return cleaned;
}

// ── Preferences (the C1 contract's DevicePrefs) ──────────────────────────────

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIGEST_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_CATEGORIES = 64;

function isIanaZone(value: string): boolean {
	if (value.length === 0 || value.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/**
 * Checks a prefs object against DevicePrefs and returns it as stored JSON. The
 * members the contract names are typed (showContent, includeAgentText, quietHours,
 * categories, timezone, digestHour, lastDigestDate); anything else is kept, as the
 * contract leaves additionalProperties open, within the overall size limit.
 */
function serializePrefs(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw new InvalidDeviceError("prefs");
	const prefs = value as Record<string, unknown>;
	const bad = (): never => {
		throw new InvalidDeviceError("prefs");
	};
	for (const flag of ["showContent", "includeAgentText"]) {
		if (prefs[flag] !== undefined && typeof prefs[flag] !== "boolean") bad();
	}
	if (prefs.quietHours !== undefined) {
		const q = prefs.quietHours as Record<string, unknown> | null;
		if (
			q === null ||
			typeof q !== "object" ||
			Array.isArray(q) ||
			typeof q.enabled !== "boolean" ||
			typeof q.start !== "string" ||
			!HH_MM.test(q.start) ||
			typeof q.end !== "string" ||
			!HH_MM.test(q.end)
		) {
			bad();
		}
	}
	if (prefs.categories !== undefined) {
		const c = prefs.categories as Record<string, unknown> | null;
		if (c === null || typeof c !== "object" || Array.isArray(c)) bad();
		const entries = Object.entries(c as Record<string, unknown>);
		if (entries.length > MAX_CATEGORIES) bad();
		for (const [name, enabled] of entries) {
			if (!CATEGORY_NAME.test(name) || typeof enabled !== "boolean") bad();
		}
	}
	if (
		prefs.timezone !== undefined &&
		(typeof prefs.timezone !== "string" || !isIanaZone(prefs.timezone))
	) {
		bad();
	}
	if (
		prefs.digestHour !== undefined &&
		(typeof prefs.digestHour !== "number" ||
			!Number.isInteger(prefs.digestHour) ||
			prefs.digestHour < 0 ||
			prefs.digestHour > 23)
	) {
		bad();
	}
	if (
		prefs.lastDigestDate !== undefined &&
		(typeof prefs.lastDigestDate !== "string" || !DIGEST_DATE.test(prefs.lastDigestDate))
	) {
		bad();
	}
	const text = JSON.stringify(prefs);
	if (new TextEncoder().encode(text).length > MAX_PREFS_BYTES) bad();
	return text;
}

export interface DeviceRegistration {
	platform: (typeof DEVICE_PLATFORMS)[number];
	environment: DeviceEnvironment;
	relayDeviceId: string;
	sendToken: string;
	kid: string;
	publicKey: string;
	clientServerRef: string;
	deviceName: string | null;
	appVersion: string | null;
	osVersion: string | null;
	prefsJson: string | null;
}

/** The registration in a request body, or an InvalidDeviceError naming the field that is wrong. */
export async function parseRegistration(body: unknown): Promise<DeviceRegistration> {
	const b = (body ?? {}) as Record<string, unknown>;
	if (!(DEVICE_PLATFORMS as readonly unknown[]).includes(b.platform)) {
		throw new InvalidDeviceError("platform");
	}
	if (!(DEVICE_ENVIRONMENTS as readonly unknown[]).includes(b.environment)) {
		throw new InvalidDeviceError("environment");
	}
	if (!(await isValidP256PublicKey(b.publicKey))) throw new InvalidDeviceError("publicKey");
	return {
		platform: b.platform as DeviceRegistration["platform"],
		environment: b.environment as DeviceEnvironment,
		relayDeviceId: requireText(b.relayDeviceId, "relayDeviceId", 64, ID_PATTERN),
		sendToken: requireText(b.sendToken, "sendToken", MAX_TOKEN_LENGTH, TOKEN_PATTERN),
		kid: requireText(b.kid, "kid", MAX_KID_LENGTH, ID_PATTERN),
		publicKey: b.publicKey as string,
		clientServerRef: requireText(b.clientServerRef, "clientServerRef", 64, ID_PATTERN),
		deviceName: optionalText(b.deviceName, "deviceName", MAX_NAME_LENGTH),
		appVersion: optionalText(b.appVersion, "appVersion", MAX_VERSION_LENGTH),
		osVersion: optionalText(b.osVersion, "osVersion", MAX_VERSION_LENGTH),
		prefsJson: serializePrefs(b.prefs),
	};
}

export interface DevicePatch {
	deviceName?: string;
	prefsJson?: string;
}

/** A PATCH body: a new name and/or new prefs (which replace the old ones). At least one. */
export function parsePatch(body: unknown): DevicePatch {
	const b = (body ?? {}) as Record<string, unknown>;
	const patch: DevicePatch = {};
	if (b.deviceName !== undefined) {
		patch.deviceName = optionalText(b.deviceName, "deviceName", MAX_NAME_LENGTH) ?? undefined;
		if (patch.deviceName === undefined) throw new InvalidDeviceError("deviceName");
	}
	if (b.prefs !== undefined) {
		const prefs = serializePrefs(b.prefs);
		if (prefs === null) throw new InvalidDeviceError("prefs");
		patch.prefsJson = prefs;
	}
	if (patch.deviceName === undefined && patch.prefsJson === undefined) {
		throw new InvalidDeviceError("body");
	}
	return patch;
}

// ── What a route may return ──────────────────────────────────────────────────

export interface DeviceDto {
	id: string;
	platform: string;
	environment: string;
	relayDeviceId: string;
	kid: string;
	clientServerRef: string;
	deviceName: string | null;
	appVersion: string | null;
	osVersion: string | null;
	prefs: Record<string, unknown> | null;
	/** True when the device's current key came from a pairing code (looked up now, not remembered). */
	paired: boolean;
	lastSeenAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** The send token and the public key are never returned: the phone already has what it needs, and a read mustn't leak a push credential. */
function toDeviceDto(row: DeviceRow, paired: boolean): DeviceDto {
	return {
		id: row.id,
		platform: row.platform,
		environment: row.environment,
		relayDeviceId: row.relayDeviceId,
		kid: row.kid,
		clientServerRef: row.clientServerRef,
		deviceName: row.deviceName,
		appVersion: row.appVersion,
		osVersion: row.osVersion,
		prefs: row.prefsJson ? (JSON.parse(row.prefsJson) as Record<string, unknown>) : null,
		paired,
		lastSeenAt: row.lastSeenAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** The DTOs for these rows; `paired` comes from one lookup of which of their keys a retained pairing code produced. */
export async function toDeviceDtos(rows: readonly DeviceRow[]): Promise<DeviceDto[]> {
	const paired = await pairedKeyIds(rows.map((r) => r.apiKeyId));
	return rows.map((row) => toDeviceDto(row, paired.has(row.apiKeyId)));
}

export async function toDeviceDtoOne(row: DeviceRow): Promise<DeviceDto> {
	return (await toDeviceDtos([row]))[0] as DeviceDto;
}

// ── Pairing provenance ───────────────────────────────────────────────────────

/** The pairing code that produced `keyId`, if one is still retained. */
async function pairingCodeIdForKey(keyId: string): Promise<string | null> {
	const [row] = await getDb()
		.select({ id: pairingCodes.id })
		.from(pairingCodes)
		.where(eq(pairingCodes.redeemedKeyId, keyId))
		.limit(1);
	return row?.id ?? null;
}

/** Of these keys, the ones a retained pairing code produced. */
async function pairedKeyIds(keyIds: readonly string[]): Promise<Set<string>> {
	const unique = [...new Set(keyIds)];
	if (unique.length === 0) return new Set();
	const rows = await getDb()
		.select({ keyId: pairingCodes.redeemedKeyId })
		.from(pairingCodes)
		.where(inArray(pairingCodes.redeemedKeyId, unique));
	return new Set(rows.flatMap((r) => (r.keyId ? [r.keyId] : [])));
}

/** True when a retained pairing code produced this key and the key is still active (revoking it is the device delete's to do). */
export async function isActivePairingMintedKey(keyId: string): Promise<boolean> {
	const [row] = await getDb()
		.select({ id: pairingCodes.id })
		.from(pairingCodes)
		.innerJoin(apiKeys, eq(apiKeys.id, pairingCodes.redeemedKeyId))
		.where(and(eq(pairingCodes.redeemedKeyId, keyId), eq(apiKeys.isActive, true)))
		.limit(1);
	return row !== undefined;
}

/** True when this key was produced by a pairing code whose row is still retained. */
export async function isPairingMintedKey(keyId: string): Promise<boolean> {
	return (await pairingCodeIdForKey(keyId)) !== null;
}

// ── The send token, encrypted at rest ────────────────────────────────────────

/**
 * Reads a device's relay send token: decrypts it, or returns null for a revoked
 * device (whose token is wiped) or one whose token can't be read (the secrets key
 * changed). Nothing else returns or logs it. This is the synchronous read, for
 * tests and one-off tooling: it stalls the event loop for tens of milliseconds
 * (scrypt), so the push send path never uses it and decrypts the stored token
 * through `decryptSecretAsync` instead.
 */
export function readSendToken(
	device: Pick<DeviceRow, "id" | "sendToken" | "revokedAt">,
): string | null {
	if (device.revokedAt !== null || device.sendToken === "") return null;
	try {
		return decryptSecret(device.sendToken);
	} catch {
		console.error(JSON.stringify({ kind: "device_send_token_unreadable", deviceId: device.id }));
		return null;
	}
}

// ── Limits ───────────────────────────────────────────────────────────────────

/** Registrations one key may make an hour (every call counts, updates included). */
export const DEVICE_REGISTRATIONS_PER_HOUR = 10;
const registrationCounter = new FixedWindowCounter(3_600_000);

export function tryConsumeRegistration(keyId: string): boolean {
	return registrationCounter.tryConsume(keyId, DEVICE_REGISTRATIONS_PER_HOUR);
}

export const DEVICE_TEST_PUSHES_PER_MINUTE = 5;
export const USER_TEST_PUSHES_PER_MINUTE = 10;
const testCounter = new FixedWindowCounter(60_000);
const userTestCounter = new FixedWindowCounter(60_000);

/**
 * Counts one test push against both the phone's and the caller's budget, or
 * neither: a request that would exceed either is refused without spending the other.
 */
export function tryConsumeDeviceTest(deviceId: string, callerKey: string): boolean {
	if (testCounter.isAtLimit(deviceId, DEVICE_TEST_PUSHES_PER_MINUTE)) return false;
	if (userTestCounter.isAtLimit(callerKey, USER_TEST_PUSHES_PER_MINUTE)) return false;
	testCounter.tryConsume(deviceId, DEVICE_TEST_PUSHES_PER_MINUTE);
	userTestCounter.tryConsume(callerKey, USER_TEST_PUSHES_PER_MINUTE);
	return true;
}

/** Follow requests one phone may make a minute. A phone follows a few sessions; this stops a loop. */
export const DEVICE_ACTIVITY_STARTS_PER_MINUTE = 30;
const activityStartCounter = new FixedWindowCounter(60_000);

export function tryConsumeActivityStart(deviceId: string): boolean {
	return activityStartCounter.tryConsume(deviceId, DEVICE_ACTIVITY_STARTS_PER_MINUTE);
}

export function _resetDeviceLimitsForTest(): void {
	activityStartCounter.reset();
	testCounter.reset();
	userTestCounter.reset();
	registrationCounter.reset();
}

export function _setDeviceLimitClockForTest(clock: (() => number) | null): void {
	testCounter.setClock(clock);
	userTestCounter.setClock(clock);
	registrationCounter.setClock(clock);
	activityStartCounter.setClock(clock);
}

// ── Register, read, update ───────────────────────────────────────────────────

function sameOwner(existing: DeviceRow, caller: DeviceCaller): boolean {
	if (existing.userId !== caller.userId) return false;
	// Two callers with no user are not the same person: only the same key is.
	return caller.userId !== null || existing.apiKeyId === caller.keyId;
}

function ownedBy(userId: string | null) {
	return userId === null ? isNull(mobileDevices.userId) : eq(mobileDevices.userId, userId);
}

async function assertRoomFor(caller: DeviceCaller): Promise<void> {
	const db = getDb();
	const live = isNull(mobileDevices.revokedAt);
	const [byKey] = await db
		.select({ n: count() })
		.from(mobileDevices)
		.where(and(live, eq(mobileDevices.apiKeyId, caller.keyId as string)));
	if ((byKey?.n ?? 0) >= MAX_DEVICES_PER_KEY) throw new DeviceLimitError("key");
	if (caller.userId !== null) {
		const [byUser] = await db
			.select({ n: count() })
			.from(mobileDevices)
			.where(and(live, eq(mobileDevices.userId, caller.userId)));
		if ((byUser?.n ?? 0) >= MAX_DEVICES_PER_USER) throw new DeviceLimitError("user");
	}
}

/**
 * Registers a phone, or updates the registration it already has. The unique
 * (platform, relay device id) is the phone's identity.
 *
 *  - New: inserted (201), within the per-key and per-user caps.
 *  - Live, same person: refreshed. If its key is a paired one and the caller's is a
 *    different key, only a manage caller may move it (DeviceKeyMismatchError).
 *  - Live, another person (or, for ownerless keys, another key): DeviceOwnedByAnotherError.
 *  - Revoked: anyone may claim it. It is reset to the new owner and key and nothing
 *    of the old registration is kept, except that a phone removed by hand with this
 *    same key stays removed (DeviceRemovedError): that key must be paired afresh.
 * Returns the row and whether it was created.
 */
export async function registerDevice(
	registration: DeviceRegistration,
	caller: DeviceCaller,
	now: Date = new Date(),
): Promise<{ device: DeviceRow; created: boolean }> {
	if (!caller.keyId) throw new DeviceKeyRequiredError();
	if (!config.secretsKey) throw new SecretsKeyMissingError();
	const nowIso = now.toISOString();
	const sendToken = await encryptSecretAsync(registration.sendToken);
	const pairedViaCodeId = await pairingCodeIdForKey(caller.keyId);
	const db = getDb();

	const fields = {
		userId: caller.userId,
		apiKeyId: caller.keyId,
		pairedViaCodeId,
		platform: registration.platform,
		environment: registration.environment,
		relayDeviceId: registration.relayDeviceId,
		sendToken,
		kid: registration.kid,
		publicKey: registration.publicKey,
		clientServerRef: registration.clientServerRef,
		deviceName: registration.deviceName,
		appVersion: registration.appVersion,
		osVersion: registration.osVersion,
		prefsJson: registration.prefsJson,
		lastSeenAt: nowIso,
		updatedAt: nowIso,
		revokedAt: null,
		revokedReason: null,
	};

	for (let attempt = 0; attempt < 3; attempt++) {
		const [existing] = await db
			.select()
			.from(mobileDevices)
			.where(
				and(
					eq(mobileDevices.platform, registration.platform),
					eq(mobileDevices.relayDeviceId, registration.relayDeviceId),
				),
			)
			.limit(1);

		if (!existing) {
			await assertRoomFor(caller);
			const inserted = await db
				.insert(mobileDevices)
				.values({ ...fields, createdAt: nowIso })
				.onConflictDoNothing()
				.returning();
			if (inserted[0]) return { device: inserted[0], created: true };
			continue; // someone registered it between our read and our insert: look again
		}

		if (existing.revokedAt !== null) {
			if (existing.revokedReason === "deleted" && existing.apiKeyId === caller.keyId) {
				throw new DeviceRemovedError();
			}
			await assertRoomFor(caller);
			// Reset to the new owner: the old name, prefs and provenance are not inherited.
			const [claimed] = await db
				.update(mobileDevices)
				.set(fields)
				.where(
					and(eq(mobileDevices.id, existing.id), eq(mobileDevices.revokedAt, existing.revokedAt)),
				)
				.returning();
			if (!claimed) continue;
			return { device: claimed, created: false };
		}

		if (!sameOwner(existing, caller)) throw new DeviceOwnedByAnotherError();
		if (
			existing.apiKeyId !== caller.keyId &&
			!caller.isManage &&
			(await isPairingMintedKey(existing.apiKeyId))
		) {
			throw new DeviceKeyMismatchError();
		}

		const [updated] = await db
			.update(mobileDevices)
			.set({
				...fields,
				// provenance is set once and kept; it is filled only if it was empty
				pairedViaCodeId: existing.pairedViaCodeId ?? pairedViaCodeId,
				deviceName: registration.deviceName ?? existing.deviceName,
				appVersion: registration.appVersion ?? existing.appVersion,
				osVersion: registration.osVersion ?? existing.osVersion,
				prefsJson:
					registration.prefsJson === null
						? existing.prefsJson
						: carryDigestMarker(registration.prefsJson, existing.prefsJson),
			})
			.where(
				and(
					eq(mobileDevices.id, existing.id),
					ownedBy(existing.userId),
					isNull(mobileDevices.revokedAt),
					prefsUnchanged(existing.prefsJson),
				),
			)
			.returning();
		if (!updated) {
			// Only a change of the stored prefs (the digest job's marker) is worth another look; a change of owner
			// or a revocation is the phone's to retry.
			const [now] = await db
				.select({ prefsJson: mobileDevices.prefsJson })
				.from(mobileDevices)
				.where(
					and(
						eq(mobileDevices.id, existing.id),
						ownedBy(existing.userId),
						isNull(mobileDevices.revokedAt),
					),
				)
				.limit(1);
			if (now && now.prefsJson !== existing.prefsJson) continue;
			throw new DeviceConflictError();
		}
		return { device: updated, created: false };
	}
	throw new DeviceConflictError();
}

export async function getDeviceById(id: string): Promise<DeviceRow | null> {
	const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, id)).limit(1);
	return row ?? null;
}

/** Whose live devices a caller sees: everyone's, one person's, or one key's. */
export type DeviceFilter = { all: true } | { userId: string } | { keyId: string };

export async function listDevices(filter: DeviceFilter): Promise<DeviceRow[]> {
	const live = isNull(mobileDevices.revokedAt);
	let where = live;
	if ("userId" in filter) where = and(live, eq(mobileDevices.userId, filter.userId)) ?? live;
	else if ("keyId" in filter) where = and(live, eq(mobileDevices.apiKeyId, filter.keyId)) ?? live;
	return getDb().select().from(mobileDevices).where(where).orderBy(mobileDevices.createdAt);
}

/**
 * `prefs.lastDigestDate` belongs to the server (the digest job writes it): the new prefs carry the stored
 * value, whatever the phone sent, and have none when nothing is stored. Unreadable stored prefs carry nothing.
 */
export function carryDigestMarker(newPrefsJson: string, storedPrefsJson: string | null): string {
	const prefs = JSON.parse(newPrefsJson) as Record<string, unknown>;
	prefs.lastDigestDate = undefined;
	try {
		const stored = storedPrefsJson
			? (JSON.parse(storedPrefsJson) as Record<string, unknown>)
			: null;
		if (typeof stored?.lastDigestDate === "string" && DIGEST_DATE.test(stored.lastDigestDate)) {
			prefs.lastDigestDate = stored.lastDigestDate;
		}
	} catch {
		// unreadable stored prefs hold no marker
	}
	return JSON.stringify(prefs);
}

/** A column-equals-text guard that also matches NULL. */
function prefsUnchanged(stored: string | null) {
	return stored === null ? isNull(mobileDevices.prefsJson) : eq(mobileDevices.prefsJson, stored);
}

/** Times a PATCH of prefs is retried when the stored prefs changed between its read and its write. */
const PREFS_WRITE_ATTEMPTS = 3;

export async function updateDevice(
	id: string,
	patch: DevicePatch,
	now: Date = new Date(),
): Promise<DeviceRow | null> {
	const nowIso = now.toISOString();
	const db = getDb();
	const live = and(eq(mobileDevices.id, id), isNull(mobileDevices.revokedAt));
	const common = {
		...(patch.deviceName !== undefined ? { deviceName: patch.deviceName } : {}),
		lastSeenAt: nowIso,
		updatedAt: nowIso,
	};
	if (patch.prefsJson === undefined) {
		const [row] = await db.update(mobileDevices).set(common).where(live).returning();
		return row ?? null;
	}
	for (let attempt = 0; attempt < PREFS_WRITE_ATTEMPTS; attempt++) {
		const [current] = await db.select().from(mobileDevices).where(live).limit(1);
		if (!current) return null;
		const [row] = await db
			.update(mobileDevices)
			.set({ ...common, prefsJson: carryDigestMarker(patch.prefsJson, current.prefsJson) })
			.where(and(live, prefsUnchanged(current.prefsJson)))
			.returning();
		if (row) return row;
	}
	throw new DeviceConflictError();
}

// ── Revocation ───────────────────────────────────────────────────────────────

/**
 * Marks the devices of these keys revoked and wipes their send tokens. Called by
 * every writer that deactivates API keys, with the transaction that does it, so a
 * key and its devices are never out of step. Returns how many devices it revoked.
 */
export async function onKeysDeactivated(
	keyIds: readonly string[],
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx?: any,
	now: Date = new Date(),
): Promise<number> {
	if (keyIds.length === 0) return 0;
	const nowIso = now.toISOString();
	const rows = await (tx ?? getDb())
		.update(mobileDevices)
		.set({ revokedAt: nowIso, revokedReason: "key_deactivated", sendToken: "", updatedAt: nowIso })
		.where(and(inArray(mobileDevices.apiKeyId, [...keyIds]), isNull(mobileDevices.revokedAt)))
		.returning({ id: mobileDevices.id });
	return rows.length;
}

/**
 * A key changed owner: its phones were registered under the old one, so they are
 * revoked (reason `owner_changed`, token wiped) and must register again under the
 * new owner. Nothing moves silently. A change to the same owner does nothing.
 */
export async function onKeyOwnerChanged(
	keyId: string,
	previousOwnerUserId: string | null,
	ownerUserId: string | null,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx?: any,
	now: Date = new Date(),
): Promise<number> {
	if (previousOwnerUserId === ownerUserId) return 0;
	const nowIso = now.toISOString();
	const rows = await (tx ?? getDb())
		.update(mobileDevices)
		.set({ revokedAt: nowIso, revokedReason: "owner_changed", sendToken: "", updatedAt: nowIso })
		.where(and(eq(mobileDevices.apiKeyId, keyId), isNull(mobileDevices.revokedAt)))
		.returning({ id: mobileDevices.id });
	return rows.length;
}

/**
 * Marks one device revoked and wipes its send token (no effect on one already revoked), then asks the
 * push side to forget what it cached about who may be sent to. Given a transaction the change isn't
 * committed yet, so the caller requests the revalidation once it has committed.
 */
export async function revokeDeviceRow(
	id: string,
	reason: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx?: any,
	now: Date = new Date(),
): Promise<void> {
	const nowIso = now.toISOString();
	await (tx ?? getDb())
		.update(mobileDevices)
		.set({ revokedAt: nowIso, revokedReason: reason, sendToken: "", updatedAt: nowIso })
		.where(and(eq(mobileDevices.id, id), isNull(mobileDevices.revokedAt)));
	if (!tx) await requestWsRevalidation();
}

/** Purges devices revoked more than 30 days ago (their activities go with them by cascade). */
export async function deleteRevokedDevices(now: Date = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - REVOKED_DEVICE_RETENTION_MS).toISOString();
	const rows = await getDb()
		.delete(mobileDevices)
		.where(lt(mobileDevices.revokedAt, cutoff))
		.returning({ id: mobileDevices.id });
	return rows.length;
}
