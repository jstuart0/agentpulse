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
