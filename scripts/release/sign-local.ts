#!/usr/bin/env bun
/**
 * Signs a payload with a key file on this machine, through the same `openssl` invocation the `sign` job
 * in pages.yml uses, and wraps it in an envelope. Two uses: the tests run it to prove that what OpenSSL
 * signs verifies under WebCrypto, and the maintainer runs it with the offline standby key to sign a
 * revoking manifest (docs/RELEASING.md), which is then deployed by `workflow_dispatch` with the envelope
 * as input.
 *
 * Usage: bun scripts/release/sign-local.ts --key <key.pem> --payload <payload.json> [--out envelope.json]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEnvelope } from "../../src/shared/release-manifest.ts";
import { keyIdOf } from "./keygen.ts";

/** The arguments between `openssl` and `-inkey`, identical to the workflow's. */
export const OPENSSL_SIGN_ARGS = ["pkeyutl", "-sign", "-rawin"] as const;

function openssl(args: string[]): Buffer {
	const proc = spawnSync("openssl", args, { encoding: "buffer" });
	if (proc.status !== 0) {
		throw new Error(
			`openssl ${args[0]} failed: ${proc.stderr?.toString().trim() ?? proc.error?.message}`,
		);
	}
	return proc.stdout;
}

export function signEnvelope(
	keyPath: string,
	payload: Uint8Array,
): { keyId: string; envelope: string } {
	const spki = openssl(["pkey", "-in", keyPath, "-pubout", "-outform", "DER"]);
	const keyId = keyIdOf(new Uint8Array(spki.subarray(spki.length - 32)));
	const dir = mkdtempSync(join(tmpdir(), "ap-sign-local-"));
	try {
		const payloadPath = join(dir, "payload.bin");
		const sigPath = join(dir, "payload.sig");
		writeFileSync(payloadPath, payload, { mode: 0o600 });
		openssl([...OPENSSL_SIGN_ARGS, "-inkey", keyPath, "-in", payloadPath, "-out", sigPath]);
		const sig = readFileSync(sigPath);
		if (sig.length !== 64) throw new Error("openssl produced a signature that is not 64 bytes");
		return { keyId, envelope: encodeEnvelope(keyId, payload, new Uint8Array(sig)) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
	const key = value("--key");
	const payload = value("--payload");
	if (!key || !payload) {
		console.error(
			"usage: bun scripts/release/sign-local.ts --key <key.pem> --payload <payload.json> [--out envelope.json]",
		);
		process.exit(2);
	}
	try {
		const { keyId, envelope } = signEnvelope(key, new Uint8Array(readFileSync(payload)));
		const out = value("--out");
		if (out) writeFileSync(out, envelope);
		else console.log(envelope);
		console.error(`signed with ${keyId}`);
	} catch (err) {
		console.error(`sign-local: ${err instanceof Error ? err.message : "failed"}`);
		process.exit(1);
	}
}
