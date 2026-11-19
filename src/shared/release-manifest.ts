/**
 * The signed release manifest: what a client may believe about which AgentPulse versions exist.
 *
 * An envelope `{v: 1, keyId, payload, sig}` carries a base64url JSON payload and an Ed25519 signature over
 * the raw payload bytes. `verifyManifest` is the one place that decides whether an envelope is trusted:
 * encoding, key lookup, revocation, signature, schema and freshness. `updateState` turns a verified
 * manifest and the running version into the one state every client shows.
 *
 * The payload carries data a client compares (versions, digests, counters, times) and nothing a client
 * runs or shows verbatim: no URLs, commands, paths or free text (rules 21 and 39). Unknown keys are
 * ignored and never copied out.
 *
 * Revocation is a standby key's power only: an envelope signed by an `active` key can't revoke anyone,
 * so one compromised active key can't lock the others out. Revocation protects only clients that have
 * seen a revoking manifest.
 *
 * Embedded verbatim into `scripts/relay.ts` (marker block `release-manifest`), together with version.ts,
 * release-keys.ts and capped-fetch.ts. It uses only WebCrypto and `Buffer`.
 */
import type { ReleaseKey } from "./release-keys.js";
import { compareReleaseVersions, parseReleaseVersion } from "./version.js";

export const MAX_ENVELOPE_BYTES = 32 * 1024;
const MAX_RELEASES = 30;
const MAX_REVOKED_KEY_IDS = 16;
const FUTURE_TOLERANCE_MS = 24 * 3_600_000;
const MAX_VALIDITY_MS = 31 * 86_400_000;

export type VerifyFailureCode =
	| "too_large"
	| "bad_envelope"
	| "unknown_key"
	| "revoked_key"
	| "bad_signature"
	| "replayed"
	| "older"
	| "future"
	| "bad_payload";

export interface ManifestRelease {
	version: string;
	commit: string;
	publishedAt: string;
	severity: "normal" | "security";
	pulled: boolean;
	/** A short machine code, never prose. */
	pulledReason?: string;
	/** The last migration file of each dialect at this release. */
	migrations: { sqlite: string; postgres: string };
	/** Full sha256 of each client file as this release ships it. */
	clients: { relay: string; statusline: string; excludeCheck: string };
}

export interface Manifest {
	schema: 1;
	seq: number;
	sourceCommit: string;
	issuedAt: string;
	expiresAt: string;
	latest: string;
	minSupported: string;
	revokedKeyIds: string[];
	releases: ManifestRelease[];
}

/** The newest manifest a client has accepted, kept by the client itself. */
export interface LastSeen {
	seq: number;
	issuedAt: string;
	/** sha256 of the payload bytes. */
	fingerprint: string;
}

export interface VerifyContext {
	keys: readonly ReleaseKey[];
	/** Every key id this client has ever seen revoked. */
	revoked: ReadonlySet<string>;
	now: number;
	last: LastSeen | null;
}

/**
 * `older` and `replayed` are both "valid, but not newer than what this client already holds": callers
 * keep the stored manifest and treat neither as unverified.
 */
export type VerifyResult =
	| {
			ok: true;
			manifest: Manifest;
			/** sha256 of the payload bytes. */
			fingerprint: string;
			/** The manifest's `expiresAt` has passed: it verifies, for display, but should not be acted on. */
			stale: boolean;
			/** What the client should store as its new `last`: issuedAt is never ratcheted past `now`. */
			next: LastSeen;
			/** The union of the client's revoked set and what this envelope revoked. */
			revoked: string[];
	  }
	| { ok: false; code: VerifyFailureCode };

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,31}$/;
const MIGRATION_NAME = /^[0-9A-Za-z_]{1,100}$/;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

function fail(code: VerifyFailureCode): VerifyResult {
	return { ok: false, code };
}

/** Canonical base64url only: a re-encode that differs means padding, stray bits or another alphabet. */
function decodeBase64url(text: unknown): Uint8Array<ArrayBuffer> | null {
	if (typeof text !== "string" || !BASE64URL.test(text)) return null;
	const bytes = new Uint8Array(Buffer.from(text, "base64url"));
	return Buffer.from(bytes).toString("base64url") === text ? bytes : null;
}

export function encodeEnvelope(keyId: string, payload: Uint8Array, sig: Uint8Array): string {
	return JSON.stringify({
		v: 1,
		keyId,
		payload: Buffer.from(payload).toString("base64url"),
		sig: Buffer.from(sig).toString("base64url"),
	});
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Buffer.from(digest).toString("hex");
}

async function signatureVerifies(
	publicKeyRaw: string,
	payload: Uint8Array<ArrayBuffer>,
	sig: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
	const raw = decodeBase64url(publicKeyRaw);
	if (!raw || raw.length !== ED25519_PUBLIC_KEY_BYTES) return false;
	try {
		const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, payload);
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
	return typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function readRelease(raw: unknown): ManifestRelease | null {
	if (!isRecord(raw)) return null;
	const { version, commit, publishedAt, severity, pulled, pulledReason, migrations, clients } = raw;
	if (typeof version !== "string" || !parseReleaseVersion(version)) return null;
	if (typeof commit !== "string" || !HEX40.test(commit)) return null;
	if (!isTime(publishedAt)) return null;
	if (severity !== "normal" && severity !== "security") return null;
	if (typeof pulled !== "boolean") return null;
	if (
		pulledReason !== undefined &&
		!(typeof pulledReason === "string" && REASON_CODE.test(pulledReason))
	) {
		return null;
	}
	if (!isRecord(migrations) || !isRecord(clients)) return null;
	const { sqlite, postgres } = migrations;
	if (typeof sqlite !== "string" || !MIGRATION_NAME.test(sqlite)) return null;
	if (typeof postgres !== "string" || !MIGRATION_NAME.test(postgres)) return null;
	const { relay, statusline, excludeCheck } = clients;
	for (const digest of [relay, statusline, excludeCheck]) {
		if (typeof digest !== "string" || !HEX64.test(digest)) return null;
	}
	const release: ManifestRelease = {
		version,
		commit,
		publishedAt,
		severity,
		pulled,
		migrations: { sqlite, postgres },
		clients: {
			relay: relay as string,
			statusline: statusline as string,
			excludeCheck: excludeCheck as string,
		},
	};
	if (pulledReason !== undefined) release.pulledReason = pulledReason;
	return release;
}

/** A clean manifest built field by field from a parsed payload, or null when any field is wrong. */
function readManifest(raw: unknown): Manifest | null {
	if (!isRecord(raw) || raw.schema !== 1) return null;
	const { seq, sourceCommit, issuedAt, expiresAt, latest, minSupported, revokedKeyIds, releases } =
		raw;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
	if (typeof sourceCommit !== "string" || !HEX40.test(sourceCommit)) return null;
	if (!isTime(issuedAt) || !isTime(expiresAt)) return null;
	const validityMs = Date.parse(expiresAt) - Date.parse(issuedAt);
	if (validityMs <= 0 || validityMs > MAX_VALIDITY_MS) return null;
	if (typeof latest !== "string" || typeof minSupported !== "string") return null;
	const latestVersion = parseReleaseVersion(latest);
	const minVersion = parseReleaseVersion(minSupported);
	if (!latestVersion || !minVersion || compareReleaseVersions(minVersion, latestVersion) > 0)
		return null;
	if (!Array.isArray(revokedKeyIds) || revokedKeyIds.length > MAX_REVOKED_KEY_IDS) return null;
	for (const id of revokedKeyIds) if (typeof id !== "string" || !KEY_ID.test(id)) return null;
	if (!Array.isArray(releases) || releases.length < 1 || releases.length > MAX_RELEASES)
		return null;
	const cleaned: ManifestRelease[] = [];
	const seen = new Set<string>();
	for (const entry of releases) {
		const release = readRelease(entry);
		if (!release || seen.has(release.version)) return null;
		seen.add(release.version);
		cleaned.push(release);
	}
	if (!seen.has(latest)) return null;
	return {
		schema: 1,
		seq,
		sourceCommit,
		issuedAt,
		expiresAt,
		latest,
		minSupported,
		revokedKeyIds: [...(revokedKeyIds as string[])],
		releases: cleaned,
	};
}

function parsePayload(bytes: Uint8Array): Manifest | null {
	try {
		return readManifest(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		return null;
	}
}

/** Null when the envelope is newer than what the client holds, else why it isn't. */
function replayVerdict(
	manifest: Manifest,
	fingerprint: string,
	last: LastSeen | null,
): "replayed" | "older" | null {
	if (!last) return null;
	if (manifest.seq < last.seq) return "replayed";
	if (manifest.seq > last.seq) return null;
	const lastMs = Date.parse(last.issuedAt);
	const issuedMs = Date.parse(manifest.issuedAt);
	if (Number.isFinite(lastMs) && issuedMs < lastMs) return "older";
	if (issuedMs === lastMs && fingerprint !== last.fingerprint) return "replayed";
	return null;
}

export async function verifyManifest(
	envelopeText: string,
	ctx: VerifyContext,
): Promise<VerifyResult> {
	if (typeof envelopeText !== "string" || Buffer.byteLength(envelopeText) > MAX_ENVELOPE_BYTES) {
		return fail("too_large");
	}
	let envelope: unknown;
	try {
		envelope = JSON.parse(envelopeText);
	} catch {
		return fail("bad_envelope");
	}
	if (!isRecord(envelope) || envelope.v !== 1) return fail("bad_envelope");
	const { keyId } = envelope;
	if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return fail("bad_envelope");
	const payloadBytes = decodeBase64url(envelope.payload);
	const sig = decodeBase64url(envelope.sig);
	if (!payloadBytes || !sig || sig.length !== ED25519_SIGNATURE_BYTES) return fail("bad_envelope");

	// A Map, so "__proto__" and "constructor" are plain misses.
	const signer = new Map(ctx.keys.map((key) => [key.keyId, key] as const)).get(keyId);
	if (!signer) return fail("unknown_key");
	if (ctx.revoked.has(keyId)) return fail("revoked_key");
	if (!(await signatureVerifies(signer.publicKeyRaw, payloadBytes, sig)))
		return fail("bad_signature");

	const manifest = parsePayload(payloadBytes);
	if (!manifest) return fail("bad_payload");
	const honoursRevocation = signer.status === "standby";
	if (honoursRevocation && manifest.revokedKeyIds.includes(keyId)) return fail("bad_payload");

	const issuedMs = Date.parse(manifest.issuedAt);
	if (issuedMs > ctx.now + FUTURE_TOLERANCE_MS) return fail("future");
	const fingerprint = await sha256Hex(payloadBytes);
	const behind = replayVerdict(manifest, fingerprint, ctx.last);
	if (behind) return fail(behind);

	const revoked = new Set(ctx.revoked);
	if (honoursRevocation) for (const id of manifest.revokedKeyIds) revoked.add(id);
	return {
		ok: true,
		manifest,
		fingerprint,
		stale: ctx.now > Date.parse(manifest.expiresAt),
		next: {
			seq: manifest.seq,
			issuedAt: new Date(Math.min(issuedMs, ctx.now)).toISOString(),
			fingerprint,
		},
		revoked: [...revoked],
	};
}

export type UpdateStateName =
	| "disabled"
	| "unverified"
	| "current_pulled"
	| "below_minimum"
	| "security"
	| "available"
	| "current";

export interface UpdateState {
	state: UpdateStateName;
	/** The manifest's validity has passed; carried beside the state, never instead of it. */
	stale: boolean;
	/** The manifest's `latest`, present whenever a manifest was read. */
	latest?: string;
}

export function releaseFor(manifest: Manifest, version: string): ManifestRelease | null {
	for (const release of manifest.releases) if (release.version === version) return release;
	return null;
}

/**
 * Precedence: disabled > unverified > current_pulled > below_minimum > security > available > current.
 * `security` is any newer non-pulled stable release marked security, not only `latest`.
 */
export function updateState(
	current: string,
	manifest: Manifest | null,
	ctx: { disabled?: boolean; now: number },
): UpdateState {
	if (ctx.disabled) return { state: "disabled", stale: false };
	if (!manifest) return { state: "unverified", stale: false };
	const stale = ctx.now > Date.parse(manifest.expiresAt);
	const result = (state: UpdateStateName): UpdateState => ({
		state,
		stale,
		latest: manifest.latest,
	});
	const running = parseReleaseVersion(current);
	if (!running) return result("unverified");

	if (releaseFor(manifest, current)?.pulled) return result("current_pulled");
	const minimum = parseReleaseVersion(manifest.minSupported) as NonNullable<
		ReturnType<typeof parseReleaseVersion>
	>;
	if (compareReleaseVersions(running, minimum) < 0) return result("below_minimum");

	const newer = (version: string) => {
		const parsed = parseReleaseVersion(version);
		return parsed !== null && compareReleaseVersions(parsed, running) > 0 ? parsed : null;
	};
	const offeredSecurity = manifest.releases.some((release) => {
		const parsed = newer(release.version);
		return (
			parsed !== null &&
			parsed.pre.length === 0 &&
			!release.pulled &&
			release.severity === "security"
		);
	});
	if (offeredSecurity) return result("security");
	return result(newer(manifest.latest) ? "available" : "current");
}
