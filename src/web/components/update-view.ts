/**
 * The pure decisions behind the update badge, the banner, the stale-tab line and the Updates panel: who sees
 * what, in what tone, and what a dismissal remembers. The components render exactly what these return, so
 * the rules are held in update-view.test.ts without a DOM.
 *
 * The status is open-valued on the wire: a `state` this build doesn't know reads as "nothing to show". The
 * only datum taken from the status into a sentence, a name or a link is the version, and only after it
 * parses as a release version.
 */
import {
	RED_UPDATE_STATES,
	type UpdateStatusWire,
	releaseNotesUrl,
} from "../../shared/update-status.js";
import { parseReleaseVersion } from "../../shared/version.js";
import {
	MEMBER_RED_COPY,
	UPDATE_BADGE_COPY,
	UPDATE_NOTICE_COPY,
	stateCopy,
} from "../lib/update-outcome-copy.js";

export type UpdateWire = UpdateStatusWire;

export interface UpdateViewer {
	/** Team mode and not an admin: red states only, and no command. */
	adminSettingsLocked: boolean;
}

type RedState = (typeof RED_UPDATE_STATES)[number];

function isRed(state: string): state is RedState {
	return (RED_UPDATE_STATES as readonly string[]).includes(state);
}

/** The latest version, only when it is a release version: nothing else is ever inserted into text or a link. */
function validLatest(status: UpdateWire): string | null {
	const { latest } = status;
	return typeof latest === "string" && parseReleaseVersion(latest) ? latest : null;
}

// ── The badge ────────────────────────────────────────────────────────────────

export interface UpdateBadgeView {
	tone: "quiet" | "red";
	state: string;
	/** What is shown: words, not colour alone. */
	text: string;
	/** The accessible name; it begins with `text`, so the visible label is inside it. */
	name: string;
}

export function deriveUpdateBadge(
	status: UpdateWire | null,
	viewer: UpdateViewer,
): UpdateBadgeView | null {
	if (!status) return null;
	const { state } = status;
	const latest = validLatest(status);
	if (isRed(state)) {
		const label = UPDATE_BADGE_COPY[state];
		return { tone: "red", state, text: label.text, name: label.name(latest) };
	}
	// Members can't update the server: a quiet "available" or "can't verify" is noise for them.
	if (viewer.adminSettingsLocked) return null;
	if (state === "available") {
		const label = UPDATE_BADGE_COPY.available;
		return { tone: "quiet", state, text: label.text, name: label.name(latest) };
	}
	if (state === "unverified") {
		const label = UPDATE_BADGE_COPY.unverified;
		return { tone: "quiet", state, text: label.text, name: label.name() };
	}
	return null;
}

// ── The banner ───────────────────────────────────────────────────────────────

export interface UpdateBannerView {
	state: RedState;
	latest: string | null;
	text: string;
	notesUrl: string | null;
	/** An admin is pointed at the Updates panel; a member gets the notes link but no way to act. */
	howTo: boolean;
}

export function deriveUpdateBanner(
	status: UpdateWire | null,
	viewer: UpdateViewer,
): UpdateBannerView | null {
	if (!status || !isRed(status.state)) return null;
	const latest = validLatest(status);
	const state = status.state;
	let text: string = MEMBER_RED_COPY[state];
	if (!viewer.adminSettingsLocked) {
		const copy = stateCopy(state, latest);
		text = copy.next ? `${copy.sentence} ${copy.next}` : copy.sentence;
	}
	return {
		state,
		latest,
		text,
		notesUrl: latest ? releaseNotesUrl(latest) : null,
		howTo: !viewer.adminSettingsLocked,
	};
}

/** The key a dismissal is stored under: the state and the version, so a new state or version shows again. */
export function dismissalKey(state: string, latest: string | null): string {
	return `agentpulse.update.dismissed.${state}.${latest ?? "none"}`;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export function isBannerDismissed(
	storage: ReadStorage | null,
	banner: Pick<UpdateBannerView, "state" | "latest">,
): boolean {
	try {
		return storage?.getItem(dismissalKey(banner.state, banner.latest)) === "1";
	} catch {
		return false;
	}
}

export function dismissBanner(
	storage: WriteStorage | null,
	banner: Pick<UpdateBannerView, "state" | "latest">,
): void {
	try {
		storage?.setItem(dismissalKey(banner.state, banner.latest), "1");
	} catch {
		// storage unavailable: the banner just comes back on the next load
	}
}

/**
 * What the polite live region says: the banner's text, but only when the state turns red while the page is
 * open. Nothing on first load (`previous` is null), nothing for a state that was already showing.
 */
export function bannerAnnouncement(
	previous: string | null,
	banner: UpdateBannerView | null,
): string | null {
	if (!banner || previous === null || previous === banner.state) return null;
	return banner.text;
}

/** Where focus goes when the banner is dismissed: the first badge actually on screen, else the page heading. */
export function focusAfterDismiss<B extends { offsetParent: unknown }, F>(
	badges: readonly B[],
	fallback: F,
): B | F {
	return badges.find((badge) => badge.offsetParent !== null) ?? fallback;
}

// ── The stale-tab line ───────────────────────────────────────────────────────

export interface StaleTabView {
	text: string;
	reloadLabel: string;
}

/** The server is running a different version than the one this tab loaded. Never in a dev build. */
export function deriveStaleTab(
	serverVersion: string | undefined,
	buildVersion: string | undefined,
): StaleTabView | null {
	if (!serverVersion || !buildVersion || buildVersion === "dev") return null;
	if (!parseReleaseVersion(serverVersion) || !parseReleaseVersion(buildVersion)) return null;
	if (serverVersion === buildVersion) return null;
	return {
		text: UPDATE_NOTICE_COPY.staleTab(serverVersion),
		reloadLabel: UPDATE_NOTICE_COPY.reload,
	};
}

/** Stale-tab line first: a reload may clear the red state, so it is the first thing to try. */
export function orderNotices(input: {
	staleTab: StaleTabView | null;
	banner: UpdateBannerView | null;
}): Array<"stale_tab" | "banner"> {
	return [
		...(input.staleTab ? (["stale_tab"] as const) : []),
		...(input.banner ? (["banner"] as const) : []),
	];
}
