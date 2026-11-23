#!/usr/bin/env bun
/**
 * Generates an Ed25519 release-signing key. Run it offline, once for the active key and once for the
 * standby key (docs/RELEASING.md). The private half is written to a directory OUTSIDE this repository
 * (refused otherwise) as a 0600 PEM, and is never printed; the script prints the key id and the public
 * half to paste into `src/shared/release-keys.ts`.
 *
 * Usage: bun scripts/release/keygen.ts --out <directory outside the repo> [--status active|standby]
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface GeneratedKey {
	keyId: string;
	publicKeyRaw: string;
	pem: string;
}

/** `k-` plus the first 12 hex characters of sha256 of the raw 32-byte public key. The sign job derives it the same way. */
export function keyIdOf(publicKeyRaw: Uint8Array): string {
	return `k-${createHash("sha256").update(publicKeyRaw).digest("hex").slice(0, 12)}`;
}

export function generateReleaseKey(): GeneratedKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const spki = publicKey.export({ format: "der", type: "spki" });
	const raw = new Uint8Array(spki.subarray(spki.length - 32));
	return {
		keyId: keyIdOf(raw),
		publicKeyRaw: Buffer.from(raw).toString("base64url"),
		pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
	};
}

/** The real path of `path` even when it doesn't exist yet: the nearest existing ancestor, resolved, plus the rest. */
function realpathLoose(path: string): string {
	const full = resolve(path);
	let existing = full;
	const rest: string[] = [];
	while (!existsSync(existing)) {
		rest.unshift(existing.slice(dirname(existing).length + 1));
		existing = dirname(existing);
	}
	return join(realpathSync(existing), ...rest);
}

export function writeKeyFile(
	outDir: string,
	repoRoot: string,
	generate: () => GeneratedKey = generateReleaseKey,
): { keyId: string; publicKeyRaw: string; path: string } {
	const target = realpathLoose(outDir);
	const root = realpathSync(repoRoot);
	if (target === root || target.startsWith(root + sep)) {
		throw new Error("refusing to write a private key inside the repository checkout");
	}
	const key = generate();
	mkdirSync(target, { recursive: true, mode: 0o700 });
	const path = join(target, `${key.keyId}.pem`);
	try {
		writeFileSync(path, key.pem, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(`${path} exists; not overwriting`);
		throw err;
	}
	return { keyId: key.keyId, publicKeyRaw: key.publicKeyRaw, path };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const out = args[args.indexOf("--out") + 1];
	const status = args.includes("--status") ? args[args.indexOf("--status") + 1] : "active";
	if (!args.includes("--out") || !out || (status !== "active" && status !== "standby")) {
		console.error(
			"usage: bun scripts/release/keygen.ts --out <directory outside the repo> [--status active|standby]",
		);
		process.exit(2);
	}
	try {
		const written = writeKeyFile(out, join(import.meta.dir, "..", ".."));
		console.log(`keyId: ${written.keyId}`);
		console.log(`publicKeyRaw: ${written.publicKeyRaw}`);
		console.log(
			`private key written to ${written.path} (0600). It is not shown and must not enter the repository.`,
		);
		console.log("Add to src/shared/release-keys.ts, in a reviewed change:");
		console.log(
			`\t{ keyId: "${written.keyId}", publicKeyRaw: "${written.publicKeyRaw}", status: "${status}" },`,
		);
	} catch (err) {
		console.error(`keygen: ${err instanceof Error ? err.message : "failed"}`);
		process.exit(1);
	}
}
