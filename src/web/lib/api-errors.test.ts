import { afterEach, describe, expect, test } from "bun:test";
import {
	apiErrorCode,
	describeApiError,
	isAiDisabledError,
	isPasswordChangeRequired,
	keyCreationErrorMessage,
	plainErrorMessage,
	revokeKeyFailure,
} from "./api-errors.js";
import { ApiError, api } from "./api.js";

const realFetch = globalThis.fetch;

function respondWith(status: number, body: unknown, contentType = "application/json") {
	globalThis.fetch = (async () =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": contentType },
		})) as unknown as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

async function rejection(call: () => Promise<unknown>): Promise<unknown> {
	try {
		await call();
	} catch (err) {
		return err;
	}
	throw new Error("expected the call to reject");
}

describe("ApiError carries the code and the parsed body", () => {
	test("a refusal with an error code exposes status, code and body", async () => {
		respondWith(403, { error: "not_owner" });
		const err = await rejection(() => api.archiveSession("s1"));
		expect(err).toBeInstanceOf(ApiError);
		const apiErr = err as ApiError;
		expect(apiErr.status).toBe(403);
		expect(apiErr.code).toBe("not_owner");
		expect(apiErr.body).toEqual({ error: "not_owner" });
	});

	test("the extra fields of a 409 survive: the mode dialog reads the keys from the body", async () => {
		respondWith(409, {
			error: "service_keys_undecided",
			keys: [{ id: "k1", name: "ci", keyPrefix: "ap_ab" }],
		});
		const err = (await rejection(() => api.setInstanceMode("team", []))) as ApiError;
		expect(err.code).toBe("service_keys_undecided");
		expect((err.body as { keys: unknown[] }).keys).toHaveLength(1);
	});

	test("a body that isn't JSON leaves the code null and the body null", async () => {
		respondWith(502, "Bad Gateway", "text/plain");
		const err = (await rejection(() => api.getSettings())) as ApiError;
		expect(err.status).toBe(502);
		expect(err.code).toBeNull();
		expect(err.body).toBeNull();
	});

	test("the message stays the server's text, as before", async () => {
		respondWith(400, { error: "Name is required" });
		const err = (await rejection(() => api.createApiKey("", ["ingest"]))) as ApiError;
		expect(err.message).toBe("Name is required");
	});
});

describe("describeApiError", () => {
	const known: Array<[string, string]> = [
		["not_owner", "Only the owner or an admin can do that."],
		["admin_required", "Only admins can do that."],
		["human_admin_required", "This needs an admin signed in to the dashboard, not an API key."],
		[
			"bad_origin",
			"This address isn't allowed to make admin changes. Set PUBLIC_URL to the address you use to open AgentPulse.",
		],
		[
			"last_admin",
			"The only admin can't be demoted or disabled. Make someone else an admin first.",
		],
		[
			"role_locked_by_env",
			"Admin role is set by AGENTPULSE_ADMIN_SSO_SUBJECTS and can't be changed here.",
		],
		["mode_locked_by_env", "The mode is set by AGENTPULSE_MODE and can't be changed here."],
		["service_keys_undecided", "A key was added while this was open."],
		["team_requires_auth", "Team mode needs sign-in. Unset DISABLE_AUTH to use it."],
		["user_disabled", "That account is disabled."],
		["password_change_required", "Choose a new password first."],
		["user_not_found", "That person no longer exists."],
		["username_taken", "That username is taken."],
		["not_local_account", "Only local accounts have a password to reset."],
		["key_has_owner", "A key with an owner can't be an admin service key."],
		["key_not_manage", "Only a key that can manage can be kept as an admin service key."],
		["insufficient_scope", "This key doesn't have permission to do that."],
		["key_not_user_settable", "That setting can't be changed here."],
	];
	for (const [code, text] of known) {
		test(`${code} reads as plain text`, () => {
			expect(describeApiError(new ApiError(403, code, { error: code }), "fallback")).toBe(text);
		});
	}

	test("a password the server refuses says why, in the server's words", () => {
		const err = new ApiError(400, "password_complexity_failed", {
			error: "password_complexity_failed",
			reason: "Password must contain at least one digit.",
		});
		expect(describeApiError(err, "fallback")).toBe("Password must contain at least one digit.");
	});

	test("a rate limit says to wait", () => {
		expect(describeApiError(new ApiError(429, "Too Many Requests", null), "fallback")).toBe(
			"Too many requests. Wait a moment and try again.",
		);
	});

	test("an unknown code or a network failure gets the caller's sentence, never the raw code", () => {
		expect(describeApiError(new ApiError(500, "boom", { error: "boom" }), "Couldn't archive")).toBe(
			"Couldn't archive",
		);
		expect(describeApiError(new TypeError("Failed to fetch"), "Couldn't archive")).toBe(
			"Couldn't archive",
		);
	});
});

describe("apiErrorCode and isPasswordChangeRequired", () => {
	test("the code of an ApiError, null for anything else", () => {
		expect(apiErrorCode(new ApiError(403, "x", { error: "not_owner" }))).toBe("not_owner");
		expect(apiErrorCode(new Error("not_owner"))).toBeNull();
	});

	test("only password_change_required is the gate's signal", () => {
		expect(
			isPasswordChangeRequired(
				new ApiError(403, "password_change_required", { error: "password_change_required" }),
			),
		).toBe(true);
		expect(isPasswordChangeRequired(new ApiError(403, "x", { error: "not_owner" }))).toBe(false);
		expect(isPasswordChangeRequired(new Error("password_change_required"))).toBe(false);
	});
});

describe("plainErrorMessage", () => {
	test("a known refusal reads as its plain sentence", () => {
		expect(
			plainErrorMessage(new ApiError(403, "admin_required", { error: "admin_required" })),
		).toBe("Only admins can do that.");
	});

	test("an unknown refusal keeps the server's own text, never 'ApiError: ...'", () => {
		expect(
			plainErrorMessage(new ApiError(400, "Name is required", { error: "Name is required" })),
		).toBe("Name is required");
	});

	test("other errors keep their message; a thrown string is passed through", () => {
		expect(plainErrorMessage(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
		expect(plainErrorMessage("boom")).toBe("boom");
	});
});

describe("keyCreationErrorMessage", () => {
	test("the rate limit says to wait, in words about keys", () => {
		expect(keyCreationErrorMessage(new ApiError(429, "Too Many Requests", null))).toBe(
			"Too many keys created. Wait a minute and try again.",
		);
	});

	test("a known refusal reads as its plain sentence", () => {
		expect(keyCreationErrorMessage(new ApiError(403, "x", { error: "insufficient_scope" }))).toBe(
			"This key doesn't have permission to do that.",
		);
	});

	test("anything else is about creating, never about loading", () => {
		expect(keyCreationErrorMessage(new TypeError("Failed to fetch"))).toBe(
			"Couldn't create the key. Try again.",
		);
		expect(keyCreationErrorMessage(new ApiError(500, "boom", null))).toBe(
			"Couldn't create the key. Try again.",
		);
	});
});

describe("revokeKeyFailure", () => {
	test("a 404 says the key isn't there or isn't theirs, and marks the list stale", () => {
		expect(revokeKeyFailure(new ApiError(404, "Not Found", { error: "not_found" }))).toEqual({
			message: "That key isn't there any more, or it isn't yours to revoke.",
			stale: true,
		});
	});

	test("a known refusal keeps its own sentence and isn't a stale list", () => {
		expect(revokeKeyFailure(new ApiError(403, "x", { error: "not_owner" }))).toEqual({
			message: "Only the owner or an admin can do that.",
			stale: false,
		});
	});

	test("anything else is about revoking", () => {
		expect(revokeKeyFailure(new TypeError("Failed to fetch"))).toEqual({
			message: "Couldn't revoke the key. Try again.",
			stale: false,
		});
	});
});

describe("Retry-After reaches the error", () => {
	function respondThrottled(retryAfter: string | null) {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "rate_limited" }), {
				status: 429,
				headers: {
					"Content-Type": "application/json",
					...(retryAfter === null ? {} : { "Retry-After": retryAfter }),
				},
			})) as unknown as typeof fetch;
	}

	test("a number of seconds", async () => {
		respondThrottled("120");
		const err = (await rejection(() => api.archiveSession("s1"))) as ApiError;
		expect(err.retryAfterSeconds).toBe(120);
	});

	test("an HTTP date is the whole seconds from now, rounded up", async () => {
		const realNow = Date.now;
		Date.now = () => Date.UTC(2026, 9, 2, 12, 0, 0, 400);
		try {
			respondThrottled("Fri, 02 Oct 2026 12:01:00 GMT");
			const err = (await rejection(() => api.archiveSession("s1"))) as ApiError;
			expect(err.retryAfterSeconds).toBe(60);
		} finally {
			Date.now = realNow;
		}
	});

	test("no header is null, not zero", async () => {
		respondThrottled(null);
		const err = (await rejection(() => api.archiveSession("s1"))) as ApiError;
		expect(err.retryAfterSeconds).toBeNull();
	});
});

describe("isAiDisabledError", () => {
	test("only the server's own 404 ai_disabled says the feature is off", () => {
		expect(isAiDisabledError(new ApiError(404, "x", { error: "ai_disabled" }))).toBe(true);
		expect(isAiDisabledError(new ApiError(404, "x", { error: "not_found" }))).toBe(false);
		expect(isAiDisabledError(new ApiError(409, "x", { error: "ai_paused" }))).toBe(false);
		expect(isAiDisabledError(new TypeError("Failed to fetch"))).toBe(false);
	});
});

describe("a busy server reads as a sentence", () => {
	test("a 503 busy answer is described, not shown as its code", async () => {
		respondWith(503, { error: "busy" });
		const err = await rejection(() => api.getSettings());
		expect(plainErrorMessage(err)).toBe("The server is busy. Try again in a moment.");
	});
});
