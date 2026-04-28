import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// SQLite returns "2026-04-16 03:54:45", browsers need ISO format with T and Z
export function parseDate(dateStr: string): number {
	// Already ISO format
	if (dateStr.includes("T")) return new Date(dateStr).getTime();
	// SQLite format: "YYYY-MM-DD HH:MM:SS" -- treat as UTC
	return new Date(`${dateStr.replace(" ", "T")}Z`).getTime();
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

export function formatTimeAgo(dateStr: string): string {
	const date = parseDate(dateStr);
	const now = Date.now();
	const diff = now - date;

	if (Number.isNaN(diff) || diff < 0) return "just now";
	if (diff < 60000) return "just now";
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
}

function hueFromString(input: string): number {
	if (!input) return 0;
	let h = 0;
	for (let i = 0; i < input.length; i += 1) {
		h = (h * 31 + input.charCodeAt(i)) | 0;
	}
	// Spread across a curated band of hues that all produce pleasant
	// pastels in dark mode. Avoid the 50–80 range (yellows) which read
	// as warning, and 0–15 (pure red) which reads as error.
	const BANDS = [
		[20, 48], // amber / orange
		[90, 160], // green / teal
		[170, 220], // cyan / blue
		[230, 270], // indigo / violet
		[280, 320], // purple / magenta
		[330, 360], // pink / rose
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
	// CSS light-dark() resolves per html.dark class (we pair it with
	// color-scheme: light / dark in globals.css). Light theme gets a
	// true pastel wash (high lightness, low saturation); dark theme
	// gets a deeper saturated pastel that reads against the dot-grid
	// background.
	return {
		hue,
		bg: `light-dark(hsl(${hue} 55% 94%), hsl(${hue} 28% 13%))`,
		border: `light-dark(hsl(${hue} 45% 78%), hsl(${hue} 40% 38%))`,
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

// Determines the operational mode of a session for UI differentiation.
// Observed = session seen via hooks only (no supervisor launch).
// Interactive/Headless/Managed = supervisor-launched with known managedState.
export function getSessionMode(session: {
	managedSession?: { managedState: string } | null;
}): SessionModeStyle {
	const managedState = session.managedSession?.managedState;
	if (managedState === "interactive_terminal") {
		return {
			mode: "interactive",
			label: "interactive",
			barClass: "bg-teal-400",
			chipClass: "text-teal-300 bg-teal-500/10 border-teal-500/20",
		};
	}
	if (managedState === "headless") {
		return {
			mode: "headless",
			label: "headless",
			barClass: "bg-indigo-400",
			chipClass: "text-indigo-300 bg-indigo-500/10 border-indigo-500/20",
		};
	}
	if (managedState === "managed" || managedState === "degraded") {
		return {
			mode: "managed",
			label: "managed",
			barClass: "bg-violet-400",
			chipClass: "text-violet-300 bg-violet-500/10 border-violet-500/20",
		};
	}
	return {
		mode: "observed",
		label: "observed",
		barClass: "bg-muted-foreground/40",
		chipClass: "text-muted-foreground bg-muted/50 border-border",
	};
}
