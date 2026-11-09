/**
 * The per-viewer draft store against a Map-backed localStorage: what is written and when, what a reload
 * brings back, whose it is, and what a send may clear or restore.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	__resetDraftsPurgedForTests,
	draftKey,
	indexKey,
	parseIndex,
	purgeAllPromptDrafts,
} from "../lib/prompt-draft-keys.js";
import { installDomStubs, removeDomStubs } from "../test-utils/render-hook.js";
import {
	DRAFT_DEBOUNCE_MS,
	DRAFT_MAX_PERSISTED_CHARS,
	DRAFT_TTL_MS,
	__resetPromptDraftsForTests,
	usePromptDraftStore,
} from "./prompt-draft-store.js";
import { useUserStore } from "./user-store.js";

const realNow = Date.now;
const realStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLE_MS = DRAFT_DEBOUNCE_MS + 150;

let map: Map<string, string>;
let sets: string[];
let gets: string[];
let failGet: boolean;
let failSet: boolean;
let now: number;

function install() {
	map = new Map();
	sets = [];
	gets = [];
	failGet = false;
	failSet = false;
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem(key: string) {
			gets.push(key);
			if (failGet) throw new Error("denied");
			return map.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			if (failSet) throw new Error("quota");
			sets.push(key);
			map.set(key, value);
		},
		removeItem(key: string) {
			map.delete(key);
		},
		key(index: number) {
			return [...map.keys()][index] ?? null;
		},
		get length() {
			return map.size;
		},
	};
}

function signIn(userId: string | null, disableAuth = false) {
	useUserStore.setState({ userId, loaded: true, disableAuth } as never);
}
function signOutOfMemory() {
	useUserStore.setState({ loaded: false } as never);
}
const store = () => usePromptDraftStore.getState();
const text = (id: string) => store().drafts[id]?.text;
const stored = (tag: string, id: string) => map.get(draftKey(tag, id));
const A = "u:A";

beforeAll(() => installDomStubs());
afterAll(() => {
	removeDomStubs();
	(globalThis as unknown as { localStorage?: unknown }).localStorage = realStorage;
});
beforeEach(() => {
	install();
	now = 1_800_000_000_000;
	Date.now = () => now;
	useUserStore.setState({ userId: null, loaded: false, disableAuth: false } as never);
	__resetDraftsPurgedForTests();
	__resetPromptDraftsForTests();
});
afterEach(() => {
	Date.now = realNow;
	// The purge flag is module state: leave it clear for the test files that run after this one.
	__resetDraftsPurgedForTests();
});

describe("storage contents", () => {
	test("each session's draft is its own", () => {
		signIn("A");
		store().edit("s1", "one");
		store().edit("s2", "two");
		store().flush();
		expect(text("s1")).toBe("one");
		expect(text("s2")).toBe("two");
		expect(JSON.parse(stored(A, "s1") ?? "{}").t).toBe("one");
		expect(JSON.parse(stored(A, "s2") ?? "{}").t).toBe("two");
	});

	test("a real reload: the draft comes back from storage, restored, with its original time, as soon as the viewer is adopted", () => {
		signIn("A");
		store().edit("s1", "typed before the reload");
		const savedAt = now;
		store().flush();
		signOutOfMemory(); // the page goes away
		expect(store().drafts).toEqual({});
		let renders = 0;
		const unsubscribe = usePromptDraftStore.subscribe(() => renders++);
		now += 60_000;
		signIn("A");
		unsubscribe();
		expect(renders).toBe(1); // one set, at adoption; reading adds none
		expect(store().drafts.s1).toEqual({
			text: "typed before the reload",
			savedAt,
			restored: true,
			persist: true,
		});
		expect(renders).toBe(1);
	});

	test("an edit is no longer 'restored'", () => {
		signIn("A");
		store().edit("s1", "x");
		store().flush();
		signOutOfMemory();
		signIn("A");
		expect(store().drafts.s1?.restored).toBe(true);
		store().edit("s1", "xy");
		expect(store().drafts.s1?.restored).toBe(false);
	});

	test("TTL is decided from the index: an expired pair is dropped without its body being read", () => {
		const fresh = now - 1000;
		map.set(
			indexKey(A),
			JSON.stringify([
				["new", fresh],
				["old", now - DRAFT_TTL_MS - 60_000],
			]),
		);
		map.set(draftKey(A, "new"), JSON.stringify({ t: "keep", at: fresh }));
		map.set(draftKey(A, "old"), JSON.stringify({ t: "gone", at: now - DRAFT_TTL_MS - 60_000 }));
		signIn("A");
		expect(text("new")).toBe("keep");
		expect(text("old")).toBeUndefined();
		expect(gets).not.toContain(draftKey(A, "old"));
		expect(map.has(draftKey(A, "old"))).toBe(false);
		expect(parseIndex(map.get(indexKey(A)) ?? null).map(([id]) => id)).toEqual(["new"]);
	});

	test("TTL edges: 7 days and 1 minute old is dropped and its key removed, 6 days 23 hours is kept", () => {
		const old = now - DRAFT_TTL_MS - 60_000;
		const near = now - (6 * 24 + 23) * 60 * 60 * 1000;
		map.set(
			indexKey(A),
			JSON.stringify([
				["near", near],
				["old", old],
			]),
		);
		map.set(draftKey(A, "near"), JSON.stringify({ t: "near", at: near }));
		map.set(draftKey(A, "old"), JSON.stringify({ t: "old", at: old }));
		signIn("A");
		expect(text("near")).toBe("near");
		expect(text("old")).toBeUndefined();
		expect(map.has(draftKey(A, "old"))).toBe(false);
	});

	test("cap edges: 20,000 characters are stored; 20,001 stay in memory and the old key is removed", () => {
		signIn("A");
		store().edit("s1", "short");
		store().flush();
		expect(stored(A, "s1")).toBeDefined();
		store().edit("s1", "x".repeat(DRAFT_MAX_PERSISTED_CHARS));
		store().flush();
		expect(JSON.parse(stored(A, "s1") ?? "{}").t).toHaveLength(DRAFT_MAX_PERSISTED_CHARS);
		store().edit("s1", "x".repeat(DRAFT_MAX_PERSISTED_CHARS + 1));
		store().flush();
		expect(text("s1")).toHaveLength(DRAFT_MAX_PERSISTED_CHARS + 1);
		expect(stored(A, "s1")).toBeUndefined();
		expect(parseIndex(map.get(indexKey(A)) ?? null)).toEqual([]);
	});

	test("LRU: with 31 drafts the oldest is gone from memory and storage; an edit refreshes recency; the other viewer's keys stay", () => {
		signIn("B");
		store().edit("b-only", "bee");
		store().flush();
		signIn("A");
		for (let i = 0; i < 30; i++) {
			now += 1000;
			store().edit(`evict-${i}`, `d${i}`);
			store().flush();
		}
		expect(Object.keys(store().drafts)).toHaveLength(30);
		now += 1000;
		store().edit("evict-0", "touched"); // refresh recency of the oldest
		store().flush();
		now += 1000;
		store().edit("evict-30", "one too many");
		store().flush();
		expect(Object.keys(store().drafts)).toHaveLength(30);
		expect(text("evict-1")).toBeUndefined();
		expect(stored(A, "evict-1")).toBeUndefined();
		expect(text("evict-0")).toBe("touched");
		expect(text("evict-30")).toBe("one too many");
		expect(map.has(draftKey("u:B", "b-only"))).toBe(true);
	});
});

describe("viewers", () => {
	test("A's draft is absent for B, back for A, and memory is cleared when nobody is known", () => {
		signIn("A");
		store().edit("s1", "mine");
		store().flush();
		signIn("B");
		expect(text("s1")).toBeUndefined();
		signIn("A");
		expect(text("s1")).toBe("mine");
		signOutOfMemory();
		expect(store().drafts).toEqual({});
	});

	test("a null viewer with auth on persists nothing; with auth off it persists under anon; the two tags never collide", () => {
		signIn(null, false);
		store().edit("s1", "memory only");
		store().flush();
		expect(text("s1")).toBe("memory only");
		expect(sets).toEqual([]);
		expect([...map.keys()].some((k) => k.includes("anon"))).toBe(false);

		signIn(null, true);
		store().edit("s1", "single user");
		store().flush();
		expect(stored("anon", "s1")).toBeDefined();
		signIn("anon"); // a user whose id is the word "anon"
		expect(text("s1")).toBeUndefined();
	});

	test("a user id with a dot can't see another user's drafts, and the orphan sweep leaves them alone", () => {
		signIn("a.b");
		store().edit("s1", "dotted");
		store().flush();
		signIn("a");
		expect(text("s1")).toBeUndefined();
		expect(map.has(draftKey("u:a.b".replace(".", "%2E"), "s1"))).toBe(true);
	});
});

describe("sends", () => {
	test("clearSent is refused after an edit", () => {
		signIn("A");
		store().edit("s1", "first");
		const ticket = store().beginSend("s1", "first");
		if (!ticket) throw new Error("ticket");
		store().sendRefused(ticket); // the POST is judged lost, then the person types
		store().edit("s1", "second");
		store().sendAccepted(ticket, "act-1", false); // the 202 arrives late
		expect(text("s1")).toBe("second");
	});

	test("clearSent clears an unchanged draft", () => {
		signIn("A");
		store().edit("s1", "first");
		store().flush();
		const ticket = store().beginSend("s1", "first");
		if (!ticket) throw new Error("ticket");
		store().sendAccepted(ticket, "act-1", false);
		expect(text("s1")).toBeUndefined();
		expect(stored(A, "s1")).toBeUndefined();
		expect(store().sending.s1).toBeUndefined();
	});

	test("clearSent is refused across a generation change at the same version", () => {
		signIn("A");
		store().edit("s1", "first");
		store().flush();
		signOutOfMemory();
		signIn("A"); // versions start again at 0
		const ticket = store().beginSend("s1", "first");
		if (!ticket) throw new Error("ticket");
		signIn("B");
		signIn("A"); // same version, another generation
		store().sendAccepted(ticket, "act-1", true);
		expect(text("s1")).toBe("first");
	});

	test("restoreUnsent is refused when text was typed meanwhile", () => {
		signIn("A");
		store().edit("s1", "sent text");
		const ticket = store().beginSend("s1", "sent text");
		if (!ticket) throw new Error("ticket");
		store().sendAccepted(ticket, "act-1", false); // the marker is gone, so the box takes typing again
		expect(text("s1")).toBeUndefined();
		store().edit("s1", "new text");
		expect(store().sendSettled(ticket, "failed", "sent text")).toBe(false);
		expect(text("s1")).toBe("new text");
	});

	test("a failed outcome puts the exact text back and stores it; an unknown outcome keeps it in memory until it is edited", async () => {
		signIn("A");
		store().edit("s1", "  untrimmed\n");
		const first = store().beginSend("s1", "  untrimmed\n");
		if (!first) throw new Error("ticket");
		store().sendAccepted(first, "act-1", true);
		expect(store().sendSettled(first, "failed", "  untrimmed\n")).toBe(true);
		store().flush();
		expect(JSON.parse(stored(A, "s1") ?? "{}").t).toBe("  untrimmed\n");

		store().edit("s2", "maybe sent");
		const second = store().beginSend("s2", "maybe sent");
		if (!second) throw new Error("ticket");
		store().sendAccepted(second, "act-2", true);
		expect(store().sendSettled(second, "unknown", "maybe sent")).toBe(true);
		await sleep(SETTLE_MS);
		expect(text("s2")).toBe("maybe sent");
		expect(stored(A, "s2")).toBeUndefined();
		store().edit("s2", "maybe sent, edited");
		store().flush();
		expect(stored(A, "s2")).toBeDefined();
	});

	test("while a send is in progress, edits and discards do nothing, and a second send is refused", () => {
		signIn("A");
		store().edit("s1", "text");
		const ticket = store().beginSend("s1", "text");
		expect(ticket).not.toBeNull();
		store().edit("s1", "changed");
		expect(text("s1")).toBe("text");
		expect(store().discard("s1")).toBeNull();
		expect(store().beginSend("s1", "text")).toBeNull();
	});

	test("undo of a discard does nothing once a send has started or something was typed", () => {
		signIn("A");
		store().edit("s1", "text");
		const removed = store().discard("s1");
		if (!removed) throw new Error("removed");
		expect(store().beginSend("s1", "other")).not.toBeNull();
		expect(store().undoDiscard("s1", removed)).toBe(false);
	});
});

describe("writes", () => {
	test("50 edits inside the debounce window make at most 2 setItem calls; flush writes at once", async () => {
		signIn("A");
		for (let i = 0; i < 50; i++) store().edit("s1", `text ${i}`);
		expect(sets).toEqual([]);
		await sleep(SETTLE_MS);
		expect(sets.length).toBeLessThanOrEqual(2);
		expect(JSON.parse(stored(A, "s1") ?? "{}").t).toBe("text 49");

		const before = sets.length;
		store().edit("s1", "now");
		store().flush("s1");
		expect(sets.length).toBeGreaterThan(before);
		expect(JSON.parse(stored(A, "s1") ?? "{}").t).toBe("now");
	});

	test("editing the session already at the front doesn't rewrite the index", () => {
		signIn("A");
		store().edit("s1", "a");
		store().flush();
		const indexWrites = () => sets.filter((k) => k === indexKey(A)).length;
		const first = indexWrites();
		now += 1000;
		store().edit("s1", "ab");
		store().flush();
		store().edit("s1", "abc");
		store().flush();
		expect(indexWrites()).toBe(first);
	});

	test("the index is rewritten when another session comes to the front", () => {
		signIn("A");
		store().edit("s1", "a");
		store().flush();
		store().edit("s2", "b");
		store().flush();
		expect(parseIndex(map.get(indexKey(A)) ?? null).map(([id]) => id)).toEqual(["s2", "s1"]);
	});
});

describe("broken storage", () => {
	test("a corrupt index, a non-array index and a hostile index parse safely and are capped at 30", () => {
		expect(parseIndex("{not json")).toEqual([]);
		expect(parseIndex('{"a":1}')).toEqual([]);
		expect(parseIndex(null)).toEqual([]);
		const hostile: unknown[] = ["bare string", null, [1, 2], ["x"], ["dup", 1], ["dup", 2]];
		hostile.push(["nan", Number.NaN], ["str-time", "5"], [{}, 3]);
		for (let i = 0; i < 1000; i++) hostile.push([`id-${i}`, i]);
		const parsed = parseIndex(JSON.stringify(hostile));
		expect(parsed).toHaveLength(30);
		expect(parsed[0]).toEqual(["dup", 1]);
		expect(new Set(parsed.map(([id]) => id)).size).toBe(30);
		for (const [, at] of parsed) expect(Number.isFinite(at)).toBe(true);
	});

	test("a corrupt index at adopt leaves an empty store, not a crash", () => {
		map.set(indexKey(A), "{{{");
		signIn("A");
		expect(store().drafts).toEqual({});
	});

	test("a throwing getItem leaves memory editing working", () => {
		failGet = true;
		signIn("A");
		store().edit("s1", "still typing");
		expect(text("s1")).toBe("still typing");
	});

	test("a throwing setItem (quota) leaves memory editing working", () => {
		signIn("A");
		failSet = true;
		store().edit("s1", "still typing");
		store().flush();
		expect(text("s1")).toBe("still typing");
	});

	test("a draft key that isn't in the index is removed at adopt (orphan)", () => {
		map.set(draftKey(A, "ghost"), JSON.stringify({ t: "ghost", at: now }));
		map.set(draftKey("u:B", "keep"), JSON.stringify({ t: "b", at: now }));
		signIn("A");
		expect(map.has(draftKey(A, "ghost"))).toBe(false);
		expect(map.has(draftKey("u:B", "keep"))).toBe(true);
	});
});

describe("sign-out", () => {
	test("purgeAllPromptDrafts removes every draft key (both viewers, indexes and entries) and nothing else", () => {
		signIn("A");
		store().edit("s1", "a");
		store().flush();
		signIn("B");
		store().edit("s1", "b");
		store().flush();
		map.set("agentpulse.openTabs.A", "[]");
		const storage = (
			globalThis as unknown as { localStorage: Parameters<typeof purgeAllPromptDrafts>[0] }
		).localStorage;
		purgeAllPromptDrafts(storage);
		expect([...map.keys()]).toEqual(["agentpulse.openTabs.A"]);
	});

	test("a write pending at sign-out can't put a draft back: not the debounced one, not the pagehide flush", async () => {
		signIn("A");
		store().edit("s1", "typed just before Sign out");
		const storage = (
			globalThis as unknown as { localStorage: Parameters<typeof purgeAllPromptDrafts>[0] }
		).localStorage;
		purgeAllPromptDrafts(storage);
		await sleep(SETTLE_MS);
		(globalThis as unknown as { dispatchEvent: (e: Event) => boolean }).dispatchEvent(
			new Event("pagehide"),
		);
		store().flush();
		expect([...map.keys()].filter((k) => k.startsWith("agentpulse.promptDraft."))).toEqual([]);
	});
});
