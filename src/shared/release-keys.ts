/**
 * The release trust root: the public keys a client accepts a signed release manifest from.
 *
 * The production list is EMPTY in this change. No real signing key exists yet; the maintainer generates
 * one active and one standby key offline (`bun scripts/release/keygen.ts`) at the first release and
 * commits the two public halves here, in a reviewed change (CODEOWNERS covers this file). Until then
 * every client reads "can't verify updates", which fails safe.
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

export const RELEASE_KEYS: readonly ReleaseKey[] = [];
