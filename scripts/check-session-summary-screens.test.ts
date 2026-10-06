/**
 * AGEN-69 review fix U-7: the screens check fails when a capture is of the wrong page, the marker
 * wasn't there, a file is missing, a screen is missing, or two viewport shots are identical.
 */
import { describe, expect, test } from "bun:test";
import { EXPECTED, type ScreenEntry, validateManifest } from "./check-session-summary-screens.js";
import { SCREENS } from "./session-summary-dev-seed.js";

const NAMES = SCREENS.map((s) => s.name);

function entryFor(screen: string, width = 375, theme = "dark"): ScreenEntry {
	const expected = EXPECTED[screen];
	return {
		file: `${screen}-${width}-${theme}.png`,
		screen,
		width,
		theme,
		kind: "viewport",
		state: expected.state ? expected.state.replace(/[\^$]/g, "").replace(/\.\*/g, "x") : null,
		finalPath: expected.path
			.replace(/^\^/, "")
			.replace(/\\\?/g, "?")
			.replace(/\\/g, "")
			.replace(/\$$/, ""),
		markerOk: true,
	};
}
const all = () => NAMES.map((n) => entryFor(n));
const files = (entries: ScreenEntry[]) => (file: string) =>
	entries.some((e) => e.file === file) ? new TextEncoder().encode(file) : null;

describe("EXPECTED", () => {
	test("every screen has an expectation, and the dashboard and digest ones are not session pages", () => {
		expect(Object.keys(EXPECTED).sort()).toEqual([...NAMES].sort());
		expect(EXPECTED["dashboard-open-summary"].path).toBe("^/$");
		expect(EXPECTED["digest-row"].path).toBe("^/digest$");
		expect(EXPECTED["activity-mode-switched"].path).toContain("tab=activity");
	});
});

describe("validateManifest", () => {
	test("a clean capture passes", () => {
		const e = all();
		expect(validateManifest(e, NAMES, files(e))).toEqual([]);
	});

	test("the dashboard screen showing a session's Activity tab fails", () => {
		const e = all();
		const dash = e.find((x) => x.screen === "dashboard-open-summary") as ScreenEntry;
		dash.finalPath = "/sessions/scr-ready?tab=activity";
		expect(validateManifest(e, NAMES, files(e)).join("\n")).toContain("dashboard-open-summary");
	});

	test("a marker that wasn't found fails", () => {
		const e = all();
		(e.find((x) => x.screen === "empty") as ScreenEntry).markerOk = false;
		expect(validateManifest(e, NAMES, files(e)).join("\n")).toContain("marker");
	});

	test("a summary screen in the wrong state fails", () => {
		const e = all();
		(e.find((x) => x.screen === "ready") as ScreenEntry).state = "none/available/none";
		expect(validateManifest(e, NAMES, files(e)).join("\n")).toContain("state");
	});

	test("a missing file, a missing screen and a duplicate image each fail", () => {
		const e = all();
		expect(validateManifest(e, NAMES, () => null).join("\n")).toContain("no file");
		expect(validateManifest(e.slice(1), NAMES, files(e)).join("\n")).toContain("missing screen");
		const same = () => new TextEncoder().encode("same");
		expect(validateManifest(e, NAMES, same).join("\n")).toContain("identical");
	});
});
