import { type SettingsPanel, panelToReveal } from "../pages/settings-panels.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useUserStore } from "../stores/user-store.js";

/**
 * The Settings section a `?panel=` link opens, given what this page has: the account section for
 * a local account, the AI section while the Labs flag `aiSettingsPanel` keeps it on the page.
 */
export function useSettingsPanelToReveal(search: string): SettingsPanel | null {
	const ai = useLabsStore((s) => s.isEnabled("aiSettingsPanel"));
	const account = useUserStore((s) => s.user?.source === "local");
	return panelToReveal(search, { account, ai });
}
