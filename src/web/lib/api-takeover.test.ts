import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../components/session-detail/session-takeover-view.js";
import { describeApiError } from "./api-errors.js";
import { ApiError, api } from "./api.js";

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; body: unknown; headers: unknown }> = [];

function stub(res: () => Response) {
	calls = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method ?? "GET", body: init?.body, headers: init?.headers });
		return res();
	}) as unknown as typeof fetch;
}
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

beforeEach(() => {
	calls = [];
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("api: taking a session over and resuming one", () => {
	test("bindSession posts exactly the strict body to the session's bind path, with a JSON content type", async () => {
		stub(() => json(202, { action: { id: "a" }, launchRequestId: "l" }));
		const out = await api.bindSession("s/1", { targetSupervisorId: "h1" });
		expect(out).toMatchObject({ action: { id: "a" }, launchRequestId: "l" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/sessions/s%2F1/bind");
		expect(calls[0]?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.body))).toEqual({
			targetSupervisorId: "h1",
			sameMachineConfirmed: true,
		});
		expect(JSON.stringify(calls[0]?.headers)).toContain("application/json");
	});

	test("resumeSession posts no body at all", async () => {
		stub(() => json(202, { action: { id: "a" }, launchRequestId: "l" }));
		await api.resumeSession("s1");
		expect(calls[0]?.url).toContain("/sessions/s1/resume");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toBeUndefined();
	});

	test("a refusal arrives as an ApiError carrying the server's code", async () => {
		stub(() => json(409, { error: "session_active" }));
		const err = await api.bindSession("s1", { targetSupervisorId: "h1" }).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).code).toBe("session_active");
	});

	test("delete and archive refused during a takeover read in plain words wherever describeApiError is used", () => {
		for (const code of ["takeover_in_progress", "retry_not_available"]) {
			const text = describeApiError(new ApiError(409, code, { error: code }), "fallback");
			expect(text).not.toBe("fallback");
			expect(text).not.toContain(code);
		}
	});
});
