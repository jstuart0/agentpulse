/**
 * Unit tests for the scope model in src/server/auth/api-key.ts (AGEN-9).
 *
 * Tests cover:
 *  - parseScopes: valid JSON, malformed JSON, non-array, empty string → fail-closed to ["ingest"]
 *  - createApiKey: rejects unknown scope values (InvalidScopeError)
 *  - createApiKey: accepts recognized scope values and defaults to ["ingest"]
 *  - verifyApiKey: returns parsed scopes from the DB record
 */

import { describe, expect, test } from "bun:test";

// Bootstrap the test DB before any db-touching import.
import "../db/__test_db.js";

const {
	parseScopes,
	InvalidScopeError,
	createApiKey,
	verifyApiKey,
	SCOPE_INGEST,
	SCOPE_MANAGE,
	SCOPE_OBSERVE,
} = await import("./api-key.js");

// ── parseScopes ───────────────────────────────────────────────────────────────

describe("parseScopes — JSON parsing and fail-closed fallback", () => {
	test("valid JSON array of strings → returned as-is", () => {
		expect(parseScopes('["ingest"]')).toEqual(["ingest"]);
		expect(parseScopes('["ingest","manage"]')).toEqual(["ingest", "manage"]);
		expect(parseScopes('["*"]')).toEqual(["*"]);
	});

	test('null/undefined/empty string → fail-closed to ["ingest"]', () => {
		expect(parseScopes(null)).toEqual([SCOPE_INGEST]);
		expect(parseScopes(undefined)).toEqual([SCOPE_INGEST]);
		expect(parseScopes("")).toEqual([SCOPE_INGEST]);
	});

	test('malformed JSON → fail-closed to ["ingest"]', () => {
		expect(parseScopes("not json")).toEqual([SCOPE_INGEST]);
		expect(parseScopes("{manage}")).toEqual([SCOPE_INGEST]);
		expect(parseScopes("[")).toEqual([SCOPE_INGEST]);
	});

	test('valid JSON but non-array → fail-closed to ["ingest"]', () => {
		expect(parseScopes('"ingest"')).toEqual([SCOPE_INGEST]);
		expect(parseScopes("42")).toEqual([SCOPE_INGEST]);
		expect(parseScopes('{"scope":"ingest"}')).toEqual([SCOPE_INGEST]);
	});

	test('array with non-string elements → fail-closed to ["ingest"]', () => {
		expect(parseScopes("[1,2]")).toEqual([SCOPE_INGEST]);
		expect(parseScopes('["ingest",null]')).toEqual([SCOPE_INGEST]);
	});
});

// ── createApiKey scope validation ─────────────────────────────────────────────

describe("createApiKey — scope validation at mint time", () => {
	test("unknown scope value → throws InvalidScopeError", async () => {
		let threw = false;
		try {
			await createApiKey("bad-scope-key", ["unknown_scope"]);
		} catch (err) {
			threw = true;
			expect(err instanceof InvalidScopeError).toBe(true);
		}
		expect(threw).toBe(true);
	});

	test("InvalidScopeError carries the bad value", async () => {
		try {
			await createApiKey("bad-scope-key-2", ["launch"]);
			throw new Error("Expected InvalidScopeError to be thrown");
		} catch (err) {
			expect(err instanceof InvalidScopeError).toBe(true);
			expect((err as InstanceType<typeof InvalidScopeError>).value).toBe("launch");
		}
	});

	test("recognized scope values are accepted", async () => {
		// These should not throw.
		const { key: key1 } = await createApiKey("ingest-only-test", [SCOPE_INGEST]);
		expect(key1).toMatch(/^ap_/);

		const { key: key2 } = await createApiKey("manage-only-test", [SCOPE_MANAGE]);
		expect(key2).toMatch(/^ap_/);

		const { key: key3 } = await createApiKey("both-scopes-test", [SCOPE_INGEST, SCOPE_MANAGE]);
		expect(key3).toMatch(/^ap_/);
	});

	test('default scopes = ["ingest"] when none supplied', async () => {
		const { key, id } = await createApiKey("default-scope-test");
		expect(key).toMatch(/^ap_/);
		expect(id).toBeTruthy();

		// Verify the stored key has ingest scope
		const record = await verifyApiKey(key);
		expect(record).not.toBeNull();
		expect(record?.scopes).toEqual([SCOPE_INGEST]);
	});
});

// ── AGEN-12 Phase 1: observe scope ────────────────────────────────────────────

describe("AGEN-12 Phase 1 — observe scope recognized at mint time", () => {
	test("SCOPE_OBSERVE is the literal string 'observe'", () => {
		expect(SCOPE_OBSERVE).toBe("observe");
	});

	test("createApiKey([SCOPE_OBSERVE]) does not throw and mints a valid key", async () => {
		const { key } = await createApiKey("observe-only-test", [SCOPE_OBSERVE]);
		expect(key).toMatch(/^ap_/);
	});

	test("createApiKey([SCOPE_OBSERVE, SCOPE_MANAGE]) does not throw (dual-scope key)", async () => {
		const { key } = await createApiKey("observe-manage-test", [SCOPE_OBSERVE, SCOPE_MANAGE]);
		expect(key).toMatch(/^ap_/);
	});

	test("verifyApiKey on an observe-only key returns scopes: ['observe']", async () => {
		const { key } = await createApiKey("verify-observe-test", [SCOPE_OBSERVE]);
		const record = await verifyApiKey(key);
		expect(record).not.toBeNull();
		expect(record?.scopes).toEqual([SCOPE_OBSERVE]);
	});
});

// ── verifyApiKey — scopes from DB record ──────────────────────────────────────

describe("verifyApiKey — scopes parsed from stored record", () => {
	test('ingest-only key returns scopes: ["ingest"]', async () => {
		const { key } = await createApiKey("verify-ingest-test", ["ingest"]);
		const record = await verifyApiKey(key);
		expect(record).not.toBeNull();
		expect(record?.scopes).toEqual(["ingest"]);
	});

	test('manage key returns scopes: ["ingest","manage"]', async () => {
		const { key } = await createApiKey("verify-manage-test", ["ingest", "manage"]);
		const record = await verifyApiKey(key);
		expect(record).not.toBeNull();
		expect(record?.scopes).toEqual(["ingest", "manage"]);
	});

	test("invalid key → null", async () => {
		const result = await verifyApiKey("ap_notarealkey00000000000000000000");
		expect(result).toBeNull();
	});
});
