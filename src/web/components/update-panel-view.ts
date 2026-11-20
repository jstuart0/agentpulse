/**
 * The Updates panel's decisions, kept apart from update-view.ts: only the lazy Settings page imports this, so
 * the command templates and this logic stay out of the main chunk.
 */
import type { InstallKind } from "../../shared/install-record.js";
import { type UpdateCommandLine, updateCommandFor } from "../../shared/update-commands.js";
import { RED_UPDATE_STATES, releaseNotesUrl } from "../../shared/update-status.js";
import { parseReleaseVersion } from "../../shared/version.js";
import { ADMIN_ONLY_SETTINGS_NOTICE } from "../lib/ownership-ui.js";
import { UPDATE_PANEL_COPY, outcomeCopy, stateCopy } from "../lib/update-outcome-copy.js";
import type { CheckNotice } from "../stores/update-store.js";
import { type UpdateViewer, type UpdateWire, VERIFICATION_FAILED } from "./update-view.js";

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

/** How the panel writes a time: short ("3h ago") and in full (for a tooltip). Injected so the view stays pure. */
export interface TimeFormat {
	ago: (iso: string) => string;
	full: (iso: string) => string;
}

const PLAIN_TIME: TimeFormat = { ago: (iso) => iso.slice(0, 10), full: (iso) => iso };

const INSTALL_KINDS: readonly string[] = ["local", "kubernetes", "container", "source"];

export interface UpdatePanelView {
	/** The server's own version is in Server Info; this lists only what the update check adds. */
	rows: Array<{
		label: string;
		value: string /** The full time, for a tooltip. */;
		title?: string;
	}>;
	/** What this machine's own updater has done: only an admin's view carries it. Empty when there is nothing to say. */
	autoRows: UpdatePanelView["rows"];
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

/**
 * Why an install that holds no verified release information says so: the words depend on whether anything was
 * published, reachable or checked at all. A real verification failure keeps the "Can't verify" words.
 */
function unverifiedSentence(status: UpdateWire | null, fallback: string): string {
	const result = status?.lastResult;
	if (result === "not_published") return UPDATE_PANEL_COPY.notPublished;
	if (result === "unreachable") return UPDATE_PANEL_COPY.unreachableNoInfo;
	if (result === undefined || result === null) return UPDATE_PANEL_COPY.notChecked;
	return VERIFICATION_FAILED.has(result) ? fallback : UPDATE_PANEL_COPY.notChecked;
}

/** What to say under "Check now", from what the person just did and what the server found. */
export function checkNoticeText(
	notice: CheckNotice,
	lastResult: string | null | undefined,
): string | null {
	switch (notice) {
		case "rate_limited":
			return UPDATE_PANEL_COPY.rateLimited;
		case "failed":
			return UPDATE_PANEL_COPY.checkFailed;
		case "localhost_only":
			return UPDATE_PANEL_COPY.localhostOnly;
		case "checked":
			if (lastResult === "unreachable") return UPDATE_PANEL_COPY.feedUnreachable;
			if (lastResult === "not_published") return UPDATE_PANEL_COPY.notPublished;
			return UPDATE_PANEL_COPY.checkedJustNow;
		default:
			return null;
	}
}

/** The rows for `localApply`: whether automatic updates are on, how the last run ended, and since when it has been waiting. */
function autoRows(status: UpdateWire | null, format: TimeFormat): UpdatePanelView["rows"] {
	const apply = status?.localApply;
	if (typeof apply !== "object" || apply === null) return [];
	const rows: UpdatePanelView["rows"] = [
		{
			label: UPDATE_PANEL_COPY.automatic,
			value: apply.auto === true ? UPDATE_PANEL_COPY.automaticOn : UPDATE_PANEL_COPY.automaticOff,
		},
	];
	if (typeof apply.lastOutcome === "string") {
		const target =
			typeof apply.lastTarget === "string" && parseReleaseVersion(apply.lastTarget)
				? ` (${apply.lastTarget})`
				: "";
		const at = typeof apply.at === "string" ? apply.at : null;
		rows.push({
			label: UPDATE_PANEL_COPY.lastRun,
			value: `${outcomeCopy(apply.lastOutcome).sentence}${target}${at ? ` ${format.ago(at)}` : ""}`,
			...(at ? { title: format.full(at) } : {}),
		});
	}
	if (typeof apply.waitingSince === "string") {
		rows.push({
			label: UPDATE_PANEL_COPY.waitingSince,
			value: format.ago(apply.waitingSince),
			title: format.full(apply.waitingSince),
		});
	}
	return rows;
}

export function derivePanelView(
	status: UpdateWire | null,
	ctx: PanelContext,
	format: TimeFormat = PLAIN_TIME,
): UpdatePanelView {
	const state = status?.state ?? "unknown";
	const latest = status ? validLatest(status) : null;
	const copy = stateCopy(state, latest);
	const hasTarget = HAS_TARGET.has(state) && latest !== null;

	const rows: UpdatePanelView["rows"] = [];
	if (latest) rows.push({ label: UPDATE_PANEL_COPY.latest, value: latest });
	if (typeof status?.checkedAt === "string") {
		rows.push({
			label: UPDATE_PANEL_COPY.lastChecked,
			value: format.ago(status.checkedAt),
			title: format.full(status.checkedAt),
		});
	}

	const published = typeof status?.manifestIssuedAt === "string" ? status.manifestIssuedAt : null;
	const staleLine =
		status?.stale && published ? UPDATE_PANEL_COPY.stale(format.ago(published)) : null;

	const kind =
		typeof status?.installKind === "string" && INSTALL_KINDS.includes(status.installKind)
			? (status.installKind as InstallKind)
			: undefined;
	const command =
		hasTarget && latest && kind && !ctx.adminSettingsLocked
			? updateCommandFor(kind, latest, status?.track ?? null)
			: null;

	let checkNow: UpdatePanelView["checkNow"] = "button";
	if (state === "disabled" || ctx.effectiveRole !== "admin") checkNow = "hidden";
	else if (ctx.disableAuth && !isLoopbackBrowserHost(ctx.hostname)) checkNow = "localhost_only";

	return {
		rows,
		autoRows: ctx.adminSettingsLocked ? [] : autoRows(status, format),
		stateSentence:
			state === "unverified" ? unverifiedSentence(status, copy.sentence) : copy.sentence,
		stateNext: copy.next,
		staleLine,
		command,
		memberNotice: hasTarget && ctx.adminSettingsLocked ? ADMIN_ONLY_SETTINGS_NOTICE : null,
		notesUrl: hasTarget && latest ? releaseNotesUrl(latest) : null,
		checkNow,
		localhostLine: checkNow === "localhost_only" ? UPDATE_PANEL_COPY.localhostOnly : null,
	};
}
