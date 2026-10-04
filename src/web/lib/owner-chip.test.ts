import { describe, expect, test } from "bun:test";
import { ownerChip, ownerChipVisible } from "./owner-chip.js";
import type { DirectoryEntry } from "./owner-label.js";

const ME = "0b5e3a52-1f2b-4c52-9a53-0d5a7c1e9a01";
const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";

const directory: Record<string, DirectoryEntry> = {
	[ALICE]: { id: ALICE, displayName: "Alice Smith", disabled: false },
	[ME]: { id: ME, displayName: "jay", disabled: false },
	gone: { id: "gone", displayName: "Gil Gone", disabled: true },
};

const ctx = {
	viewerUserId: ME,
	lookup: (id: string) => directory[id],
	initialsById: new Map<string, string>([
		[ALICE, "AS"],
		[ME, "JA"],
		["gone", "GG"],
	]),
};

describe("ownerChip", () => {
	test("another person: initials, name, and what owner means, in neutral words", () => {
		expect(ownerChip({ ownerUserId: ALICE, ownerKind: "user" }, ctx)).toEqual({
			kind: "user",
			text: "Alice Smith",
			initials: "AS",
			srText: "Owner: Alice Smith",
			title: "Owner: Alice Smith. Reported by their key. Any member can open and steer it.",
		});
	});

	test("your own session reads 'You' and 'your key'", () => {
		expect(ownerChip({ ownerUserId: ME, ownerKind: "user" }, ctx)).toEqual({
			kind: "user",
			text: "You",
			initials: "JA",
			srText: "Owner: You",
			title: "Owner: You. Reported by your key. Any member can open and steer it.",
		});
	});

	test("a disabled person says so", () => {
		const chip = ownerChip({ ownerUserId: "gone", ownerKind: "user" }, ctx);
		expect(chip.text).toBe("Gil Gone (disabled)");
		expect(chip.srText).toBe("Owner: Gil Gone (disabled)");
	});

	test("a person the directory doesn't list yet: the fallback name, never the raw id", () => {
		const chip = ownerChip(
			{ ownerUserId: "3f2a9c10-0000-4000-8000-000000000000", ownerKind: "user" },
			ctx,
		);
		expect(chip.text).toBe("User 3f2a");
		expect(chip.initials).toBe("3F");
		expect(chip.title).not.toContain("3f2a9c10-0000");
	});

	test("a name with control characters is shown without them", () => {
		const evil = { id: "e", displayName: "Al‮ice\u0007", disabled: false };
		const chip = ownerChip({ ownerUserId: "e", ownerKind: "user" }, { ...ctx, lookup: () => evil });
		expect(chip.text).toBe("Alice");
	});

	test("a key with no owner, and a session with neither, are plain text", () => {
		expect(ownerChip({ ownerUserId: null, ownerKind: "service" }, ctx)).toEqual({
			kind: "service",
			text: "Service key",
			initials: null,
			srText: "Owner: none, reported by a service key",
			title: "Reported by a service key, which has no owner. Any member can open and steer it.",
		});
		expect(ownerChip({ ownerUserId: null, ownerKind: "unassigned" }, ctx)).toEqual({
			kind: "unassigned",
			text: "Unassigned",
			initials: null,
			srText: "Owner: none",
			title: "Unassigned: no owner, and no key on record. Any member can open and steer it.",
		});
		expect(ownerChip({ ownerUserId: null }, ctx).kind).toBe("unassigned");
	});
});

describe("ownerChipVisible", () => {
	test("shown on Everyone grouped by project or agent", () => {
		expect(ownerChipVisible(true, "all", "project")).toBe(true);
		expect(ownerChipVisible(true, "all", "agent")).toBe(true);
	});

	test("hidden when grouped by user (the header says it)", () => {
		expect(ownerChipVisible(true, "all", "user")).toBe(false);
	});

	test("hidden when the view is already one owner: Mine, a person, or an ownerless kind", () => {
		for (const owner of ["me", "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02", "unassigned", "service"]) {
			expect(ownerChipVisible(true, owner, "project")).toBe(false);
		}
	});

	test("hidden entirely when team features are off (solo)", () => {
		expect(ownerChipVisible(false, "all", "project")).toBe(false);
	});
});

describe("ownerChipVisible with the machine grouping", () => {
	test("grouping by machine says nothing about owners, so the chip stays", () => {
		expect(ownerChipVisible(true, "all", "machine")).toBe(true);
		expect(ownerChipVisible(false, "all", "machine")).toBe(false);
		expect(ownerChipVisible(true, "me", "machine")).toBe(false);
	});
});
