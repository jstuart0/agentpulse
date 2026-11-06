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

describe("mapError — ownership and role refusals (403)", () => {
	const cases: Array<[code: string, mustContain: string]> = [
		["not_owner", "owner or an admin"],
		["admin_required", "needs an admin"],
		["human_admin_required", "signed-in admin"],
		["password_change_required", "change the password"],
		["bad_origin", "dashboard"],
	];
	for (const [code, mustContain] of cases) {
		test(`403 ${code} → a plain message, not the bare code`, () => {
			const text = mapError(new ApiError(403, { error: code }), BASE_URL).content[0].text;
			expect(text.toLowerCase()).toContain(mustContain.toLowerCase());
			expect(text).not.toBe(code);
			expect(text.startsWith("AgentPulse")).toBe(true);
		});
	}

	test("the five refusals read differently from one another and from insufficient_scope", () => {
		const texts = [...cases.map(([code]) => code), "insufficient_scope"].map(
			(code) => mapError(new ApiError(403, { error: code }), BASE_URL).content[0].text,
		);
		expect(new Set(texts).size).toBe(texts.length);
	});

	test("bad_origin names both causes: a foreign Origin, and an untrusted Host with authentication off", () => {
		const text = mapError(new ApiError(403, { error: "bad_origin" }), BASE_URL).content[0].text;
		expect(text).toContain("Origin");
		expect(text).toContain("Host");
	});

	test("415 unsupported_media_type tells the caller to declare JSON", () => {
		const text = mapError(new ApiError(415, { error: "unsupported_media_type" }), BASE_URL)
			.content[0].text;
		expect(text).toContain("application/json");
		expect(text.startsWith("AgentPulse")).toBe(true);
		expect(text).not.toContain("unsupported_media_type");
	});

	test("a 403 with an unrecognised code still falls through to the generic message", () => {
		const text = mapError(new ApiError(403, { error: "something_else" }), BASE_URL).content[0].text;
		expect(text).toContain("something_else");
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

	// AGEN-44: a newer client (or a hand-rolled REST call) can send an
	// agent_type this server's AGENT_TYPES doesn't recognize. The 400 body
	// carries {error, value, allowed} but no `message`, so the generic 4xx
	// fallback (bodyMessage → code) would otherwise surface just the bare
	// code "invalid_agent_type" with no indication of the bad value or what's
	// allowed — this dedicated row keeps the tool error actionable.
	test("400 invalid_agent_type names the rejected value and the allowed list", () => {
		const result = mapError(
			new ApiError(400, {
				error: "invalid_agent_type",
				value: "copilot_cli",
				allowed: ["claude_code", "codex_cli"],
			}),
			BASE_URL,
		);
		expect(result.content[0].text).toContain("copilot_cli");
		expect(result.content[0].text).toContain("claude_code");
		expect(result.content[0].text).toContain("codex_cli");
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

describe("mapError — answering a HITL request", () => {
	const cases: Array<[status: number, code: string, mustContain: string]> = [
		[409, "prompt_not_deliverable", "can't type"],
		[409, "stale_proposal", "moved on"],
		[409, "not_approvable", "can't be approved"],
		[409, "launch_missing", "how that session was launched"],
		[409, "already_resolved", "already answered"],
		[409, "prompt_changed", "get_inbox again"],
		[409, "expired", "expired"],
		[409, "not_awaiting", "isn't waiting"],
		[400, "empty_prompt", "no prompt to send"],
		[400, "prompt_hash_required", "prompt_hash"],
		[400, "dispatch_blocked", "safety filter"],
		[400, "prompt_unsafe", "won't type"],
	];
	for (const [status, code, mustContain] of cases) {
		test(`${status} ${code} reads as a plain sentence`, () => {
			const result = mapError(
				new ApiError(status, { error: code, message: "server words" }),
				BASE_URL,
			);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain(mustContain);
			expect(result.content[0].text).not.toContain("server words");
		});
	}

	test("a slash-command refusal of a continued session reads as its own sentence, and human_required as a person's act", () => {
		const slash = mapError(
			new ApiError(400, {
				error: "prompt_unsafe",
				reason: "slash_command",
				message: "server words",
			}),
			BASE_URL,
		).content[0].text;
		expect(slash).toContain("starts with a slash");
		expect(slash).not.toContain("request is still open");
		expect(slash).not.toContain("server words");
		const human = mapError(
			new ApiError(403, { error: "human_required", message: "server words" }),
			BASE_URL,
		).content[0].text;
		expect(human).toContain("signed-in person");
		expect(human).not.toContain("server words");
	});

	test("a busy session says nothing was sent and the request is still open, so retrying is safe", () => {
		const text = mapError(
			new ApiError(409, { error: "prompt_not_deliverable", reason: "control_busy" }),
			BASE_URL,
		).content[0].text;
		expect(text).toContain("NOT sent");
		expect(text).toContain("still open");
		expect(text).toContain("Retryable");
	});
});

describe("mapError — a session whose host isn't there (AGEN-66)", () => {
	test("a stop or prompt refused host_offline surfaces the server's sentence, not a bare code", () => {
		const message =
			"The host running this session is offline, so it can't be controlled right now.";
		const text = mapError(new ApiError(409, { error: "host_offline", message }), BASE_URL)
			.content[0].text;
		expect(text).toBe(message);
	});

	test("host_gone on a HITL approval says the prompt was NOT sent and the request is still open, without the raw code", () => {
		const text = mapError(
			new ApiError(409, { error: "prompt_not_deliverable", reason: "host_gone" }),
			BASE_URL,
		).content[0].text;
		expect(text).toContain("NOT sent");
		expect(text).toContain("still open");
		expect(text).toContain("removed");
		expect(text).not.toContain("host_gone");
	});

	test("a Codex session on a host too old to send prompts says to start a new session, whichever route refused", () => {
		const copy =
			"This session's host is running an older supervisor that can't send prompts to Codex. Update it, then start a new session for this work. Updating ends the sessions running there.";
		const withMessage = mapError(
			new ApiError(409, { error: "host_upgrade_required", message: copy }),
			BASE_URL,
		).content[0].text;
		expect(withMessage).toBe(copy);
		const bare = mapError(new ApiError(409, { error: "host_upgrade_required" }), BASE_URL)
			.content[0].text;
		expect(bare).toBe(copy);
		const decided = mapError(
			new ApiError(409, { error: "prompt_not_deliverable", reason: "host_upgrade_required" }),
			BASE_URL,
		).content[0].text;
		expect(decided).toContain("NOT sent");
		expect(decided).toContain("still open");
		expect(decided).toContain(
			"Update it, then start a new session for this work. Updating ends the sessions running there.",
		);
		expect(decided).toContain("decline it");
		expect(decided).not.toContain("call decide_hitl again");
		expect(decided).not.toContain("host_upgrade_required");
	});

	test("a Codex session whose process ended with its host's restart says so, whichever route refused", () => {
		const copy =
			"This session's process ended when its host restarted, so it can't take more prompts. Start a new session for this work.";
		expect(
			mapError(new ApiError(409, { error: "managed_state_not_continuable" }), BASE_URL).content[0]
				.text,
		).toBe(copy);
		const decided = mapError(
			new ApiError(409, { error: "prompt_not_deliverable", reason: "managed_state" }),
			BASE_URL,
		).content[0].text;
		expect(decided).toContain("process ended when its host restarted");
		expect(decided).toContain("NOT sent");
		expect(decided).not.toContain("managed_state");
	});
});
