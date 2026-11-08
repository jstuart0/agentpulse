import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ControlAction } from "../../shared/types.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { type StopFollowOptions, useStopFollow, useStopTurnFollow } from "./useStopFollow.js";

beforeAll(installDomStubs);
afterAll(removeDomStubs);

const session = { agentType: "claude_code", managedSession: { hostName: "studio" } } as never;

function stop(status: ControlAction["status"], error: string | null = null): ControlAction {
	return {
		id: "a1",
		sessionId: "s1",
		actionType: "stop",
		status,
		error,
		metadata: null,
		createdAt: "2026-11-05T10:00:00.000Z",
	} as ControlAction;
}

function setup(over: Partial<StopFollowOptions> = {}) {
	const spoken: string[] = [];
	let reloads = 0;
	const props: StopFollowOptions = {
		sessionId: "s1",
		session,
		controlActions: [],
		reload: async () => {
			reloads += 1;
		},
		announce: (text) => void spoken.push(text),
		pollMs: 5,
		...over,
	};
	return { props, spoken, reloads: () => reloads };
}

const mount = async (props: StopFollowOptions) => {
	const view = renderHook(useStopFollow, props);
	await view.render(props);
	return view;
};

describe("useStopFollow", () => {
	test("while a stop is queued or running it refreshes the session on its own timer", async () => {
		const { props, reloads } = setup({ controlActions: [stop("running")] });
		const view = await mount(props);
		expect(view.current.value?.stopping).toBe(true);
		await flush(60);
		expect(reloads()).toBeGreaterThanOrEqual(3);
		await view.unmount();
	});

	test("with no stop in flight it never polls", async () => {
		const { props, reloads } = setup({ controlActions: [stop("succeeded")] });
		const view = await mount(props);
		await flush(40);
		expect(reloads()).toBe(0);
		expect(view.current.value?.stopping).toBe(false);
		await view.unmount();
	});

	test("a refresh that rejects is swallowed", async () => {
		const { props } = setup({
			controlActions: [stop("queued")],
			reload: async () => {
				throw new Error("network");
			},
		});
		const view = await mount(props);
		await flush(30);
		expect(view.current.value?.stopping).toBe(true);
		await view.unmount();
	});

	test("a stop that was in flight and failed is spoken once, with the host's cleaned words", async () => {
		const { props, spoken } = setup({ controlActions: [stop("running")] });
		const view = await mount(props);
		const failed = {
			...props,
			controlActions: [stop("failed", "A command on this machine is still finishing.")],
		};
		await view.render(failed);
		expect(view.current.value).toEqual({
			stopping: false,
			failure: "A command on this machine is still finishing.",
		});
		expect(spoken).toEqual(["A command on this machine is still finishing."]);
		await view.render({ ...failed });
		await flush(20);
		expect(spoken).toHaveLength(1);
		await view.unmount();
	});

	test("a failed stop already on the page when it opens is shown but not announced", async () => {
		const { props, spoken } = setup({ controlActions: [stop("failed", "Nope.")] });
		const view = await mount(props);
		expect(view.current.value?.failure).toBe("Nope.");
		expect(spoken).toEqual([]);
		await view.unmount();
	});

	test("a stop that succeeds is announced once as 'Stopped.', not as a failure, and leaves no failure", async () => {
		const { props, spoken } = setup({ controlActions: [stop("running")] });
		const view = await mount(props);
		const done = { ...props, controlActions: [stop("succeeded")] };
		await view.render(done);
		expect(spoken).toEqual(["Stopped."]);
		expect(view.current.value?.failure).toBeNull();
		await view.render({ ...done });
		await flush(20);
		expect(spoken).toEqual(["Stopped."]);
		await view.unmount();
	});

	test("a succeeded stop already on the page when it opens says nothing", async () => {
		const { props, spoken } = setup({ controlActions: [stop("succeeded")] });
		const view = await mount(props);
		expect(spoken).toEqual([]);
		await view.unmount();
	});

	test("a failure that is stale because the session ended is neither shown nor spoken", async () => {
		const ended = {
			agentType: "claude_code",
			endedAt: "2099-01-01T00:00:00.000Z",
			managedSession: {
				hostName: "studio",
				managedState: "headless",
				updatedAt: "2020-01-01T00:00:00.000Z",
			},
		} as never;
		const { props, spoken } = setup({ controlActions: [stop("running")], session: ended });
		const view = await mount(props);
		await view.render({ ...props, controlActions: [stop("failed", "Nope.")] });
		expect(view.current.value?.failure).toBeNull();
		expect(spoken).toEqual([]);
		await view.unmount();
	});

	test("an outcome that arrives with a change of session is not announced", async () => {
		const { props, spoken } = setup({ controlActions: [stop("running")] });
		const view = await mount(props);
		await view.render({ ...props, sessionId: "s2", controlActions: [stop("failed", "Nope.")] });
		expect(spoken).toEqual([]);
		await view.unmount();
	});
});

function interrupt(
	status: ControlAction["status"],
	error: string | null = null,
	metadata: Record<string, unknown> | null = null,
): ControlAction {
	return {
		id: "i1",
		sessionId: "s1",
		actionType: "interrupt",
		status,
		error,
		metadata,
		createdAt: "2026-11-08T10:00:00.000Z",
	} as ControlAction;
}

describe("useStopTurnFollow (AGEN-119)", () => {
	const mountTurn = async (props: StopFollowOptions) => {
		const view = renderHook(useStopTurnFollow, props);
		await view.render(props);
		return view;
	};

	test("while a Stop turn is queued or running it refreshes on its own timer; a Stop is not followed by it", async () => {
		const { props, reloads } = setup({ controlActions: [interrupt("running")] });
		const view = await mountTurn(props);
		expect(view.current.value?.stoppingTurn).toBe(true);
		await flush(60);
		expect(reloads()).toBeGreaterThanOrEqual(3);
		await view.unmount();

		const other = setup({ controlActions: [stop("running")] });
		const quiet = await mountTurn(other.props);
		expect(quiet.current.value?.stoppingTurn).toBe(false);
		await flush(40);
		expect(other.reloads()).toBe(0);
		await quiet.unmount();
	});

	test("success is announced once as 'Turn stopped. You can send a prompt.' and counted, for focus", async () => {
		const { props, spoken } = setup({ controlActions: [interrupt("running")] });
		const view = await mountTurn(props);
		const done = {
			...props,
			controlActions: [interrupt("succeeded", null, { interrupted: true })],
		};
		await view.render(done);
		await flush(10);
		expect(spoken).toEqual(["Turn stopped. You can send a prompt."]);
		expect(view.current.value?.succeeded).toBe(1);
		expect(view.current.value?.failure).toBeNull();
		await view.render({ ...done });
		await flush(20);
		expect(spoken).toHaveLength(1);
		await view.unmount();
	});

	test("failure is announced once with the host's words, stays as the standing failure, and does not move focus", async () => {
		const { props, spoken } = setup({ controlActions: [interrupt("running")] });
		const view = await mountTurn(props);
		await view.render({
			...props,
			controlActions: [
				interrupt(
					"failed",
					"Claude didn't stop within 30 seconds and is still working. Try again, or end the session.",
				),
			],
		});
		await flush(10);
		expect(spoken).toEqual([
			"Claude didn't stop within 30 seconds and is still working. Try again, or end the session.",
		]);
		expect(view.current.value?.failure).toContain("30 seconds");
		expect(view.current.value?.succeeded).toBe(0);
		await view.unmount();
	});

	test("a turn that had already finished is said plainly, and an 'already ended' failure stays quiet", async () => {
		const natural = setup({ controlActions: [interrupt("running")] });
		const a = await mountTurn(natural.props);
		await a.render({
			...natural.props,
			controlActions: [interrupt("succeeded", null, { interrupted: false })],
		});
		await flush(10);
		expect(natural.spoken).toEqual(["Claude had already finished the turn."]);
		await a.unmount();

		const ended = setup({ controlActions: [interrupt("running")] });
		const b = await mountTurn(ended.props);
		await b.render({
			...ended.props,
			controlActions: [interrupt("failed", "The turn had already ended.")],
		});
		await flush(10);
		expect(ended.spoken).toEqual([]);
		expect(b.current.value?.failure).toBeNull();
		await b.unmount();
	});

	test("an outcome that arrives with a change of session is not announced", async () => {
		const { props, spoken } = setup({ controlActions: [interrupt("running")] });
		const view = await mountTurn(props);
		await view.render({
			...props,
			sessionId: "s2",
			controlActions: [interrupt("failed", "Nope.")],
		});
		expect(spoken).toEqual([]);
		await view.unmount();
	});
});
