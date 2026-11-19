import { LOCAL_UPDATER } from "../../shared/constants.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type { SupervisorRecord } from "../../shared/types.js";
import type { UpdateStatusWire } from "../../shared/update-status.js";
import { compareReleaseVersions, parseReleaseVersion } from "../../shared/version.js";
import { type DirectoryEntry, hostLabel } from "../lib/owner-label.js";
import type { OwnershipUi } from "../lib/ownership-ui.js";
import { UPDATE_HOST_COPY } from "../lib/update-outcome-copy.js";

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

// ── A host that is behind the server (AGEN-155) ─────────────────────────────

export interface HostUpdateNoticePart {
	/** `host` is the host's name as plain text, never joined into the command. */
	kind: "text" | "code" | "host";
	text: string;
}

export interface HostUpdateNotice {
	kind: "update_server_first" | "update_host" | "reinstall";
	parts: HostUpdateNoticePart[];
}

/** What supervisors reported before they carried the real version. */
const LEGACY_PLACEHOLDER_VERSION = "0.1.0";
const LOCAL_UPDATE_COMMAND = "~/.agentpulse/bin/agentpulse update";
const SUPERVISOR_ONLY_COMMAND = "install-local.sh --supervisor-only";
/** Server states that mean the server itself has a newer release to move to. */
const SERVER_BEHIND_STATES: ReadonlySet<string> = new Set([
	"available",
	"security",
	"below_minimum",
	"current_pulled",
]);

/**
 * What a host card says when its supervisor is older than the server it reports to. It compares against the
 * server's CURRENT version, not the latest release: a host can't move ahead of its server, so when the server
 * is itself behind, the first step is the server. Shown only to someone who may act on the host (its owner or
 * an admin: `canManage` from `deriveHostAccess`), and never for a revoked host. A version that can't be read
 * on either side says nothing rather than guess.
 */
export function deriveHostUpdateNotice(
	supervisor: Pick<SupervisorRecord, "version" | "hostName" | "enrollmentState" | "capabilities">,
	server: { current: string; state: string } | null,
	access: { canManage: boolean },
): HostUpdateNotice | null {
	if (!access.canManage || !server || supervisor.enrollmentState === "revoked") return null;
	// Supervisors before the real version reported a placeholder "0.1.0": that says nothing about the host.
	if (supervisor.version === LEGACY_PLACEHOLDER_VERSION) return null;
	const host = parseReleaseVersion(supervisor.version);
	const running = parseReleaseVersion(server.current);
	if (!host || !running || compareReleaseVersions(host, running) >= 0) return null;

	const versions: HostUpdateNoticePart = {
		kind: "text",
		text: UPDATE_HOST_COPY.versions(supervisor.version, server.current),
	};
	if (SERVER_BEHIND_STATES.has(server.state)) {
		return {
			kind: "update_server_first",
			parts: [versions, { kind: "text", text: UPDATE_HOST_COPY.serverFirst }],
		};
	}
	if (supervisor.capabilities?.features?.includes(LOCAL_UPDATER)) {
		return {
			kind: "update_host",
			parts: [
				versions,
				{ kind: "text", text: UPDATE_HOST_COPY.runBefore },
				{ kind: "code", text: LOCAL_UPDATE_COMMAND },
				{ kind: "text", text: UPDATE_HOST_COPY.runAfter },
				{ kind: "host", text: supervisor.hostName },
				{ kind: "text", text: UPDATE_HOST_COPY.end },
			],
		};
	}
	return {
		kind: "reinstall",
		parts: [
			versions,
			{ kind: "text", text: UPDATE_HOST_COPY.reinstallBefore },
			{ kind: "code", text: SUPERVISOR_ONLY_COMMAND },
			{ kind: "text", text: UPDATE_HOST_COPY.end },
		],
	};
}

/** The server's own version and update state, for comparing a host against; null until it is known. */
export function serverUpdateOf(
	status: UpdateStatusWire | null,
): { current: string; state: string } | null {
	return status && typeof status.current === "string"
		? { current: status.current, state: status.state }
		: null;
}
