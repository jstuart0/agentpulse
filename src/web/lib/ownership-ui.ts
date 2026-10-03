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
		machinesMenuLabel: "Machines",
	};
}

export interface SessionActionAccess {
	canRename: boolean;
	canPin: boolean;
	canArchive: boolean;
	canDelete: boolean;
	/** The session's notes and its stored CLAUDE.md. */
	canEditNotes: boolean;
}

const ALL_ALLOWED: SessionActionAccess = {
	canRename: true,
	canPin: true,
	canArchive: true,
	canDelete: true,
	canEditNotes: true,
};
const NONE_ALLOWED: SessionActionAccess = {
	canRename: false,
	canPin: false,
	canArchive: false,
	canDelete: false,
	canEditNotes: false,
};

/**
 * Mirrors the server's owner-or-admin rule for changing a session: solo never
 * refuses; in team mode the owner, an admin, or anyone when the session has
 * no owner. Prompts, stop and retry are open to everyone and aren't asked
 * about here.
 */
export function sessionActionAccess(
	ui: OwnershipUi,
	session: { ownerUserId?: string | null },
	viewer: { userId?: string | null; effectiveRole?: "admin" | "member" | null },
): SessionActionAccess {
	if (!ui.ownerGatesSessionActions) return ALL_ALLOWED;
	if (viewer.effectiveRole === "admin") return ALL_ALLOWED;
	const owner = session.ownerUserId ?? null;
	if (owner === null) return ALL_ALLOWED;
	return viewer.userId != null && viewer.userId === owner ? ALL_ALLOWED : NONE_ALLOWED;
}

/** What the Notes and CLAUDE.md editors say when the viewer can't edit them. */
export const NOTES_BLOCKED_REASON =
	"Only the owner or an admin can edit this session's notes and CLAUDE.md.";

/** What the session name says when someone who can't rename tries to. The detail page has no other owner-gated control that explains itself. */
export const RENAME_BLOCKED_REASON = "Only the owner or an admin can rename this session.";

export const ADMIN_ONLY_SETTINGS_NOTICE = "Only admins can change these settings.";

/** Whether the server says this viewer is an admin right now. */
export function viewerIsAdmin(viewer: OwnershipViewer): boolean {
	return viewer.effectiveRole === "admin";
}
