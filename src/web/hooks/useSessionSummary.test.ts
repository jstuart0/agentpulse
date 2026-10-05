import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import {
	SUMMARY_VIEW_FIXTURES as F,
	FIXTURE_NOW,
} from "../../shared/__fixtures__/session-summary-view/index.js";
import type { SessionSummaryView } from "../../shared/session-summary-view.js";
import type { AiStatusResponse } from "../lib/api.js";
import { ApiError, type GenerateSummaryResult, api } from "../lib/api.js";
import { resetAiStatusStore, useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import {
	deferred,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../test-utils/render-hook.js";
import {
	COOLDOWN_TICK_MS,
	SUMMARY_POLL_INTERVAL_MS,
	SUMMARY_POLL_RETRIES,
	type UseSessionSummary,
	useSessionSummary,
} from "./useSessionSummary.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };

type Responder = SessionSummaryView | Error | (() => Promise<SessionSummaryView>);
let queue: Responder[] = [];
let gets: string[] = [];
let posts = 0;
let postIds: string[] = [];
let aiStatusCalls = 0;
let labsCalls = 0;
const mounted: Array<{ unmount: () => Promise<void> }> = [];

function script(...responders: Responder[]) {
	queue = [...responders];
}
function nextResponder(): Responder {
	if (queue.length === 0) throw new Error("unscripted GET");
	return queue.length === 1 ? queue[0] : (queue.shift() as Responder);
}
const STARTED: GenerateSummaryResult = {
	ok: true,
	body: { attempt: { status: "generating", startedAt: FIXTURE_NOW, joined: false } },
};
const JOINED: GenerateSummaryResult = {
	ok: true,
	body: { attempt: { status: "generating", startedAt: FIXTURE_NOW, joined: true } },
};
const refused = (
	status: number,
	code: string,
	retryAfterSeconds: number | null = null,
): GenerateSummaryResult => ({
	ok: false,
	// biome-ignore lint/suspicious/noExplicitAny: the code is a plain string on the wire
	refusal: { status, code: code as any, retryAfterSeconds },
});
function postReturns(result: GenerateSummaryResult | Promise<GenerateSummaryResult>) {
	client.generateSessionSummary = (sessionId: string) => {
		posts++;
		postIds.push(sessionId);
		return Promise.resolve(result);
	};
}
const AI_ON: AiStatusResponse = { build: true, runtime: true, killSwitch: false, active: true };
const AI_PAUSED: AiStatusResponse = { build: true, runtime: true, killSwitch: true, active: false };
/** The tab only exists once both sources have answered, so a mounted hook sees loaded stores. */
function loadedStores(ai: AiStatusResponse = AI_ON) {
	useAiStatusStore.setState({ status: ai, loadState: "loaded", error: null });
	useLabsStore.setState({
		// biome-ignore lint/suspicious/noExplicitAny: the flag joins LabsFlags in phase 5
		flags: { sessionSummary: true } as any,
		registry: [],
		loading: false,
		error: null,
	});
}

/**
 * A background tab fires timers late while the clock keeps running. Fake timers reset `Date` on
 * every advance, so the lateness is added on top of whatever `Date.now` says.
 */
let fakeNow: (() => number) | null = null;
let clockSkewMs = 0;
function skewClock(ms: number) {
	const base = fakeNow ?? Date.now;
	fakeNow = base;
	clockSkewMs += ms;
	Date.now = () => base() + clockSkewMs;
}

async function settle() {
	await act(async () => {
		for (let i = 0; i < 12; i++) await Promise.resolve();
	});
}
async function tick(ms: number) {
	await act(async () => {
		jest.advanceTimersByTime(ms);
	});
	await settle();
}

type Props = { id: string | undefined; enabled: boolean };
async function mount(sessionId: string | null = "s1", enabled = true) {
	const id = sessionId ?? undefined;
	const h = renderHook<Props, UseSessionSummary>((p) => useSessionSummary(p.id, p.enabled), {
		id,
		enabled,
	});
	mounted.push(h);
	await h.render({ id, enabled });
	await settle();
	return {
		h,
		get v(): UseSessionSummary {
			return h.current.value as UseSessionSummary;
		},
		rerender: async (p: Props) => {
			await h.render(p);
			await settle();
		},
	};
}
async function generateOnce(m: { v: UseSessionSummary }, options?: { confirmed?: boolean }) {
	let result: Awaited<ReturnType<UseSessionSummary["generate"]>> | undefined;
	await act(async () => {
		result = await m.v.generate(options);
	});
	await settle();
	return result;
}
function viewOf(m: { v: UseSessionSummary }): SessionSummaryView {
	if (m.v.load.status !== "ready") throw new Error(`load is ${m.v.load.status}`);
	return m.v.load.view;
}

beforeEach(() => {
	installDomStubs();
	jest.useFakeTimers();
	queue = [];
	gets = [];
	posts = 0;
	postIds = [];
	aiStatusCalls = 0;
	labsCalls = 0;
	client.getSessionSummary = (id: string) => {
		gets.push(id);
		const r = nextResponder();
		if (typeof r === "function") return r();
		return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
	};
	client.getAiStatus = async () => {
		aiStatusCalls++;
		return { build: true, runtime: true, killSwitch: false, active: true };
	};
	client.getLabsFlags = async () => {
		labsCalls++;
		return { flags: { sessionSummary: true }, registry: [] };
	};
	resetAiStatusStore();
	useLabsStore.setState({ flags: null, registry: [], loading: false, error: null });
});
afterEach(async () => {
	if (fakeNow) Date.now = fakeNow;
	fakeNow = null;
	clockSkewMs = 0;
	for (const h of mounted.splice(0)) await h.unmount();
	expect(jest.getTimerCount()).toBe(0);
	jest.useRealTimers();
	removeDomStubs();
	client.getSessionSummary = real.getSessionSummary;
	client.generateSessionSummary = real.generateSessionSummary;
	client.getAiStatus = real.getAiStatus;
	client.getLabsFlags = real.getLabsFlags;
});

describe("loading", () => {
	test("TC-7.15a the first fetch goes loading to ready", async () => {
		const d = deferred<SessionSummaryView>();
		script(() => d.promise);
		const m = await mount();
		expect(m.v.load.status).toBe("loading");
		d.resolve(F.empty);
		await settle();
		expect(m.v.load.status).toBe("ready");
		expect(gets).toEqual(["s1"]);
	});

	test("TC-7.15b a failed fetch and a 503 busy both give load failed; retry loads", async () => {
		script(new Error("down"));
		const m = await mount();
		expect(m.v.load.status).toBe("error");
		script(new ApiError(503, "busy", { error: "busy" }, 1));
		await act(async () => {
			m.v.retry();
		});
		await settle();
		expect(m.v.load.status).toBe("error");
		script(F.ready);
		await act(async () => {
			m.v.retry();
		});
		await settle();
		expect(m.v.load.status).toBe("ready");
	});

	test("TC-7.15c disabled or without a session id: unavailable and no fetch", async () => {
		script(F.empty);
		const off = await mount("s1", false);
		expect(off.v.load.status).toBe("unavailable");
		const none = await mount(null, true);
		expect(none.v.load.status).toBe("unavailable");
		expect(gets).toEqual([]);
		await off.rerender({ id: "s1", enabled: true });
		expect(off.v.load.status).toBe("ready");
	});
});

describe("generating and polling", () => {
	test("TC-7.16 generate sends one POST, is generating at once, polls each interval, stops once settled", async () => {
		const post = deferred<GenerateSummaryResult>();
		postReturns(post.promise);
		script(F.empty, F.generating, F.ready);
		const m = await mount();
		await act(async () => {
			void m.v.generate();
		});
		expect(posts).toBe(1);
		expect(m.v.generating).toBe(true);
		post.resolve(STARTED);
		await settle();
		expect(gets).toHaveLength(1);
		await tick(SUMMARY_POLL_INTERVAL_MS - 1);
		expect(gets).toHaveLength(1);
		await tick(1);
		expect(gets).toHaveLength(2);
		expect(m.v.generating).toBe(true);
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets).toHaveLength(3);
		expect(m.v.generating).toBe(false);
		await tick(SUMMARY_POLL_INTERVAL_MS * 3);
		expect(gets).toHaveLength(3);
	});

	test("TC-7.17 a poll slower than the interval never overlaps; the next is scheduled after it finishes", async () => {
		postReturns(STARTED);
		const slow = deferred<SessionSummaryView>();
		script(F.empty, () => slow.promise, F.generating);
		const m = await mount();
		await generateOnce(m);
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets).toHaveLength(2);
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toHaveLength(2);
		slow.resolve(F.generating);
		await settle();
		await tick(SUMMARY_POLL_INTERVAL_MS - 1);
		expect(gets).toHaveLength(2);
		await tick(1);
		expect(gets).toHaveLength(3);
	});

	test("TC-7.17b the POST names the session it was clicked on, and follows a session change", async () => {
		postReturns(STARTED);
		script(F.empty);
		const m = await mount("s1");
		await generateOnce(m);
		expect(postIds).toEqual(["s1"]);
		await m.rerender({ id: "s2", enabled: true });
		await generateOnce(m);
		expect(postIds).toEqual(["s1", "s2"]);
		expect(posts).toBe(2);
	});

	test("TC-7.17c a read asked for while one is in flight waits for it: one GET at a time, the later view wins", async () => {
		const held = deferred<SessionSummaryView>();
		script(() => held.promise, F.ready);
		const m = await mount();
		expect(gets).toEqual(["s1"]);
		await act(async () => m.v.retry());
		await settle();
		expect(gets).toEqual(["s1"]);
		held.resolve(F.empty);
		await settle();
		expect(gets).toEqual(["s1", "s1"]);
		expect(viewOf(m).stored).not.toBeNull();
		await tick(SUMMARY_POLL_INTERVAL_MS * 3);
		expect(gets).toHaveLength(2);
	});

	test("TC-7.17d a late answer that lost the race cannot replace the later view", async () => {
		const first = deferred<SessionSummaryView>();
		const second = deferred<SessionSummaryView>();
		script(
			() => first.promise,
			() => second.promise,
		);
		const m = await mount();
		await act(async () => m.v.retry());
		first.resolve(F.empty);
		await settle();
		second.resolve(F.ready);
		await settle();
		expect(viewOf(m).stored).not.toBeNull();
		expect(gets).toHaveLength(2);
	});

	test("TC-7.18a unmount clears the timer", async () => {
		script(F.generating);
		const m = await mount();
		expect(gets).toHaveLength(1);
		await m.h.unmount();
		mounted.length = 0;
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toHaveLength(1);
	});

	test("TC-7.18c unmounting with a cooldown, a poll or a refusal countdown pending leaves no timer behind", async () => {
		script({ ...F.cooldown, cooldownSeconds: 20 });
		const cooling = await mount();
		expect(jest.getTimerCount()).toBeGreaterThan(0);
		await cooling.h.unmount();
		mounted.length = 0;
		expect(jest.getTimerCount()).toBe(0);

		script(F.generating);
		const polling = await mount("s3");
		expect(jest.getTimerCount()).toBe(1);
		await polling.h.unmount();
		mounted.length = 0;
		expect(jest.getTimerCount()).toBe(0);

		postReturns(refused(429, "summary_rate_limited", 30));
		script(F.empty);
		const limited = await mount("s4");
		await generateOnce(limited);
		expect(limited.v.refusal).not.toBeNull();
		expect(jest.getTimerCount()).toBeGreaterThan(0);
		await limited.h.unmount();
		mounted.length = 0;
		expect(jest.getTimerCount()).toBe(0);
	});

	test("TC-7.18b a response arriving after unmount sets no state and triggers no GET", async () => {
		const late = deferred<SessionSummaryView>();
		script(F.generating, () => late.promise, F.generating);
		const m = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets).toHaveLength(2);
		await m.h.unmount();
		mounted.length = 0;
		late.resolve(F.generating);
		await settle();
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toHaveLength(2);
	});

	test("TC-7.19 every terminal state stops polling; a cooldown is waited out by its countdown, not by polls", async () => {
		for (const name of ["ready", "interrupted", "too_little_activity", "no_provider"] as const) {
			gets = [];
			script(F.generating, F[name]);
			const m = await mount();
			await tick(SUMMARY_POLL_INTERVAL_MS);
			expect(gets, name).toHaveLength(2);
			await tick(SUMMARY_POLL_INTERVAL_MS * 5);
			expect(gets, `${name} kept polling`).toHaveLength(2);
			await m.h.unmount();
			mounted.length = 0;
		}
		for (const name of ["failed", "failed_ai_inactive"] as const) {
			gets = [];
			script(F.generating, F[name]);
			const m = await mount();
			await tick(SUMMARY_POLL_INTERVAL_MS);
			expect(gets, name).toHaveLength(2);
			// The fixture's cooldown is 10 s: no read until it ends, then one.
			await tick(6_000);
			expect(gets, `${name} polled during its cooldown`).toHaveLength(2);
			await tick(4_000);
			expect(gets, `${name} re-read when the cooldown ended`).toHaveLength(3);
			await m.h.unmount();
			mounted.length = 0;
		}
	});

	test("TC-7.20 three consecutive poll failures keep going, the fourth gives load failed, a success resets the count", async () => {
		expect(SUMMARY_POLL_RETRIES).toBe(3);
		const boom = new Error("blip");
		script(F.generating, boom, boom, boom, F.generating, boom, boom, boom, boom, F.generating);
		const m = await mount();
		for (let i = 0; i < 3; i++) {
			await tick(SUMMARY_POLL_INTERVAL_MS);
			expect(m.v.load.status, `failure ${i + 1}`).toBe("ready");
		}
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(m.v.load.status).toBe("ready");
		for (let i = 0; i < 3; i++) {
			await tick(SUMMARY_POLL_INTERVAL_MS);
			expect(m.v.load.status).toBe("ready");
		}
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(m.v.load.status).toBe("ready");
		expect(m.v.lostContact).toBe(true);
		const after = gets.length;
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toHaveLength(after);
	});

	test("TC-7.20b after the retries fail the last view stays readable with a separate lost-contact state, and Retry brings it back", async () => {
		const boom = new Error("down");
		script(F.generating, boom, boom, boom, boom);
		const g = await mount();
		expect(g.v.lostContact).toBe(false);
		for (let i = 0; i < 4; i++) await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(g.v.lostContact).toBe(true);
		expect(g.v.load.status).toBe("ready");
		expect(viewOf(g).attempt.status).toBe("generating");
		script(boom);
		await act(async () => g.v.retry());
		await settle();
		expect(g.v.lostContact).toBe(true);
		expect(g.v.load.status).toBe("ready");
		script(F.ready);
		await act(async () => g.v.retry());
		await settle();
		expect(g.v.lostContact).toBe(false);
		expect(viewOf(g).stored).not.toBeNull();
		expect(g.v.generating).toBe(false);
	});

	test("TC-7.20c a first load that never succeeds is still the load-failed state, not lost contact", async () => {
		script(new Error("down"));
		const m = await mount();
		expect(m.v.load.status).toBe("error");
		expect(m.v.lostContact).toBe(false);
	});

	test("TC-7.20d lost contact ends polling, and a later view arriving by another path clears it", async () => {
		const boom = new Error("down");
		script(F.generating, boom, boom, boom, boom, F.ready);
		const m = await mount();
		for (let i = 0; i < 4; i++) await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(m.v.lostContact).toBe(true);
		const seen = gets.length;
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toHaveLength(seen);
		await act(async () => m.v.retry());
		await settle();
		expect(m.v.lostContact).toBe(false);
	});

	test("TC-7.21 a session change mid-flight ignores the late old response and stops the old poll", async () => {
		const late = deferred<SessionSummaryView>();
		script(F.generating, () => late.promise);
		const m = await mount("s1");
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets).toEqual(["s1", "s1"]);
		script(F.empty);
		await m.rerender({ id: "s2", enabled: true });
		expect(gets).toEqual(["s1", "s1", "s2"]);
		late.resolve(F.ready);
		await settle();
		expect(viewOf(m).stored).toBeNull();
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toEqual(["s1", "s1", "s2"]);
	});

	test("TC-7.23 a page the server reports generating polls without a click and is not started here", async () => {
		script(F.generating, F.generating, F.ready);
		const m = await mount();
		expect(m.v.generating).toBe(true);
		expect(m.v.startedHere).toBe(false);
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets).toHaveLength(2);
		expect(posts).toBe(0);
	});
});

describe("generate", () => {
	test("TC-7.22a 429 rate limited: inline countdown, nothing is polled, the text clears at zero", async () => {
		postReturns(refused(429, "summary_rate_limited", 3));
		script(F.empty);
		const m = await mount();
		await generateOnce(m);
		expect(m.v.refusal?.text).toBe("Too many summary requests. Try again in 3s.");
		expect(m.v.generating).toBe(false);
		await tick(COOLDOWN_TICK_MS);
		expect(m.v.refusal?.text).toBe("Too many summary requests. Try again in 2s.");
		await tick(COOLDOWN_TICK_MS * 2);
		expect(m.v.refusal).toBeNull();
		expect(gets).toHaveLength(1);
	});

	test("TC-7.22b a cooldown refusal refetches the view and shows the blocked action, not inline copy", async () => {
		postReturns(refused(429, "summary_cooldown", 5));
		script(F.empty, { ...F.ready, blocked: "summary_cooldown", cooldownSeconds: 5 });
		const m = await mount();
		await generateOnce(m);
		expect(gets).toHaveLength(2);
		expect(m.v.refusal).toBeNull();
		expect(viewOf(m).blocked).toBe("summary_cooldown");
		expect(m.v.generating).toBe(false);
	});

	test("TC-7.22c the 409s the blocked action explains refetch the view", async () => {
		for (const code of ["no_provider", "too_little_activity", "spend_cap_reached"]) {
			gets = [];
			postReturns(refused(409, code));
			script(
				F.empty,
				F[
					code === "no_provider"
						? "no_provider"
						: code === "spend_cap_reached"
							? "spend_cap"
							: "too_little_activity"
				],
			);
			const m = await mount();
			await generateOnce(m);
			expect(gets, code).toHaveLength(2);
			expect(viewOf(m).blocked).not.toBeNull();
			expect(m.v.refusal).toBeNull();
			expect(m.v.generating).toBe(false);
			await m.h.unmount();
			mounted.length = 0;
		}
	});

	test("TC-7.22d 503 shutting down shows retry copy and starts no polling", async () => {
		postReturns(refused(503, "shutting_down", 5));
		script(F.empty);
		const m = await mount();
		await generateOnce(m);
		expect(m.v.refusal?.text).toBe("The server is restarting. Try again in a moment.");
		expect(m.v.generating).toBe(false);
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toHaveLength(1);
	});

	test("TC-7.22e 202 joined polls but is not started here", async () => {
		postReturns(JOINED);
		script(F.empty, F.generating, F.ready);
		const m = await mount();
		await generateOnce(m);
		expect(m.v.generating).toBe(true);
		expect(m.v.startedHere).toBe(false);
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets).toHaveLength(2);
		expect(m.v.announcement).toBeNull();
	});

	test("TC-7.22f AI and Labs refusals re-read their own source", async () => {
		loadedStores();
		postReturns(refused(409, "ai_paused"));
		script(F.empty);
		const a = await mount();
		await generateOnce(a);
		expect(a.v.refusal?.text).toBe("AI was just paused.");
		expect(aiStatusCalls).toBe(1);
		expect(labsCalls).toBe(0);
		postReturns(refused(409, "session_summary_disabled"));
		await generateOnce(a);
		expect(a.v.refusal?.text).toBe("Session summaries were just turned off.");
		expect(labsCalls).toBe(1);
	});

	test("TC-7.22g an inline refusal clears when the re-read changes what the action says", async () => {
		loadedStores();
		client.getAiStatus = async () => {
			aiStatusCalls++;
			return AI_PAUSED;
		};
		postReturns(refused(409, "ai_paused"));
		script(F.empty);
		const m = await mount();
		await generateOnce(m);
		expect(aiStatusCalls).toBe(1);
		expect(useAiStatusStore.getState().status?.killSwitch).toBe(true);
		expect(m.v.refusal).toBeNull();
	});

	test("TC-7.22h the same for a view re-read that changes the blocker, and a refusal that outlives nothing it explained stays", async () => {
		loadedStores();
		postReturns(refused(409, "provider_key_unreadable"));
		script(F.empty, F.no_provider);
		const m = await mount();
		await generateOnce(m);
		expect(gets).toHaveLength(2);
		expect(viewOf(m).blocked).toBe("no_provider");
		expect(m.v.refusal).toBeNull();
		script(F.empty, F.empty);
		const stays = await mount("s2");
		await generateOnce(stays);
		expect(stays.v.refusal?.text).toBe(
			"The provider's API key can't be read. An admin needs to enter it again in AI settings.",
		);
	});

	test("TC-7.22i a refusal does not outlive the generation that follows it", async () => {
		loadedStores();
		postReturns(refused(409, "provider_key_unreadable"));
		script(F.empty, F.generating, F.ready);
		const m = await mount();
		await generateOnce(m);
		expect(m.v.refusal).toBeNull();
		expect(m.v.generating).toBe(true);
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(m.v.generating).toBe(false);
		expect(m.v.refusal).toBeNull();
	});

	test("TC-7.24a a second generate during an in-flight POST sends no second POST", async () => {
		const post = deferred<GenerateSummaryResult>();
		postReturns(post.promise);
		script(F.empty, F.generating);
		const m = await mount();
		let second: unknown;
		await act(async () => {
			void m.v.generate();
			second = await Promise.race([m.v.generate(), Promise.resolve("still waiting")]);
		});
		expect(second).toBe("ignored");
		expect(posts).toBe(1);
		post.resolve(STARTED);
		await settle();
	});

	test("TC-7.24b a generate while a generation is active sends no POST", async () => {
		postReturns(STARTED);
		script(F.generating);
		const m = await mount();
		expect(await generateOnce(m)).toBe("ignored");
		expect(posts).toBe(0);
	});

	test("TC-7.25 with evidence shrunk, update sends no POST until confirmed", async () => {
		postReturns(STARTED);
		script(F.evidence_shrunk, F.generating);
		const m = await mount();
		expect(await generateOnce(m)).toBe("needs_confirmation");
		expect(posts).toBe(0);
		expect(await generateOnce(m, { confirmed: true })).toBe("started");
		expect(posts).toBe(1);
	});

	test("TC-7.25b it asks exactly when the model supplies confirm text: shrunk with a stored summary, not shrunk, and shrunk with nothing stored", async () => {
		postReturns(STARTED);
		script({ ...F.empty, evidenceShrunk: true }, F.generating);
		const none = await mount();
		expect(await generateOnce(none)).toBe("started");
		expect(posts).toBe(1);
		await none.h.unmount();
		mounted.length = 0;
		posts = 0;
		script(F.ready, F.generating);
		const plain = await mount("s2");
		expect(await generateOnce(plain)).toBe("started");
		expect(posts).toBe(1);
	});
});

describe("cooldown", () => {
	test("TC-7.14 the countdown ticks, and at zero the view is refetched and the action enabled", async () => {
		script({ ...F.cooldown, cooldownSeconds: 3 }, F.ready);
		const m = await mount();
		expect(viewOf(m).blocked).toBe("summary_cooldown");
		expect(viewOf(m).cooldownSeconds).toBe(3);
		await tick(COOLDOWN_TICK_MS);
		expect(viewOf(m).cooldownSeconds).toBe(2);
		await tick(COOLDOWN_TICK_MS);
		expect(viewOf(m).cooldownSeconds).toBe(1);
		expect(gets).toHaveLength(1);
		await tick(COOLDOWN_TICK_MS);
		expect(gets).toHaveLength(2);
		expect(viewOf(m).blocked).toBeNull();
		await tick(COOLDOWN_TICK_MS * 5);
		expect(gets).toHaveLength(2);
	});
});

describe("cooldown deadlines", () => {
	test("TC-7.14b the countdown counts from a deadline: a throttled tick that fires late shows the true time left", async () => {
		script({ ...F.cooldown, cooldownSeconds: 20 }, F.ready);
		const m = await mount();
		expect(viewOf(m).cooldownSeconds).toBe(20);
		skewClock(7_000);
		await tick(COOLDOWN_TICK_MS);
		expect(viewOf(m).cooldownSeconds).toBe(12);
		skewClock(60_000);
		await tick(COOLDOWN_TICK_MS);
		expect(gets).toHaveLength(2);
		expect(viewOf(m).blocked).toBeNull();
	});

	test("TC-7.14c a rate-limit countdown is a deadline too", async () => {
		postReturns(refused(429, "summary_rate_limited", 30));
		script(F.empty);
		const m = await mount();
		await generateOnce(m);
		expect(m.v.refusal?.text).toBe("Too many summary requests. Try again in 30s.");
		skewClock(12_000);
		await tick(COOLDOWN_TICK_MS);
		expect(m.v.refusal?.text).toBe("Too many summary requests. Try again in 17s.");
		skewClock(60_000);
		await tick(COOLDOWN_TICK_MS);
		expect(m.v.refusal).toBeNull();
	});
});

describe("announcements and the New badge", () => {
	test("TC-7.38a a generation started here announces Summarizing, then Summary ready, once each", async () => {
		postReturns(STARTED);
		script(F.empty, F.generating, F.ready);
		const m = await mount();
		const seen: Array<string | null> = [];
		const sample = () => {
			const a = m.v.announcement;
			if (seen[seen.length - 1] !== a) seen.push(a);
		};
		sample();
		await generateOnce(m);
		sample();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		sample();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		sample();
		await tick(SUMMARY_POLL_INTERVAL_MS * 3);
		sample();
		expect(seen).toEqual([null, "Summarizing", "Summary ready"]);
	});

	test("TC-7.38b a failure announces Summary failed; a generation started elsewhere announces nothing", async () => {
		postReturns(STARTED);
		script(F.empty, F.failed);
		const m = await mount();
		await generateOnce(m);
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(m.v.announcement).toBe("Summary failed");
		await m.h.unmount();
		mounted.length = 0;
		script(F.generating, F.ready);
		const other = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(other.v.announcement).toBeNull();
	});

	test("TC-7.36b New means a generation seen finishing this visit; clearing it works; a fresh load shows none", async () => {
		script(F.ready);
		const fresh = await mount();
		expect(fresh.v.newResult).toBe(false);
		await fresh.h.unmount();
		mounted.length = 0;

		script(F.generating, F.ready);
		const m = await mount();
		expect(m.v.newResult).toBe(false);
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(m.v.newResult).toBe(true);
		await act(async () => m.v.clearNew());
		expect(m.v.newResult).toBe(false);
	});

	test("TC-7.36c a generation that failed is not a New summary", async () => {
		script(F.generating, F.failed);
		const m = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(m.v.newResult).toBe(false);
	});

	test("TC-7.36d a failed attempt is not New even when an older summary is stored", async () => {
		script(F.generating, F.failed_ai_inactive);
		const m = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(viewOf(m).stored).not.toBeNull();
		expect(viewOf(m).attempt.status).toBe("failed");
		expect(m.v.newResult).toBe(false);
	});

	test("TC-7.36e started here turns false once the generation finishes, whichever way it ends", async () => {
		for (const outcome of [F.ready, F.failed]) {
			postReturns(STARTED);
			script(F.empty, F.generating, outcome);
			const m = await mount();
			await generateOnce(m);
			expect(m.v.startedHere).toBe(true);
			await tick(SUMMARY_POLL_INTERVAL_MS);
			expect(m.v.startedHere).toBe(true);
			await tick(SUMMARY_POLL_INTERVAL_MS);
			expect(m.v.generating).toBe(false);
			expect(m.v.startedHere).toBe(false);
			await m.h.unmount();
			mounted.length = 0;
		}
	});
});

describe("polled views that leave the stored summary out (AGEN-69 phase 8a)", () => {
	const OMITTED = { stored: null, storedOmitted: true } as unknown as Partial<SessionSummaryView>;
	const generatingWithPrevious: SessionSummaryView = {
		...F.ready,
		attempt: { status: "generating", startedAt: FIXTURE_NOW, errorCode: null },
	};

	test("a poll that says storedOmitted keeps the summary already on screen", async () => {
		script(generatingWithPrevious, { ...generatingWithPrevious, ...OMITTED });
		const m = await mount();
		expect(viewOf(m).stored).not.toBeNull();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets).toHaveLength(2);
		expect(viewOf(m).stored).toEqual(F.ready.stored);
		expect(m.v.generating).toBe(true);
	});

	test("a poll without the flag and without a stored summary is taken at its word", async () => {
		script(generatingWithPrevious, { ...generatingWithPrevious, stored: null });
		const m = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(viewOf(m).stored).toBeNull();
	});

	test("when the generation finishes in a poll that omits the summary, the new one is read in full", async () => {
		const done = { ...F.ready, ...OMITTED } as SessionSummaryView;
		const fresh: SessionSummaryView = { ...F.ready, generatedAt: "2026-10-04T12:01:00.000Z" };
		script(generatingWithPrevious, done, fresh);
		const m = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets).toHaveLength(3);
		expect(viewOf(m).stored).not.toBeNull();
		expect(viewOf(m).generatedAt).toBe("2026-10-04T12:01:00.000Z");
		expect(m.v.generating).toBe(false);
		expect(m.v.newResult).toBe(true);
	});

	test("a failed generation in a poll that omits the summary keeps the old one and does not re-read", async () => {
		const failed = {
			...F.ready,
			...OMITTED,
			attempt: { status: "failed", startedAt: FIXTURE_NOW, errorCode: "parse_failed" },
		} as SessionSummaryView;
		script(generatingWithPrevious, failed);
		const m = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		await tick(SUMMARY_POLL_INTERVAL_MS * 3);
		expect(gets).toHaveLength(2);
		expect(viewOf(m).stored).toEqual(F.ready.stored);
		expect(viewOf(m).attempt.status).toBe("failed");
	});

	test("a failed full re-read after a finish picks polling back up instead of freezing on 'generating'", async () => {
		const done = { ...F.ready, ...OMITTED } as SessionSummaryView;
		script(generatingWithPrevious, done, new Error("down"), F.ready);
		const m = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(gets.length).toBeGreaterThanOrEqual(4);
		expect(m.v.generating).toBe(false);
	});

	test("only a poll asks for ?poll=1; the first read and a re-read after a finish are full", async () => {
		const seen: unknown[] = [];
		client.getSessionSummary = (_id: string, options: unknown) => {
			seen.push(options);
			if (seen.length === 1) return Promise.resolve(generatingWithPrevious);
			if (seen.length === 2) return Promise.resolve({ ...F.ready, ...OMITTED });
			return Promise.resolve(F.ready);
		};
		await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		expect(seen).toEqual([{ poll: false }, { poll: true }, { poll: false }]);
	});

	test("T-5 a server that answers every read idle + storedOmitted cannot make the hook spin", async () => {
		const stuck = {
			...generatingWithPrevious,
			...OMITTED,
			attempt: { status: "idle", startedAt: FIXTURE_NOW, errorCode: null },
		} as SessionSummaryView;
		let n = 0;
		client.getSessionSummary = (_id: string) => {
			gets.push(_id);
			if (++n > 40) throw new Error("spinning: more than 40 reads");
			return Promise.resolve(n === 1 ? generatingWithPrevious : stuck);
		};
		const m = await mount();
		await tick(SUMMARY_POLL_INTERVAL_MS);
		await tick(SUMMARY_POLL_INTERVAL_MS * 3);
		expect(gets.length).toBeLessThan(12);
		await m.h.unmount();
	});
});
