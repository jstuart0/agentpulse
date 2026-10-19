/**
 * Seals a push payload to one phone's key.
 *
 * HPKE (RFC 9180) base mode with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and
 * AES-256-GCM: the suite iOS CryptoKit calls `.P256_SHA256_AES_GCM_256`, so the
 * phone's key can live in the Secure Enclave. `info` is a fixed string and the
 * AAD binds the relay device id and the push id (`agentpulse-push-v1|<d>|<p>`),
 * so a ciphertext cannot be replayed to another registration under the same key.
 *
 * Base mode gives confidentiality only: whoever holds the device public key can
 * seal a valid alert. That is accepted; the outer alert is generic and the phone
 * re-verifies every action with the server.
 *
 * Why a dependency and not hand-rolled WebCrypto: `@hpke/core` is MIT, pure
 * JavaScript over WebCrypto (one transitive package, @hpke/common), and the
 * suite's KEM, key schedule and context handling are the parts worth not
 * writing twice. It is pinned to an exact version. It returns `{ ct, enc }`
 * (not `ciphertext`); the sealer returns `{ e, c }` already base64url.
 */
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import type { InterruptionLevel, PushCategory, PushSessionStatus } from "./types.js";

export const HPKE_INFO = "agentpulse-push-v1";
/** The plaintext the sealer accepts, in bytes. It leaves room for the envelope inside the relay's 4 KB APNs budget. */
export const MAX_PLAINTEXT_BYTES = 2400;
const UNCOMPRESSED_P256_POINT_BYTES = 65;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** The characters an id may use in the associated data. `|` is the separator, so it must never appear inside one. */
const AAD_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** The sealed plaintext, as the phone's extension reads it. Mirrors `push-payload.schema.json`. */
export interface PushPayload {
	v: 1;
	kid: string;
	pid: string;
	/** Seconds since the Unix epoch. */
	ts: number;
	ref: string;
	t: string;
	cat: PushCategory;
	il: InterruptionLevel;
	sid?: string;
	sname?: string;
	agent?: string;
	machine?: string;
	status?: PushSessionStatus;
	pending?: number;
	hitlId?: string;
	decision?: "continue" | "ask";
	proposalId?: string;
	promptHash?: string;
	actionRequestId?: string;
	actionKind?: string;
	launchId?: string;
	threadId?: string;
	assistantMessageId?: string;
	title?: string;
	proposalCount?: number;
	durationSec?: number;
	toolCount?: number;
	text?: string;
}

/** The five members the relay forwards unchanged. */
export interface RelayEnvelope {
	v: 1;
	/** HPKE encapsulated key: an uncompressed P-256 point, base64url. */
	e: string;
	/** AEAD ciphertext followed by its 16-byte tag, base64url. */
	c: string;
	/** The relay device id. */
	d: string;
	/** The push id. */
	p: string;
}

export type SealErrorCode = "invalid_public_key" | "payload_too_large" | "invalid_input";

export class SealError extends Error {
	override readonly name = "SealError";
	constructor(
		readonly code: SealErrorCode,
		message: string,
	) {
		super(message);
	}
}

const suite = new CipherSuite({
	kem: new DhkemP256HkdfSha256(),
	kdf: new HkdfSha256(),
	aead: new Aes256Gcm(),
});
const encoder = new TextEncoder();
const INFO_BYTES = encoder.encode(HPKE_INFO);

/** The associated data both sides compute from cleartext fields the relay must not alter. */
export function pushAad(relayDeviceId: string, pushId: string): string {
	return `${HPKE_INFO}|${relayDeviceId}|${pushId}`;
}

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function decodePublicKey(publicKey: string): Uint8Array {
	if (!BASE64URL.test(publicKey)) {
		throw new SealError("invalid_public_key", "device public key is not base64url");
	}
	const bytes = new Uint8Array(Buffer.from(publicKey, "base64url"));
	// Canonical form only: a re-encode that differs means stray trailing bits or padding.
	if (toBase64Url(bytes) !== publicKey) {
		throw new SealError("invalid_public_key", "device public key is not canonical base64url");
	}
	if (bytes.length !== UNCOMPRESSED_P256_POINT_BYTES || bytes[0] !== 0x04) {
		throw new SealError(
			"invalid_public_key",
			"device public key is not an uncompressed P-256 point",
		);
	}
	return bytes;
}

/** True when `publicKey` is a base64url uncompressed point that lies on P-256. */
export async function isValidDevicePublicKey(publicKey: string): Promise<boolean> {
	try {
		await suite.kem.deserializePublicKey(decodePublicKey(publicKey));
		return true;
	} catch {
		return false;
	}
}

export interface SealTarget {
	/** The phone's uncompressed P-256 point, base64url. */
	publicKey: string;
	relayDeviceId: string;
	pushId: string;
}

/**
 * Seals `plaintext` for `target`. Refuses more than MAX_PLAINTEXT_BYTES: trimming
 * is the caller's job (see `sealPushPayload`), because only the caller knows which
 * members are expendable.
 */
export async function sealBytes(
	plaintext: Uint8Array,
	target: SealTarget,
): Promise<{ enc: string; ct: string }> {
	if (plaintext.length > MAX_PLAINTEXT_BYTES) {
		throw new SealError(
			"payload_too_large",
			`plaintext is ${plaintext.length} bytes; the limit is ${MAX_PLAINTEXT_BYTES}`,
		);
	}
	if (!AAD_ID.test(target.relayDeviceId) || !AAD_ID.test(target.pushId)) {
		throw new SealError(
			"invalid_input",
			"relay device id and push id must be 1 to 64 id characters",
		);
	}
	let recipientPublicKey: CryptoKey;
	try {
		recipientPublicKey = await suite.kem.deserializePublicKey(decodePublicKey(target.publicKey));
	} catch (err) {
		if (err instanceof SealError) throw err;
		throw new SealError("invalid_public_key", "device public key is not a valid P-256 point");
	}
	const aad = encoder.encode(pushAad(target.relayDeviceId, target.pushId));
	// @hpke/core names the ciphertext `ct`; reading `.ciphertext` would silently give undefined.
	const { ct, enc } = await suite.seal({ recipientPublicKey, info: INFO_BYTES }, plaintext, aad);
	return { enc: toBase64Url(new Uint8Array(enc)), ct: toBase64Url(new Uint8Array(ct)) };
}

const byteLength = (s: string): number => encoder.encode(s).length;

/** The longest prefix of `value`, in whole code points, for which `fits` holds. */
function longestPrefix(value: string, fits: (candidate: string) => boolean): string {
	const points = Array.from(value);
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(points.slice(0, mid).join(""))) lo = mid;
		else hi = mid - 1;
	}
	return points.slice(0, lo).join("");
}

export type TrimmedMember = "text" | "title" | "sname";

/**
 * Brings the serialized payload within MAX_PLAINTEXT_BYTES by cutting `text`,
 * then `title`, then `sname`, each as little as possible and never mid-character. Nothing
 * else is ever cut: ids, the category and the timestamp are what make the push
 * actionable and verifiable. Throws `payload_too_large` if that is not enough.
 */
export function fitPayload(payload: PushPayload): {
	payload: PushPayload;
	trimmed: TrimmedMember[];
} {
	const trimmed: TrimmedMember[] = [];
	let current: PushPayload = { ...payload };
	const size = (p: PushPayload) => byteLength(JSON.stringify(p));
	if (size(current) <= MAX_PLAINTEXT_BYTES) return { payload: current, trimmed };

	for (const member of ["text", "title", "sname"] as const) {
		const original = current[member];
		if (original === undefined) continue;
		const withoutMember = { ...current };
		delete withoutMember[member];
		const kept = longestPrefix(
			original,
			(candidate) => size({ ...current, [member]: candidate }) <= MAX_PLAINTEXT_BYTES,
		);
		if (kept.length > 0 && size({ ...current, [member]: kept }) <= MAX_PLAINTEXT_BYTES) {
			current = { ...current, [member]: kept };
		} else {
			current = withoutMember;
		}
		trimmed.push(member);
		if (size(current) <= MAX_PLAINTEXT_BYTES) return { payload: current, trimmed };
	}
	throw new SealError(
		"payload_too_large",
		`payload exceeds ${MAX_PLAINTEXT_BYTES} bytes after trimming text, title and sname`,
	);
}

export interface SealedPush {
	envelope: RelayEnvelope;
	/** Plaintext size in bytes, after trimming. */
	plaintextBytes: number;
	trimmed: TrimmedMember[];
}

/**
 * Serializes, trims to fit, and seals one payload for one device. The push id in
 * the payload is the envelope's `p`, and is bound into the AAD.
 */
export async function sealPushPayload(
	payload: PushPayload,
	target: { publicKey: string; relayDeviceId: string },
): Promise<SealedPush> {
	const fitted = fitPayload(payload);
	const bytes = encoder.encode(JSON.stringify(fitted.payload));
	const { enc, ct } = await sealBytes(bytes, { ...target, pushId: payload.pid });
	return {
		envelope: { v: 1, e: enc, c: ct, d: target.relayDeviceId, p: payload.pid },
		plaintextBytes: bytes.length,
		trimmed: fitted.trimmed,
	};
}
