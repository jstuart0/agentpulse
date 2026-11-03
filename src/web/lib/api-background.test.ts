/**
 * A background request (the Hosts page's quiet refetch) must never be what reloads the page: a failed fetch
 * is an outage there, not a possible expired sign-in. An expired sign-in that shows as a redirect response
 * still reloads. A foreground request reloads only once a health probe shows the server is answering.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { reachabilityNetworkHandler, useReachabilityStore } from "../stores/reachability-store.js";
import { api, resetAuthBounceForTests, setNetworkHandler } from "./api.js";
import { runRetryProbe } from "./retry-probe.js";

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
	// The app's handler goes back: module state is shared by every test file, and a later one (the first
	// identity check) relies on the store's wiring being there.
	setNetworkHandler(reachabilityNetworkHandler);
	warn.mockRestore();
	if (savedWindow.had) g.window = savedWindow.value;
	else g.window = undefined;
});

const throwing = () => {
	globalThis.fetch = (async () => {
		throw new TypeError("Failed to fetch");
	}) as unknown as typeof fetch;
};
/** The request itself gets no answer; /health answers with this status (null: it gets none either). */
const throwingExceptHealth = (status: number | null) => {
	globalThis.fetch = (async (url: string) => {
		if (status !== null && String(url).endsWith("/health")) return new Response("{}", { status });
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

	test("in the foreground with the server answering /health: a blocked sign-in, so it reloads once and reports no outage", async () => {
		throwingExceptHealth(200);
		await expect(api.getSupervisors()).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(1);
		expect(failed).toBe(0);
	});

	test("the explicit foreground flag is the default too", async () => {
		throwingExceptHealth(200);
		await expect(api.getSupervisors({ background: false })).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(1);
	});

	test("AGEN-85: in the foreground with the server refusing connections: no reload, the outage is reported, and no reload is remembered", async () => {
		throwingExceptHealth(null);
		await expect(api.getSupervisors()).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(0);
		expect(failed).toBe(1);
		expect(stored).toEqual({});
	});

	test("AGEN-85: a gateway answering for a stopped app is an outage too", async () => {
		for (const status of [502, 503, 504]) {
			throwingExceptHealth(status);
			failed = 0;
			await expect(api.getSupervisors()).rejects.toBeInstanceOf(TypeError);
			await reloadSoon();
			expect(reloads).toBe(0);
			expect(failed).toBe(1);
		}
	});

	test("a sign-in redirect or refusal in front of /health means something answered: it reloads", async () => {
		throwingExceptHealth(401);
		await expect(api.getSupervisors()).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(1);
	});

	test("requests that fail together probe once", async () => {
		let probes = 0;
		globalThis.fetch = (async (url: string) => {
			if (String(url).endsWith("/health")) {
				probes++;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;
		await Promise.allSettled([api.getSupervisors(), api.getSupervisors(), api.getSupervisors()]);
		await reloadSoon();
		expect(probes).toBe(1);
		expect(reloads).toBe(0);
		expect(failed).toBe(3);
	});

	test("a reload already recorded in the last minute needs no probe", async () => {
		let probes = 0;
		stored["agentpulse.authBounceAt"] = String(Date.now());
		globalThis.fetch = (async (url: string) => {
			if (String(url).endsWith("/health")) probes++;
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;
		await expect(api.getSupervisors()).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(probes).toBe(0);
		expect(failed).toBe(1);
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

describe("the outage notice's probe and the fingerprint poll never reload the page", () => {
	test("W8: /health that gets no answer reports an outage and does not reload (it is never behind forwardauth, so it can't be an auth bounce)", async () => {
		throwing();
		await expect(api.getHealth()).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(0);
		expect(failed).toBe(1);
	});

	test("W8: nor does the identity check the notice's retry may use instead of /health", async () => {
		throwing();
		await expect(api.getAuthMe()).rejects.toBeInstanceOf(TypeError);
		await reloadSoon();
		expect(reloads).toBe(0);
		expect(failed).toBe(1);
	});

	test("a failed probe counts once against the retry backoff, however many ways it is reported", async () => {
		useReachabilityStore.setState({ unreachable: true, attempt: 0 });
		// the wiring the app has: a request that gets no answer reports a failure to the store
		setNetworkHandler(reachabilityNetworkHandler);
		throwing();
		await runRetryProbe({
			identityPending: false,
			loadIdentity: async () => {},
			identityConfirmed: () => true,
			health: () => api.getHealth(),
			onFail: () => useReachabilityStore.getState().reportProbeFailure(),
		});
		await reloadSoon();
		expect(useReachabilityStore.getState().attempt).toBe(1);
		expect(useReachabilityStore.getState().unreachable).toBe(true);
		expect(reloads).toBe(0);
		useReachabilityStore.setState({ unreachable: false, attempt: 0 });
	});

	test("the notice and the fingerprint poll go through api.getHealth, not a request of their own", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const notice = readFileSync(
			join(import.meta.dir, "../components/ServerUnreachableNotice.tsx"),
			"utf-8",
		);
		const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf-8");
		expect(notice).toContain("health: () => api.getHealth()");
		expect(app).toContain("await api.getHealth()");
		const apiSource = readFileSync(join(import.meta.dir, "api.ts"), "utf-8");
		expect(apiSource).toMatch(/\}>\("\/health", undefined, \{ background: true \}\)/);
		expect(apiSource).toContain(
			'request<AuthMeResponse>("/auth/me", undefined, { background: true })',
		);
	});
});
