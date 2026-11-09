/**
 * Which answers mean "the session is gone", through the real client with a stubbed fetch, and the pool
 * that asks about many tabs at once.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, api } from "./api.js";
import { checkSessions, isSessionGone } from "./session-gone.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function answer(status: number, body: string, type = "application/json") {
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(body, { status, headers: { "Content-Type": type } }),
		)) as unknown as typeof fetch;
}

async function failure(call: () => Promise<unknown>): Promise<unknown> {
	try {
		await call();
	} catch (err) {
		return err;
	}
	throw new Error("expected the call to fail");
}

const cases: Array<[string, number, string, string, boolean]> = [
	[
		"404 with the server's own body",
		404,
		'{"error":"Session not found"}',
		"application/json",
		true,
	],
	["404 with an HTML body", 404, "<html>Not Found</html>", "text/html", false],
	["404 with another error", 404, '{"error":"route_not_found"}', "application/json", false],
	[
		"403 password_change_required",
		403,
		'{"error":"password_change_required"}',
		"application/json",
		false,
	],
	["503", 503, '{"error":"busy"}', "application/json", false],
];

describe("isSessionGone through the real client", () => {
	for (const [name, status, body, type, expected] of cases) {
		test(`${name}: ${expected ? "gone" : "not gone"} (full detail and name read)`, async () => {
			answer(status, body, type);
			expect(isSessionGone(await failure(() => api.getSession("s1")))).toBe(expected);
			expect(isSessionGone(await failure(() => api.getSessionName("s1")))).toBe(expected);
		});
	}

	test("a thrown network error is not gone", () => {
		expect(isSessionGone(new TypeError("Failed to fetch"))).toBe(false);
	});

	test("the name read asks for the small projection, encoded, as a background request", async () => {
		let url = "";
		globalThis.fetch = ((input: RequestInfo | URL) => {
			url = String(input);
			return Promise.resolve(
				new Response('{"session":{"sessionId":"a/b","displayName":"x"}}', {
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;
		await api.getSessionName("a/b");
		expect(url).toEndWith("/sessions/a%2Fb?fields=displayName");
	});
});

describe("checkSessions", () => {
	test("never has more than 3 in flight over 12 ids, and returns the gone one (s7)", async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
		expect(ids).toHaveLength(12);
		let inFlight = 0;
		let peak = 0;
		const check = async (id: string) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 2));
			inFlight--;
			if (id === "s7") {
				throw new ApiError(404, "Session not found", { error: "Session not found" });
			}
		};
		const result = await checkSessions(ids, check, { concurrency: 3 });
		expect(result).toEqual(["s7"]);
		expect(peak).toBe(3);
	});

	test("any other failure keeps the id", async () => {
		const result = await checkSessions(
			["a", "b"],
			async (id) => {
				throw id === "a" ? new ApiError(500, "x", { error: "x" }) : new TypeError("net");
			},
			{ concurrency: 3 },
		);
		expect(result).toEqual([]);
	});

	test("zero ids make no call", async () => {
		let calls = 0;
		const result = await checkSessions(
			[],
			async () => {
				calls++;
			},
			{ concurrency: 3 },
		);
		expect(result).toEqual([]);
		expect(calls).toBe(0);
	});
});
