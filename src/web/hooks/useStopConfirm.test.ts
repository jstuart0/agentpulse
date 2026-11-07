import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import {
	deferred,
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../test-utils/render-hook.js";
import { type StopConfirm, useStopConfirm } from "./useStopConfirm.js";

beforeAll(installDomStubs);
afterAll(removeDomStubs);

async function mount() {
	const view = renderHook<null, StopConfirm>(() => useStopConfirm(), null);
	await view.render(null);
	return view;
}
type View = Awaited<ReturnType<typeof mount>>;
const state = (view: View) => view.current.value as StopConfirm;
const tap = (view: View) => act(async () => state(view).request());
const cancel = (view: View) => act(async () => state(view).cancel());
const confirm = (view: View, perform: () => Promise<string | null>) =>
	act(async () => {
		await state(view).confirm(perform);
	});

describe("Stop is a two-step action", () => {
	test("one tap opens the confirmation and sends nothing; only confirm runs the stop", async () => {
		const view = await mount();
		let sent = 0;
		const stop = async () => {
			sent += 1;
			return null;
		};
		await tap(view);
		expect(state(view).open).toBe(true);
		expect(sent).toBe(0);
		await confirm(view, stop);
		expect(sent).toBe(1);
		expect(state(view).open).toBe(false);
		await view.unmount();
	});

	test("cancel closes it without running anything", async () => {
		const view = await mount();
		await tap(view);
		await cancel(view);
		expect(state(view).open).toBe(false);
		await view.unmount();
	});

	test("a second confirm while the first is in flight runs nothing, and cancel is ignored until it ends", async () => {
		const view = await mount();
		await tap(view);
		const gate = deferred<string | null>();
		let sent = 0;
		const perform = () => {
			sent += 1;
			return gate.promise;
		};
		let first: Promise<void> = Promise.resolve();
		await act(async () => {
			first = state(view).confirm(perform);
		});
		expect(state(view).busy).toBe(true);
		await confirm(view, perform);
		await cancel(view);
		expect(sent).toBe(1);
		expect(state(view).open).toBe(true);
		await act(async () => {
			gate.resolve(null);
			await first;
		});
		await flush();
		expect(state(view).busy).toBe(false);
		expect(state(view).open).toBe(false);
		await view.unmount();
	});

	test("a failure keeps the dialog open with the reason, and a retry can run again", async () => {
		const view = await mount();
		await tap(view);
		const reason = "Studio is offline, so this session can't be controlled right now.";
		await confirm(view, async () => reason);
		expect(state(view).open).toBe(true);
		expect(state(view).error).toBe(reason);
		await confirm(view, async () => null);
		expect(state(view).open).toBe(false);
		expect(state(view).error).toBeNull();
		await view.unmount();
	});

	test("a throw from the request is shown, not lost", async () => {
		const view = await mount();
		await tap(view);
		await confirm(view, async () => {
			throw new Error("network down");
		});
		expect(state(view).error).toBe("network down");
		expect(state(view).open).toBe(true);
		await view.unmount();
	});

	test("opening it again clears the last attempt's reason", async () => {
		const view = await mount();
		await tap(view);
		await confirm(view, async () => "Couldn't stop the session.");
		await cancel(view);
		expect(state(view).error).toBeNull();
		await tap(view);
		expect(state(view).error).toBeNull();
		await view.unmount();
	});
});

describe("the dialog belongs to one session (Back with the dialog open)", () => {
	async function mountFor(initial: string) {
		const view = renderHook<{ key: string }, StopConfirm>((props) => useStopConfirm(props.key), {
			key: initial,
		});
		await view.render({ key: initial });
		return view;
	}
	const open = (view: Awaited<ReturnType<typeof mountFor>>) =>
		act(async () => (view.current.value as StopConfirm).request());
	const now = (view: Awaited<ReturnType<typeof mountFor>>) => view.current.value as StopConfirm;

	test("changing the session closes an open dialog and forgets its error", async () => {
		const view = await mountFor("a");
		await open(view);
		await act(async () => {
			await now(view).confirm(async () => "Studio is offline.");
		});
		expect(now(view).open).toBe(true);
		expect(now(view).error).toBe("Studio is offline.");
		await view.render({ key: "b" });
		await flush();
		expect(now(view).open).toBe(false);
		expect(now(view).error).toBeNull();
		await view.unmount();
	});

	test("positive control: the same session keeps its dialog across a re-render", async () => {
		const view = await mountFor("a");
		await open(view);
		await view.render({ key: "a" });
		await flush();
		expect(now(view).open).toBe(true);
		await view.unmount();
	});

	test("a stop still running for the old session neither reopens, errs nor blocks the new one", async () => {
		const view = await mountFor("a");
		await open(view);
		const gate = deferred<string | null>();
		let first: Promise<void> = Promise.resolve();
		await act(async () => {
			first = now(view).confirm(() => gate.promise);
		});
		expect(now(view).busy).toBe(true);
		await view.render({ key: "b" });
		await flush();
		expect(now(view).busy).toBe(false);
		await act(async () => {
			gate.resolve("Old session's failure");
			await first;
		});
		await flush();
		expect(now(view).error).toBeNull();
		expect(now(view).open).toBe(false);
		// The new session's own stop runs: the old one's lock is not held against it.
		await open(view);
		let sent = 0;
		await act(async () => {
			await now(view).confirm(async () => {
				sent += 1;
				return null;
			});
		});
		expect(sent).toBe(1);
		await view.unmount();
	});
});

describe("isCurrent and the abandoned dialog", () => {
	test("perform is told whether its session is still the one shown", async () => {
		const view = renderHook<{ key: string }, StopConfirm>((props) => useStopConfirm(props.key), {
			key: "a",
		});
		await view.render({ key: "a" });
		const gate = deferred<string | null>();
		const seen: boolean[] = [];
		let pending: Promise<void> = Promise.resolve();
		await act(async () => {
			(view.current.value as StopConfirm).request();
		});
		await act(async () => {
			pending = (view.current.value as StopConfirm).confirm(async (isCurrent) => {
				seen.push(isCurrent());
				const failure = await gate.promise;
				seen.push(isCurrent());
				return failure;
			});
		});
		await view.render({ key: "b" });
		await flush();
		await act(async () => {
			gate.resolve(null);
			await pending;
		});
		expect(seen).toEqual([true, false]);
		await view.unmount();
	});

	test("an open dialog closed by a change of session says so (focus has somewhere to go); a closed one doesn't", async () => {
		let abandoned = 0;
		const view = renderHook<{ key: string }, StopConfirm>(
			(props) =>
				useStopConfirm(props.key, () => {
					abandoned += 1;
				}),
			{ key: "a" },
		);
		await view.render({ key: "a" });
		await view.render({ key: "b" });
		await flush();
		expect(abandoned).toBe(0);
		await act(async () => {
			(view.current.value as StopConfirm).request();
		});
		await view.render({ key: "c" });
		await flush();
		expect(abandoned).toBe(1);
		await view.unmount();
	});
});
