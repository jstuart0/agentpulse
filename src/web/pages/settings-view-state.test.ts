import { describe, expect, test } from "bun:test";
import { sectionLoad, settingsSectionOrder } from "./settings-view-state.js";

describe("sectionLoad", () => {
	test("loaded: inputs work and saving is allowed", () => {
		expect(sectionLoad("ok", "the settings")).toEqual({
			showError: false,
			message: null,
			inputsDisabled: false,
			canSave: true,
		});
	});

	test("failed: an error that names what didn't load, inputs off, nothing saves from defaults", () => {
		expect(sectionLoad("failed", "the settings")).toEqual({
			showError: true,
			message: "Couldn't load the settings.",
			inputsDisabled: true,
			canSave: false,
		});
		expect(sectionLoad("failed", "API keys").message).toBe("Couldn't load API keys.");
	});

	test("still loading: no error yet, but nothing can be edited or saved", () => {
		expect(sectionLoad("loading", "the settings")).toEqual({
			showError: false,
			message: null,
			inputsDisabled: true,
			canSave: false,
		});
	});
});

describe("settingsSectionOrder", () => {
	test("solo: the order the page has always had", () => {
		expect(settingsSectionOrder(false)).toEqual([
			"appearance",
			"supervisor",
			"launches",
			"session-config",
			"labs",
			"ai",
			"workspaces",
			"telegram",
			"team",
			"keys",
			"account",
			"server",
		]);
	});

	test("team: people, keys and account right after appearance, the rest in their order", () => {
		expect(settingsSectionOrder(true)).toEqual([
			"appearance",
			"team",
			"keys",
			"account",
			"supervisor",
			"launches",
			"session-config",
			"labs",
			"ai",
			"workspaces",
			"telegram",
			"server",
		]);
	});

	test("every section appears exactly once in both orders", () => {
		for (const teamOn of [false, true]) {
			const order = settingsSectionOrder(teamOn);
			expect(new Set(order).size).toBe(order.length);
			expect(order).toHaveLength(12);
		}
	});
});
