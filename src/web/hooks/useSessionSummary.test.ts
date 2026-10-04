import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import {
	SUMMARY_VIEW_FIXTURES as F,
	FIXTURE_NOW,
} from "../../shared/__fixtures__/session-summary-view/index.js";
import type { SessionSummaryView } from "../../shared/session-summary-view.js";
import { ApiError, type GenerateSummaryResult, api } from "../lib/api.js";
import { useAiStatusStore } from "../stores/ai-status-store.js";
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
	client.generateSessionSummary = () => {
		posts++;
		return Promise.resolve(result);
	};
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
	useAiStatusStore.setState({ status: null, loadState: "idle", error: null });
	useLabsStore.setState({ flags: null, registry: [], loading: false, error: null });
});
afterEach(async () => {
	for (const h of mounted.splice(0)) await h.unmount();
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

	test("TC-7.18a unmount clears the timer", async () => {
		script(F.generating);
		const m = await mount();
		expect(gets).toHaveLength(1);
		await m.h.unmount();
		mounted.length = 0;
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toHaveLength(1);
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

	test("TC-7.19 every terminal state stops polling", async () => {
		for (const name of [
			"ready",
			"failed",
			"interrupted",
			"too_little_activity",
			"no_provider",
			"failed_ai_inactive",
		] as const) {
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
		expect(m.v.load.status).toBe("error");
		const after = gets.length;
		await tick(SUMMARY_POLL_INTERVAL_MS * 5);
		expect(gets).toHaveLength(after);
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
});
