import { describe, expect, test } from "bun:test";
import {
	aiSettingsHref,
	panelAnchorId,
	panelFromSearch,
	panelToReveal,
	resolvePanel,
} from "./settings-panels.js";

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

describe("the labs and ai panels (AGEN-69)", () => {
	test("TC-7.32a both resolve from the query and have anchors", () => {
		expect(panelFromSearch("?panel=labs")).toBe("labs");
		expect(panelFromSearch("?panel=ai")).toBe("ai");
		expect(panelAnchorId("labs")).toBe("settings-labs");
		expect(panelAnchorId("ai")).toBe("settings-ai");
	});

	test("TC-7.32b labs is always there; ai falls back when unavailable, including when the caller doesn't say", () => {
		expect(resolvePanel("labs", { account: false })).toBe("labs");
		expect(resolvePanel("ai", { account: false, ai: true })).toBe("ai");
		expect(resolvePanel("ai", { account: true, ai: false })).toBeNull();
		expect(resolvePanel("ai", { account: true })).toBeNull();
	});

	test("TC-7.32d the no-provider link is never dead", () => {
		expect(aiSettingsHref(true)).toBe("/settings?panel=ai");
		expect(aiSettingsHref(false)).toBe("/settings");
	});
});

describe("panelToReveal (AGEN-69 phase 8a)", () => {
	test("?panel=ai opens the AI section only when the page has one; labs and team always", () => {
		expect(panelToReveal("?panel=ai", { account: true, ai: true })).toBe("ai");
		expect(panelToReveal("?panel=ai", { account: true, ai: false })).toBeNull();
		expect(panelToReveal("?panel=labs", { account: false, ai: false })).toBe("labs");
		expect(panelToReveal("?panel=team", { account: false, ai: false })).toBe("team");
	});

	test("account still needs a local account; anything else is nothing", () => {
		expect(panelToReveal("?panel=account", { account: false, ai: true })).toBeNull();
		expect(panelToReveal("?panel=account", { account: true, ai: true })).toBe("account");
		expect(panelToReveal("", { account: true, ai: true })).toBeNull();
		expect(panelToReveal("?panel=nope", { account: true, ai: true })).toBeNull();
	});
});
