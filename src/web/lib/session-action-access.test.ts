import { describe, expect, test } from "bun:test";
import { ownershipUi } from "./ownership-ui.js";
import {
	NOTES_BLOCKED_REASON,
	RENAME_BLOCKED_REASON,
	sessionActionAccess,
} from "./session-action-access.js";

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
		canPrompt: true,
	};
	const none = {
		canRename: false,
		canPin: false,
		canArchive: false,
		canDelete: false,
		canEditNotes: false,
		canPrompt: false,
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

describe("canPrompt follows the same owner-or-admin rule", () => {
	const solo = ownershipUi("solo", { effectiveRole: "member" });
	const team = ownershipUi("team", { effectiveRole: "member" });
	const admin = ownershipUi("team", { effectiveRole: "admin" });

	test("solo always, team owner and admin, not a team member who isn't the owner", () => {
		expect(sessionActionAccess(solo, { ownerUserId: "a" }, { userId: "b" }).canPrompt).toBe(true);
		const owner = { userId: "a", effectiveRole: "member" as const };
		expect(sessionActionAccess(team, { ownerUserId: "a" }, owner).canPrompt).toBe(true);
		const other = { userId: "b", effectiveRole: "member" as const };
		expect(sessionActionAccess(team, { ownerUserId: "a" }, other).canPrompt).toBe(false);
		expect(
			sessionActionAccess(admin, { ownerUserId: "a" }, { userId: "c", effectiveRole: "admin" })
				.canPrompt,
		).toBe(true);
	});
});

describe("RENAME_BLOCKED_REASON", () => {
	test("the one owner-gated action the detail page explains is renaming", () => {
		expect(RENAME_BLOCKED_REASON).toBe("Only the owner or an admin can rename this session.");
	});
});
