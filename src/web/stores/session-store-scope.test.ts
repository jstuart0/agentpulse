import { describe, expect, test } from "bun:test";
import type { Session } from "../../shared/types.js";
import { applySessionUpdateToList } from "./session-store.js";

const ME = "0b5e3a52-1f2b-4c52-9a53-0d5a7c1e9a01";
const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";

function row(sessionId: string, ownerUserId: string | null): Session {
	return {
		id: sessionId,
		sessionId,
		ownerUserId,
		ownerKind: ownerUserId ? "user" : "unassigned",
	} as unknown as Session;
}

const mineScope = { owner: "me", viewerUserId: ME };
const everyone = { owner: "all", viewerUserId: ME };

describe("applySessionUpdateToList under a scope", () => {
	test("a row that doesn't belong is not added, and the list is returned untouched", () => {
		const list = [row("a", ME)];
		const result = applySessionUpdateToList(list, row("b", ALICE), mineScope);
		expect(result).toBe(list);
	});

	test("a row that belongs is added at the front", () => {
		const result = applySessionUpdateToList([row("a", ME)], row("b", ME), mineScope);
		expect(result.map((s) => s.sessionId)).toEqual(["b", "a"]);
	});

	test("a row whose owner changed away is removed", () => {
		const result = applySessionUpdateToList(
			[row("a", ME), row("b", ME)],
			row("a", ALICE),
			mineScope,
		);
		expect(result.map((s) => s.sessionId)).toEqual(["b"]);
	});

	test("a row whose owner changed to the viewer is added", () => {
		const result = applySessionUpdateToList([row("b", ME)], row("a", ME), mineScope);
		expect(result.map((s) => s.sessionId)).toEqual(["a", "b"]);
	});

	test("everyone, or no scope at all, behaves as it always did", () => {
		const list = [row("a", ME)];
		expect(
			applySessionUpdateToList(list, row("b", ALICE), everyone).map((s) => s.sessionId),
		).toEqual(["b", "a"]);
		expect(applySessionUpdateToList(list, row("b", ALICE)).map((s) => s.sessionId)).toEqual([
			"b",
			"a",
		]);
	});
});

describe("a row from a server that sends no owner field at all", () => {
	function legacy(sessionId: string): Session {
		return { id: sessionId, sessionId } as unknown as Session;
	}

	test("one already shown is kept and replaced, not dropped, under a narrowed view", () => {
		const list = [legacy("a")];
		const next = { ...legacy("a"), isWorking: true } as unknown as Session;
		const result = applySessionUpdateToList(list, next, mineScope);
		expect(result.map((s) => s.sessionId)).toEqual(["a"]);
		expect((result[0] as { isWorking?: boolean }).isWorking).toBe(true);
	});

	test("one not shown is not added: the poll decides whether it belongs", () => {
		const list = [row("a", ME)];
		expect(applySessionUpdateToList(list, legacy("b"), mineScope)).toBe(list);
	});

	test("a row that does carry an owner is still judged on it", () => {
		const result = applySessionUpdateToList([legacy("a")], row("a", ALICE), mineScope);
		expect(result).toEqual([]);
	});
});

describe("a row that says nothing about its owner", () => {
	function ownerless(sessionId: string): Session {
		return { id: sessionId, sessionId } as unknown as Session;
	}

	test("is added under Everyone, which judges nobody", () => {
		const result = applySessionUpdateToList([row("a", ME)], ownerless("b"), everyone);
		expect(result.map((s) => s.sessionId)).toEqual(["b", "a"]);
	});

	test("is not added under a narrowed view, and one already shown is kept and refreshed", () => {
		const list = [ownerless("a")];
		expect(applySessionUpdateToList(list, ownerless("b"), mineScope)).toBe(list);
		const refreshed = { ...ownerless("a"), displayName: "renamed" } as Session;
		expect(applySessionUpdateToList(list, refreshed, mineScope)).toEqual([refreshed]);
	});
});
