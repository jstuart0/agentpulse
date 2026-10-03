import { describe, expect, test } from "bun:test";
import { initialFocusTarget, returnFocusTarget, tabAction } from "./dialog-focus.js";

describe("initialFocusTarget", () => {
	test("something inside already took focus: leave it", () => {
		expect(initialFocusTarget({ panelHasFocus: true, hasHeading: true })).toBe("keep");
	});

	test("nothing inside took focus: the heading, so it is announced", () => {
		expect(initialFocusTarget({ panelHasFocus: false, hasHeading: true })).toBe("heading");
	});

	test("no heading either: the panel itself", () => {
		expect(initialFocusTarget({ panelHasFocus: false, hasHeading: false })).toBe("panel");
	});

	test("a control marked as the safe first stop wins over the heading", () => {
		expect(initialFocusTarget({ panelHasFocus: false, hasHeading: true, hasPreferred: true })).toBe(
			"preferred",
		);
	});

	test("but never takes focus from something that already has it", () => {
		expect(initialFocusTarget({ panelHasFocus: true, hasHeading: true, hasPreferred: true })).toBe(
			"keep",
		);
	});
});

describe("tabAction", () => {
	const base = {
		focusableCount: 3,
		activeInside: true,
		shift: false,
		onFirst: false,
		onLast: false,
	};

	test("with nothing to tab to, Tab is held (focus must not escape behind the dialog)", () => {
		expect(tabAction({ ...base, focusableCount: 0 })).toBe("block");
		expect(tabAction({ ...base, focusableCount: 0, shift: true })).toBe("block");
	});

	test("focus outside the dialog is pulled back to an end", () => {
		expect(tabAction({ ...base, activeInside: false })).toBe("first");
		expect(tabAction({ ...base, activeInside: false, shift: true })).toBe("last");
	});

	test("Tab on the last wraps to the first; Shift+Tab on the first wraps to the last", () => {
		expect(tabAction({ ...base, onLast: true })).toBe("first");
		expect(tabAction({ ...base, onFirst: true, shift: true })).toBe("last");
	});

	test("anywhere else the browser moves focus", () => {
		expect(tabAction(base)).toBe("native");
		expect(tabAction({ ...base, onFirst: true })).toBe("native");
		expect(tabAction({ ...base, onLast: true, shift: true })).toBe("native");
	});
});

describe("returnFocusTarget", () => {
	test("the opener, when it is still on the page and usable", () => {
		expect(
			returnFocusTarget({ hadOpener: true, openerConnected: true, openerDisabled: false }),
		).toBe("opener");
	});

	test("an opener that is gone, disabled or never existed falls back to the section heading", () => {
		expect(
			returnFocusTarget({ hadOpener: true, openerConnected: false, openerDisabled: false }),
		).toBe("fallback");
		expect(
			returnFocusTarget({ hadOpener: true, openerConnected: true, openerDisabled: true }),
		).toBe("fallback");
		expect(
			returnFocusTarget({ hadOpener: false, openerConnected: false, openerDisabled: false }),
		).toBe("fallback");
	});
});
