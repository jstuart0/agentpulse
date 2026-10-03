import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useTabsStore } from "./tabs-store.js";
import { useUserStore } from "./user-store.js";

const files = new Map<string, string>();
const realStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;

const tab = (sessionId: string) => ({
	sessionId,
	displayName: sessionId,
	agentType: "claude_code" as const,
	managedState: null,
});

beforeEach(() => {
	files.clear();
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (key: string) => files.get(key) ?? null,
		setItem: (key: string, value: string) => void files.set(key, value),
		removeItem: (key: string) => void files.delete(key),
	};
	useUserStore.setState({ userId: null, mode: "team", loaded: false } as never);
	useTabsStore.setState({ tabs: [] });
});

afterEach(() => {
	(globalThis as unknown as { localStorage?: unknown }).localStorage = realStorage;
});

describe("open tabs belong to the person who opened them", () => {
	test("each person's tabs are stored under their own key", () => {
		useUserStore.setState({ userId: "A", loaded: true } as never);
		useTabsStore.getState().open(tab("s1"));
		expect(files.has("agentpulse.openTabs.A")).toBe(true);
		expect(files.has("agentpulse.openTabs")).toBe(false);
	});

	test("the next person on the same browser starts empty, and the first gets theirs back", () => {
		useUserStore.setState({ userId: "A", loaded: true } as never);
		useTabsStore.getState().open(tab("s1"));
		useUserStore.setState({ userId: "B" } as never);
		expect(useTabsStore.getState().tabs).toEqual([]);
		useTabsStore.getState().open(tab("s2"));
		expect(files.has("agentpulse.openTabs.B")).toBe(true);
		useUserStore.setState({ userId: "A" } as never);
		expect(useTabsStore.getState().tabs.map((t) => t.sessionId)).toEqual(["s1"]);
	});

	test("tabs the shared key held are never shown to a team member, and the key is removed", () => {
		files.set("agentpulse.openTabs", JSON.stringify([tab("old")]));
		useUserStore.setState({ userId: "A", loaded: true } as never);
		expect(useTabsStore.getState().tabs).toEqual([]);
		expect(files.has("agentpulse.openTabs")).toBe(false);
	});
});
