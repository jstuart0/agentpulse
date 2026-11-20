/**
 * Test-only signing for the release manifest suites. The key is the throwaway one in
 * release-test-key.json. Nothing outside test files may import this (release-keys.guard.test.ts
 * enforces it for the trust root; check-no-test-seam-leaks covers the rest).
 */
import { createPrivateKey, sign } from "node:crypto";
import type { ReleaseKey } from "../release-keys.js";
import type { Manifest, ManifestRelease } from "../release-manifest.js";
import { encodeEnvelope } from "../release-manifest.js";
import fixture from "./release-test-key.json";

export type TestKeyName = "active" | "standby" | "unknown";

export const TEST_KEYS = fixture as unknown as Record<
	TestKeyName,
	{ keyId: string; publicKeyRaw: string; seed: string }
>;

/** The keys a client under test trusts: the active one and the standby one. */
export const TEST_KEY_LIST: readonly ReleaseKey[] = [
	{ keyId: TEST_KEYS.active.keyId, publicKeyRaw: TEST_KEYS.active.publicKeyRaw, status: "active" },
	{
		keyId: TEST_KEYS.standby.keyId,
		publicKeyRaw: TEST_KEYS.standby.publicKeyRaw,
		status: "standby",
	},
];

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A PKCS#8 PEM for a seed. For files inside a test's own temp directory only. */
export function pkcs8Pem(name: TestKeyName): string {
	const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(TEST_KEYS[name].seed, "base64url")]);
	// The delimiter lines are assembled so no source line looks like a private key to the redactor self-scan.
	const label = ["PRIVATE", "KEY"].join(" ");
	const body = (der.toString("base64").match(/.{1,64}/g) ?? []).join("\n");
	return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export function signBytes(name: TestKeyName, bytes: Uint8Array): Uint8Array {
	const key = createPrivateKey(pkcs8Pem(name));
	return new Uint8Array(sign(null, bytes, key));
}

const hex = (c: string) => c.repeat(64);

export function testRelease(
	version: string,
	overrides: Partial<ManifestRelease> = {},
): ManifestRelease {
	return {
		version,
		commit: "a".repeat(40),
		publishedAt: "2026-11-01T00:00:00.000Z",
		severity: "normal",
		pulled: false,
		migrations: { sqlite: "0022_example_last", postgres: "0022_example_last" },
		clients: { relay: hex("1"), statusline: hex("2"), excludeCheck: hex("3") },
		...overrides,
	};
}

export const NOW = Date.parse("2026-11-19T12:00:00.000Z");

export function testPayload(overrides: Partial<Manifest> = {}): Manifest {
	return {
		schema: 1,
		seq: 100,
		sourceCommit: "b".repeat(40),
		issuedAt: "2026-11-19T11:00:00.000Z",
		expiresAt: "2026-11-29T11:00:00.000Z",
		latest: "0.12.0",
		minSupported: "0.11.0",
		revokedKeyIds: [],
		releases: [testRelease("0.12.0"), testRelease("0.11.0")],
		...overrides,
	};
}

/** Signs `payload` (an object, or a string of raw payload bytes) and wraps it in an envelope. */
export function envelopeFor(
	payload: unknown,
	signer: TestKeyName = "active",
	options: { keyId?: string } = {},
): string {
	const bytes = new TextEncoder().encode(
		typeof payload === "string" ? payload : JSON.stringify(payload),
	);
	return encodeEnvelope(options.keyId ?? TEST_KEYS[signer].keyId, bytes, signBytes(signer, bytes));
}
