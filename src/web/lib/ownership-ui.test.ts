import { describe, expect, test } from "bun:test";
import { shouldShowFirstRun } from "../pages/dashboard-empty.js";
import { viewKind } from "../pages/dashboard-scope.js";
import { ownerChipVisible } from "./owner-chip.js";
import { scopeQuery } from "./owner-scope.js";
import {
	ADMIN_ONLY_SETTINGS_NOTICE,
	NOTES_BLOCKED_REASON,
	RENAME_BLOCKED_REASON,
	ownershipUi,
	sessionActionAccess,
	viewerIsAdmin,
} from "./ownership-ui.js";

const SOLO_ROW = {
	showScope: false,
	showOwnerSelect: false,
	showGroupBy: false,
	showOwnerChip: false,
	showOwnerFields: false,
	showTeamSection: false,
	showKeyOwner: false,
	showHostOwner: false,
	adminSettingsLocked: false,
	callDirectory: false,
	showUsersLink: false,
	themeIsPerBrowser: false,
	showTeamCopy: false,
	ownerGatesSessionActions: false,
	adminMayClearOthersAttention: false,
	showSummarySharedNote: false,
	machinesMenuLabel: "Admin" as const,
};

describe("ownershipUi in solo mode", () => {
	test("every flag is false and the menu stays 'Admin', whoever is looking", () => {
		for (const effectiveRole of ["admin", "member", null, undefined] as const) {
			expect(ownershipUi("solo", { effectiveRole })).toEqual(SOLO_ROW);
		}
	});

	test("the solo row has no truthy flag besides the label (nothing new can appear)", () => {
		const row = ownershipUi("solo", { effectiveRole: "admin" });
		const truthy = Object.entries(row).filter(
			([key, value]) => key !== "machinesMenuLabel" && value,
		);
		expect(truthy).toEqual([]);
	});
});

describe("everything the dashboard adds for teams is off in solo", () => {
	const solo = ownershipUi("solo", { effectiveRole: "admin" });

	test("no switch, no Owner select, no Group by, no owner chip", () => {
		expect(solo.showScope).toBe(false);
		expect(solo.showOwnerSelect).toBe(false);
		expect(solo.showGroupBy).toBe(false);
		expect(solo.showOwnerChip).toBe(false);
		for (const groupBy of ["project", "user", "agent"] as const) {
			expect(ownerChipVisible(solo.showOwnerChip, "all", groupBy)).toBe(false);
		}
	});

	test("the view reads as plain: today's wording, no narrowing, no scope in any request", () => {
		expect(viewKind(solo.showScope, "all")).toBe("plain");
		expect(scopeQuery({ owner: "all", excludeScratch: false })).toEqual({});
	});

	test("an empty install shows first-run exactly as it did", () => {
		expect(shouldShowFirstRun({ isLoading: false, loadedCount: 0, owner: "all" })).toBe(true);
	});
});

describe("ownershipUi in team mode", () => {
	test("a member sees owners everywhere, the settings read-only, the menu 'Machines' and no Users link", () => {
		expect(ownershipUi("team", { effectiveRole: "member" })).toEqual({
			showScope: true,
			showOwnerSelect: true,
			showGroupBy: true,
			showOwnerChip: true,
			showOwnerFields: true,
			showTeamSection: false,
			showKeyOwner: true,
			showHostOwner: true,
			adminSettingsLocked: true,
			callDirectory: true,
			showUsersLink: false,
			themeIsPerBrowser: true,
			showTeamCopy: true,
			ownerGatesSessionActions: true,
			adminMayClearOthersAttention: false,
			showSummarySharedNote: true,
			machinesMenuLabel: "Machines",
		});
	});

	test("an admin gets the team section, a Users link, editable settings and the acknowledge override", () => {
		expect(ownershipUi("team", { effectiveRole: "admin" })).toEqual({
			showScope: true,
			showOwnerSelect: true,
			showGroupBy: true,
			showOwnerChip: true,
			showOwnerFields: true,
			showTeamSection: true,
			showKeyOwner: true,
			showHostOwner: true,
			adminSettingsLocked: false,
			callDirectory: true,
			showUsersLink: true,
			themeIsPerBrowser: true,
			showTeamCopy: true,
			ownerGatesSessionActions: true,
			adminMayClearOthersAttention: true,
			showSummarySharedNote: true,
			machinesMenuLabel: "Machines",
		});
	});

	test("a viewer whose role the server didn't say is treated as a member", () => {
		const row = ownershipUi("team", { effectiveRole: undefined });
		expect(row.adminSettingsLocked).toBe(true);
		expect(row.showTeamSection).toBe(false);
	});
});

describe("notes and CLAUDE.md editing", () => {
	test("the blocked reason names who can edit", () => {
		expect(NOTES_BLOCKED_REASON).toBe(
			"Only the owner or an admin can edit this session's notes and CLAUDE.md.",
		);
	});
});

describe("sessionActionAccess", () => {
	const solo = ownershipUi("solo", { effectiveRole: "member" });
	const teamMember = ownershipUi("team", { effectiveRole: "member" });
	const teamAdmin = ownershipUi("team", { effectiveRole: "admin" });
	const all = {
		canRename: true,
		canPin: true,
		canArchive: true,
		canDelete: true,
		canEditNotes: true,
	};
	const none = {
		canRename: false,
		canPin: false,
		canArchive: false,
		canDelete: false,
		canEditNotes: false,
	};

	test("solo: always allowed, whoever owns the session", () => {
		expect(sessionActionAccess(solo, { ownerUserId: "alice" }, { userId: "bob" })).toEqual(all);
	});

	test("team: the owner may", () => {
		expect(
			sessionActionAccess(
				teamMember,
				{ ownerUserId: "alice" },
				{ userId: "alice", effectiveRole: "member" },
			),
		).toEqual(all);
	});

	test("team: someone else's session is read-only for a member", () => {
		expect(
			sessionActionAccess(
				teamMember,
				{ ownerUserId: "alice" },
				{ userId: "bob", effectiveRole: "member" },
			),
		).toEqual(none);
	});

	test("team: an admin may act on anyone's session", () => {
		expect(
			sessionActionAccess(
				teamAdmin,
				{ ownerUserId: "alice" },
				{ userId: "carol", effectiveRole: "admin" },
			),
		).toEqual(all);
	});

	test("team: an unowned session is open to any member, as on the server", () => {
		expect(
			sessionActionAccess(
				teamMember,
				{ ownerUserId: null },
				{ userId: "bob", effectiveRole: "member" },
			),
		).toEqual(all);
		expect(sessionActionAccess(teamMember, {}, { userId: "bob", effectiveRole: "member" })).toEqual(
			all,
		);
	});

	test("team: a viewer with no user id can't claim to be the owner", () => {
		expect(
			sessionActionAccess(
				teamMember,
				{ ownerUserId: "alice" },
				{ userId: null, effectiveRole: "member" },
			),
		).toEqual(none);
	});
});

describe("RENAME_BLOCKED_REASON", () => {
	test("the one owner-gated action the detail page explains is renaming", () => {
		expect(RENAME_BLOCKED_REASON).toBe("Only the owner or an admin can rename this session.");
	});
});

describe("ADMIN_ONLY_SETTINGS_NOTICE", () => {
	test("the sentence a member reads above admin-only settings", () => {
		expect(ADMIN_ONLY_SETTINGS_NOTICE).toBe("Only admins can change these settings.");
	});
});

describe("viewerIsAdmin", () => {
	test("only the server's word 'admin' counts", () => {
		expect(viewerIsAdmin({ effectiveRole: "admin" })).toBe(true);
		expect(viewerIsAdmin({ effectiveRole: "member" })).toBe(false);
		expect(viewerIsAdmin({ effectiveRole: null })).toBe(false);
		expect(viewerIsAdmin({})).toBe(false);
	});
});

describe("the summary shared note (AGEN-69)", () => {
	test("TC-7.26a false in solo, true in team for a member and an admin alike", () => {
		expect(ownershipUi("solo", { effectiveRole: "admin" }).showSummarySharedNote).toBe(false);
		expect(ownershipUi("team", { effectiveRole: "member" }).showSummarySharedNote).toBe(true);
		expect(ownershipUi("team", { effectiveRole: "admin" }).showSummarySharedNote).toBe(true);
	});
});
