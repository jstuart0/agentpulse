import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "../lib/api.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useUserStore } from "./user-store.js";

/**
 * A role or mode change made elsewhere reaches an open tab through the
 * refusals it causes: the tab re-asks who the viewer is, a bounded number of
 * times, and the answer updates the UI (or resets everything for another
 * person). Driven through the real request wrapper with a stubbed fetch.
 */
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;
let meCalls = 0;
let meBody: unknown;
let assigned: string[] = [];

function me(userId: string, role: "user" | "admin", mode: "solo" | "team") {
	return {
		authenticated: true,
		user: {
			name: userId,
			source: "local",
			id: userId,
			role,
			userId,
			effectiveRole: role === "admin" ? "admin" : "member",
		},
		signOutUrl: null,
		disableAuth: false,
		allowSignup: false,
		mode,
	};
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function refused(code: string) {
	await api.getSessions(scopedQuery({ owner: "all", excludeScratch: false })).catch(() => {});
	return code;
}

beforeEach(async () => {
	meCalls = 0;
	assigned = [];
	meBody = me("viewer", "admin", "team");
	(globalThis as { window?: unknown }).window = {
		location: { assign: (url: string) => assigned.push(url) },
	};
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/auth/me")) {
			meCalls += 1;
			return Promise.resolve(json(200, meBody));
		}
		return Promise.resolve(json(403, { error: refusalCode }));
	}) as typeof fetch;
	refusalCode = "admin_required";
	await useUserStore.getState().load();
	meCalls = 0;
	const { _resetIdentityRecheckForTest } = await import("./user-store.js");
	_resetIdentityRecheckForTest();
});

afterEach(() => {
	useUserStore.setState({
		authenticated: false,
		userId: null,
		mode: "solo",
		effectiveRole: null,
	} as never);
	globalThis.fetch = realFetch;
	if (realWindow === undefined) Reflect.deleteProperty(globalThis, "window");
	else (globalThis as { window?: unknown }).window = realWindow;
});

let refusalCode = "admin_required";

describe("refusals that say the viewer's standing may have changed", () => {
	for (const code of ["admin_required", "human_admin_required", "not_owner"]) {
		test(`${code} re-asks who the viewer is, and a demotion shows`, async () => {
			refusalCode = code;
			meBody = me("viewer", "user", "team");
			await refused(code);
			await new Promise((r) => setTimeout(r, 20));
			expect(meCalls).toBe(1);
			expect(useUserStore.getState().effectiveRole).toBe("member");
		});
	}

	test("a mode switched to solo elsewhere shows after the refusal", async () => {
		meBody = me("viewer", "admin", "solo");
		await refused("admin_required");
		await new Promise((r) => setTimeout(r, 20));
		expect(useUserStore.getState()).toMatchObject({ mode: "solo" });
	});

	test("many refusals at once, and more right after, make one re-check", async () => {
		await Promise.all([1, 2, 3, 4, 5].map(() => refused("admin_required")));
		await new Promise((r) => setTimeout(r, 20));
		await refused("admin_required");
		await new Promise((r) => setTimeout(r, 20));
		expect(meCalls).toBe(1);
	});

	test("a different person signed in from another tab resets everything", async () => {
		meBody = me("someone-else", "user", "team");
		await refused("not_owner");
		await new Promise((r) => setTimeout(r, 20));
		expect(assigned).toEqual(["/login"]);
	});
});
