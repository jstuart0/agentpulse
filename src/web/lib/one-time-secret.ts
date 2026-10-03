/** A password, enrollment token or key value that can't be fetched again stays on screen this long. */
export const SECRET_LIFETIME_MS = 5 * 60_000;

export function shouldClearSecret(input: {
	shownAt: number;
	now: number;
	tabHidden: boolean;
}): boolean {
	return input.tabHidden || input.now - input.shownAt >= SECRET_LIFETIME_MS;
}

/** Said wherever a one-time secret is shown. */
export const SECRET_LIFETIME_NOTE = "It disappears after 5 minutes or when you leave this tab.";
