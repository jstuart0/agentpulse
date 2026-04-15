import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function formatDuration(startedAt: string): string {
	const start = new Date(startedAt).getTime();
	const now = Date.now();
	const diff = now - start;

	const hours = Math.floor(diff / 3600000);
	const minutes = Math.floor((diff % 3600000) / 60000);
	const seconds = Math.floor((diff % 60000) / 1000);

	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function formatTimeAgo(dateStr: string): string {
	const date = new Date(dateStr).getTime();
	const now = Date.now();
	const diff = now - date;

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
