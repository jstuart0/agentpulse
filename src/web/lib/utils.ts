import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type { ManagedState } from "../../shared/types.js";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// SQLite returns a bare "YYYY-MM-DD HH:MM:SS" (zone-less, UTC); Postgres
// returns the same shape with an explicit offset. parseStoredTimestamp
// (src/shared/timestamp.ts) is the one parser for both forms plus ISO;
// NaN preserves this function's existing "unparsable -> NaN" contract for
// its callers (formatDuration etc.) rather than throwing or returning null.
export function parseDate(dateStr: string): number {
	return parseStoredTimestamp(dateStr) ?? Number.NaN;
}

export function formatDuration(startedAt: string): string {
	const start = parseDate(startedAt);
	const now = Date.now();
	const diff = now - start;

	if (Number.isNaN(diff) || diff < 0) return "0s";

	const hours = Math.floor(diff / 3600000);
	const minutes = Math.floor((diff % 3600000) / 60000);
	const seconds = Math.floor((diff % 60000) / 1000);

	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function formatTimeAgo(dateStr: string, opts?: { justNow?: boolean }): string {
	const date = parseDate(dateStr);
	const now = Date.now();
	const diff = now - date;

	if (Number.isNaN(diff) || diff < 0) return opts?.justNow ? "just now" : "0s ago";
	if (diff < 60000) {
		// AskPage (and similar) want sub-60s resolution with "Xs ago".
		// Callers that prefer "just now" pass { justNow: true }.
		if (opts?.justNow) return "just now";
		return `${Math.floor(diff / 1000)}s ago`;
	}
	if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
	if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
	return `${Math.floor(diff / 86400000)}d ago`;
}

export function extractProjectName(cwd: string | null): string {
	if (!cwd) return "Unknown";
	const parts = cwd.split("/");
	return parts[parts.length - 1] || "Unknown";
}

/**
 * Deterministic hash → hue mapping so every "project" (last path
 * segment of cwd) gets a stable pastel color across renders and
 * across reloads. Two sessions in different branches of the same
 * repo share a color; two sessions in different repos don't.
 *
 * We live in a dark-mode-first app, so the returned values are tuned
 * to show as subtle tints: low-saturation 8% alpha bg, mid-saturation
 * 30% alpha border. Bright enough to scan-group a grid, muted enough
 * not to fight the status badges and agent-type chips inside the card.
 */

export interface ProjectColor {
	/** CSS background-color value, subtle tint. */
	bg: string;
	/** CSS border-color value, slightly louder than bg. */
	border: string;
	/** Strong accent for the left rail / tab underline. */
	accent: string;
	/** Final resolved hue (0-359) — exposed for callers that want text. */
	hue: number;
	/** Which of the saturation and lightness steps this project got (0-based), so neighbours differ in more than hue. */
	satStep: number;
	lightStep: number;
}

/**
 * Dark-theme wash saturation and lightness, and the matching light-theme pair,
 * one step per project. The bounds are what keeps muted text readable on every
 * tinted card (4.5:1 in both themes, checked for every step by
 * tint-contrast.test.ts) while no wash reads as grey: dark washes stay at or
 * below 13% lightness, light washes at or above 89%, each with enough
 * saturation to stay a colour.
 */
const SATURATION_STEPS = [
	{ dark: 36, light: 58 },
	{ dark: 42, light: 66 },
	{ dark: 48, light: 74 },
];
const LIGHTNESS_STEPS = [
	{ dark: 9, light: 93 },
	{ dark: 11, light: 91 },
	{ dark: 13, light: 89 },
];

/** A second and third hash of the same name, independent of the hue's, so saturation and lightness don't just follow it. */
function stepFromString(input: string, seed: number, steps: number): number {
	let h = seed;
	for (let i = 0; i < input.length; i += 1) {
		h = (Math.imul(h, 16777619) ^ input.charCodeAt(i)) | 0;
	}
	h ^= h >>> 15;
	h = Math.imul(h, 2246822507);
	h ^= h >>> 13;
	return Math.abs(h) % steps;
}

function hueFromString(input: string): number {
	if (!input) return 0;
	let h = 0;
	for (let i = 0; i < input.length; i += 1) {
		h = (h * 31 + input.charCodeAt(i)) | 0;
	}
	// Spread across curated bands of cool hues (green through violet), which
	// make pleasant pastels in dark mode and can never be mistaken for the two
	// status badges a card renders right next to its tint: amber/orange (the
	// WAITING badge) and red/pink/magenta (the ERROR badge, and the wine a dark
	// magenta wash turns into) are excluded entirely.
	const BANDS = [
		[100, 150], // green
		[160, 195], // teal / cyan
		[200, 235], // blue
		[240, 270], // indigo / violet
	];
	const band = BANDS[Math.abs(h) % BANDS.length];
	const offset = Math.abs(h >> 8) % (band[1] - band[0] + 1);
	return band[0] + offset;
}

export function projectColor(cwd: string | null): ProjectColor | null {
	if (!cwd) return null;
	const key = extractProjectName(cwd);
	if (!key || key === "Unknown") return null;
	const hue = hueFromString(key);
	const satStep = stepFromString(key, 2166136261, SATURATION_STEPS.length);
	const lightStep = stepFromString(key, 3266489917, LIGHTNESS_STEPS.length);
	const sat = SATURATION_STEPS[satStep];
	const light = LIGHTNESS_STEPS[lightStep];
	// CSS light-dark() resolves per html.dark class (we pair it with
	// color-scheme: light / dark in globals.css). Light theme gets a
	// true pastel wash (high lightness, low saturation); dark theme
	// gets a deeper saturated pastel that reads against the dot-grid
	// background.
	return {
		hue,
		satStep,
		lightStep,
		bg: `light-dark(hsl(${hue} ${sat.light}% ${light.light}%), hsl(${hue} ${sat.dark}% ${light.dark}%))`,
		border: `light-dark(hsl(${hue} 45% 78%), hsl(${hue} ${sat.dark + 10}% 38%))`,
		accent: `light-dark(hsl(${hue} 55% 55%), hsl(${hue} 65% 65%))`,
	};
}

export type SessionMode = "observed" | "interactive" | "headless" | "managed";

export interface SessionModeStyle {
	mode: SessionMode;
	label: string;
	barClass: string;
	chipClass: string;
}

// Visual styling for every member of the ManagedState union, plus a
// fallback used when no managedSession row exists (observed-only).
// Typed as Record<ManagedState, …> so adding a new member to
// MANAGED_STATES forces this map to be updated — that's the whole
// point of slice TYPE-2b. The previous `default: "observed"` fallback
// silently masked new lifecycle states.
const OBSERVED_STYLE: SessionModeStyle = {
	mode: "observed",
	label: "observed",
	barClass: "bg-muted-foreground/40",
	chipClass: "text-muted-foreground bg-muted/50 border-border",
};

const MANAGED_STATE_STYLES: Record<ManagedState, SessionModeStyle> = {
	interactive_terminal: {
		mode: "interactive",
		label: "interactive",
		barClass: "bg-teal-400",
		chipClass: "text-teal-300 bg-teal-500/10 border-teal-500/20",
	},
	headless: {
		mode: "headless",
		label: "headless",
		barClass: "bg-indigo-400",
		chipClass: "text-indigo-300 bg-indigo-500/10 border-indigo-500/20",
	},
	managed: {
		mode: "managed",
		label: "managed",
		barClass: "bg-violet-400",
		chipClass: "text-violet-300 bg-violet-500/10 border-violet-500/20",
	},
	degraded: {
		mode: "managed",
		label: "managed",
		barClass: "bg-violet-400",
		chipClass: "text-violet-300 bg-violet-500/10 border-violet-500/20",
	},
	// Lifecycle states without a dedicated visual treatment fall back
	// to the observed style (matches the legacy `default:` branch for
	// `pending` / `linked` / `stopped` / `completed` / `failed`).
	pending: OBSERVED_STYLE,
	linked: OBSERVED_STYLE,
	stopped: OBSERVED_STYLE,
	completed: OBSERVED_STYLE,
	failed: OBSERVED_STYLE,
};

// Determines the operational mode of a session for UI differentiation.
// Observed = session seen via hooks only (no supervisor launch).
// Interactive/Headless/Managed = supervisor-launched with known managedState.
export function getSessionMode(session: {
	managedSession?: { managedState: ManagedState } | null;
}): SessionModeStyle {
	const managedState = session.managedSession?.managedState;
	if (!managedState) return OBSERVED_STYLE;
	return MANAGED_STATE_STYLES[managedState];
}

/**
 * Mirrors the server's acknowledge-permission rule for the owner path: the
 * session's owner, an unowned session (including one from an older server that
 * sends no owner), or auth disabled. Auto-acknowledge on the detail page and
 * "Mark all as seen" use only this; viewing or bulk-clearing must never act on
 * someone else's session. An admin's override lives in `explicitAckAccess`.
 */
export function canAcknowledgeSession(
	session: { ownerUserId?: string | null },
	viewerUserId: string | null | undefined,
	disableAuth: boolean,
): boolean {
	return session.ownerUserId == null || disableAuth || viewerUserId === session.ownerUserId;
}

/**
 * The single-session buttons ("Mark as seen", "Dismiss error"): the owner
 * path, plus an admin in team mode acting for someone else. `forOwnerId` is
 * set only when the override is what allows it, so the button can say whose
 * session it is.
 */
export function explicitAckAccess(
	session: { ownerUserId?: string | null },
	viewerUserId: string | null | undefined,
	disableAuth: boolean,
	adminOverride: boolean,
): { allowed: boolean; forOwnerId: string | null } {
	if (canAcknowledgeSession(session, viewerUserId, disableAuth)) {
		return { allowed: true, forOwnerId: null };
	}
	return adminOverride && session.ownerUserId != null
		? { allowed: true, forOwnerId: session.ownerUserId }
		: { allowed: false, forOwnerId: null };
}
