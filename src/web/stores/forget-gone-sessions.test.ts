import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	__resetForgottenForTests,
	forgetGoneSessions,
	handleGoneSession,
} from "./forget-gone-sessions.js";
import { useSessionStore } from "./session-store.js";
import { useTabsStore } from "./tabs-store.js";
import { useUserStore } from "./user-store.js";

const files = new Map<string, string>();
const realStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;
let writes = 0;

const tab = (sessionId: string) => ({
	sessionId,
	displayName: sessionId,
	agentType: "claude_code" as const,
	managedState: null,
});

beforeEach(() => {
	__resetForgottenForTests();
	files.clear();
	writes = 0;
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (key: string) => files.get(key) ?? null,
		setItem: (key: string, value: string) => {
			writes++;
			files.set(key, value);
		},
		removeItem: (key: string) => void files.delete(key),
	};
	useUserStore.setState({ userId: "A", mode: "team", loaded: true } as never);
	useTabsStore.setState({ tabs: [tab("s1"), tab("s2"), tab("s3")] });
	useSessionStore.setState({
		sessions: [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }],
	} as never);
});

afterEach(() => {
	(globalThis as unknown as { localStorage?: unknown }).localStorage = realStorage;
});

describe("forgetGoneSessions", () => {
	test("closes the tabs, drops the store rows and counts the tabs closed", () => {
		const { closedTabs } = forgetGoneSessions(["s1", "s3", "never-open"]);
		expect(closedTabs).toBe(2);
		expect(useTabsStore.getState().tabs.map((t) => t.sessionId)).toEqual(["s2"]);
		expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toEqual(["s2"]);
	});

	test("a second call is idempotent and writes nothing", () => {
		forgetGoneSessions(["s1"]);
		const writesAfterFirst = writes;
		const tabsBefore = useTabsStore.getState().tabs;
		const sessionsBefore = useSessionStore.getState().sessions;
		expect(forgetGoneSessions(["s1"])).toEqual({ closedTabs: 0 });
		expect(writes).toBe(writesAfterFirst);
		expect(useTabsStore.getState().tabs).toBe(tabsBefore);
		expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
	});

	test("closing many tabs is one write", () => {
		forgetGoneSessions(["s1", "s2", "s3"]);
		expect(writes).toBe(1);
	});
});

describe("handleGoneSession: the page's own 404 says 'deleted' whenever the server's word is confirmed", () => {
	test("the page answers first: it closes the tab itself", () => {
		const result = handleGoneSession("s1", false);
		expect(result).toEqual({ closedTabs: 1, notice: true });
	});

	test("the restored-tab check answered first: the tab is already closed, and the page still says deleted", () => {
		forgetGoneSessions(["s1"]); // what useRestoredTabsCheck does
		const result = handleGoneSession("s1", false);
		expect(result).toEqual({ closedTabs: 0, notice: true });
	});

	test("a session the page showed before says deleted even with no tab open", () => {
		expect(handleGoneSession("not-a-tab", true)).toEqual({ closedTabs: 0, notice: true });
	});

	test("a first load of a bad link, with no tab and nothing confirmed earlier, stays hedged", () => {
		expect(handleGoneSession("typo-id", false)).toEqual({ closedTabs: 0, notice: false });
		forgetGoneSessions(["another"]);
		expect(handleGoneSession("typo-id", false).notice).toBe(false);
	});
});
