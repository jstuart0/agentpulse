/**
 * Tests for src/mcp/scopes.ts — discoverScopes() (AGEN-12 Phase 2, D5
 * corrected per test-contract Correction #2).
 *
 * DISABLE_AUTH does NOT make /auth/me return authenticated:false —
 * getAuthUserFromHeaders returns a synthetic {source:"api_key",
 * scopes:["*"]} user (middleware.ts:63-64). discoverScopes() must branch
 * on user.scopes.includes("*"), never on `authenticated`. Test 27 pins
 * this exact shape — do NOT write it as {authenticated:false, ...}.
 */
import { describe, expect, test } from "bun:test";
import type { AgentPulseClient, AuthMeResponse } from "./client.js";
import { ScopeDiscoveryError, discoverScopes } from "./scopes.js";

function fakeClient(authMe: AuthMeResponse): AgentPulseClient {
	return {
		baseUrl: "http://localhost:3000/api/v1",
		getStats: async () => {
			throw new Error("not used in these tests");
		},
		getAuthMe: async () => authMe,
	};
}

describe("discoverScopes", () => {
	test("observe + manage scopes → both discovered", async () => {
		const scopes = await discoverScopes(
			fakeClient({
				authenticated: true,
				user: { name: "t", source: "api_key", scopes: ["observe", "manage"] },
			}),
		);
		expect(scopes.sort()).toEqual(["manage", "observe"]);
	});

	test("observe-only scope → observe-only set", async () => {
		const scopes = await discoverScopes(
			fakeClient({
				authenticated: true,
				user: { name: "t", source: "api_key", scopes: ["observe"] },
			}),
		);
		expect(scopes).toEqual(["observe"]);
	});

	test("ingest-only key (neither observe nor manage) → fail-fast naming the mint command", async () => {
		await expect(
			discoverScopes(
				fakeClient({
					authenticated: true,
					user: { name: "t", source: "api_key", scopes: ["ingest"] },
				}),
			),
		).rejects.toThrow(ScopeDiscoveryError);
	});

	test('wildcard ["*"] scope (the actual DISABLE_AUTH=true shape) → registers everything', async () => {
		const scopes = await discoverScopes(
			fakeClient({
				authenticated: true,
				user: { name: "anonymous", source: "api_key", scopes: ["*"] },
			}),
		);
		expect(scopes.sort()).toEqual(["manage", "observe"]);
	});

	test("does NOT write the DISABLE_AUTH case as authenticated:false — that shape is unreachable", async () => {
		// Regression guard: assert the *reachable* shape works, proving the
		// implementation branches on scopes, not on `authenticated`.
		const scopes = await discoverScopes(
			fakeClient({
				authenticated: true,
				user: { name: "anonymous", source: "api_key", scopes: ["*"] },
			}),
		);
		expect(scopes.length).toBeGreaterThan(0);
	});

	test("missing scopes field on an authenticated api_key user (older server) → fail-fast with a min-version message", async () => {
		await expect(
			discoverScopes(fakeClient({ authenticated: true, user: { name: "t", source: "api_key" } })),
		).rejects.toThrow(ScopeDiscoveryError);

		try {
			await discoverScopes(
				fakeClient({ authenticated: true, user: { name: "t", source: "api_key" } }),
			);
			throw new Error("expected discoverScopes to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ScopeDiscoveryError);
			expect((err as Error).message.toLowerCase()).toContain("agentpulse");
		}
	});

	test("non-api_key identity (forwardauth) passed to discoverScopes fails fast rather than defaulting", async () => {
		await expect(
			discoverScopes(
				fakeClient({ authenticated: true, user: { name: "t", source: "forwardauth" } }),
			),
		).rejects.toThrow(ScopeDiscoveryError);
	});

	test("authenticated:false (bad/missing key) fails fast", async () => {
		await expect(discoverScopes(fakeClient({ authenticated: false, user: null }))).rejects.toThrow(
			ScopeDiscoveryError,
		);
	});
});
