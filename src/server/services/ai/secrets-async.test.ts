import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.js";
import { decryptSecret, decryptSecretAsync, encryptSecret, encryptSecretAsync } from "./secrets.js";

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

describe("encryptSecretAsync", () => {
	let originalKey: string;
	beforeEach(() => {
		originalKey = config.secretsKey;
		config.secretsKey = "c".repeat(32);
	});
	afterEach(() => {
		config.secretsKey = originalKey;
	});

	test("writes the stored format both readers read: async and sync decrypt agree on what it wrote", async () => {
		for (const value of ["short", "send-token-0123456789abcdef", "ünïcode ✓", "x".repeat(4000)]) {
			const stored = await encryptSecretAsync(value);
			expect(await decryptSecretAsync(stored)).toBe(value);
			expect(decryptSecret(stored)).toBe(value);
		}
	});

	test("is the same format as the synchronous writer: same length for the same plaintext, readable the other way round", async () => {
		const sync = encryptSecret("same-shape");
		const fromAsync = await encryptSecretAsync("same-shape");
		expect(Buffer.from(fromAsync, "base64").length).toBe(Buffer.from(sync, "base64").length);
		expect(await decryptSecretAsync(sync)).toBe("same-shape");
	});

	test("every call uses a fresh salt and iv: the same plaintext never stores the same way twice", async () => {
		const [a, b] = await Promise.all([encryptSecretAsync("repeat"), encryptSecretAsync("repeat")]);
		expect(a).not.toBe(b);
		expect(a).not.toContain("repeat");
	});

	test("does not block the event loop: a timer fires while it runs", async () => {
		let ticked = false;
		const timer = setTimeout(() => {
			ticked = true;
		}, 0);
		const pending = encryptSecretAsync("unblocked");
		await new Promise((resolve) => setTimeout(resolve, 1));
		const stillRunningWhenTimerFired = ticked;
		await pending;
		clearTimeout(timer);
		expect(stillRunningWhenTimerFired).toBe(true);
	});

	test("with no instance key it refuses, naming the setting", async () => {
		config.secretsKey = "";
		await expect(encryptSecretAsync("needs a key")).rejects.toThrow("AGENTPULSE_SECRETS_KEY");
	});
});
