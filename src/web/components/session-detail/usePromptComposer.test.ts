/**
 * The prompt box's wiring, through the real hook on the render-hook harness (TESTING.md): the api client's
 * `sendSessionPrompt` and `getSessionControlActions` are replaced, nothing else is. The 1.5 s poll sleep
 * and `Date.now` are the real wiring; the tests replace only the timer underneath, so a no-op sleep or a
 * stuck clock in the hook still fails.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { CONTROL_TIMEOUT_ERROR } from "../../../shared/managed-messages.js";
import type { ControlAction, Session } from "../../../shared/types.js";
import { ApiError, api } from "../../lib/api.js";
import {
	deferred,
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../../test-utils/render-hook.js";
import {
	COMPOSER_BLOCKED_RESTARTED,
	COMPOSER_BUSY,
	COMPOSER_UNKNOWN_OUTCOME,
	FOLLOW_POLL_MS,
	boxState,
	composerMode,
} from "./prompt-composer-view.js";
import { type PromptComposerOptions, usePromptComposer } from "./usePromptComposer.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;

let fakeNow = 0;
let pollDelays: number[] = [];

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => {
	fakeNow = 5_000_000;
	pollDelays = [];
	Date.now = () => fakeNow;
	// Only the poll's own 1.5 s wait is shortened (and moves the clock by what it was asked to wait).
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		if (ms === FOLLOW_POLL_MS) {
			pollDelays.push(ms);
			fakeNow += ms;
			return realSetTimeout(fn, 0);
		}
		return realSetTimeout(fn, ms, ...rest);
	}) as typeof setTimeout;
});
afterEach(() => {
	Date.now = realNow;
	globalThis.setTimeout = realSetTimeout;
	Object.assign(api, real);
});

function session(agentType: "codex_cli" | "claude_code", state: string, isWorking = false) {
	return {
		sessionId: "s1",
		agentType,
		isWorking,
		metadata: {},
		managedSession: { managedState: state, hostName: "studio", providerSyncError: null },
	} as unknown as Session;
}
const action = (over: Partial<ControlAction> = {}) =>
	({ id: "act-1", sessionId: "s1", status: "running", error: null, ...over }) as ControlAction;

function mount(over: Partial<PromptComposerOptions> & { s?: Session } = {}) {
	const s = over.s ?? session("codex_cli", "managed");
	const calls = { submitted: 0, settled: 0 };
	const options: PromptComposerOptions = {
		session: s,
		mode: composerMode(s, { canPrompt: true }),
		onSubmitted: async () => {
			calls.submitted += 1;
		},
		onSettled: () => {
			calls.settled += 1;
		},
		...over,
	};
	const h = renderHook((o: PromptComposerOptions) => usePromptComposer(o), options);
	const now = () => {
		const value = h.current.value;
		if (!value) throw new Error("not rendered");
		return value;
	};
	return {
		h,
		calls,
		options,
		now,
		render: (next: PromptComposerOptions = options) => h.render(next),
		async type(text: string) {
			await act(async () => now().edit(text));
		},
		async send() {
			await act(async () => {
				void now().submit();
			});
			await flush();
		},
	};
}

describe("a refused send (409)", () => {
	test("keeps the text, shows the reason, sends once, and never polls", async () => {
		let sends = 0;
		let polls = 0;
		client.sendSessionPrompt = async () => {
			sends += 1;
			throw new ApiError(409, "x", { error: "managed_state_not_continuable" });
		};
		client.getSessionControlActions = async () => {
			polls += 1;
			return { controlActions: [] };
		};
		const t = mount();
		await t.render();
		await t.type("do the thing");
		await t.send();
		const v = t.now();
		expect(sends).toBe(1);
		expect(polls).toBe(0);
		expect(v.prompt).toBe("do the thing");
		expect(v.phase).toEqual({ step: "failed", reason: COMPOSER_BLOCKED_RESTARTED, startNew: true });
		const mode = t.options.mode;
		if (!mode) throw new Error("mode");
		const box = boxState(mode, v.phase, { posting: v.posting });
		expect(box).toMatchObject({
			alert: COMPOSER_BLOCKED_RESTARTED,
			readOnly: false,
			sendDisabled: false,
			buttonText: "Send prompt",
			startNew: true,
		});
		await t.h.unmount();
	});

	test("the lock being held shows its own sentence", async () => {
		client.sendSessionPrompt = async () => {
			throw new ApiError(400, "Another control action is already in progress for this session.", {
				error: "Another control action is already in progress for this session.",
				reason: "control_busy",
			});
		};
		const t = mount();
		await t.render();
		await t.type("go");
		await t.send();
		expect(t.now().phase).toEqual({ step: "failed", reason: COMPOSER_BUSY, startNew: false });
		expect(t.now().prompt).toBe("go");
		await t.h.unmount();
	});
});

describe("a 202 on Codex", () => {
	test("goes read-only 'Sending…', polls the action it was given with a quiet request, and clears on succeeded", async () => {
		const sent: Array<[string, string]> = [];
		client.sendSessionPrompt = async (id: string, text: string) => {
			sent.push([id, text]);
			return { action: action() };
		};
		const first = deferred<{ controlActions: ControlAction[] }>();
		const received: unknown[][] = [];
		client.getSessionControlActions = (...args: unknown[]) => {
			received.push(args);
			return received.length === 1
				? first.promise
				: Promise.resolve({ controlActions: [action({ status: "succeeded" })] });
		};
		const t = mount();
		await t.render();
		await t.type("  next step  ");
		await t.send();

		expect(sent).toEqual([["s1", "next step"]]);
		const mode = t.options.mode;
		if (!mode) throw new Error("mode");
		const during = boxState(mode, t.now().phase, { posting: t.now().posting });
		expect(during).toMatchObject({ readOnly: true, sendDisabled: true, buttonText: "Sending…" });
		expect(t.now().prompt).toBe("  next step  ");
		expect(received[0]).toEqual(["s1", { background: true }]);

		first.resolve({ controlActions: [action({ status: "running" })] });
		await flush(30);
		const v = t.now();
		expect(received.length).toBeGreaterThanOrEqual(2);
		expect(
			received.every((args) => args[0] === "s1" && (args[1] as { background: boolean }).background),
		).toBe(true);
		expect(v.prompt).toBe("");
		expect(v.phase).toEqual({ step: "idle" });
		expect(v.justSent).toBe(true);
		expect(t.calls.settled).toBe(1);
		expect(t.calls.submitted).toBe(2);
		expect(pollDelays).toEqual([FOLLOW_POLL_MS]);
		await t.h.unmount();
	});

	test("a second click while it is following sends nothing", async () => {
		let sends = 0;
		client.sendSessionPrompt = async () => {
			sends += 1;
			return { action: action() };
		};
		const hold = deferred<{ controlActions: ControlAction[] }>();
		client.getSessionControlActions = () => hold.promise;
		const t = mount();
		await t.render();
		await t.type("once");
		await t.send();
		await t.send();
		await t.send();
		expect(sends).toBe(1);
		hold.resolve({ controlActions: [action({ status: "succeeded" })] });
		await flush(30);
		await t.h.unmount();
	});
});

describe("a 202 on Claude headless", () => {
	test("clears at once, never polls, and shows no alert, notice or status", async () => {
		client.sendSessionPrompt = async () => ({ action: action() });
		let polls = 0;
		client.getSessionControlActions = async () => {
			polls += 1;
			return { controlActions: [] };
		};
		const s = session("claude_code", "headless", true);
		const t = mount({ s });
		await t.render();
		await t.type("long task");
		await t.send();
		const v = t.now();
		expect(v.prompt).toBe("");
		expect(v.phase).toEqual({ step: "idle" });
		expect(v.justSent).toBe(false);
		expect(polls).toBe(0);
		expect(t.calls.settled).toBe(0);
		// Past the 90 s lock nothing changes, because nothing is watching.
		fakeNow += 120_000;
		await flush(30);
		expect(t.now().phase).toEqual({ step: "idle" });
		expect(polls).toBe(0);
		await t.h.unmount();
	});

	test("a refusal is a toast, as before, with the text kept and no inline alert", async () => {
		client.sendSessionPrompt = async () => {
			throw new ApiError(409, "x", { error: "host_offline" });
		};
		const s = session("claude_code", "headless");
		const t = mount({ s });
		await t.render();
		await t.type("keep me");
		await t.send();
		expect(t.now().prompt).toBe("keep me");
		expect(t.now().phase).toEqual({ step: "idle" });
		await t.h.unmount();
	});
});

describe("how a followed send ends", () => {
	test("failed restores the text with the host's reason, and typing clears the alert", async () => {
		client.sendSessionPrompt = async () => ({ action: action() });
		client.getSessionControlActions = async () => ({
			controlActions: [action({ status: "failed", error: "Codex hasn't ended its current turn." })],
		});
		const t = mount();
		await t.render();
		await t.type("retry me");
		await t.send();
		await flush(30);
		expect(t.now().prompt).toBe("retry me");
		expect(t.now().phase).toEqual({
			step: "failed",
			reason: "Codex hasn't ended its current turn.",
			startNew: false,
		});
		expect(t.calls.settled).toBe(1);
		await t.type("retry me now");
		expect(t.now().phase).toEqual({ step: "idle" });
		await t.h.unmount();
	});

	test("a failure is dropped when the turn it was about ends", async () => {
		client.sendSessionPrompt = async () => ({ action: action() });
		client.getSessionControlActions = async () => ({
			controlActions: [action({ status: "failed", error: "Codex hasn't ended its current turn." })],
		});
		const working = session("codex_cli", "managed", true);
		const t = mount({ s: working });
		await t.render();
		await t.type("x");
		await t.send();
		await flush(30);
		expect(t.now().phase.step).toBe("failed");
		await t.render({ ...t.options, session: session("codex_cli", "managed", true) });
		expect(t.now().phase.step).toBe("failed");
		await t.render({ ...t.options, session: session("codex_cli", "managed", false) });
		expect(t.now().phase).toEqual({ step: "idle" });
		await t.h.unmount();
	});

	test("an action that never settles ends as unknown at the 100 s mark, on the real timer and clock", async () => {
		client.sendSessionPrompt = async () => ({ action: action() });
		let polls = 0;
		client.getSessionControlActions = async () => {
			polls += 1;
			// A stuck clock or a missing wait would keep polling; the cap turns that into a wrong answer, not a hang.
			return {
				controlActions: [action({ status: polls > 300 ? "succeeded" : "running" })],
			};
		};
		const t = mount();
		await t.render();
		await t.type("slow one");
		await t.send();
		for (let i = 0; i < 40 && t.now().phase.step === "following"; i += 1) await flush(50);
		expect(t.now().phase).toEqual({ step: "unknown" });
		expect(t.now().prompt).toBe("slow one");
		expect(polls).toBeGreaterThanOrEqual(60);
		expect(polls).toBeLessThanOrEqual(75);
		expect(pollDelays.length).toBe(polls - 1);
		expect(pollDelays.every((ms) => ms === 1500)).toBe(true);
		const mode = t.options.mode;
		if (!mode) throw new Error("mode");
		expect(boxState(mode, t.now().phase, { posting: false }).alert).toBe(COMPOSER_UNKNOWN_OUTCOME);
		await t.h.unmount();
	});

	test("an action whose lock ran out reads as unknown, not failed", async () => {
		client.sendSessionPrompt = async () => ({ action: action() });
		client.getSessionControlActions = async () => ({
			controlActions: [action({ status: "failed", error: CONTROL_TIMEOUT_ERROR })],
		});
		const t = mount();
		await t.render();
		await t.type("maybe ran");
		await t.send();
		await flush(30);
		expect(t.now().phase).toEqual({ step: "unknown" });
		await t.h.unmount();
	});
});

describe("leaving the page", () => {
	test("unmounting mid-follow stops the polling and applies nothing when the poll comes back", async () => {
		client.sendSessionPrompt = async () => ({ action: action() });
		let polls = 0;
		const pending = deferred<{ controlActions: ControlAction[] }>();
		client.getSessionControlActions = () => {
			polls += 1;
			return pending.promise;
		};
		const t = mount();
		await t.render();
		await t.type("bye");
		await t.send();
		expect(polls).toBe(1);
		await t.h.unmount();
		pending.resolve({ controlActions: [action({ status: "succeeded" })] });
		await flush(30);
		expect(polls).toBe(1);
		expect(t.calls.settled).toBe(0);
		expect(t.calls.submitted).toBe(1);
	});

	test("unmounting while the POST is in flight starts no follow", async () => {
		const post = deferred<{ action: ControlAction }>();
		client.sendSessionPrompt = () => post.promise;
		let polls = 0;
		client.getSessionControlActions = async () => {
			polls += 1;
			return { controlActions: [action({ status: "succeeded" })] };
		};
		const t = mount();
		await t.render();
		await t.type("late");
		await t.send();
		await t.h.unmount();
		post.resolve({ action: action() });
		await flush(30);
		expect(polls).toBe(0);
		expect(t.calls.settled).toBe(0);
		expect(t.calls.submitted).toBe(0);
	});
});
