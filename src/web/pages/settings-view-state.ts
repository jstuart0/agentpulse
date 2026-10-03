/** Where each fetch behind Settings stands. A section that never loaded must not look like an empty one, or save the defaults it shows. */
export type FetchStatus = "loading" | "ok" | "failed";

export interface SectionLoad {
	showError: boolean;
	message: string | null;
	inputsDisabled: boolean;
	canSave: boolean;
}

export function sectionLoad(status: FetchStatus, noun: string): SectionLoad {
	return {
		showError: status === "failed",
		message: status === "failed" ? `Couldn't load ${noun}.` : null,
		inputsDisabled: status !== "ok",
		canSave: status === "ok",
	};
}

export type SettingsSectionId =
	| "appearance"
	| "supervisor"
	| "launches"
	| "session-config"
	| "labs"
	| "ai"
	| "workspaces"
	| "telegram"
	| "team"
	| "keys"
	| "account"
	| "server";

/** Top to bottom. Solo keeps the page as it always was; in team mode the people, keys and account sections come up front. */
export function settingsSectionOrder(teamOn: boolean): SettingsSectionId[] {
	const tail: SettingsSectionId[] = [
		"supervisor",
		"launches",
		"session-config",
		"labs",
		"ai",
		"workspaces",
		"telegram",
	];
	return teamOn
		? ["appearance", "team", "keys", "account", ...tail, "server"]
		: ["appearance", ...tail, "team", "keys", "account", "server"];
}
