/**
 * AGEN-69 phase 8a: the Settings page opens the section a `?panel=` link names, and `?panel=ai`
 * counts only while the page has an AI section (the Labs flag `aiSettingsPanel`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LabsFlags } from "../lib/api.js";
import type { SettingsPanel } from "../pages/settings-panels.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useUserStore } from "../stores/user-store.js";
import { installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useSettingsPanelToReveal } from "./useSettingsPanelToReveal.js";

const flags = (aiSettingsPanel: boolean) => ({ aiSettingsPanel }) as unknown as LabsFlags;

async function reveal(search: string): Promise<SettingsPanel | null> {
	const probe = renderHook((s: string) => useSettingsPanelToReveal(s), search);
	await probe.render(search);
	const value = probe.current.value ?? null;
	await probe.unmount();
	return value;
}

beforeEach(() => {
	installDomStubs();
	useUserStore.setState({ user: { source: "local" } } as never);
});
afterEach(() => {
	removeDomStubs();
	useLabsStore.setState({ flags: null });
	useUserStore.setState({ user: null } as never);
});

describe("useSettingsPanelToReveal", () => {
	test("?panel=ai opens the AI section while the page has one, and nothing once it doesn't", async () => {
		useLabsStore.setState({ flags: flags(true) });
		expect(await reveal("?panel=ai")).toBe("ai");
		useLabsStore.setState({ flags: flags(false) });
		expect(await reveal("?panel=ai")).toBeNull();
	});

	test("labs always opens; account opens only for a local account", async () => {
		useLabsStore.setState({ flags: flags(false) });
		expect(await reveal("?panel=labs")).toBe("labs");
		expect(await reveal("?panel=account")).toBe("account");
		useUserStore.setState({ user: { source: "forwardauth" } } as never);
		expect(await reveal("?panel=account")).toBeNull();
	});
});
