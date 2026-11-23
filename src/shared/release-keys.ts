/**
 * The release trust root: the public keys a client accepts a signed release manifest from.
 *
 * One active and one standby key, generated with `bun scripts/release/keygen.ts` for the first signed
 * release (0.12.0). Only the public halves are here; a change to this list is a reviewed change
 * (CODEOWNERS covers this file).
 *
 * A key's `status` decides what its envelopes may do: only a `standby` key's `revokedKeyIds` are honoured
 * (see release-manifest.ts). Tests sign with a throwaway key of their own; this file must never import
 * it (`release-keys.guard.test.ts`).
 *
 * Embedded verbatim into `scripts/relay.ts` (marker block `release-keys`), so it imports nothing.
 */

export type ReleaseKeyStatus = "active" | "standby";

export interface ReleaseKey {
	/** `k-` plus the first 12 hex characters of sha256 of the raw public key (keygen.ts prints it). */
	readonly keyId: string;
	/** The 32-byte Ed25519 public key, canonical base64url. */
	readonly publicKeyRaw: string;
	readonly status: ReleaseKeyStatus;
}

export const RELEASE_KEYS: readonly ReleaseKey[] = [
	{
		keyId: "k-fc3883894331",
		publicKeyRaw: "cwjfqf-f0_t-ll0i7XE7awd2EJorGx-a4qyc3iZMyQg",
		status: "active",
	},
	{
		keyId: "k-71cb6fc03027",
		publicKeyRaw: "JxoqINaPROBB2tcPP6jmLtU7rZn2kJ55ZHY5nLkEgkA",
		status: "standby",
	},
];
