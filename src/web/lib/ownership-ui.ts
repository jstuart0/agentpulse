/**
 * The one place the instance mode is compared. Everything else asks this
 * module what to show: in solo mode every flag is false and the menu is
 * called "Admin", so solo looks exactly as it did before team mode existed.
 * Each flag names a thing that only exists in team mode (or, for
 * `adminSettingsLocked`, a restriction that only exists there).
 */
export type InstanceMode = "solo" | "team";

export interface OwnershipViewer {
	/** What the server says the viewer may do right now. Absent on an older server. */
	effectiveRole?: "admin" | "member" | null;
}

export interface OwnershipUi {
	/** Mine | Everyone switch (the views that read these flags ship separately). */
	showScope: boolean;
	showOwnerSelect: boolean;
	showGroupBy: boolean;
	showOwnerChip: boolean;
	/** An Owner field on session detail, hosts and keys. */
	showOwnerFields: boolean;
	/** The people list and checklist in Settings. Admins only. */
	showTeamSection: boolean;
	showKeyOwner: boolean;
	showHostOwner: boolean;
	/** Admin-only settings are visible but read-only. */
	adminSettingsLocked: boolean;
	/** The user directory is fetched for labels and pickers. */
	callDirectory: boolean;
	/** A "Users" item in the user menu. */
	showUsersLink: boolean;
	/** The theme toggle writes this browser only, not the shared setting. */
	themeIsPerBrowser: boolean;
	/** Copy that talks about "your" keys, hosts and machines. */
	showTeamCopy: boolean;
	/** Archive, rename, pin and delete belong to a session's owner or an admin. */
	ownerGatesSessionActions: boolean;
	/** An admin may mark anyone's session as seen. */
	adminMayClearOthersAttention: boolean;
	/** The Summary panel says everyone on the instance can read a generated summary. */
	showSummarySharedNote: boolean;
	machinesMenuLabel: "Admin" | "Machines";
}

const SOLO_UI: OwnershipUi = {
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
	machinesMenuLabel: "Admin",
};

export function ownershipUi(mode: InstanceMode, viewer: OwnershipViewer): OwnershipUi {
	if (mode !== "team") return SOLO_UI;
	const isAdmin = viewerIsAdmin(viewer);
	return {
		showScope: true,
		showOwnerSelect: true,
		showGroupBy: true,
		showOwnerChip: true,
		showOwnerFields: true,
		showTeamSection: isAdmin,
		showKeyOwner: true,
		showHostOwner: true,
		adminSettingsLocked: !isAdmin,
		callDirectory: true,
		showUsersLink: isAdmin,
		themeIsPerBrowser: true,
		showTeamCopy: true,
		ownerGatesSessionActions: true,
		adminMayClearOthersAttention: isAdmin,
		showSummarySharedNote: true,
		machinesMenuLabel: "Machines",
	};
}

export const ADMIN_ONLY_SETTINGS_NOTICE = "Only admins can change these settings.";

/** Whether the server says this viewer is an admin right now. */
export function viewerIsAdmin(viewer: OwnershipViewer): boolean {
	return viewer.effectiveRole === "admin";
}

// Kept for the iOS repo's fixture generator (harness/gen-domain-cases.ts), which reads these names from this module.
export {
	NOTES_BLOCKED_REASON,
	RENAME_BLOCKED_REASON,
	sessionActionAccess,
} from "./session-action-access.js";
export type { SessionActionAccess } from "./session-action-access.js";
