import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, api } from "./api.js";

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; body: unknown }> = [];

function stub(res: () => Response) {
	calls = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method ?? "GET", body: init?.body });
		return res();
	}) as unknown as typeof fetch;
}
function json(status: number, body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

beforeEach(() => {
	calls = [];
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("api session summary", () => {
	test("TC-7.27a getSessionSummary: GET on the encoded path through the client", async () => {
		stub(() => json(200, { stored: null }));
		const view = await api.getSessionSummary("a/b");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("/app-api/v1/ai/sessions/a%2Fb/summary");
		expect(calls[0].method).toBe("GET");
		expect(view).toEqual({ stored: null } as never);
	});

	test("phase 8a the poll form asks for ?poll=1 only when told to", async () => {
		stub(() => json(200, { stored: null }));
		await api.getSessionSummary("s1", { poll: true });
		await api.getSessionSummary("s1", { poll: false });
		await api.getSessionSummary("s1", {});
		expect(calls.map((c) => c.url)).toEqual([
			"/app-api/v1/ai/sessions/s1/summary?poll=1",
			"/app-api/v1/ai/sessions/s1/summary",
			"/app-api/v1/ai/sessions/s1/summary",
		]);
	});

	test("TC-7.27b getSessionSummary rejects with the ApiError on a refusal", async () => {
		stub(() => json(503, { error: "busy" }, { "Retry-After": "1" }));
		const err = await api.getSessionSummary("s1").catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(503);
	});

	test("TC-7.27c generateSessionSummary: POST with no body, 202 body returned", async () => {
		const attempt = { status: "generating", startedAt: "2026-10-04T12:00:00.000Z", joined: false };
		stub(() => json(202, { attempt }));
		const res = await api.generateSessionSummary("s 1");
		expect(calls[0].url).toBe("/app-api/v1/ai/sessions/s%201/summary");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toBeUndefined();
		expect(res).toEqual({ ok: true, body: { attempt } } as never);
	});

	test("TC-7.27d a refusal is typed; retryAfterSeconds from the body wins over the header", async () => {
		stub(() =>
			json(429, { error: "summary_rate_limited", retryAfterSeconds: 4 }, { "Retry-After": "9" }),
		);
		expect(await api.generateSessionSummary("s1")).toEqual({
			ok: false,
			refusal: { status: 429, code: "summary_rate_limited", retryAfterSeconds: 4 },
		});
	});

	test("TC-7.27e retryAfterSeconds falls back to the header when the body has none", async () => {
		stub(() => json(503, { error: "busy" }, { "Retry-After": "1" }));
		expect(await api.generateSessionSummary("s1")).toEqual({
			ok: false,
			refusal: { status: 503, code: "busy", retryAfterSeconds: 1 },
		});
		stub(() => json(409, { error: "no_provider" }));
		expect(await api.generateSessionSummary("s1")).toEqual({
			ok: false,
			refusal: { status: 409, code: "no_provider", retryAfterSeconds: null },
		});
	});

	test("TC-7.27f an unlisted code or a non-JSON failure gives code null", async () => {
		stub(() => json(409, { error: "something_new" }));
		expect(await api.generateSessionSummary("s1")).toMatchObject({
			ok: false,
			refusal: { status: 409, code: null },
		});
		stub(() => new Response("upstream exploded", { status: 500 }));
		expect(await api.generateSessionSummary("s1")).toMatchObject({
			ok: false,
			refusal: { status: 500, code: null },
		});
	});

	test("TC-7.27g the spend_cap_reached refusal keeps its code", async () => {
		stub(() =>
			json(409, { error: "spend_cap_reached", spentCents: 420, capCents: 500, maxCostCents: 45 }),
		);
		expect(await api.generateSessionSummary("s1")).toMatchObject({
			ok: false,
			refusal: { code: "spend_cap_reached" },
		});
	});
});
