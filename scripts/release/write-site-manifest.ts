#!/usr/bin/env bun
/**
 * The `deploy` job's last gate: assembles the signed envelope, verifies it against the trust root in
 * `src/shared/release-keys.ts` (the same verifier clients use), and only then writes
 * `site/releases/manifest.json`. Nothing unverified reaches Pages. It also refuses to publish a stale
 * manifest and fails if any file under the site directory holds a private-key header, so a signing
 * artifact can't be published by accident.
 *
 * Inputs (environment): SIGNED_ENVELOPE (a manifest signed offline, passed to `workflow_dispatch`), or
 * PAYLOAD (base64url) with KEY_ID and SIG from the `sign` job. With none of them there is no manifest
 * this run (before the first release) and nothing is written.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCapped } from "../../src/shared/capped-fetch.ts";
import { RELEASE_KEYS, type ReleaseKey } from "../../src/shared/release-keys.ts";
import { encodeEnvelope, verifyManifest } from "../../src/shared/release-manifest.ts";
import { MANIFEST_URL } from "./verify-published.ts";

export interface LiveOptions {
	/** The disaster path: deploy without comparing to the live manifest. Never the default. */
	noLive: boolean;
	/** Nothing is pinned yet, so there can be no live manifest to compare to. */
	nothingPinned: boolean;
	url?: string;
	fetcher?: typeof fetchCapped;
}

const MAX_MANIFEST_BYTES = 32 * 1024;

const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function scanForPrivateKeys(dir: string): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) scanForPrivateKeys(path);
		else if (PRIVATE_KEY_HEADER.test(readFileSync(path, "latin1"))) {
			throw new Error(`${path} holds a private key header; refusing to publish`);
		}
	}
}

/**
 * An envelope signed offline can be deployed by dispatch, so it is judged against what is live exactly as a
 * client would judge it: a lower seq, an earlier issuedAt, or the same time with different bytes is a replay,
 * and a key the live manifest revoked is out. The one exception is a standby-signed revoking envelope, which
 * must be able to land whatever the ordering. With no readable live manifest the deploy is refused once
 * anything is pinned, unless the disaster path (`--no-live`) is taken on purpose.
 */
async function checkAgainstLive(
	envelope: string,
	keys: readonly ReleaseKey[],
	now: number,
	live: LiveOptions,
): Promise<void> {
	if (live.noLive) return;
	const fetched = await (live.fetcher ?? fetchCapped)(live.url ?? MANIFEST_URL, {
		deadlineMs: 15_000,
		maxBytes: MAX_MANIFEST_BYTES,
	});
	if (!fetched.ok) {
		if (live.nothingPinned) return;
		throw new Error(
			`could not read the live manifest (${fetched.code}); refusing to deploy over it. The disaster path is --no-live (docs/RELEASING.md)`,
		);
	}
	const current = await verifyManifest(fetched.body, { keys, revoked: new Set(), now, last: null });
	if (!current.ok) {
		throw new Error(
			`the live manifest does not verify (${current.code}); the disaster path is --no-live`,
		);
	}
	const revoked = new Set(current.revoked);
	const incoming = await verifyManifest(envelope, { keys, revoked, now, last: null });
	if (!incoming.ok)
		throw new Error(`the envelope does not verify against the live revocations (${incoming.code})`);
	const signer = keys.find((k) => k.keyId === (JSON.parse(envelope) as { keyId: string }).keyId);
	if (signer?.status === "standby" && incoming.manifest.revokedKeyIds.length > 0) return;
	const ordered = await verifyManifest(envelope, { keys, revoked, now, last: current.next });
	if (!ordered.ok)
		throw new Error(`the envelope is not newer than the live manifest (${ordered.code})`);
}

export async function writeSiteManifest(options: {
	siteDir: string;
	envelope: string;
	keys: readonly ReleaseKey[];
	now: number;
	live: LiveOptions;
}): Promise<{ seq: number; latest: string; keyStatus: string }> {
	const verdict = await verifyManifest(options.envelope, {
		keys: options.keys,
		revoked: new Set(),
		now: options.now,
		last: null,
	});
	if (!verdict.ok) throw new Error(`the envelope does not verify (${verdict.code})`);
	if (verdict.stale) throw new Error("the manifest has already expired");
	await checkAgainstLive(options.envelope, options.keys, options.now, options.live);
	scanForPrivateKeys(options.siteDir);
	mkdirSync(join(options.siteDir, "releases"), { recursive: true });
	writeFileSync(join(options.siteDir, "releases", "manifest.json"), options.envelope);
	const signer = (JSON.parse(options.envelope) as { keyId: string }).keyId;
	return {
		seq: verdict.manifest.seq,
		latest: verdict.manifest.latest,
		keyStatus: options.keys.find((k) => k.keyId === signer)?.status ?? "unknown",
	};
}

export function envelopeFromEnv(env: Record<string, string | undefined>): string | null {
	if (env.SIGNED_ENVELOPE) return env.SIGNED_ENVELOPE;
	if (!env.PAYLOAD) return null;
	if (!env.KEY_ID || !env.SIG) throw new Error("PAYLOAD without KEY_ID and SIG");
	return encodeEnvelope(
		env.KEY_ID,
		new Uint8Array(Buffer.from(env.PAYLOAD, "base64url")),
		new Uint8Array(Buffer.from(env.SIG, "base64url")),
	);
}

function nothingPinned(): boolean {
	try {
		const data = JSON.parse(readFileSync("releases/release-data.json", "utf-8")) as {
			releases?: unknown[];
		};
		return Array.isArray(data.releases) && data.releases.length === 0;
	} catch {
		return false;
	}
}

if (import.meta.main) {
	try {
		const envelope = envelopeFromEnv(process.env);
		if (envelope === null) {
			console.log("write-site-manifest: no manifest this run; the site deploys without one");
		} else {
			const done = await writeSiteManifest({
				siteDir: process.argv[2] ?? "site",
				envelope,
				keys: RELEASE_KEYS,
				now: Date.now(),
				live: {
					noLive: process.argv.includes("--no-live") || process.env.NO_LIVE === "true",
					nothingPinned: nothingPinned(),
				},
			});
			console.log(
				`write-site-manifest: verified seq ${done.seq}, latest ${done.latest}, signed by a ${done.keyStatus} key`,
			);
		}
	} catch (err) {
		console.error(`write-site-manifest: ${err instanceof Error ? err.message : "failed"}`);
		process.exit(1);
	}
}
