import { describe, expect, test } from "bun:test";
import {
	clearFieldError,
	passwordChecks,
	passwordRulesSummary,
	validatePasswordForm,
} from "./password-form.js";

const good = {
	current: "old-password-1!",
	next: "Fresh-Password-9!",
	confirm: "Fresh-Password-9!",
};

describe("validatePasswordForm", () => {
	test("a good form passes with no errors", () => {
		expect(validatePasswordForm(good)).toEqual({ ok: true, errors: {} });
	});

	test("nothing typed yet asks for the current password and a new one", () => {
		const result = validatePasswordForm({ current: "", next: "", confirm: "" });
		expect(result.ok).toBe(false);
		expect(result.errors.current).toBe("Enter your current password.");
		expect(result.errors.next).toBe("Choose a new password.");
	});

	test("the same four rules as the server, with the server's wording", () => {
		expect(validatePasswordForm({ ...good, next: "Short1!", confirm: "Short1!" }).errors.next).toBe(
			"Password must be at least 12 characters.",
		);
		expect(
			validatePasswordForm({ ...good, next: "lowercase-only-1!", confirm: "lowercase-only-1!" })
				.errors.next,
		).toBe("Password must contain at least one uppercase letter.");
		expect(
			validatePasswordForm({ ...good, next: "No-Digits-Here-!!", confirm: "No-Digits-Here-!!" })
				.errors.next,
		).toBe("Password must contain at least one digit.");
		expect(
			validatePasswordForm({ ...good, next: "NoSymbols12345A", confirm: "NoSymbols12345A" }).errors
				.next,
		).toBe("Password must contain at least one symbol.");
	});

	test("the confirmation has to match", () => {
		const result = validatePasswordForm({ ...good, confirm: "Fresh-Password-8!" });
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual({ confirm: "The two new passwords don't match." });
	});

	test("the new password has to differ from the current one", () => {
		const same = "Fresh-Password-9!";
		const result = validatePasswordForm({ current: same, next: same, confirm: same });
		expect(result.errors.next).toBe("The new password must be different from the current one.");
	});

	test("an empty confirmation is a mismatch, not a second 'choose' prompt", () => {
		expect(validatePasswordForm({ ...good, confirm: "" }).errors.confirm).toBe(
			"The two new passwords don't match.",
		);
	});
});

describe("passwordChecks", () => {
	test("four visible requirements, each met or not", () => {
		expect(passwordChecks("abc")).toEqual([
			{ id: "length", label: "At least 12 characters", met: false },
			{ id: "upper", label: "An uppercase letter", met: false },
			{ id: "digit", label: "A digit", met: false },
			{ id: "symbol", label: "A symbol", met: false },
		]);
		expect(passwordChecks("Fresh-Password-9!").every((check) => check.met)).toBe(true);
	});
});

describe("clearFieldError", () => {
	test("only the field that changed loses its error", () => {
		const errors = { current: "a", next: "b", confirm: "c" };
		expect(clearFieldError(errors, "next")).toEqual({ current: "a", confirm: "c" });
		expect(errors.next).toBe("b");
	});

	test("a field with no error changes nothing", () => {
		expect(clearFieldError({ current: "a" }, "next")).toEqual({ current: "a" });
	});
});

describe("passwordRulesSummary", () => {
	test("nothing typed: all four still needed, in plain words", () => {
		expect(passwordRulesSummary("")).toBe(
			"0 of 4 rules met. Still needed: at least 12 characters, an uppercase letter, a digit, a symbol.",
		);
	});

	test("some met: names what is left", () => {
		expect(passwordRulesSummary("Abcdefghijkl")).toBe(
			"2 of 4 rules met. Still needed: a digit, a symbol.",
		);
	});

	test("all met", () => {
		expect(passwordRulesSummary("Abcdefghijk1!")).toBe("All 4 rules met.");
	});
});
