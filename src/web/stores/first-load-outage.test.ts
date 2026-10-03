import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "../lib/api.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useReachabilityStore } from "./reachability-store.js";
import { useUserStore } from "./user-store.js";

/**
 * The first identity check answering 5xx or 429 is an outage, not a sign-out:
 * the app says so and keeps asking, instead of sitting on the skeleton.
 * Driven through the real request wrapper with a stubbed fetch.
 */
const realFetch = globalThis.fetch;
let identityStatus = 200;
let otherStatus = 200;
let otherBody: unknown = { error: "x" };

function reply(status: number, body: unknown = { error: "x" }): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	identityStatus = 200;
	otherStatus = 200;
	otherBody = { error: "x" };
	useReachabilityStore.setState({ unreachable: false, attempt: 0, recoveries: 0 });
	useUserStore.setState({
		loaded: false,
		loading: false,
		authenticated: false,
		error: null,
	} as never);
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/auth/me")) {
			return Promise.resolve(
				identityStatus === 200
					? reply(200, {
							authenticated: true,
							user: null,
							signOutUrl: null,
							disableAuth: false,
							allowSignup: false,
						})
					: reply(identityStatus),
			);
		}
		return Promise.resolve(
			otherStatus === 200 ? reply(200, { sessions: [], total: 0 }) : reply(otherStatus, otherBody),
		);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("the first identity check during an outage", () => {
	for (const status of [500, 502, 503, 429]) {
		test(`${status} is reported as an outage and leaves the app waiting, not signed out`, async () => {
			identityStatus = status;
			await useUserStore.getState().load();
			expect(useReachabilityStore.getState().unreachable).toBe(true);
			expect(useUserStore.getState().loaded).toBe(false);
		});
	}

	test("a failed retry keeps the outage and does not reset the backoff", async () => {
		identityStatus = 503;
		await useUserStore.getState().load();
		useReachabilityStore.getState().reportProbeFailure();
		useReachabilityStore.getState().reportProbeFailure();
		await useUserStore.getState().load();
		expect(useReachabilityStore.getState().unreachable).toBe(true);
		expect(useReachabilityStore.getState().attempt).toBe(2);
	});

	test("when the identity check answers again the outage clears and the app continues", async () => {
		identityStatus = 503;
		await useUserStore.getState().load();
		identityStatus = 200;
		await useUserStore.getState().load();
		expect(useReachabilityStore.getState().unreachable).toBe(false);
		expect(useUserStore.getState().loaded).toBe(true);
	});

	test("a health answer while the first identity check is unanswered does not end the outage", async () => {
		identityStatus = 503;
		await useUserStore.getState().load();
		expect(useReachabilityStore.getState().unreachable).toBe(true);

		await api.getHealth();

		// Still waiting: the notice keeps its retry, and the skeleton is not the end state.
		expect(useReachabilityStore.getState().unreachable).toBe(true);
		expect(useUserStore.getState().loaded).toBe(false);

		identityStatus = 200;
		await useUserStore.getState().load();
		expect(useReachabilityStore.getState().unreachable).toBe(false);
		expect(useUserStore.getState().loaded).toBe(true);
	});

	test("once the identity is known, any answer ends an outage as before", async () => {
		useUserStore.setState({ loaded: true, authenticated: true } as never);
		useReachabilityStore.setState({ unreachable: true });
		await api.getHealth();
		expect(useReachabilityStore.getState().unreachable).toBe(false);
	});

	test("a gateway error on any call is an outage; an ordinary error is not", async () => {
		const call = () =>
			api.getSessions(scopedQuery({ owner: "all", excludeScratch: false })).catch(() => {});
		otherStatus = 500;
		await call();
		expect(useReachabilityStore.getState().unreachable).toBe(false);
		otherStatus = 502;
		await call();
		expect(useReachabilityStore.getState().unreachable).toBe(true);
	});

	test("a busy answer (503 with the busy code) is not an outage", async () => {
		otherStatus = 503;
		otherBody = { error: "busy" };
		await api.getSessions(scopedQuery({ owner: "all", excludeScratch: false })).catch(() => {});
		expect(useReachabilityStore.getState().unreachable).toBe(false);
	});
});

describe("polls refused while the identity cannot be confirmed", () => {
	test("three 401s in a row with an unanswered identity check mark the sign-in unconfirmed", async () => {
		useUserStore.setState({ loaded: true, authenticated: true } as never);
		identityStatus = 503;
		otherStatus = 401;
		const poll = () =>
			api.getSessions(scopedQuery({ owner: "all", excludeScratch: false })).catch(() => {});
		await poll();
		await poll();
		expect(
			(useUserStore.getState() as { sessionUnconfirmed?: boolean }).sessionUnconfirmed,
		).not.toBe(true);
		await poll();
		await useUserStore.getState().load();
		expect((useUserStore.getState() as { sessionUnconfirmed?: boolean }).sessionUnconfirmed).toBe(
			true,
		);
	});

	test("refused polls alone don't make it unconfirmed while the identity check answers", async () => {
		useUserStore.setState({ loaded: true, authenticated: true } as never);
		identityStatus = 200;
		otherStatus = 401;
		const poll = () =>
			api.getSessions(scopedQuery({ owner: "all", excludeScratch: false })).catch(() => {});
		await poll();
		await poll();
		await poll();
		await poll();
		await useUserStore.getState().load();
		expect((useUserStore.getState() as { sessionUnconfirmed?: boolean }).sessionUnconfirmed).toBe(
			false,
		);
	});

	test("the identity check answering again clears it", async () => {
		useUserStore.setState({ loaded: true, authenticated: true, sessionUnconfirmed: true } as never);
		identityStatus = 200;
		await useUserStore.getState().load();
		expect((useUserStore.getState() as { sessionUnconfirmed?: boolean }).sessionUnconfirmed).toBe(
			false,
		);
	});
});
