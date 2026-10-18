/**
 * Mobile pairing: a signed-in person mints a short single-use code, a phone
 * redeems it for an API key owned by that person.
 *
 * Codes are 20 characters of Crockford base32 (100 bits), valid for five minutes.
 * The QR is the only way a code travels (nobody types one), so its length costs
 * nothing and guessing is out of the question; the limiter is a backstop.
 * Only the SHA-256 of the normalized code is stored, and the code is never
 * logged. Redemption is one atomic step with the key insert: the key is created
 * under the admin lock and the code is claimed by a compare-and-swap in that same
 * transaction, so two phones racing for one code produce exactly one key, and a
 * failed claim rolls the key back.
 *
 * A redeemed row stays as provenance (which key this code produced) until that
 * key is inactive or gone; see retention-service.
 *
 * Every refusal reaches the caller as the same `invalid_code`: a wrong, used,
 * expired or malformed code, a disabled owner, a lost race, and a caller the
 * limiter has stopped, are indistinguishable from outside.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { SCOPE_MANAGE, SCOPE_RESPOND, createApiKey } from "../auth/api-key.js";
import { rateLimitKeyForIp } from "../auth/client-ip.js";
import { OwnerDisabledError } from "../auth/owner-state.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { apiKeys, authSessions, pairingCodes } from "../db/schema/index.js";
import { getMode } from "./instance-mode.js";
import { getAdminServiceKeyIds } from "./service-keys.js";
import { cleanDisplayText } from "./util/clean-text.js";
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

export type PairingAccess = "full" | "respond";

export const PAIRING_ACCESS: readonly PairingAccess[] = ["full", "respond"];
export const PAIRING_CODE_LENGTH = 20;
export const PAIRING_CODE_TTL_MS = 300_000;
/** Longest device label or name kept; longer input is cut. */
export const PAIRING_NAME_MAX_LENGTH = 64;
const PLATFORM_PATTERN = /^[a-z][a-z0-9_-]{1,15}$/;

/** Crockford base32: no I, L, O or U. 32 symbols, so a random byte maps without bias. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** What a paired key may do: `full` is a manage key (every operator route), `respond` the narrow mobile scope. */
export function scopesFor(access: PairingAccess): string[] {
	return access === "respond" ? [SCOPE_RESPOND] : [SCOPE_MANAGE];
}

export class InvalidPairingCodeError extends Error {
	constructor() {
		super("invalid_code");
		this.name = "InvalidPairingCodeError";
	}
}

/** Thrown inside the redeem transaction when the compare-and-swap claims nothing. */
export class PairingRaceError extends Error {
	constructor() {
		super("pairing code was claimed concurrently");
		this.name = "PairingRaceError";
	}
}

export function generatePairingCode(): string {
	const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => ALPHABET[byte % 32]).join("");
}

/**
 * The canonical form of what a person typed or a QR carried, or null when it
 * can't be a code: upper-cased, whitespace and hyphens dropped, I and L read as
 * 1, O as 0. U is not in the alphabet and is refused rather than guessed.
 */
export function normalizePairingCode(input: string): string | null {
	const cleaned = input
		.toUpperCase()
		.replace(/[\s-]+/g, "")
		.replace(/[IL]/g, "1")
		.replace(/O/g, "0");
	if (cleaned.length !== PAIRING_CODE_LENGTH) return null;
	for (const char of cleaned) if (!ALPHABET.includes(char)) return null;
	return cleaned;
}

/** The hash a code is stored under (of its normalized form). */
export async function hashPairingCode(normalized: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanText(input: unknown): string {
	return cleanDisplayText(input, PAIRING_NAME_MAX_LENGTH);
}

// ── The minter's credential ──────────────────────────────────────────────────

/**
 * A code with no owner makes an ownerless key. In solo that is ordinary. In team
 * mode an ownerless key is something an admin decides on (the mode switch asks
 * about each one), so a code of that kind is honoured only while it is held by a
 * key an admin has kept: a code minted in solo and still unredeemed when the mode
 * is switched to team is refused, rather than becoming a key nobody ruled on.
 */
async function ownerlessCodeStillAllowed(minterCredential: string | null): Promise<boolean> {
	if ((await getMode()) === "solo") return true;
	if (!minterCredential?.startsWith("key:")) return false;
	return (await getAdminServiceKeyIds()).includes(minterCredential.slice(4));
}

/**
 * What a code remembers about the credential it was minted with: `key:<api key
 * id>` or `session:<session token hash>`. A code dies with that credential: once
 * the key is revoked or the session ends, redeeming it is refused, so signing out
 * (or revoking the key) takes back a code that is still on a screen. A caller with
 * neither leaves it null and the code is bound to its five minutes alone (and to
 * the access it was minted with, which the web defaults to `respond`).
 *
 * That covers signed-out sessions and revoked keys, and an SSO user's dashboard
 * session too, because the forwardauth bridge gives the browser an `ap_session`
 * cookie that the mint request carries. It does NOT cover a minter whose request
 * carries only proxy-supplied identity headers with no cookie and no key, or
 * auth off: there is no stable, revocable handle on that path (the headers are
 * re-asserted on every request and nothing server-side can be turned off), so
 * those codes rely on the five-minute TTL.
 */
async function minterStillActive(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	credential: string | null,
	nowIso: string,
): Promise<boolean> {
	if (credential === null) return true;
	if (credential.startsWith("key:")) {
		const [row] = await db
			.select({ isActive: apiKeys.isActive })
			.from(apiKeys)
			.where(eq(apiKeys.id, credential.slice(4)))
			.limit(1);
		return row?.isActive === true;
	}
	if (credential.startsWith("session:")) {
		const [row] = await db
			.select({ expiresAt: authSessions.expiresAt })
			.from(authSessions)
			.where(eq(authSessions.tokenHash, credential.slice(8)))
			.limit(1);
		return row !== undefined && row.expiresAt > nowIso;
	}
	return false;
}

// ── Mint ─────────────────────────────────────────────────────────────────────

export interface MintedPairingCode {
	id: string;
	code: string;
	expiresAt: string;
}

export async function mintPairingCode(input: {
	userId: string | null;
	access: PairingAccess;
	deviceLabel?: string | null;
	/** `key:<id>` or `session:<token hash>`; see "The minter's credential". */
	minterCredential?: string | null;
	now?: Date;
}): Promise<MintedPairingCode> {
	const now = input.now ?? new Date();
	const code = generatePairingCode();
	const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
	const [row] = await getDb()
		.insert(pairingCodes)
		.values({
			codeHash: await hashPairingCode(code),
			userId: input.userId,
			access: input.access,
			deviceLabel: cleanText(input.deviceLabel) || null,
			minterCredential: input.minterCredential ?? null,
			createdAt: now.toISOString(),
			expiresAt,
		})
		.returning({ id: pairingCodes.id });
	return { id: (row as { id: string }).id, code, expiresAt };
}

// ── Status (the web panel's countdown and "redeemed by") ────────────────────

export interface PairingCodeStatus {
	state: "pending" | "redeemed" | "expired";
	expiresAt: string;
	redeemedDeviceName: string | null;
	redeemedKeyId: string | null;
}

/**
 * The status of a code, for whoever minted it; null when it isn't theirs or doesn't
 * exist. A caller with a user id is the owner by that id. A caller with none (an
 * ownerless key, or auth off) is only the owner of an ownerless code, and then only
 * with the same credential that minted it (or with auth off, where everyone is the
 * same anonymous operator): two unrelated ownerless callers don't see each other's.
 */
export async function getPairingCodeStatus(
	id: string,
	caller: { userId: string | null; credential: string | null },
	now: Date = new Date(),
): Promise<PairingCodeStatus | null> {
	const [row] = await getDb().select().from(pairingCodes).where(eq(pairingCodes.id, id)).limit(1);
	if (!row) return null;
	const isOwner =
		caller.userId !== null
			? row.userId === caller.userId
			: row.userId === null &&
				(config.disableAuth ||
					(row.minterCredential !== null && row.minterCredential === caller.credential));
	if (!isOwner) return null;
	const state = row.redeemedAt
		? "redeemed"
		: row.expiresAt > now.toISOString()
			? "pending"
			: "expired";
	return {
		state,
		expiresAt: row.expiresAt,
		redeemedDeviceName: row.redeemedDeviceName,
		redeemedKeyId: row.redeemedKeyId,
	};
}

// ── Limiter ──────────────────────────────────────────────────────────────────

export const PAIRING_FAILURES_PER_IP = 10;
export const PAIRING_FAILURES_GLOBAL = 500;
/** How long a request is held once the global threshold is passed. */
export const PAIRING_TARPIT_MS = 2000;
/** Most requests held at once; past this a request is refused at once instead of waiting. */
export const PAIRING_TARPIT_MAX_HELD = 100;
const LIMIT_WINDOW_MS = 600_000;
const GLOBAL_SUBJECT = "global";

export interface PairingReservation {
	/** The attempt succeeded: give back the slots it reserved, so only failures stay counted. */
	succeeded(): void;
	/**
	 * The attempt failed. Below the global threshold this returns at once; past it the
	 * caller waits PAIRING_TARPIT_MS first (unless PAIRING_TARPIT_MAX_HELD others are
	 * already waiting, in which case it returns at once too). Only misses wait: a
	 * correct code never calls this.
	 */
	failed(): Promise<void>;
}

/**
 * Counts failed redemptions. An attempt reserves its slot before any hashing or
 * database work (so concurrent attempts can't all slip under the limit together)
 * and gives it back if it succeeds.
 *
 *  - Per client (IPv4 address, or IPv6 /64): at the limit, the attempt is refused
 *    without looking at the code.
 *  - Across everyone: past the threshold every attempt is still looked up, and a
 *    correct code is served at once; only a miss is held for PAIRING_TARPIT_MS
 *    before it is answered, so a distributed guess slows to a crawl while a real
 *    phone is never kept waiting. Only PAIRING_TARPIT_MAX_HELD misses wait at
 *    once; past that a miss is answered immediately.
 */
export class PairingLimiter {
	private readonly perClient = new FixedWindowCounter(LIMIT_WINDOW_MS);
	private readonly global = new FixedWindowCounter(LIMIT_WINDOW_MS);
	private held = 0;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: { clock?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
		if (options.clock) {
			this.perClient.setClock(options.clock);
			this.global.setClock(options.clock);
		}
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** Null when the attempt is refused outright (this client is at its limit). */
	reserve(ip: string): PairingReservation | null {
		const clientKey = rateLimitKeyForIp(ip);
		const clientWindow = this.perClient.tryReserve(clientKey, PAIRING_FAILURES_PER_IP);
		if (clientWindow === null) return null;
		const globalWindow = this.global.tryReserve(GLOBAL_SUBJECT, PAIRING_FAILURES_GLOBAL);
		const tarpitted = globalWindow === null;
		return {
			succeeded: () => {
				this.perClient.refund(clientKey, clientWindow);
				if (globalWindow !== null) this.global.refund(GLOBAL_SUBJECT, globalWindow);
			},
			failed: async () => {
				if (!tarpitted || this.held >= PAIRING_TARPIT_MAX_HELD) return;
				this.held++;
				try {
					await this.sleep(PAIRING_TARPIT_MS);
				} finally {
					this.held--;
				}
			},
		};
	}

	reset(): void {
		this.perClient.reset();
		this.global.reset();
		this.held = 0;
	}
}

const sharedLimiter = new PairingLimiter();

// ── Redeem ───────────────────────────────────────────────────────────────────

export interface RedeemedPairing {
	key: string;
	keyId: string;
	scopes: string[];
}

/**
 * Redeems a code for a key, or throws InvalidPairingCodeError for every kind of
 * refusal. The attempt is counted against `ip` before anything is looked up; a
 * code that is found and live is served without delay whatever the global load,
 * and only an attempt that fails waits (see PairingLimiter).
 */
export async function redeemPairingCode(input: {
	code: unknown;
	deviceName: unknown;
	platform: unknown;
	ip: string;
	now?: Date;
	limiter?: PairingLimiter;
}): Promise<RedeemedPairing> {
	const limiter = input.limiter ?? sharedLimiter;
	const reservation = limiter.reserve(input.ip);
	if (!reservation) throw new InvalidPairingCodeError();
	try {
		const live = await findLiveCode(input);
		const paired = await claimCode(live);
		reservation.succeeded();
		return paired;
	} catch (err) {
		if (!isRefusal(err)) throw err;
		await reservation.failed();
		throw new InvalidPairingCodeError();
	}
}

function isRefusal(err: unknown): boolean {
	return (
		err instanceof InvalidPairingCodeError ||
		err instanceof OwnerDisabledError ||
		err instanceof PairingRaceError
	);
}

interface LiveCode {
	row: typeof pairingCodes.$inferSelect;
	deviceName: string;
	platform: string;
	nowIso: string;
}

/** The unredeemed, unexpired row for a code and a well-formed request, or an InvalidPairingCodeError. */
async function findLiveCode(input: {
	code: unknown;
	deviceName: unknown;
	platform: unknown;
	now?: Date;
}): Promise<LiveCode> {
	const deviceName = cleanText(input.deviceName);
	const normalized = typeof input.code === "string" ? normalizePairingCode(input.code) : null;
	if (
		!normalized ||
		!deviceName ||
		typeof input.platform !== "string" ||
		!PLATFORM_PATTERN.test(input.platform)
	) {
		throw new InvalidPairingCodeError();
	}
	const nowIso = (input.now ?? new Date()).toISOString();

	const [row] = await getDb()
		.select()
		.from(pairingCodes)
		.where(eq(pairingCodes.codeHash, await hashPairingCode(normalized)))
		.limit(1);
	if (!row || row.redeemedAt !== null || row.expiresAt <= nowIso) {
		throw new InvalidPairingCodeError();
	}
	return { row, deviceName, platform: input.platform, nowIso };
}

/** Checks the minter and the owner, then creates the key and claims the code in one transaction. */
async function claimCode({
	row,
	deviceName,
	platform,
	nowIso,
}: LiveCode): Promise<RedeemedPairing> {
	if (!(await minterStillActive(getDb(), row.minterCredential, nowIso))) {
		throw new InvalidPairingCodeError();
	}
	if (row.userId === null && !(await ownerlessCodeStillAllowed(row.minterCredential))) {
		throw new InvalidPairingCodeError();
	}

	const scopes = scopesFor(row.access === "respond" ? "respond" : "full");
	const label = row.deviceLabel ? `${row.deviceLabel}` : deviceName;
	const { key, id } = await createApiKey(`${label} (${platform})`, scopes, row.userId, {
		withinTransaction: async (tx, keyId) => {
			// Judged again inside the transaction: a revoke that landed since the
			// read above still stops the key from being born.
			if (!(await minterStillActive(tx, row.minterCredential, nowIso))) {
				throw new PairingRaceError();
			}
			const claimed = await tx
				.update(pairingCodes)
				.set({ redeemedAt: nowIso, redeemedKeyId: keyId, redeemedDeviceName: deviceName })
				.where(
					and(
						eq(pairingCodes.id, row.id),
						isNull(pairingCodes.redeemedAt),
						gt(pairingCodes.expiresAt, nowIso),
					),
				)
				.returning({ id: pairingCodes.id });
			if (claimed.length === 0) throw new PairingRaceError();
		},
	});

	console.log(
		JSON.stringify({
			kind: "pairing_redeemed",
			level: "info",
			codeId: row.id,
			keyId: id,
			access: row.access,
		}),
	);
	return { key, keyId: id, scopes };
}

// ── Test-only seams ───────────────────────────────────────────────────────
// Enforced by check-no-test-seam-leaks.ts: referenced only from *.test.ts.
export function _resetPairingLimiterForTest(): void {
	sharedLimiter.reset();
}
