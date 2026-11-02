/**
 * After an outage the dashboard socket has given up (paused after three failures) and nothing reloads the
 * page any more, so the socket must start again by itself when the server is reachable. Driven through the
 * hook with a fake WebSocket; nothing here opens a connection.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { useConnectionStore } from "../stores/connection-store.js";
import { useReachabilityStore } from "../stores/reachability-store.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useWebSocket } from "./useWebSocket.js";

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
const saved = { WebSocket: g.WebSocket, location: g.location, setTimeout: globalThis.setTimeout };
/** The socket's 3 s reconnect timers started by a test: all cleared after it, so none fires into a later test. */
let reconnectTimers: Array<ReturnType<typeof setTimeout>> = [];

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => {
	reconnectTimers = [];
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		const handle = (saved.setTimeout as (...a: unknown[]) => ReturnType<typeof setTimeout>)(
			fn,
			ms,
			...rest,
		);
		if (ms === 3000) reconnectTimers.push(handle);
		return handle;
	}) as unknown as typeof setTimeout;
	FakeSocket.instances = [];
	g.WebSocket = FakeSocket;
	g.location = { protocol: "http:", host: "example.test" };
	useReachabilityStore.setState({ unreachable: false, attempt: 0, recoveries: 0 });
	useConnectionStore.setState({ wsState: "reconnecting" });
});
afterEach(() => {
	globalThis.setTimeout = saved.setTimeout;
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
});
