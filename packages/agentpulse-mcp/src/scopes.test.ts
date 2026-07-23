/**
 * Tests for scopes.ts — discoverScopes() (AGEN-12 Phase 2, D5
 * corrected per test-contract Correction #2).
 *
 * DISABLE_AUTH does NOT make /auth/me return authenticated:false —
 * getAuthUserFromHeaders returns a synthetic {source:"api_key",
 * scopes:["*"]} user (middleware.ts:63-64). discoverScopes() must branch
 * on user.scopes.includes("*"), never on `authenticated`. Test 27 pins
 * this exact shape — do NOT write it as {authenticated:false, ...}.
 */
import { describe, expect, test } from "bun:test";
import { ScopeDiscoveryError, discoverScopes } from "./scopes.js";
import { fakeClient as baseFakeClient } from "./test-support.js";
import type { AuthMeResponse } from "./types.js";

/** Fills the AuthMeResponse fields these tests don't care about with defaults, so each test only spells out what it's asserting on. */
function authMe(overrides: {
	authenticated: boolean;
	user: AuthMeResponse["user"];
}): AuthMeResponse {
	return {
		signOutUrl: null,
		disableAuth: false,
		allowSignup: false,
		...overrides,
	};
}

function fakeClient(response: AuthMeResponse) {
	return baseFakeClient({ getAuthMe: async () => response });
}

describe("discoverScopes", () => {
	test("observe + manage scopes → both discovered", async () => {
		const scopes = await discoverScopes(
			fakeClient(
				authMe({
					authenticated: true,
					user: {
						name: "t",
						source: "api_key",
						id: "1",
						role: null,
						scopes: ["observe", "manage"],
					},
				}),
			),
		);
		expect(scopes.sort()).toEqual(["manage", "observe"]);
	});

	test("observe-only scope → observe-only set", async () => {
		const scopes = await discoverScopes(
			fakeClient(
				authMe({
					authenticated: true,
					user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["observe"] },
				}),
			),
		);
		expect(scopes).toEqual(["observe"]);
	});

	test("ingest-only key (neither observe nor manage) → fail-fast, message names the mint command", async () => {
		const client = fakeClient(
			authMe({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["ingest"] },
			}),
		);

		await expect(discoverScopes(client)).rejects.toThrow(ScopeDiscoveryError);

		// dexter/tessa Med: the test name promises a mint-command assertion —
		// pin the actual message content, not just the error class. A
		// regression that throws ScopeDiscoveryError with a useless message
		// (e.g. just "denied") would previously pass this test silently.
		try {
			await discoverScopes(client);
			throw new Error("expected discoverScopes to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ScopeDiscoveryError);
			const message = (err as Error).message;
			expect(message).toContain("neither");
			expect(message.toLowerCase()).toContain("mint");
			expect(message).toContain("/api/v1/api-keys");
		}
	});

	test('unrecognized-only scopes (e.g. ["admin"], not just a recognized-but-insufficient scope like "ingest") → fail-fast, same as neither observe nor manage', async () => {
		// xander X6 (2026-07-23-deliver-agentpulse-mcp-package, Phase 3 step
		// 7b): distinct from the "ingest-only" case above, which uses a
		// RECOGNIZED scope that just isn't observe/manage. This case proves
		// the held.length===0 branch (scopes.ts) also fails closed on a
		// scope string the server has never heard of — never an
		// all-tools-fallback.
		const client = fakeClient(
			authMe({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["admin"] },
			}),
		);
		await expect(discoverScopes(client)).rejects.toThrow(ScopeDiscoveryError);
	});

	test('wildcard ["*"] scope (the actual DISABLE_AUTH=true shape) → registers everything', async () => {
		const scopes = await discoverScopes(
			fakeClient(
				authMe({
					authenticated: true,
					user: {
						name: "anonymous",
						source: "api_key",
						id: "anonymous",
						role: null,
						scopes: ["*"],
					},
				}),
			),
		);
		expect(scopes.sort()).toEqual(["manage", "observe"]);
	});

	test("missing scopes field on an authenticated api_key user (older server) → fail-fast with a min-version message", async () => {
		const client = fakeClient(
			authMe({ authenticated: true, user: { name: "t", source: "api_key", id: "1", role: null } }),
		);

		await expect(discoverScopes(client)).rejects.toThrow(ScopeDiscoveryError);

		try {
			await discoverScopes(client);
			throw new Error("expected discoverScopes to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ScopeDiscoveryError);
			expect((err as Error).message.toLowerCase()).toContain("agentpulse");
		}
	});

	test("non-api_key identity (forwardauth) passed to discoverScopes fails fast rather than defaulting", async () => {
		await expect(
			discoverScopes(
				fakeClient(
					authMe({
						authenticated: true,
						user: { name: "t", source: "forwardauth", id: "1", role: null },
					}),
				),
			),
		).rejects.toThrow(ScopeDiscoveryError);
	});

	test("authenticated:false (bad/missing key) fails fast", async () => {
		await expect(
			discoverScopes(fakeClient(authMe({ authenticated: false, user: null }))),
		).rejects.toThrow(ScopeDiscoveryError);
	});
});
