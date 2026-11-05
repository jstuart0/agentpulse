import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ControlAction } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useResumeAttempt } from "./useResumeAttempt.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
afterEach(() => {
	client.getSessionControlActions = real.getSessionControlActions;
});

function resume(
	id: string,
	status: ControlAction["status"],
	over: Partial<ControlAction> = {},
	kind = "takeover",
): ControlAction {
	return {
		id,
		sessionId: "s1",
		actionType: "resume",
		status,
		error: null,
		metadata: { resumeKind: kind },
		createdAt: "2026-11-04T12:00:00.000Z",
		...over,
	} as ControlAction;
}

function setup(over: Record<string, unknown> = {}) {
	const spoken: string[] = [];
	let reloads = 0;
	const props = {
		sessionId: "s1",
		controlActions: [] as ControlAction[],
		hostName: "studio",
		reload: async () => {
			reloads++;
		},
		announce: (text: string) => void spoken.push(text),
		pollMs: 5,
		...over,
	};
	return { props, spoken, reloads: () => reloads };
}

describe("useResumeAttempt", () => {
	test("derives the attempt from the actions it is given", async () => {
		const { props } = setup({ controlActions: [resume("a", "running")] });
		const h = renderHook(useResumeAttempt, props);
		await h.render(props);
		expect(h.current.value?.attempt).toMatchObject({ state: "in_flight", actionId: "a" });
		await h.unmount();
	});

	test("while in flight it polls the actions and asks the page to reload when the action settles", async () => {
		let calls = 0;
		client.getSessionControlActions = async () => {
			calls++;
			return { controlActions: [resume("a", calls < 3 ? "running" : "succeeded")] };
		};
		const { props, reloads } = setup({ controlActions: [resume("a", "running")] });
		const h = renderHook(useResumeAttempt, props);
		await h.render(props);
		await flush(80);
		expect(calls).toBeGreaterThanOrEqual(3);
		expect(reloads()).toBeGreaterThanOrEqual(1);
		await h.unmount();
	});

	test("success announces once, and raises the focus token", async () => {
		client.getSessionControlActions = async () => ({ controlActions: [resume("a", "succeeded")] });
		const first = setup({ controlActions: [resume("a", "running")] });
		const h = renderHook(useResumeAttempt, first.props);
		await h.render(first.props);
		const before = h.current.value?.focusToken ?? 0;
		const done = { ...first.props, controlActions: [resume("a", "succeeded")] };
		await h.render(done);
		await h.render(done);
		expect(first.spoken).toEqual(["studio took over this session. You can send a prompt now."]);
		expect(h.current.value?.focusToken).toBe(before + 1);
		await h.unmount();
	});

	test("failure announces the host's sentence and does not raise the focus token", async () => {
		client.getSessionControlActions = async () => ({ controlActions: [] });
		const first = setup({ controlActions: [resume("a", "running")] });
		const h = renderHook(useResumeAttempt, first.props);
		await h.render(first.props);
		await h.render({
			...first.props,
			controlActions: [resume("a", "failed", { error: "studio restarted before it finished." })],
		});
		expect(first.spoken).toEqual(["studio restarted before it finished."]);
		expect(h.current.value?.focusToken).toBe(0);
		await h.unmount();
	});

	test("moving to another session announces nothing: the old attempt ending is not this session's news", async () => {
		client.getSessionControlActions = async () => ({ controlActions: [] });
		const first = setup({ controlActions: [resume("a", "running")] });
		const h = renderHook(useResumeAttempt, first.props);
		await h.render(first.props);
		await h.render({ ...first.props, sessionId: "s2", controlActions: [] });
		expect(first.spoken).toEqual([]);
		await h.unmount();
	});

	test("no attempt in flight means no polling", async () => {
		let calls = 0;
		client.getSessionControlActions = async () => {
			calls++;
			return { controlActions: [] };
		};
		const { props } = setup();
		const h = renderHook(useResumeAttempt, props);
		await h.render(props);
		await flush(40);
		expect(calls).toBe(0);
		await h.unmount();
	});
});
