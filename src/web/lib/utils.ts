import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// SQLite returns "2026-04-16 03:54:45", browsers need ISO format with T and Z
function parseDate(dateStr: string): number {
	// Already ISO format
	if (dateStr.includes("T")) return new Date(dateStr).getTime();
	// SQLite format: "YYYY-MM-DD HH:MM:SS" -- treat as UTC
	return new Date(dateStr.replace(" ", "T") + "Z").getTime();
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
