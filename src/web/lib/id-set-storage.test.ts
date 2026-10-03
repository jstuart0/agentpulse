import { describe, expect, test } from "bun:test";
import { type KeyValueStorage, addToIdSet, readIdSet, userScopedKey } from "./id-set-storage.js";

function memory(
	initial: Record<string, string> = {},
): KeyValueStorage & { data: Record<string, string> } {
	const data = { ...initial };
	return {
		data,
		getItem: (key) => data[key] ?? null,
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

describe("id set storage", () => {
	test("nothing stored reads as an empty set", () => {
		expect(readIdSet("k", memory()).size).toBe(0);
	});

	test("ids added are remembered, without duplicates, across reads", () => {
		const storage = memory();
		addToIdSet("k", ["a", "b"], storage);
		addToIdSet("k", ["b", "c"], storage);
		expect([...readIdSet("k", storage)].sort()).toEqual(["a", "b", "c"]);
	});

	test("corrupt or hostile stored text reads as an empty set, never throws", () => {
		expect(readIdSet("k", memory({ k: "{not json" })).size).toBe(0);
		expect(readIdSet("k", memory({ k: '{"a":1}' })).size).toBe(0);
		expect([...readIdSet("k", memory({ k: '["a", 3, null, "b"]' }))]).toEqual(["a", "b"]);
	});

	test("no storage (private mode) still answers, and remembers for the moment only", () => {
		expect(readIdSet("k", null).size).toBe(0);
		expect([...addToIdSet("k", ["a"], null)]).toEqual(["a"]);
	});

	test("a storage that refuses writes doesn't throw", () => {
		const refusing: KeyValueStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect([...addToIdSet("k", ["a"], refusing)]).toEqual(["a"]);
	});
});

describe("userScopedKey", () => {
	test("one key per person, so a shared browser keeps their choices apart", () => {
		expect(userScopedKey("agentpulse.team.dismissedChecklist", "u1")).toBe(
			"agentpulse.team.dismissedChecklist.u1",
		);
		expect(userScopedKey("agentpulse.team.dismissedChecklist", "u2")).not.toBe(
			userScopedKey("agentpulse.team.dismissedChecklist", "u1"),
		);
	});

	test("someone with no id gets their own anonymous bucket", () => {
		expect(userScopedKey("k", null)).toBe("k.anonymous");
	});
});
