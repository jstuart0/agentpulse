import { describe, expect, test } from "bun:test";
import { panelAnchorId, panelFromSearch, resolvePanel } from "./settings-panels.js";

describe("panelFromSearch", () => {
	test("?panel=account and ?panel=team", () => {
		expect(panelFromSearch("?panel=account")).toBe("account");
		expect(panelFromSearch("?panel=team")).toBe("team");
		expect(panelFromSearch("?x=1&panel=team")).toBe("team");
	});

	test("anything else is no panel", () => {
		expect(panelFromSearch("")).toBeNull();
		expect(panelFromSearch("?panel=billing")).toBeNull();
		expect(panelFromSearch("?panel=")).toBeNull();
		expect(panelFromSearch("?panel=TEAM")).toBeNull();
	});
});

describe("panelAnchorId and resolvePanel", () => {
	test("each panel has its own anchor", () => {
		expect(panelAnchorId("account")).toBe("settings-account");
		expect(panelAnchorId("team")).toBe("settings-team");
	});

	test("the team section is always there; the account panel only for accounts that have a password", () => {
		expect(resolvePanel("team", { account: false })).toBe("team");
		expect(resolvePanel("account", { account: true })).toBe("account");
		expect(resolvePanel("account", { account: false })).toBeNull();
		expect(resolvePanel(null, { account: true })).toBeNull();
	});
});
