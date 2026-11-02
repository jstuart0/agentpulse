/**
 * A background request (the Hosts page's quiet refetch) must never be what reloads the page: a failed fetch
 * is an outage there, not a possible expired sign-in. An expired sign-in that shows as a redirect response
 * still reloads. Every other caller is unchanged.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { api, resetAuthBounceForTests, setNetworkHandler } from "./api.js";

const realFetch = globalThis.fetch;
const g = globalThis as unknown as Record<string, unknown>;
const savedWindow = { had: "window" in g, value: g.window };

let failed = 0;
let reloads = 0;
let stored: Record<string, string> = {};
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
	failed = 0;
	reloads = 0;
	stored = {};
	resetAuthBounceForTests();
	g.window = {
		sessionStorage: {
			getItem: (key: string) => stored[key] ?? null,
			setItem: (key: string, value: string) => {
				stored[key] = value;
			},
		},
		location: {
			reload: () => {
				reloads++;
			},
		},
	};
	setNetworkHandler({ failed: () => void failed++, ok: () => {} });
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	globalThis.fetch = realFetch;
	setNetworkHandler(null);
	warn.mockRestore();
	if (savedWindow.had) g.window = savedWindow.value;
	else g.window = undefined;
});

const throwing = () => {
	globalThis.fetch = (async () => {
		throw new TypeError("Failed to fetch");
	}) as unknown as typeof fetch;
};
const reloadSoon = () => new Promise((resolve) => setTimeout(resolve, 120));

describe("a fetch that throws a TypeError", () => {
	test("in the background: no reload, and the outage handler is told", async () => {
		throwing();
		await expect(api.getSupervisors({ background: true })).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(0);
		expect(failed).toBe(1);
	});

	test("in the foreground (the default): unchanged, the first one reloads and does not report an outage", async () => {
		throwing();
		await expect(api.getSupervisors()).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(1);
		expect(failed).toBe(0);
	});

	test("the explicit foreground flag is the default too", async () => {
		throwing();
		await expect(api.getSupervisors({ background: false })).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(1);
	});
});

describe("an answer that is an expired sign-in", () => {
	test("is still caught in the background: the page reloads to reauthenticate", async () => {
		globalThis.fetch = (async () => {
			const res = new Response(null, { status: 200 });
			Object.defineProperty(res, "type", { value: "opaqueredirect" });
			return res;
		}) as unknown as typeof fetch;
		await expect(api.getSupervisors({ background: true })).rejects.toThrow(/Session expired/);
		await reloadSoon();
		expect(reloads).toBe(1);
		expect(failed).toBe(0);
	});
});
