/**
 * Restored tabs are asked about once per adoption: only a tab whose session the server says is gone is
 * closed, and a single toast says so.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError, api } from "../lib/api.js";
import { useSessionStore } from "../stores/session-store.js";
import { useTabsStore } from "../stores/tabs-store.js";
import { useUserStore } from "../stores/user-store.js";
import {
	deferred,
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../test-utils/render-hook.js";

const toasts: string[] = [];
// Module mocks last for the whole test process, so keep every other export of sonner (and toast's methods) real.
const realSonner = await import("sonner");
mock.module("sonner", () => ({
	...realSonner,
	toast: Object.assign((m: string) => void toasts.push(m), realSonner.toast),
}));
const { useRestoredTabsCheck } = await import("./useRestoredTabsCheck.js");

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const files = new Map<string, string>();
const realStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;

const tab = (sessionId: string) => ({
	sessionId,
	displayName: sessionId,
	agentType: "claude_code" as const,
	managedState: null,
});
const goneError = () => new ApiError(404, "Session not found", { error: "Session not found" });
const open = () => useTabsStore.getState().tabs.map((t) => t.sessionId);

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => {
	files.clear();
	toasts.length = 0;
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (key: string) => files.get(key) ?? null,
		setItem: (key: string, value: string) => void files.set(key, value),
		removeItem: (key: string) => void files.delete(key),
	};
	useUserStore.setState({ userId: null, mode: "team", loaded: false } as never);
	useSessionStore.setState({ sessions: [] } as never);
});
afterEach(() => {
	client.getSessionName = real.getSessionName;
	(globalThis as unknown as { localStorage?: unknown }).localStorage = realStorage;
});

function restoreFor(user: string, ids: string[]) {
	files.set(`agentpulse.openTabs.${user}`, JSON.stringify(ids.map(tab)));
	useUserStore.setState({ userId: user, loaded: true } as never);
}

describe("useRestoredTabsCheck", () => {
	test("gone, 500 and 403: only the gone tab closes, with one toast; mounting after adoption still checks", async () => {
		const asked: string[] = [];
		client.getSessionName = async (id: string) => {
			asked.push(id);
			if (id === "gone") throw goneError();
			if (id === "boom") throw new ApiError(500, "x", { error: "x" });
			if (id === "locked") throw new ApiError(403, "x", { error: "password_change_required" });
		};
		restoreFor("A", ["gone", "boom", "locked"]);
		const h = renderHook(() => useRestoredTabsCheck(), null);
		await h.render(null);
		await flush();
		expect(asked.sort()).toEqual(["boom", "gone", "locked"]);
		expect(open()).toEqual(["boom", "locked"]);
		expect(toasts).toEqual(["Closed 1 tab for a session that was deleted."]);
		await h.unmount();
	});

	test("zero tabs makes zero reads", async () => {
		let reads = 0;
		client.getSessionName = async () => {
			reads++;
		};
		restoreFor("A", []);
		const h = renderHook(() => useRestoredTabsCheck(), null);
		await h.render(null);
		await flush();
		expect(reads).toBe(0);
		await h.unmount();
	});

	test("a tab opened after adoption isn't checked", async () => {
		const asked: string[] = [];
		client.getSessionName = async (id: string) => {
			asked.push(id);
		};
		restoreFor("A", ["old"]);
		const h = renderHook(() => useRestoredTabsCheck(), null);
		await h.render(null);
		await flush();
		useTabsStore.getState().open(tab("new"));
		await h.render(null);
		await flush();
		expect(asked).toEqual(["old"]);
		await h.unmount();
	});

	test("a viewer change while the check is out closes nothing", async () => {
		const pending = deferred<void>();
		let goneReads = 0;
		// A's read of "gone" hangs and later fails as gone; B's own read of the same id answers fine.
		client.getSessionName = (id: string) =>
			id === "gone" && ++goneReads === 1 ? pending.promise : Promise.resolve();
		restoreFor("A", ["gone"]);
		const h = renderHook(() => useRestoredTabsCheck(), null);
		await h.render(null);
		await flush();
		files.set("agentpulse.openTabs.B", JSON.stringify([tab("gone")]));
		useUserStore.setState({ userId: "B" } as never);
		await flush();
		pending.reject(goneError());
		await flush();
		expect(open()).toEqual(["gone"]);
		expect(toasts).toEqual([]);
		await h.unmount();
	});
});
