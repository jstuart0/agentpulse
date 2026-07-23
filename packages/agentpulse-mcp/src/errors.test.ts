/**
 * Tests for errors.ts — domain-failure → MCP {isError} mapping
 * (AGEN-12 Phase 2, D5). Table-driven per test contract assertions 8-16.
 *
 * Two corrections pinned here per tessa's test contract (not the plan's
 * literal D5 text):
 *  1. ai_disabled is emitted at TWO status codes (404 build-off, 409
 *     runtime-off) — both must map to distinct text, keyed on the
 *     {status, error} PAIR, not status alone.
 *  2. No 503 ai_kill_switch_active row exists — it must fall through to
 *     the generic 5xx handler, not crash or get a dead-code branch.
 */
import { describe, expect, test } from "bun:test";
import { ApiError, NetworkError, TimeoutError } from "./client.js";
import { mapError } from "./errors.js";

const BASE_URL = "http://localhost:3000/api/v1";

describe("mapError — network/timeout", () => {
	test("NetworkError maps to an 'unreachable' message naming the base URL", () => {
		const result = mapError(new NetworkError("boom"), BASE_URL);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("AgentPulse unreachable at");
		expect(result.content[0].text).toContain(BASE_URL);
	});

	test("TimeoutError maps to the same 'unreachable' message shape", () => {
		const result = mapError(new TimeoutError("timed out"), BASE_URL);
		expect(result.content[0].text).toContain("AgentPulse unreachable at");
		expect(result.content[0].text).toContain(BASE_URL);
	});
});

describe("mapError — ApiError status/body pairs", () => {
	test("401 → API key rejected", () => {
		const result = mapError(new ApiError(401, { error: "unauthorized" }), BASE_URL);
		expect(result.content[0].text).toContain("API key rejected");
	});

	test("403 insufficient_scope → names the required scope", () => {
		const result = mapError(
			new ApiError(403, { error: "insufficient_scope", required: "manage" }),
			BASE_URL,
		);
		expect(result.content[0].text).toContain("manage");
		expect(result.content[0].text.toLowerCase()).toContain("scope");
	});

	test("404 ai_disabled (build-off) maps distinctly", () => {
		const result = mapError(
			new ApiError(404, { error: "ai_disabled", message: "AI feature not compiled in" }),
			BASE_URL,
		);
		expect(result.content[0].text).toContain("not enabled");
	});

	test("409 ai_disabled (runtime-off) maps to TEXT DISTINCT from the 404 case and the 409 ai_paused case (Correction #1)", () => {
		const runtimeOff = mapError(
			new ApiError(409, {
				error: "ai_disabled",
				message: "AI feature disabled. Enable in Settings.",
			}),
			BASE_URL,
		);
		const buildOff = mapError(
			new ApiError(404, { error: "ai_disabled", message: "AI feature not compiled in" }),
			BASE_URL,
		);
		const paused = mapError(
			new ApiError(409, {
				error: "ai_paused",
				message: "All watchers are paused via the kill switch.",
			}),
			BASE_URL,
		);

		expect(runtimeOff.content[0].text).not.toBe(buildOff.content[0].text);
		expect(runtimeOff.content[0].text).not.toBe(paused.content[0].text);
	});

	test("409 ai_paused → kill-switch message", () => {
		const result = mapError(
			new ApiError(409, {
				error: "ai_paused",
				message: "All watchers are paused via the kill switch.",
			}),
			BASE_URL,
		);
		expect(result.content[0].text.toLowerCase()).toContain("paused");
	});

	test("other 4xx passes through the {error} body text verbatim", () => {
		const result = mapError(
			new ApiError(422, { error: "validation_failed", details: [{ field: "x" }] }),
			BASE_URL,
		);
		expect(result.content[0].text).toContain("validation_failed");
	});

	test("5xx includes the status code and truncates an oversized body", () => {
		const bigBody = { error: "internal", detail: "x".repeat(5000) };
		const result = mapError(new ApiError(500, bigBody), BASE_URL);
		expect(result.content[0].text).toContain("500");
		expect(result.content[0].text.length).toBeLessThan(2000);
	});

	test("never-shipped 503 ai_kill_switch_active falls through to generic 5xx handling, not a dead-code crash", () => {
		const result = mapError(
			new ApiError(503, {
				error: "ai_kill_switch_active",
				message: "should never be emitted by the server",
			}),
			BASE_URL,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("503");
		// Must NOT match any of the AI-gate-specific messages — proves no
		// dead-code branch exists for this code.
		expect(result.content[0].text.toLowerCase()).not.toContain("paused");
		expect(result.content[0].text.toLowerCase()).not.toContain("not enabled");
	});
});

describe("mapError — unexpected error shapes", () => {
	test("a plain thrown Error (not ApiError/NetworkError/TimeoutError) still maps to {isError}, never rethrows", () => {
		const result = mapError(new Error("unexpected"), BASE_URL);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("unexpected");
	});

	test("client.ts's malformed-2xx-JSON Error (tessa Med) maps through the generic fallback, not a crash", () => {
		const result = mapError(
			new Error(
				"AgentPulse returned malformed JSON on a 200 response from /sessions/stats: {trunc",
			),
			BASE_URL,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("malformed JSON");
	});
});
