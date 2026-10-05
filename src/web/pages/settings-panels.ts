/** The sections of Settings that a link can open directly (`/settings?panel=account`). */
export type SettingsPanel = "account" | "team" | "labs" | "ai";

const PANELS: readonly SettingsPanel[] = ["account", "team", "labs", "ai"];

export function panelFromSearch(search: string): SettingsPanel | null {
	const value = new URLSearchParams(search).get("panel");
	return PANELS.find((panel) => panel === value) ?? null;
}

export function panelAnchorId(panel: SettingsPanel): string {
	return `settings-${panel}`;
}

/**
 * The team and labs sections are always on the page; the account panel only for accounts that
 * have a password here; the AI panel only when the caller says the page has one (an omitted
 * `ai` means it doesn't, so a link can never point at an anchor that isn't there).
 */
export function resolvePanel(
	panel: SettingsPanel | null,
	available: { account: boolean; ai?: boolean },
): SettingsPanel | null {
	if (panel === "account" && !available.account) return null;
	if (panel === "ai" && !available.ai) return null;
	return panel;
}

/** Where the "No AI provider is set up" sentence links: the AI panel when Settings has one, else Settings. */
export function aiSettingsHref(aiPanelAvailable: boolean): string {
	return aiPanelAvailable ? "/settings?panel=ai" : "/settings";
}

/** The section a `?panel=` link opens on this page, or null when the page doesn't have it. */
export function panelToReveal(
	_search: string,
	_available: { account: boolean; ai: boolean },
): SettingsPanel | null {
	return null;
}
