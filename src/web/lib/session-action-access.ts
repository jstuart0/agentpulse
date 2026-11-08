/**
 * What a viewer may do to one session. Split from ownership-ui.ts so the session page and cards load
 * it without the rest of the team-mode flags; the instance mode is still compared only in
 * ownership-ui.ts, which hands this module the `ownerGatesSessionActions` flag.
 */
import type { OwnershipUi } from "./ownership-ui.js";

export interface SessionActionAccess {
	canRename: boolean;
	canPin: boolean;
	canArchive: boolean;
	canDelete: boolean;
	/** The session's notes and its stored CLAUDE.md. */
	canEditNotes: boolean;
	/** Sending a prompt to the session (POST /prompt is owner-checked). */
	canPrompt: boolean;
}

const ALL_ALLOWED: SessionActionAccess = {
	canRename: true,
	canPin: true,
	canArchive: true,
	canDelete: true,
	canEditNotes: true,
	canPrompt: true,
};
const NONE_ALLOWED: SessionActionAccess = {
	canRename: false,
	canPin: false,
	canArchive: false,
	canDelete: false,
	canEditNotes: false,
	canPrompt: false,
};

/**
 * Mirrors the server's owner-or-admin rule for changing a session: solo never
 * refuses; in team mode the owner, an admin, or anyone when the session has
 * no owner. Prompting follows the same rule (POST /prompt is owner-checked);
 * stop and retry aren't asked about here.
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

/**
 * What the viewer may do with the stored detail of a continued session's tool calls (AGEN-123). Display
 * only: the server decides (`mayReadToolDetail`), and this mirrors it so a viewer who would be refused isn't
 * offered a control. Deliberately not derived from `sessionActionAccess`: that rule treats an unowned team
 * session as open to every member, and detail does not (an unowned session's detail is an admin's).
 *  - `allowed`: solo, or the session's owner.
 *  - `admin_on_others`: an admin on a session that is someone else's, or nobody's.
 *  - `denied`: a member on any session but their own.
 */
export type ToolDetailAccess = "allowed" | "admin_on_others" | "denied";

export function toolDetailAccess(
	ui: OwnershipUi,
	session: { ownerUserId?: string | null },
	viewer: { userId?: string | null; effectiveRole?: "admin" | "member" | null },
): ToolDetailAccess {
	if (!ui.ownerGatesSessionActions) return "allowed";
	const owner = session.ownerUserId ?? null;
	if (owner !== null && viewer.userId != null && viewer.userId === owner) return "allowed";
	return viewer.effectiveRole === "admin" ? "admin_on_others" : "denied";
}

export function canReadToolDetail(
	ui: OwnershipUi,
	session: { ownerUserId?: string | null },
	viewer: { userId?: string | null; effectiveRole?: "admin" | "member" | null },
): boolean {
	return toolDetailAccess(ui, session, viewer) !== "denied";
}
