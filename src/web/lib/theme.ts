export type AppTheme = "dark" | "light";

const STORAGE_KEY = "agentpulse-theme";

export function applyTheme(theme: AppTheme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
	document.documentElement.dataset.theme = theme;
}

export function getStoredTheme(): AppTheme | null {
	try {
		const value = window.localStorage.getItem(STORAGE_KEY);
		return value === "dark" || value === "light" ? value : null;
	} catch {
		return null;
	}
}

export function persistTheme(theme: AppTheme) {
	try {
		window.localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// Ignore storage failures.
	}
	applyTheme(theme);
}

export function resolveInitialTheme(): AppTheme {
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function asTheme(value: unknown): AppTheme | null {
	return value === "dark" || value === "light" ? value : null;
}

/**
 * Which theme to apply once the shared setting is known. Solo: the shared
 * setting wins and is remembered in this browser (as it always was). Team:
 * the shared setting would change everyone's screen, so this browser's own
 * choice wins, and the shared one is only a starting point that isn't saved
 * as theirs. Null means leave the page as it is.
 */
export function themeToApply(input: {
	perBrowser: boolean;
	stored: AppTheme | null;
	server: unknown;
}): { theme: AppTheme; persist: boolean } | null {
	const server = asTheme(input.server);
	if (input.perBrowser) {
		const theme = input.stored ?? server;
		return theme ? { theme, persist: false } : null;
	}
	if (server) return { theme: server, persist: true };
	return input.stored ? { theme: input.stored, persist: false } : null;
}
