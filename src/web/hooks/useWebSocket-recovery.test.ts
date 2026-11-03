/**
 * After an outage the dashboard socket has given up (paused after three failures) and nothing reloads the
 * page any more, so the socket must start again by itself when the server is reachable. Driven through the
 * hook with a fake WebSocket; nothing here opens a connection.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { useConnectionStore } from "../stores/connection-store.js";
import { useReachabilityStore } from "../stores/reachability-store.js";
import {
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
	setDocumentHidden,
} from "../test-utils/render-hook.js";
import { PAUSED_RETRY_MS, useWebSocket } from "./useWebSocket.js";

class FakeSocket {
	static instances: FakeSocket[] = [];
	static readonly OPEN = 1;
	readyState = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	constructor(public url: string) {
		FakeSocket.instances.push(this);
	}
	send() {}
	close() {
		this.onclose?.();
	}
}

const g = globalThis as unknown as Record<string, unknown>;
const saved = {
	WebSocket: g.WebSocket,
	location: g.location,
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
};
/** The socket's 3 s reconnect timers started by a test: all cleared after it, so none fires into a later test. */
let reconnectTimers: Array<ReturnType<typeof setTimeout>> = [];
/** The same timers' callbacks, so a test can fire a 3 s reconnect without waiting for it. */
let reconnectCallbacks: Array<() => void> = [];
/** The paused socket's slow timers, cleared and fired the same way. */
let pausedCallbacks: Array<() => void> = [];
let pausedHandles: Array<ReturnType<typeof setTimeout>> = [];
let cleared: unknown[] = [];

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => {
	reconnectTimers = [];
	reconnectCallbacks = [];
	pausedCallbacks = [];
	pausedHandles = [];
	cleared = [];
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
		cleared.push(handle);
		saved.clearTimeout(handle);
	}) as typeof clearTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		const handle = (saved.setTimeout as (...a: unknown[]) => ReturnType<typeof setTimeout>)(
			fn,
			ms,
			...rest,
		);
		if (ms === 3000) {
			reconnectTimers.push(handle);
			reconnectCallbacks.push(fn);
		}
		if (ms === PAUSED_RETRY_MS) {
			reconnectTimers.push(handle);
			pausedCallbacks.push(fn);
			pausedHandles.push(handle);
		}
		return handle;
	}) as unknown as typeof setTimeout;
	FakeSocket.instances = [];
	g.WebSocket = FakeSocket;
	g.location = { protocol: "http:", host: "example.test" };
	useReachabilityStore.setState({ unreachable: false, attempt: 0, recoveries: 0 });
	useConnectionStore.setState({ wsState: "reconnecting" });
});
afterEach(() => {
	setDocumentHidden(false);
	globalThis.setTimeout = saved.setTimeout;
	globalThis.clearTimeout = saved.clearTimeout;
	for (const handle of reconnectTimers) clearTimeout(handle);
	g.WebSocket = saved.WebSocket;
	g.location = saved.location;
});

const recover = () =>
	act(async () => {
		useReachabilityStore.setState((s) => ({ recoveries: s.recoveries + 1 }));
	});

/** Three closes in a row with no open between them: the socket gives up. */
async function giveUp(socket: FakeSocket) {
	await act(async () => {
		socket.onclose?.();
		socket.onclose?.();
		socket.onclose?.();
	});
}

async function mount(enabled = true) {
	const h = renderHook((on: boolean) => useWebSocket(on), enabled);
	await h.render(enabled);
	await flush(2);
	return h;
}

describe("the socket after an outage", () => {
	test("a socket that gave up is started again when the server is reachable, with no reload", async () => {
		const h = await mount();
		expect(FakeSocket.instances).toHaveLength(1);
		await giveUp(FakeSocket.instances[0] as FakeSocket);
		expect(useConnectionStore.getState().wsState).toBe("paused");
		await recover();
		await flush(2);
		expect(FakeSocket.instances).toHaveLength(2);
		expect(useConnectionStore.getState().wsState).toBe("reconnecting");
		// and it has a fresh failure budget: it opens, and a failure after that is attempt one, not paused
		const reopened = FakeSocket.instances[1] as FakeSocket;
		await act(async () => reopened.onclose?.());
		expect(useConnectionStore.getState().wsState).toBe("reconnecting");
		await h.unmount();
	});

	test("two recoveries in a row start one socket, not two", async () => {
		const h = await mount();
		await giveUp(FakeSocket.instances[0] as FakeSocket);
		await recover();
		await recover();
		await flush(2);
		expect(FakeSocket.instances).toHaveLength(2);
		await h.unmount();
	});

	test("a socket that is open, or already waiting to reconnect, is left alone", async () => {
		const h = await mount();
		const first = FakeSocket.instances[0] as FakeSocket;
		await act(async () => {
			first.readyState = FakeSocket.OPEN;
			first.onopen?.();
		});
		expect(useConnectionStore.getState().wsState).toBe("connected");
		await recover();
		await flush(2);
		expect(FakeSocket.instances).toHaveLength(1);
		// one failure: the socket is waiting out its 3 s before trying again; a recovery doesn't add a second
		await act(async () => first.onclose?.());
		expect(useConnectionStore.getState().wsState).toBe("reconnecting");
		await recover();
		await flush(2);
		expect(FakeSocket.instances).toHaveLength(1);
		await h.unmount();
	});

	test("a viewer who may not use the app does not get a socket from a recovery", async () => {
		const h = await mount(false);
		expect(FakeSocket.instances).toHaveLength(0);
		useConnectionStore.setState({ wsState: "paused" });
		await recover();
		await flush(2);
		expect(FakeSocket.instances).toHaveLength(0);
		await h.unmount();
	});

	test("K1: a recovery that arrives while an attempt is pending is not lost: the budget starts over, still one socket at a time", async () => {
		const h = await mount();
		const fireNextReconnect = () =>
			act(async () => {
				const fire = reconnectCallbacks.shift();
				fire?.();
			});
		// two attempts fail, the third upgrade is pending
		await act(async () => FakeSocket.instances[0]?.onclose?.());
		await fireNextReconnect();
		await act(async () => FakeSocket.instances[1]?.onclose?.());
		await fireNextReconnect();
		expect(FakeSocket.instances).toHaveLength(3);
		expect(useConnectionStore.getState().wsState).toBe("reconnecting");
		// an HTTP probe succeeds meanwhile: the recovery is counted, no second socket is opened
		await recover();
		await flush(2);
		expect(FakeSocket.instances).toHaveLength(3);
		// the pending upgrade fails: it used to reach the threshold and pause for good
		await act(async () => FakeSocket.instances[2]?.onclose?.());
		expect(useConnectionStore.getState().wsState).toBe("reconnecting");
		expect(reconnectCallbacks.length).toBeGreaterThan(0);
		// one recovery bought one fresh budget of three; an upgrade that keeps failing still ends paused
		await fireNextReconnect();
		await act(async () => FakeSocket.instances[3]?.onclose?.());
		expect(useConnectionStore.getState().wsState).toBe("reconnecting");
		await fireNextReconnect();
		await act(async () => FakeSocket.instances[4]?.onclose?.());
		expect(useConnectionStore.getState().wsState).toBe("paused");
		expect(FakeSocket.instances).toHaveLength(5);
		await flush(2);
		expect(FakeSocket.instances, "paused: nothing retries before the slow timer").toHaveLength(5);
		await h.unmount();
	});
});

describe("a socket that gave up while HTTP stayed healthy (AGEN-86)", () => {
	const firePaused = () =>
		act(async () => {
			pausedCallbacks.shift()?.();
		});

	test("tries one upgrade on the slow timer, stays paused while it is pending, and goes live when it opens", async () => {
		const h = await mount();
		await giveUp(FakeSocket.instances[0] as FakeSocket);
		expect(FakeSocket.instances).toHaveLength(1);
		expect(pausedCallbacks).toHaveLength(1);
		await firePaused();
		expect(FakeSocket.instances).toHaveLength(2);
		expect(useConnectionStore.getState().wsState).toBe("paused");
		await act(async () => FakeSocket.instances[1]?.onopen?.());
		expect(useConnectionStore.getState().wsState).toBe("connected");
		expect(pausedCallbacks).toHaveLength(0);
		await h.unmount();
	});

	test("an attempt that fails goes back to waiting: no 3 s loop, one timer", async () => {
		const h = await mount();
		await giveUp(FakeSocket.instances[0] as FakeSocket);
		const fastTimers = reconnectCallbacks.length;
		await firePaused();
		await act(async () => FakeSocket.instances[1]?.onclose?.());
		expect(useConnectionStore.getState().wsState).toBe("paused");
		expect(reconnectCallbacks).toHaveLength(fastTimers);
		expect(pausedCallbacks).toHaveLength(1);
		await h.unmount();
	});

	test("a hidden tab and an outage skip their turn and keep the timer going", async () => {
		const h = await mount();
		await giveUp(FakeSocket.instances[0] as FakeSocket);
		setDocumentHidden(true);
		await firePaused();
		expect(FakeSocket.instances).toHaveLength(1);
		setDocumentHidden(false);
		useReachabilityStore.setState({ unreachable: true });
		await firePaused();
		expect(FakeSocket.instances).toHaveLength(1);
		useReachabilityStore.setState({ unreachable: false });
		await firePaused();
		expect(FakeSocket.instances).toHaveLength(2);
		await h.unmount();
	});

	test("a recovery while the timer waits replaces it: the old timer opens nothing more", async () => {
		const h = await mount();
		await giveUp(FakeSocket.instances[0] as FakeSocket);
		await recover();
		await flush(2);
		expect(FakeSocket.instances).toHaveLength(2);
		expect(cleared).toContain(pausedHandles[0]);
		await h.unmount();
	});

	test("a recovery during the slow attempt doesn't open a second socket", async () => {
		const h = await mount();
		await giveUp(FakeSocket.instances[0] as FakeSocket);
		await firePaused();
		expect(FakeSocket.instances).toHaveLength(2);
		await recover();
		await flush(2);
		expect(FakeSocket.instances).toHaveLength(2);
		// it failed with a fresh budget: the fast retry takes over
		await act(async () => FakeSocket.instances[1]?.onclose?.());
		expect(useConnectionStore.getState().wsState).toBe("reconnecting");
		await h.unmount();
	});

	test("a viewer signed out while paused has no timer left", async () => {
		const h = await mount();
		await giveUp(FakeSocket.instances[0] as FakeSocket);
		await h.render(false);
		await flush(2);
		expect(cleared).toContain(pausedHandles[0]);
		expect(FakeSocket.instances).toHaveLength(1);
		await h.unmount();
	});
});
