import { describe, expect, test } from "bun:test";
import { inboxViewedKeys, readInboxViewed, writeInboxViewed } from "./inbox-viewed.js";

function memoryStorage() {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
	};
}

describe("the inbox 'last viewed' marks belong to the viewer", () => {
	test("each viewer has their own keys", () => {
		expect(inboxViewedKeys("A")).not.toEqual(inboxViewedKeys("B"));
		expect(inboxViewedKeys("A").at).not.toBe(inboxViewedKeys("A").total);
		expect(inboxViewedKeys(null)).not.toEqual(inboxViewedKeys("A"));
	});

	test("one viewer's marks are not read by the next on the same browser", () => {
		const storage = memoryStorage();
		writeInboxViewed(storage, "A", { at: 500, total: 4 });
		expect(readInboxViewed(storage, "A")).toEqual({ at: 500, total: 4 });
		expect(readInboxViewed(storage, "B")).toEqual({ at: 0, total: 0 });
		expect(readInboxViewed(storage, null)).toEqual({ at: 0, total: 0 });
	});

	test("no storage reads as never viewed, and a refusing storage doesn't throw", () => {
		expect(readInboxViewed(undefined, "A")).toEqual({ at: 0, total: 0 });
		const refusing = {
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		};
		expect(() => writeInboxViewed(refusing, "A", { at: 1, total: 1 })).not.toThrow();
	});
});
