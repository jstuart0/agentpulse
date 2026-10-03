import { describe, expect, test } from "bun:test";
import { themeToApply } from "./theme.js";

describe("themeToApply", () => {
	test("solo: the shared setting wins and is remembered here, as it always was", () => {
		expect(themeToApply({ perBrowser: false, stored: "dark", server: "light" })).toEqual({
			theme: "light",
			persist: true,
		});
	});

	test("solo: with no usable shared setting, this browser's own choice stands", () => {
		expect(themeToApply({ perBrowser: false, stored: "dark", server: undefined })).toEqual({
			theme: "dark",
			persist: false,
		});
		expect(themeToApply({ perBrowser: false, stored: "dark", server: "purple" })).toEqual({
			theme: "dark",
			persist: false,
		});
	});

	test("team: this browser's choice wins over the shared setting, which nobody can overwrite for others", () => {
		expect(themeToApply({ perBrowser: true, stored: "dark", server: "light" })).toEqual({
			theme: "dark",
			persist: false,
		});
	});

	test("team: with no choice yet, the shared setting is the starting point but isn't saved as theirs", () => {
		expect(themeToApply({ perBrowser: true, stored: null, server: "light" })).toEqual({
			theme: "light",
			persist: false,
		});
	});

	test("nothing known: leave the page as it is", () => {
		expect(themeToApply({ perBrowser: false, stored: null, server: undefined })).toBeNull();
		expect(themeToApply({ perBrowser: true, stored: null, server: 42 })).toBeNull();
	});
});
