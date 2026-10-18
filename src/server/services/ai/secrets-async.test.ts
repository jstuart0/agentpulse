import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.js";
import { decryptSecret, decryptSecretAsync, encryptSecret } from "./secrets.js";

describe("decryptSecretAsync", () => {
	let originalKey: string;
	beforeEach(() => {
		originalKey = config.secretsKey;
		config.secretsKey = "a".repeat(32);
	});
	afterEach(() => {
		config.secretsKey = originalKey;
	});

	test("reads exactly what encryptSecret writes, and agrees with decryptSecret", async () => {
		for (const value of ["short", "sk-ant-api03-abcdef123456", "ünïcode ✓", "x".repeat(4000)]) {
			const stored = encryptSecret(value);
			expect(await decryptSecretAsync(stored)).toBe(value);
			expect(await decryptSecretAsync(stored)).toBe(decryptSecret(stored));
		}
	});

	test("a second read of the same record skips scrypt: it is far cheaper than the first", async () => {
		const stored = encryptSecret("warm-me");
		const t0 = performance.now();
		await decryptSecretAsync(stored);
		const cold = performance.now() - t0;
		const t1 = performance.now();
		for (let i = 0; i < 20; i++) await decryptSecretAsync(stored);
		const warmEach = (performance.now() - t1) / 20;
		expect(cold).toBeGreaterThan(5);
		expect(warmEach).toBeLessThan(cold / 5);
	});

	test("the plaintext is decrypted on every call, not cached: a record changed after the first read fails", async () => {
		const stored = encryptSecret("first");
		await decryptSecretAsync(stored);
		const buf = Buffer.from(stored, "base64");
		buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 1;
		await expect(decryptSecretAsync(buf.toString("base64"))).rejects.toThrow();
	});

	test("a changed instance key does not reuse a derived key", async () => {
		const stored = encryptSecret("rekeyed");
		expect(await decryptSecretAsync(stored)).toBe("rekeyed");
		config.secretsKey = "b".repeat(32);
		await expect(decryptSecretAsync(stored)).rejects.toThrow();
	});

	test("rejects a record that is too short, corrupt, or read with no instance key", async () => {
		await expect(decryptSecretAsync("AAAA")).rejects.toThrow("too short");
		await expect(decryptSecretAsync(Buffer.alloc(80, 7).toString("base64"))).rejects.toThrow();
		const stored = encryptSecret("needs a key");
		config.secretsKey = "";
		await expect(decryptSecretAsync(stored)).rejects.toThrow("AGENTPULSE_SECRETS_KEY");
	});
});
