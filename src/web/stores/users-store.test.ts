import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("users store keeps up with changes", () => {
	test("reload asks again after the load already in flight, so a change made meanwhile is seen", async () => {
		let calls = 0;
		let directory = [alice];
		let release: () => void = () => {};
		const store = createUsersStore({
			loadDirectory: async () => {
				calls += 1;
				const answer = directory;
				if (calls === 1) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				return answer;
			},
			canCall: () => true,
			debounceMs: 5,
		});
		const first = store.getState().load();
		directory = [alice, bob];
		const reloaded = store.getState().reload();
		release();
		await Promise.all([first, reloaded]);
		expect(calls).toBe(2);
		expect(store.getState().lookup("u2")).toEqual(bob);
	});

	test("reload with nothing in flight loads once", async () => {
		const h = harness({ canCall: true });
		await h.store.getState().load();
		await h.store.getState().reload();
		expect(h.calls()).toBe(2);
	});

	test("an id is not remembered as missing when the directory could not be loaded", async () => {
		let fail = true;
		let calls = 0;
		const store = createUsersStore({
			loadDirectory: async () => {
				calls += 1;
				if (fail) throw new Error("down");
				return [alice, bob];
			},
			canCall: () => true,
			debounceMs: 5,
		});
		store.getState().noteUnknown("u2");
		await settle();
		expect(calls).toBe(1);

		fail = false;
		store.getState().noteUnknown("u2");
		await settle();
		expect(calls).toBe(2);
		expect(store.getState().lookup("u2")).toEqual(bob);
	});
});

describe("every place that changes the people reloads the directory", () => {
	const panel = readFileSync(
		join(import.meta.dir, "..", "components", "settings", "TeamPanel.tsx"),
		"utf8",
	);

	test("Team settings reloads it after a change, and after the mode dialog commits", () => {
		const afterChange = panel.slice(panel.indexOf("function changed()"));
		expect(afterChange.slice(0, 300)).toContain("useUsersStore.getState().reload()");
		const modeDialog = panel.slice(panel.indexOf("<ModeDialog"));
		expect(modeDialog.slice(0, 500)).toContain("useUsersStore.getState().reload()");
	});
});
