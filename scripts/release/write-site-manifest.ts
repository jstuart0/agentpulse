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
import { RELEASE_KEYS, type ReleaseKey } from "../../src/shared/release-keys.ts";
import { encodeEnvelope, verifyManifest } from "../../src/shared/release-manifest.ts";

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

export async function writeSiteManifest(options: {
	siteDir: string;
	envelope: string;
	keys: readonly ReleaseKey[];
	now: number;
}): Promise<{ seq: number; latest: string; keyStatus: string }> {
	const verdict = await verifyManifest(options.envelope, {
		keys: options.keys,
		revoked: new Set(),
		now: options.now,
		last: null,
	});
	if (!verdict.ok) throw new Error(`the envelope does not verify (${verdict.code})`);
	if (verdict.stale) throw new Error("the manifest has already expired");
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
