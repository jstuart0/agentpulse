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
import { draftKey } from "../../lib/prompt-draft-keys.js";
import {
	SEND_ANSWER_TIMEOUT_MS,
	__resetPromptDraftsForTests,
	usePromptDraftStore,
} from "../../stores/prompt-draft-store.js";
import { useUserStore } from "../../stores/user-store.js";
import {
	deferred,
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../../test-utils/render-hook.js";
import { HOST_RESTARTED_PROMPT_COPY } from "./host-control-view.js";
import {
	COMPOSER_BUSY,
	COMPOSER_LATE_ACCEPT,
	COMPOSER_TIMEOUT_OUTCOME,
	COMPOSER_UNKNOWN_OUTCOME,
	FOLLOW_POLL_MS,
	boxState,
	composerMode,
	composerStatus,
} from "./prompt-composer-view.js";
import { type PromptComposerOptions, usePromptComposer } from "./usePromptComposer.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;

let fakeNow = 0;
let pollDelays: number[] = [];
let fastSendTimeout = false;
/** When set, the 30 s send timer is captured instead of run, so a test can fire it at the moment it chooses. */
let holdSendTimeout = false;
let heldTimeout: (() => void) | null = null;

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => {
	fakeNow = 5_000_000;
	__resetPromptDraftsForTests();
	pollDelays = [];
	fastSendTimeout = false;
	holdSendTimeout = false;
	heldTimeout = null;
	Date.now = () => fakeNow;
	// Only the poll's own 1.5 s wait is shortened (and moves the clock by what it was asked to wait).
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		if (ms === SEND_ANSWER_TIMEOUT_MS && holdSendTimeout) {
			heldTimeout = fn;
			return realSetTimeout(() => {}, 0);
		}
		if (ms === SEND_ANSWER_TIMEOUT_MS && fastSendTimeout) return realSetTimeout(fn, 0);
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
		mode: composerMode(s, { canPrompt: true, canResume: true }),
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
		expect(v.phase).toEqual({ step: "failed", reason: HOST_RESTARTED_PROMPT_COPY, startNew: true });
		const mode = t.options.mode;
		if (!mode) throw new Error("mode");
		const box = boxState(mode, v.phase, { posting: v.posting });
		expect(box).toMatchObject({
			alert: HOST_RESTARTED_PROMPT_COPY,
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

describe("a 202 on Claude headless (AGEN-117 T16: followed until the host has taken it)", () => {
	test("waits read-only through queued and the claim, then the host's acceptance clears the draft and stops the polling", async () => {
		client.sendSessionPrompt = async () => ({ action: action({ status: "queued" }) });
		let polls = 0;
		client.getSessionControlActions = async () => {
			polls += 1;
			return {
				controlActions: [
					polls < 2
						? action({ status: "queued" })
						: polls < 4
							? action({ status: "running" })
							: action({ status: "running", metadata: { acceptedAt: "2026-11-06 01:00:00" } }),
				],
			};
		};
		const s = session("claude_code", "headless", true);
		const t = mount({ s });
		await t.render();
		await t.type("long task");
		await t.send();
		await flush(30);
		const v = t.now();
		expect(v.prompt).toBe("");
		expect(v.phase).toEqual({ step: "idle" });
		expect(v.justSent).toBe(true);
		expect(polls).toBe(4);
		expect(t.calls.settled).toBe(1);
		// The turn runs for as long as it likes: nothing is watching it any more.
		fakeNow += 600_000;
		await flush(30);
		expect(polls).toBe(4);
		expect(t.now().phase).toEqual({ step: "idle" });
		await t.h.unmount();
	});

	test("while it is queued the box says Sending… and takes no second send", async () => {
		client.sendSessionPrompt = async () => ({ action: action({ status: "queued" }) });
		const hold = deferred<{ controlActions: ControlAction[] }>();
		client.getSessionControlActions = () => hold.promise;
		const s = session("claude_code", "headless");
		const t = mount({ s });
		await t.render();
		await t.type("one");
		await t.send();
		expect(t.now().phase).toEqual({ step: "following" });
		expect(boxState(t.options.mode as never, t.now().phase, { posting: false })).toMatchObject({
			readOnly: true,
			sendDisabled: true,
			buttonText: "Sending…",
		});
		hold.resolve({
			controlActions: [
				action({ status: "running", metadata: { acceptedAt: "2026-11-06 01:00:00" } }),
			],
		});
		await flush(30);
		expect(t.now().phase).toEqual({ step: "idle" });
		await t.h.unmount();
	});

	test("a refusal by the host keeps the text and says why, at the box", async () => {
		client.sendSessionPrompt = async () => ({ action: action({ status: "queued" }) });
		client.getSessionControlActions = async () => ({
			controlActions: [
				action({
					status: "failed",
					error:
						"Claude is still working on the last prompt, so nothing was sent. Try again when it finishes.",
				}),
			],
		});
		const s = session("claude_code", "headless", true);
		const t = mount({ s });
		await t.render();
		await t.type("keep me");
		await t.send();
		await flush(30);
		expect(t.now().prompt).toBe("keep me");
		expect(t.now().phase).toEqual({
			step: "failed",
			reason:
				"Claude is still working on the last prompt, so nothing was sent. Try again when it finishes.",
			startNew: false,
		});
		await t.h.unmount();
	});

	test("a host refusal that arrives after the claim keeps the draft: the claim was not acceptance", async () => {
		client.sendSessionPrompt = async () => ({ action: action({ status: "queued" }) });
		let polls = 0;
		client.getSessionControlActions = async () => {
			polls += 1;
			return {
				controlActions: [
					polls < 3
						? action({ status: "running" })
						: action({
								status: "failed",
								error: "This conversation is still open on this machine, so nothing was sent.",
							}),
				],
			};
		};
		const t = mount({ s: session("claude_code", "headless") });
		await t.render();
		await t.type("do not lose me");
		await t.send();
		await flush(30);
		expect(polls).toBe(3);
		expect(t.now().prompt).toBe("do not lose me");
		expect(t.now().phase).toMatchObject({
			step: "failed",
			reason: "This conversation is still open on this machine, so nothing was sent.",
		});
		await t.h.unmount();
	});

	test("a turn that succeeded before the first poll is accepted too", async () => {
		client.sendSessionPrompt = async () => ({ action: action({ status: "queued" }) });
		client.getSessionControlActions = async () => ({
			controlActions: [action({ status: "succeeded" })],
		});
		const t = mount({ s: session("claude_code", "headless") });
		await t.render();
		await t.type("quick");
		await t.send();
		await flush(30);
		expect(t.now().prompt).toBe("");
		await t.h.unmount();
	});

	test("a refusal of the POST itself is shown at the box with the text kept", async () => {
		client.sendSessionPrompt = async () => {
			throw new ApiError(409, "x", { error: "host_offline" });
		};
		const s = session("claude_code", "headless");
		const t = mount({ s });
		await t.render();
		await t.type("keep me");
		await t.send();
		expect(t.now().prompt).toBe("keep me");
		expect(t.now().phase.step).toBe("failed");
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

describe("a box that can't send", () => {
	test("a blocked mode sends nothing even if asked", async () => {
		let sends = 0;
		client.sendSessionPrompt = async () => {
			sends += 1;
			return { action: action() };
		};
		const s = session("codex_cli", "degraded");
		const t = mount({ s });
		await t.render();
		await t.type("draft kept while blocked");
		await t.send();
		expect(sends).toBe(0);
		expect(t.now().prompt).toBe("draft kept while blocked");
		expect(t.now().posting).toBe(false);
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
		// Still running when it answers: without the abort the follow would go on to poll again.
		pending.resolve({ controlActions: [action({ status: "running" })] });
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

describe("the draft belongs to the session and the viewer (AGEN-142)", () => {
	const other = () => session("codex_cli", "managed");
	const s2 = () => ({ ...other(), sessionId: "s2" }) as Session;
	const store = () => usePromptDraftStore.getState();
	const succeeded = () => Promise.resolve({ controlActions: [action({ status: "succeeded" })] });
	const running = () => Promise.resolve({ controlActions: [action({ status: "running" })] });

	test("(a) a switch away and back: A's text shows, and B's box is empty", async () => {
		const a = mount();
		await a.render();
		await a.type("text for A");
		await a.h.unmount();
		const sB = s2();
		const b = mount({
			s: sB,
			session: sB,
			mode: composerMode(sB, { canPrompt: true, canResume: true }),
		});
		await b.render();
		expect(b.now().prompt).toBe("");
		await b.h.unmount();
		const again = mount();
		await again.render();
		expect(again.now().prompt).toBe("text for A");
		await again.h.unmount();
	});

	test("(b) unmount during the POST, then a fresh mount: read-only 'Sending…', a second submit sends nothing, and the 202 is followed to a cleared box", async () => {
		const post = deferred<{ action: ControlAction }>();
		let sends = 0;
		client.sendSessionPrompt = () => {
			sends += 1;
			return post.promise;
		};
		client.getSessionControlActions = succeeded;
		const first = mount();
		await first.render();
		await first.type("one send only");
		await first.send();
		await first.h.unmount();

		const second = mount();
		await second.render();
		const v = second.now();
		expect(v.prompt).toBe("one send only");
		expect(v.sending).toBe(true);
		expect(v.phase).toEqual({ step: "following" });
		await second.send();
		expect(sends).toBe(1);

		post.resolve({ action: action() });
		await flush(30);
		expect(second.now().prompt).toBe("");
		expect(second.now().phase).toEqual({ step: "idle" });
		expect(second.now().sending).toBe(false);
		await second.h.unmount();
	});

	test("(c) unmount during the follow, then remount: the follow resumes on the same action and the draft stays cleared", async () => {
		client.sendSessionPrompt = async () => ({ action: action({ id: "act-77" }) });
		const asked: string[] = [];
		let answer = running;
		client.getSessionControlActions = () => {
			asked.push("poll");
			return answer();
		};
		const first = mount();
		await first.render();
		await first.type("keep going");
		await first.send();
		expect(first.now().phase).toEqual({ step: "following" });
		await first.h.unmount();
		expect(store().sending.s1?.actionId).toBe("act-77");

		answer = () =>
			Promise.resolve({ controlActions: [action({ id: "act-77", status: "succeeded" })] });
		const second = mount();
		await second.render();
		await flush(30);
		expect(asked.length).toBeGreaterThan(2); // the remounted box kept watching the same action
		expect(second.now().prompt).toBe("");
		expect(second.now().phase).toEqual({ step: "idle" });
		expect(store().drafts.s1).toBeUndefined();
		await second.h.unmount();
	});

	test("(d) a failed follow puts back the exact untrimmed text", async () => {
		client.sendSessionPrompt = async () => ({ action: action() });
		client.getSessionControlActions = () =>
			Promise.resolve({
				controlActions: [action({ status: "failed", error: "The host said no." })],
			});
		const t = mount();
		await t.render();
		await t.type("  keep my spaces\n");
		await t.send();
		await flush(30);
		expect(t.now().prompt).toBe("  keep my spaces\n");
		expect(t.now().phase).toMatchObject({ step: "failed" });
		await t.h.unmount();
	});

	test("(e) an unknown follow restores the text to the box once, and it isn't stored", async () => {
		client.sendSessionPrompt = async () => ({ action: action() });
		let polls = 0;
		client.getSessionControlActions = () => {
			polls += 1;
			return Promise.resolve({
				controlActions: [action({ status: "failed", error: CONTROL_TIMEOUT_ERROR })],
			});
		};
		const t = mount();
		await t.render();
		await t.type("maybe ran");
		await t.send();
		await flush(30);
		expect(polls).toBe(1);
		expect(t.now().prompt).toBe("maybe ran");
		expect(t.now().phase).toEqual({ step: "unknown" });
		expect(store().drafts.s1?.persist).toBe(false);
		await t.h.unmount();
	});

	test("(f) a viewer change mid-send: the other viewer's draft stays empty, nothing is written under their keys, and the first viewer's stored draft isn't cleared", async () => {
		const files = new Map<string, string>();
		const realStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;
		(globalThis as unknown as { localStorage: unknown }).localStorage = {
			getItem: (k: string) => files.get(k) ?? null,
			setItem: (k: string, v: string) => void files.set(k, v),
			removeItem: (k: string) => void files.delete(k),
			key: (i: number) => [...files.keys()][i] ?? null,
			get length() {
				return files.size;
			},
		};
		try {
			useUserStore.setState({ userId: "A", loaded: true, disableAuth: false } as never);
			const post = deferred<{ action: ControlAction }>();
			client.sendSessionPrompt = () => post.promise;
			client.getSessionControlActions = succeeded;
			const t = mount();
			await t.render();
			await t.type("A's prompt");
			store().flush();
			await t.send();
			useUserStore.setState({ userId: "B" } as never);
			post.resolve({ action: action() });
			await flush(30);
			expect(store().drafts.s1).toBeUndefined();
			expect(store().sending.s1).toBeUndefined();
			expect([...files.keys()].some((k) => k.includes("u:B"))).toBe(false);
			expect(files.has(draftKey("u:A", "s1"))).toBe(true);
			await t.h.unmount();
		} finally {
			useUserStore.setState({ userId: null, loaded: false } as never);
			(globalThis as unknown as { localStorage?: unknown }).localStorage = realStorage;
		}
	});

	test("(g) a refused POST keeps the draft and removes the marker", async () => {
		client.sendSessionPrompt = async () => {
			throw new ApiError(409, "x", { error: "managed_state_not_continuable" });
		};
		const t = mount();
		await t.render();
		await t.type("keep me");
		await t.send();
		expect(t.now().prompt).toBe("keep me");
		expect(t.now().sending).toBe(false);
		expect(store().sending.s1).toBeUndefined();
		await t.h.unmount();
	});

	test("(h) Discard then a new send: Undo during the send does nothing, and the box ends empty with nothing stored", async () => {
		const post = deferred<{ action: ControlAction }>();
		client.sendSessionPrompt = () => post.promise;
		client.getSessionControlActions = succeeded;
		const t = mount();
		await t.render();
		await t.type("old text");
		await act(async () => t.now().discard());
		expect(t.now().prompt).toBe("");
		const removed = { text: "old text", savedAt: 1, restored: false, persist: true };
		await t.type("new text");
		await t.send();
		expect(t.now().sending).toBe(true);
		expect(store().undoDiscard("s1", removed)).toBe(false);
		await act(async () => t.now().discard()); // Discard during a send does nothing either
		expect(t.now().prompt).toBe("new text");
		post.resolve({ action: action() });
		await flush(30);
		expect(t.now().prompt).toBe("");
		expect(store().drafts.s1).toBeUndefined();
		await t.h.unmount();
	});

	test("(i) a POST that never answers: after the timeout the text is back, unsaved, with the may-have-run copy, and a late 202 clears only an unedited draft and follows nothing", async () => {
		fastSendTimeout = true;
		const post = deferred<{ action: ControlAction }>();
		client.sendSessionPrompt = () => post.promise;
		let polls = 0;
		client.getSessionControlActions = () => {
			polls += 1;
			return succeeded();
		};
		const t = mount();
		await t.render();
		await t.type("lost answer");
		await t.send();
		await flush(30);
		expect(store().sending.s1).toBeUndefined();
		expect(t.now().prompt).toBe("lost answer");
		expect(t.now().phase).toEqual({ step: "unknown", timeout: true });
		expect(store().drafts.s1?.persist).toBe(false);
		const mode = t.options.mode;
		if (!mode) throw new Error("mode");
		expect(boxState(mode, t.now().phase, { posting: false }).alert).toBe(COMPOSER_TIMEOUT_OUTCOME);

		post.resolve({ action: action() });
		await flush(30);
		expect(t.now().prompt).toBe(""); // not edited: the late 202 means it was sent
		expect(t.now().phase).toEqual({ step: "accepted" }); // no stale "your text is back" over an empty box
		expect(composerStatus(mode, t.now().phase, false)?.text).toBe(COMPOSER_LATE_ACCEPT);
		expect(polls).toBe(0);
		await t.h.unmount();
	});

	test("(i, edited) a late 202 keeps text the person typed after the timeout", async () => {
		fastSendTimeout = true;
		const post = deferred<{ action: ControlAction }>();
		client.sendSessionPrompt = () => post.promise;
		client.getSessionControlActions = succeeded;
		const t = mount();
		await t.render();
		await t.type("lost answer");
		await t.send();
		await flush(30);
		await t.type("lost answer, and more");
		post.resolve({ action: action() });
		await flush(30);
		expect(t.now().prompt).toBe("lost answer, and more");
		await t.h.unmount();
	});
});

describe("how a send ended survives a box that was unmounted when it ended (AGEN-142)", () => {
	const store = () => usePromptDraftStore.getState();

	/** Sends from a first box, unmounts it before the POST answers, and mounts a second one. */
	async function sendThenRemount(post: ReturnType<typeof deferred<{ action: ControlAction }>>) {
		holdSendTimeout = true;
		client.sendSessionPrompt = () => post.promise;
		client.getSessionControlActions = () =>
			Promise.resolve({ controlActions: [action({ status: "succeeded" })] });
		const first = mount();
		await first.render();
		await first.type("remount me");
		await first.send();
		await first.h.unmount();
		const second = mount();
		await second.render();
		expect(second.now().sending).toBe(true);
		return second;
	}

	test("a timeout after the remount: the new box has its text back and the 'may have been sent' warning", async () => {
		const second = await sendThenRemount(deferred());
		await act(async () => heldTimeout?.());
		const v = second.now();
		expect(v.sending).toBe(false);
		expect(v.prompt).toBe("remount me");
		expect(v.phase).toEqual({ step: "unknown", timeout: true });
		const mode = second.options.mode;
		if (!mode) throw new Error("mode");
		expect(boxState(mode, v.phase, { posting: false }).alert).toBe(COMPOSER_TIMEOUT_OUTCOME);
		await second.h.unmount();
	});

	test("a refusal after the remount: the new box shows why, and keeps the text", async () => {
		const post = deferred<{ action: ControlAction }>();
		const second = await sendThenRemount(post);
		await act(async () => {
			post.reject(new ApiError(409, "x", { error: "host_offline" }));
			await Promise.resolve();
		});
		await flush(30);
		const v = second.now();
		expect(v.sending).toBe(false);
		expect(v.prompt).toBe("remount me");
		expect(v.phase.step).toBe("failed");
		expect((v.phase as { reason: string }).reason.length).toBeGreaterThan(0);
		await second.h.unmount();
	});

	test("a late 202 after a timeout and a remount: the draft is cleared and the box says the host took it", async () => {
		const post = deferred<{ action: ControlAction }>();
		const second = await sendThenRemount(post);
		await act(async () => heldTimeout?.());
		expect(second.now().phase).toEqual({ step: "unknown", timeout: true });
		post.resolve({ action: action() });
		await flush(30);
		expect(second.now().prompt).toBe("");
		expect(second.now().phase).toEqual({ step: "accepted" });
		await second.h.unmount();
	});

	test("typing clears the note", async () => {
		const second = await sendThenRemount(deferred());
		await act(async () => heldTimeout?.());
		await second.type("something else");
		expect(second.now().phase).toEqual({ step: "idle" });
		expect(store().outcomes.s1).toBeUndefined();
		await second.h.unmount();
	});

	test("after a timeout, Send works again while the hung POST is still out (it no longer holds the box)", async () => {
		holdSendTimeout = true;
		const hung = deferred<{ action: ControlAction }>();
		let sends = 0;
		client.sendSessionPrompt = () => {
			sends += 1;
			return sends === 1 ? hung.promise : Promise.resolve({ action: action({ id: "act-2" }) });
		};
		client.getSessionControlActions = () =>
			Promise.resolve({ controlActions: [action({ id: "act-2", status: "succeeded" })] });
		const t = mount();
		await t.render();
		await t.type("try twice");
		await t.send();
		await act(async () => heldTimeout?.());
		expect(t.now().posting).toBe(false);
		await t.send();
		expect(sends).toBe(2);
		await flush(30);
		expect(t.now().prompt).toBe("");
		await t.h.unmount();
	});
});
