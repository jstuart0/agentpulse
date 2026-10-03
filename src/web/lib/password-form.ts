/**
 * Validation for the account password form. The rules and their wording match
 * the server's (checkPasswordComplexity), so a refusal on submit is rare and
 * reads the same as the hint that came before it.
 */
export interface PasswordFormInput {
	current: string;
	next: string;
	confirm: string;
}

export interface PasswordFormErrors {
	current?: string;
	next?: string;
	confirm?: string;
}

export interface PasswordCheck {
	id: "length" | "upper" | "digit" | "symbol";
	label: string;
	met: boolean;
}

const MIN_LENGTH = 12;

export function passwordChecks(next: string): PasswordCheck[] {
	return [
		{ id: "length", label: `At least ${MIN_LENGTH} characters`, met: next.length >= MIN_LENGTH },
		{ id: "upper", label: "An uppercase letter", met: /[A-Z]/.test(next) },
		{ id: "digit", label: "A digit", met: /[0-9]/.test(next) },
		{ id: "symbol", label: "A symbol", met: /[^A-Za-z0-9]/.test(next) },
	];
}

const REFUSALS: Record<PasswordCheck["id"], string> = {
	length: `Password must be at least ${MIN_LENGTH} characters.`,
	upper: "Password must contain at least one uppercase letter.",
	digit: "Password must contain at least one digit.",
	symbol: "Password must contain at least one symbol.",
};

export function validatePasswordForm(input: PasswordFormInput): {
	ok: boolean;
	errors: PasswordFormErrors;
} {
	const errors: PasswordFormErrors = {};
	if (!input.current) errors.current = "Enter your current password.";

	if (!input.next) {
		errors.next = "Choose a new password.";
	} else {
		const unmet = passwordChecks(input.next).find((check) => !check.met);
		if (unmet) errors.next = REFUSALS[unmet.id];
		else if (input.next === input.current) {
			errors.next = "The new password must be different from the current one.";
		}
	}

	if (input.next !== input.confirm) errors.confirm = "The two new passwords don't match.";
	return { ok: Object.keys(errors).length === 0, errors };
}

/** A field's error goes away as soon as the field changes. */
export function clearFieldError(
	errors: PasswordFormErrors,
	field: keyof PasswordFormErrors,
): PasswordFormErrors {
	const { [field]: _cleared, ...rest } = errors;
	return rest;
}

/** One sentence for a polite live region: how many rules are met and what is still needed. */
export function passwordRulesSummary(next: string): string {
	const checks = passwordChecks(next);
	const unmet = checks.filter((check) => !check.met);
	if (unmet.length === 0) return `All ${checks.length} rules met.`;
	const needed = unmet.map((check) => check.label.charAt(0).toLowerCase() + check.label.slice(1));
	return `${checks.length - unmet.length} of ${checks.length} rules met. Still needed: ${needed.join(", ")}.`;
}
