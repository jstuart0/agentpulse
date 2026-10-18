import { createCipheriv, createDecipheriv, randomBytes, scrypt, scryptSync } from "node:crypto";
import { config } from "../../config.js";

// AES-256-GCM with a scrypt-derived key. The on-disk ciphertext format is:
//   base64( salt(16) || iv(12) || authTag(16) || ciphertext(...) )
// A fresh random salt per encryption prevents pre-computed attacks on the
// instance's AGENTPULSE_SECRETS_KEY. The salt travels with the ciphertext,
// so rotating the instance key requires decrypt-then-re-encrypt.

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKey(salt: Buffer): Buffer {
	if (!config.secretsKey) {
		throw new Error("AGENTPULSE_SECRETS_KEY is not set; AI credential operations are unavailable.");
	}
	// scryptSync is CPU-bound but fine for infrequent encrypt/decrypt of
	// credentials (not per-request). N=16384 is the Node default.
	return scryptSync(config.secretsKey, salt, KEY_LENGTH);
}

/**
 * Encrypt a plaintext string for at-rest storage.
 *
 * Returns a base64 string containing salt+iv+authTag+ciphertext. The caller
 * stores this as-is in `credential_ciphertext`.
 */
export function encryptSecret(plaintext: string): string {
	const salt = randomBytes(SALT_LENGTH);
	const iv = randomBytes(IV_LENGTH);
	const key = deriveKey(salt);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return Buffer.concat([salt, iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypt a ciphertext produced by `encryptSecret`.
 *
 * Throws if the key is wrong, the ciphertext is corrupt, or the auth tag
 * fails. Callers should treat failure as "credential unusable; require
 * re-entry" rather than trying to recover.
 */
export function decryptSecret(ciphertextBase64: string): string {
	const buf = Buffer.from(ciphertextBase64, "base64");
	if (buf.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
		throw new Error("Ciphertext too short to be valid");
	}
	const salt = buf.subarray(0, SALT_LENGTH);
	const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
	const authTag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
	const ciphertext = buf.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
	const key = deriveKey(salt);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(authTag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return plaintext.toString("utf8");
}

/**
 * Generate a 4-character suffix hint for UI display ("last four" of a key).
 * This is meant for human recognition, not security — never rely on hint
 * uniqueness or use it as input to any auth flow.
 */
export function credentialHint(plaintext: string): string {
	const trimmed = plaintext.trim();
	if (trimmed.length <= 4) return "*".repeat(trimmed.length);
	return `…${trimmed.slice(-4)}`;
}

// ---- Async decrypt for hot paths -------------------------------------------------------------
//
// scryptSync stalls the event loop for tens of milliseconds, which is fine for the occasional
// credential read and not for a path that runs on every push. `decryptSecretAsync` reads the same
// format, derives the key on the libuv pool, and keeps the derived key (never the plaintext) in a
// small bounded cache keyed by the record's salt, so a device's later sends skip scrypt. A cached
// key reveals nothing the process does not already hold in `config.secretsKey`.

const DERIVED_KEY_CACHE_MAX = 1000;
const DERIVED_KEY_CACHE_TTL_MS = 60 * 60 * 1000;

interface DerivedKey {
	key: Buffer;
	/** The instance key it was derived from: a changed key must not reuse the entry. */
	forSecretsKey: string;
	expiresAt: number;
}
const derivedKeys = new Map<string, DerivedKey>();

function deriveKeyAsync(salt: Buffer): Promise<Buffer> {
	const secretsKey = config.secretsKey;
	if (!secretsKey) {
		return Promise.reject(
			new Error("AGENTPULSE_SECRETS_KEY is not set; AI credential operations are unavailable."),
		);
	}
	const cacheKey = salt.toString("base64");
	const now = Date.now();
	const hit = derivedKeys.get(cacheKey);
	if (hit && hit.forSecretsKey === secretsKey && hit.expiresAt > now) {
		derivedKeys.delete(cacheKey);
		derivedKeys.set(cacheKey, hit);
		return Promise.resolve(hit.key);
	}
	return new Promise((resolve, reject) => {
		scrypt(secretsKey, salt, KEY_LENGTH, (err, key) => {
			if (err) return reject(err);
			derivedKeys.delete(cacheKey);
			derivedKeys.set(cacheKey, {
				key,
				forSecretsKey: secretsKey,
				expiresAt: Date.now() + DERIVED_KEY_CACHE_TTL_MS,
			});
			if (derivedKeys.size > DERIVED_KEY_CACHE_MAX) {
				const oldest = derivedKeys.keys().next().value;
				if (oldest !== undefined) derivedKeys.delete(oldest);
			}
			resolve(key);
		});
	});
}

/** Same contract as `decryptSecret`, without blocking the event loop. */
export async function decryptSecretAsync(ciphertextBase64: string): Promise<string> {
	const buf = Buffer.from(ciphertextBase64, "base64");
	if (buf.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
		throw new Error("Ciphertext too short to be valid");
	}
	const salt = buf.subarray(0, SALT_LENGTH);
	const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
	const authTag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
	const ciphertext = buf.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
	const key = await deriveKeyAsync(salt);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
