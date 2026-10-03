import { describe, expect, test } from "bun:test";
import type { DirectoryUser } from "../lib/api.js";
import { createUsersStore } from "./users-store.js";

const alice: DirectoryUser = { id: "u1", displayName: "Alice", disabled: false };
const bob: DirectoryUser = { id: "u2", displayName: "Bob", disabled: false };

function harness(opts: { canCall: boolean; directory?: DirectoryUser[] }) {
	let calls = 0;
	let directory = opts.directory ?? [alice];
	const store = createUsersStore({
		loadDirectory: async () => {
			calls += 1;
			return directory;
		},
		canCall: () => opts.canCall,
		debounceMs: 5,
	});
	return {
		store,
		calls: () => calls,
		setDirectory: (next: DirectoryUser[]) => {
			directory = next;
		},
	};
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe("users store in solo mode", () => {
	test("never calls the directory, however it is asked", async () => {
		const h = harness({ canCall: false });
		await h.store.getState().load();
		h.store.getState().noteUnknown("someone");
		await settle();
		expect(h.calls()).toBe(0);
		expect(h.store.getState().loaded).toBe(false);
	});
});

describe("users store in team mode", () => {
	test("load fills the directory and lookup finds people", async () => {
		const h = harness({ canCall: true });
		await h.store.getState().load();
		expect(h.calls()).toBe(1);
		expect(h.store.getState().loaded).toBe(true);
		expect(h.store.getState().lookup("u1")).toEqual(alice);
		expect(h.store.getState().lookup("nobody")).toBeUndefined();
		expect(h.store.getState().lookup(null)).toBeUndefined();
	});

	test("simultaneous loads share one request", async () => {
		const h = harness({ canCall: true });
		await Promise.all([h.store.getState().load(), h.store.getState().load()]);
		expect(h.calls()).toBe(1);
	});

	test("a burst of lookups for an unknown id refetches once, and then finds the new person", async () => {
		const h = harness({ canCall: true });
		await h.store.getState().load();
		h.setDirectory([alice, bob]);
		for (let i = 0; i < 5; i++) h.store.getState().noteUnknown("u2");
		await settle();
		expect(h.calls()).toBe(2);
		expect(h.store.getState().lookup("u2")).toEqual(bob);
	});

	test("an id that is still missing after the refetch doesn't trigger another one", async () => {
		const h = harness({ canCall: true });
		await h.store.getState().load();
		h.store.getState().noteUnknown("ghost");
		await settle();
		expect(h.calls()).toBe(2);
		h.store.getState().noteUnknown("ghost");
		await settle();
		expect(h.calls()).toBe(2);
	});

	test("a known id never refetches", async () => {
		const h = harness({ canCall: true });
		await h.store.getState().load();
		h.store.getState().noteUnknown("u1");
		h.store.getState().noteUnknown(null);
		await settle();
		expect(h.calls()).toBe(1);
	});

	test("a failed load doesn't throw and leaves what was known", async () => {
		let fail = false;
		const store = createUsersStore({
			loadDirectory: async () => {
				if (fail) throw new Error("down");
				return [alice];
			},
			canCall: () => true,
			debounceMs: 5,
		});
		await store.getState().load();
		fail = true;
		await store.getState().load();
		expect(store.getState().lookup("u1")).toEqual(alice);
	});
});
