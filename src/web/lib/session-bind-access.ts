/**
 * May this viewer take an observed session over, or resume a managed one whose process is gone (AGEN-115)?
 * Its own module, not an export of session-action-access.ts: that module's shape is read by the iOS repo's
 * fixture generator and is re-exported from ownership-ui.ts, which every page loads, and only the session
 * page asks this. The instance mode is still compared only in ownership-ui.ts, which hands this the
 * `ownerGatesSessionActions` flag.
 */
import type { OwnershipUi } from "./ownership-ui.js";

/**
 * Mirrors the
 * server's rule (`mayBindSession`) and is stricter than prompting: solo never refuses; in team mode the
 * session's owner or an admin, and an unowned session is an admin's alone. Display only, the server decides.
 */
export function sessionBindAccess(
	ui: OwnershipUi,
	session: { ownerUserId?: string | null },
	viewer: { userId?: string | null; effectiveRole?: "admin" | "member" | null },
): boolean {
	if (!ui.ownerGatesSessionActions) return true;
	if (viewer.effectiveRole === "admin") return true;
	const owner = session.ownerUserId ?? null;
	return owner !== null && viewer.userId != null && viewer.userId === owner;
}
