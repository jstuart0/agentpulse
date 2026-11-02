import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type { SupervisorRecord } from "../../shared/types.js";
import { type DirectoryEntry, hostLabel } from "../lib/owner-label.js";
import type { OwnershipUi } from "../lib/ownership-ui.js";

/**
 * Pure derivation of what HostsPage should render. Splits the "no hosts
 * are registered yet" empty state from a failed `GET /admin/supervisors`
 * request — the symptom this exists to fix: the page used to render the
 * genuine-empty-state copy indistinguishably from a silently failed load,
 * which is exactly how a registered-but-invisible host goes unnoticed.
 *
 * `loadError` takes priority over the supervisors list even when the list
 * is non-empty — a failed refresh leaves stale data on screen, and stale
 * data presented as current is its own kind of silent failure.
 */
export type HostsViewState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "empty" }
	| { kind: "populated"; supervisors: SupervisorRecord[] };

export function deriveHostsViewState(params: {
	loading: boolean;
	loadError: string | null;
	supervisors: SupervisorRecord[];
}): HostsViewState {
	if (params.loading) return { kind: "loading" };
	if (params.loadError) return { kind: "error", message: params.loadError };
	if (params.supervisors.length === 0) return { kind: "empty" };
	return { kind: "populated", supervisors: params.supervisors };
}

// ── Owner, and who may rotate or revoke ─────────────────────────────────────

export interface HostAccess {
	/** The Owner field's text; null when the field isn't shown (solo). */
	ownerText: string | null;
	canManage: boolean;
	/** Why Rotate and Revoke are disabled, shown under them. */
	manageReason: string | null;
	/** Owning a host gates rotate and revoke only; this says anyone may still launch. */
	launchNote: string | null;
	canChangeOwner: boolean;
}

export function deriveHostAccess(
	supervisor: Pick<SupervisorRecord, "ownerUserId" | "enrollmentState">,
	ctx: {
		ui: OwnershipUi;
		viewerUserId: string | null;
		isAdmin: boolean;
		ownerName: (id: string) => string;
	},
): HostAccess {
	if (!ctx.ui.showHostOwner) {
		return {
			ownerText: null,
			canManage: true,
			manageReason: null,
			launchNote: null,
			canChangeOwner: false,
		};
	}

	const owner = supervisor.ownerUserId ?? null;
	const ownerText = owner === null ? "Unassigned" : ctx.ownerName(owner);
	const isMine = owner !== null && owner === ctx.viewerUserId;
	const canManage = ctx.isAdmin || isMine;
	return {
		ownerText,
		canManage,
		manageReason: canManage
			? null
			: owner === null
				? "Only an admin can rotate or revoke an unassigned host."
				: ownerText.trim().toLowerCase() === "admin"
					? "Only its owner (admin) or another admin can rotate or revoke this host."
					: `Only ${ownerText} or an admin can rotate or revoke this host.`,
		// A revoked host can't run a launch for anyone.
		launchNote:
			canManage || supervisor.enrollmentState === "revoked"
				? null
				: "Anyone can still launch on this host.",
		canChangeOwner: ctx.isAdmin,
	};
}

export function enrollmentOwnershipNote(ui: OwnershipUi): string | null {
	return ui.showTeamCopy ? "Hosts you enroll are yours." : null;
}

/** What a host is called wherever it is picked as a launch target: in team mode, with whose it is. */
export function launchHostLabel(
	ui: OwnershipUi,
	supervisor: Pick<SupervisorRecord, "hostName" | "ownerUserId">,
	lookup: (id: string) => DirectoryEntry | undefined,
	selfId?: string | null,
): string {
	return ui.showHostOwner
		? hostLabel(supervisor.hostName, supervisor.ownerUserId, lookup, selfId)
		: supervisor.hostName;
}

/** What the confirmation says before a host's credential is replaced or its access removed. */
export function hostActionConfirm(
	kind: "rotate" | "revoke",
	hostName: string,
): { title: string; body: string; confirmLabel: string } {
	return kind === "rotate"
		? {
				title: `Re-enroll ${hostName}?`,
				body: "This creates a one-time token. When it is used, the host's current credential is replaced and anything still using the old one stops working.",
				confirmLabel: "Create token",
			}
		: {
				title: `Revoke ${hostName}?`,
				body: "The host can't report or run launches until an admin enrolls it again. It stays listed here.",
				confirmLabel: "Revoke host",
			};
}

/** Choosing the owner a host already has sends nothing. `chosen` is the select's value ("" for Unassigned). */
export function hostOwnerUnchanged(current: string | null | undefined, chosen: string): boolean {
	return (current ?? "") === chosen;
}

/** The line under the owner picker. A revoked host can't run launches, so it doesn't say anyone can. */
export function hostOwnerDialogNote(host: Pick<SupervisorRecord, "enrollmentState">): string {
	const base = "The owner (and any admin) can rotate or revoke this host.";
	return host.enrollmentState === "revoked" ? base : `${base} Anyone can still launch on it.`;
}

/**
 * The one notice a host card carries about its exclude file: only when the
 * supervisor said the file is invalid (it then sends no session data until the
 * file is fixed) AND that supervisor is still alive. A host whose heartbeat lease
 * has run out (or that the server already calls stale or offline) said "invalid"
 * some time ago and may since have been fixed, restarted or removed, so the flag
 * is not evidence of anything now. Anything else, including null or absent (the
 * server keeps no other state) and anything unexpected, shows nothing.
 */
export type HostExcludeNotice = { text: string };

export const HOST_EXCLUDE_INVALID_TEXT =
	"This host's supervisor is sending nothing: its exclude file or its saved exclude state has an error. Run agentpulse exclude check on that machine.";

function leaseIsLive(leaseExpiresAt: string | undefined, now: number): boolean {
	const expiry = parseStoredTimestamp(leaseExpiresAt);
	return expiry !== null && expiry > now;
}

export function deriveHostExcludeNotice(
	supervisor: Pick<SupervisorRecord, "excludeRulesState" | "status" | "heartbeatLeaseExpiresAt">,
	now: number = Date.now(),
): HostExcludeNotice | null {
	if (supervisor.excludeRulesState !== "invalid") return null;
	if (supervisor.status !== "connected") return null;
	if (!leaseIsLive(supervisor.heartbeatLeaseExpiresAt, now)) return null;
	return { text: HOST_EXCLUDE_INVALID_TEXT };
}

// ── the offline outbox notice ────────────────────────────────────────────────────────────────

/** How long after a flush a host still says what it delivered and lost. */
const OUTBOX_RECOVERED_MS = 24 * 60 * 60 * 1000;

export type HostOutboxNotice = {
	kind: "catching-up" | "recovered" | "offline";
	text: string;
	/** Events the host could not keep; the notice is amber only when this is above zero. */
	lost: number;
};

export const HOST_OUTBOX_OFFLINE_TEXT =
	"This host keeps its sessions' events while it's offline and sends them when it reconnects.";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PLURALS = new Intl.PluralRules("en");

/** "1 event", "3 events". */
function events(n: number): string {
	return `${n} ${PLURALS.select(n) === "one" ? "event" : "events"}`;
}

/** The time of day (24-hour, local) for today, else "Mon 3 Nov, 14:02". */
export function formatOutboxTime(iso: string | null | undefined, now: number): string | null {
	const ms = parseStoredTimestamp(iso ?? undefined);
	if (ms === null) return null;
	const at = new Date(ms);
	const today = new Date(now);
	const pad = (n: number) => String(n).padStart(2, "0");
	const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
	const sameDay =
		at.getFullYear() === today.getFullYear() &&
		at.getMonth() === today.getMonth() &&
		at.getDate() === today.getDate();
	if (sameDay) return clock;
	return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${clock}`;
}

/**
 * The one notice a host card carries about its offline outbox, from what the host last reported:
 *  - catching up: the host is live and still holds events from while it was offline;
 *  - recovered: it is live, holds nothing, and flushed within a day (hidden when that moved nothing);
 *  - offline: its lease has run out, and it keeps its sessions' events until it reconnects.
 * Never for a revoked or pending host. The reported figures are the last the host sent, so the live
 * branches also need a live lease, as the exclude notice does.
 */
export function deriveHostOutboxNotice(
	supervisor: Pick<
		SupervisorRecord,
		"outbox" | "status" | "heartbeatLeaseExpiresAt" | "enrollmentState" | "capabilities"
	>,
	now: number = Date.now(),
): HostOutboxNotice | null {
	const enrollment = supervisor.enrollmentState ?? "active";
	if (enrollment !== "active") return null;
	if (!leaseIsLive(supervisor.heartbeatLeaseExpiresAt, now)) {
		return supervisor.capabilities?.features?.includes("offline_outbox")
			? { kind: "offline", text: HOST_OUTBOX_OFFLINE_TEXT, lost: 0 }
			: null;
	}
	if (supervisor.status !== "connected") return null;
	const outbox = supervisor.outbox;
	if (!outbox) return null;
	if (outbox.pending > 0) {
		const oldest = formatOutboxTime(outbox.oldestPendingAt, now);
		return {
			kind: "catching-up",
			text: `Catching up: ${events(outbox.pending)} from while this host was offline${
				oldest ? `, the oldest from ${oldest}` : ""
			}.`,
			lost: 0,
		};
	}
	const flushedMs = parseStoredTimestamp(outbox.lastFlushAt ?? undefined);
	if (flushedMs === null || now - flushedMs > OUTBOX_RECOVERED_MS) return null;
	const delivered = outbox.lastFlushDelivered;
	const lost = outbox.lastFlushLost;
	if (delivered <= 0 && lost <= 0) return null;
	let text = `Back online ${formatOutboxTime(outbox.lastFlushAt, now)}.`;
	if (delivered > 0)
		text += ` ${delivered} late ${PLURALS.select(delivered) === "one" ? "event" : "events"} delivered.`;
	if (lost > 0) {
		text += ` ${events(lost)} lost: the host's offline queue was full or they were more than a day old.`;
	}
	return { kind: "recovered", text, lost };
}

/**
 * What a screen reader is told when a host's notice changes: the new notice's sentence when it changes
 * branch, "Caught up." when the catching-up notice goes away, and nothing for a change in a count.
 */
export function outboxAnnouncement(
	prev: HostOutboxNotice | null,
	next: HostOutboxNotice | null,
): string | null {
	if (next && next.kind !== prev?.kind) return next.text;
	if (!next && prev?.kind === "catching-up") return "Caught up.";
	return null;
}
