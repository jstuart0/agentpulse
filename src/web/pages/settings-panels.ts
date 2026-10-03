/** The sections of Settings that a link can open directly (`/settings?panel=account`). */
export type SettingsPanel = "account" | "team";

const PANELS: readonly SettingsPanel[] = ["account", "team"];

export function panelFromSearch(search: string): SettingsPanel | null {
	const value = new URLSearchParams(search).get("panel");
	return PANELS.find((panel) => panel === value) ?? null;
}

export function panelAnchorId(panel: SettingsPanel): string {
	return `settings-${panel}`;
}

/** The team section is always on the page; the account panel only for accounts that have a password here. */
export function resolvePanel(
	panel: SettingsPanel | null,
	available: { account: boolean },
): SettingsPanel | null {
	if (panel === "account" && !available.account) return null;
	return panel;
}
