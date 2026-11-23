import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TEST_KEYS,
	TEST_KEY_LIST,
	pkcs8Pem,
	testPayload,
} from "../../src/shared/__fixtures__/release-test-signer.ts";
import { verifyManifest } from "../../src/shared/release-manifest.ts";
import { generateReleaseKey, writeKeyFile } from "./keygen.ts";
import { OPENSSL_SIGN_ARGS, signEnvelope } from "./sign-local.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const temps: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "ap-keygen-"));
	temps.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const bytes = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload));

describe("keygen", () => {
	test("generates an Ed25519 key whose id is k- plus 12 hex of sha256 of the raw public key", () => {
		const key = generateReleaseKey();
		const raw = Buffer.from(key.publicKeyRaw, "base64url");
		expect(raw).toHaveLength(32);
		expect(key.keyId).toBe(`k-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`);
		expect(key.pem).toContain("BEGIN PRIVATE KEY");
	});

	test("writes the private key 0600 into the output directory and prints nothing secret", () => {
		const out = join(temp(), "keys");
		const written = writeKeyFile(out, REPO_ROOT);
		expect(readdirSync(out)).toEqual([`${written.keyId}.pem`]);
		expect(statSync(written.path).mode & 0o777).toBe(0o600);
		expect(statSync(out).mode & 0o777).toBe(0o700);
		expect(readFileSync(written.path, "utf-8")).toContain("BEGIN PRIVATE KEY");
		expect(JSON.stringify(written)).not.toContain("PRIVATE");
	});

	test("refuses an output directory inside the repository, and creates nothing there", () => {
		for (const sub of ["keys-should-not-exist", "site/keys-should-not-exist"]) {
			const inside = join(REPO_ROOT, sub);
			expect(() => writeKeyFile(inside, REPO_ROOT), sub).toThrow(/inside the repository/);
			expect(existsSync(inside), sub).toBe(false);
		}
	});

	test("never overwrites an existing key file", () => {
		const out = join(temp(), "keys");
		const first = writeKeyFile(out, REPO_ROOT);
		writeFileSync(first.path, "mine");
		const sameKey = () => ({ keyId: first.keyId, publicKeyRaw: first.publicKeyRaw, pem: "new" });
		expect(() => writeKeyFile(out, REPO_ROOT, sameKey)).toThrow(/exists/);
		expect(readFileSync(first.path, "utf-8")).toBe("mine");
	});
});

describe("sign-local: the workflow's openssl argv, verified by WebCrypto", () => {
	test("uses the same openssl invocation the sign job does", () => {
		expect(OPENSSL_SIGN_ARGS).toEqual(["pkeyutl", "-sign", "-rawin"]);
	});

	test("an OpenSSL-signed payload verifies with the verifier, under the key's own id", async () => {
		const dir = temp();
		const keyPath = join(dir, "active.pem");
		writeFileSync(keyPath, pkcs8Pem("active"), { mode: 0o600 });
		const { keyId, envelope } = signEnvelope(keyPath, bytes(testPayload()));
		expect(keyId).toBe(TEST_KEYS.active.keyId);
		const r = await verifyManifest(envelope, {
			keys: TEST_KEY_LIST,
			revoked: new Set(),
			now: NOW,
			last: null,
		});
		expect(r.ok).toBe(true);
	});

	test("a freshly generated key signs and verifies once its public half is the trust root", async () => {
		const out = join(temp(), "keys");
		const written = writeKeyFile(out, REPO_ROOT);
		const { envelope } = signEnvelope(written.path, bytes(testPayload()));
		const keys = [
			{ keyId: written.keyId, publicKeyRaw: written.publicKeyRaw, status: "active" as const },
		];
		expect(
			(await verifyManifest(envelope, { keys, revoked: new Set(), now: NOW, last: null })).ok,
		).toBe(true);
		expect(
			await verifyManifest(envelope, {
				keys: TEST_KEY_LIST,
				revoked: new Set(),
				now: NOW,
				last: null,
			}),
		).toEqual({
			ok: false,
			code: "unknown_key",
		});
	});

	test("the standby key signs a revoking manifest that the verifier honours", async () => {
		const dir = temp();
		const keyPath = join(dir, "standby.pem");
		writeFileSync(keyPath, pkcs8Pem("standby"), { mode: 0o600 });
		const payload = testPayload({ revokedKeyIds: [TEST_KEYS.active.keyId] });
		const { envelope } = signEnvelope(keyPath, bytes(payload));
		const r = await verifyManifest(envelope, {
			keys: TEST_KEY_LIST,
			revoked: new Set(),
			now: NOW,
			last: null,
		});
		expect(r.ok && r.revoked).toEqual([TEST_KEYS.active.keyId]);
	});

	test("a bad key file is an error, not an unsigned envelope", () => {
		const dir = temp();
		const keyPath = join(dir, "junk.pem");
		writeFileSync(keyPath, "not a key", { mode: 0o600 });
		expect(() => signEnvelope(keyPath, bytes(testPayload()))).toThrow();
	});
});
