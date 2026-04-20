import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.js";
import { credentialHint, decryptSecret, encryptSecret } from "./secrets.js";

const TEST_KEY = "a".repeat(32);

describe("secrets", () => {
	let originalKey: string;
	beforeEach(() => {
		originalKey = config.secretsKey;
		config.secretsKey = TEST_KEY;
	});
	afterEach(() => {
		config.secretsKey = originalKey;
	});

	test("round-trips a plaintext secret", () => {
		const input = "sk-ant-api03-abcdef123456";
		const ciphertext = encryptSecret(input);
		const roundtripped = decryptSecret(ciphertext);
		expect(roundtripped).toBe(input);
	});

	test("produces distinct ciphertext for identical plaintexts (salted)", () => {
		const a = encryptSecret("same-value");
		const b = encryptSecret("same-value");
		expect(a).not.toBe(b);
		expect(decryptSecret(a)).toBe("same-value");
		expect(decryptSecret(b)).toBe("same-value");
	});

	test("fails fast with a wrong key", () => {
		const ciphertext = encryptSecret("secret");
		config.secretsKey = "b".repeat(32);
		expect(() => decryptSecret(ciphertext)).toThrow();
	});

	test("fails fast with corrupt ciphertext", () => {
		const ciphertext = encryptSecret("secret");
		const corrupted = `${ciphertext.slice(0, -4)}xxxx`;
		expect(() => decryptSecret(corrupted)).toThrow();
	});

	test("throws when AGENTPULSE_SECRETS_KEY is missing", () => {
		config.secretsKey = "";
		expect(() => encryptSecret("anything")).toThrow(/AGENTPULSE_SECRETS_KEY/);
	});

	test("hint shows last four chars", () => {
		expect(credentialHint("sk-ant-abc-EFGH")).toBe("…EFGH");
		expect(credentialHint("abcd")).toBe("****");
		expect(credentialHint("ab")).toBe("**");
	});

	test("handles unicode plaintext", () => {
		const input = "🔐 secret with ünicode ✓";
		expect(decryptSecret(encryptSecret(input))).toBe(input);
	});

	test("handles large plaintext", () => {
		const input = "x".repeat(64_000);
		expect(decryptSecret(encryptSecret(input))).toBe(input);
	});
});
