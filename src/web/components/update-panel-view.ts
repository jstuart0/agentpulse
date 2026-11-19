/**
 * The Updates panel's decisions, kept apart from update-view.ts: only the lazy Settings page imports this, so
 * the command templates and this logic stay out of the main chunk.
 */
import type { InstallKind } from "../../shared/install-record.js";
import { type UpdateCommandLine, updateCommandFor } from "../../shared/update-commands.js";
import { RED_UPDATE_STATES, releaseNotesUrl } from "../../shared/update-status.js";
import { parseReleaseVersion } from "../../shared/version.js";
import { ADMIN_ONLY_SETTINGS_NOTICE } from "../lib/ownership-ui.js";
import { UPDATE_PANEL_COPY, stateCopy } from "../lib/update-outcome-copy.js";
import type { UpdateViewer, UpdateWire } from "./update-view.js";

/** The latest version, only when it is a release version. */
function validLatest(status: UpdateWire): string | null {
	const { latest } = status;
	return typeof latest === "string" && parseReleaseVersion(latest) ? latest : null;
}

// ── The Updates panel ────────────────────────────────────────────────────────

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** A whole-name test: nothing that merely starts with "localhost" or "127.". */
export function isLoopbackBrowserHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "[::1]" ||
		hostname === "::1" ||
		LOOPBACK_V4.test(hostname)
	);
}

export interface PanelContext extends UpdateViewer {
	effectiveRole: "admin" | "member" | null | undefined;
	disableAuth: boolean;
	hostname: string;
}

export interface UpdatePanelView {
	rows: Array<{ label: string; value: string }>;
	stateSentence: string;
	stateNext: string | null;
	staleLine: string | null;
	/** How to update, for someone who may; null when there is no newer version to go to. */
	command: UpdateCommandLine[] | null;
	memberNotice: string | null;
	notesUrl: string | null;
	checkNow: "button" | "hidden" | "localhost_only";
	localhostLine: string | null;
}

/** States that name a newer release to move to. */
const HAS_TARGET: ReadonlySet<string> = new Set(["available", ...RED_UPDATE_STATES]);

export function derivePanelView(status: UpdateWire | null, ctx: PanelContext): UpdatePanelView {
	const state = status?.state ?? "unknown";
	const latest = status ? validLatest(status) : null;
	const copy = stateCopy(state, latest);
	const hasTarget = HAS_TARGET.has(state) && latest !== null;

	const rows: UpdatePanelView["rows"] = [];
	if (typeof status?.current === "string") {
		rows.push({ label: UPDATE_PANEL_COPY.running, value: status.current });
	}
	if (latest) rows.push({ label: UPDATE_PANEL_COPY.latest, value: latest });
	if (typeof status?.checkedAt === "string") {
		rows.push({ label: UPDATE_PANEL_COPY.lastChecked, value: status.checkedAt });
	}

	const published =
		typeof status?.manifestIssuedAt === "string" ? status.manifestIssuedAt.slice(0, 10) : null;
	const staleLine = status?.stale && published ? UPDATE_PANEL_COPY.stale(published) : null;

	const kind = status?.installKind as InstallKind | undefined;
	const command =
		hasTarget && latest && kind && !ctx.adminSettingsLocked
			? updateCommandFor(kind, latest, status?.track ?? null)
			: null;

	let checkNow: UpdatePanelView["checkNow"] = "button";
	if (state === "disabled" || ctx.effectiveRole !== "admin") checkNow = "hidden";
	else if (ctx.disableAuth && !isLoopbackBrowserHost(ctx.hostname)) checkNow = "localhost_only";

	return {
		rows,
		stateSentence: copy.sentence,
		stateNext: copy.next,
		staleLine,
		command,
		memberNotice: hasTarget && ctx.adminSettingsLocked ? ADMIN_ONLY_SETTINGS_NOTICE : null,
		notesUrl: hasTarget && latest ? releaseNotesUrl(latest) : null,
		checkNow,
		localhostLine: checkNow === "localhost_only" ? UPDATE_PANEL_COPY.localhostOnly : null,
	};
}
