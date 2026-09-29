/**
 * Onboarding choices shared by FirstRunWelcome, the SetupPage "Remote relay"
 * card and the Settings key list: which scopes a key is minted with, and which
 * install command the user copies.
 */

export type OnboardingLocation = "local" | "relay";

const LOCAL_KEY_SCOPES = ["ingest"];
/** The relay posts hooks and reads the session list (names, CLAUDE.md). */
export const RELAY_KEY_SCOPES = ["ingest", "observe"];

export const RELAY_KEY_NOTE =
	"Relay keys need Hook ingest + Observe. A key without Observe will be refused by the installer.";
export const SWITCHED_NOTICE = "Switched — mint a key for this option";

const HOOK_FILES = ["~/.claude/settings.json", "~/.codex/hooks.json"];
const STATUSLINE_FILE = "~/.claude/statusline-agentpulse.sh";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function installCommand(script: string, serverUrl: string, args: string[]) {
	const pipe = args.length > 0 ? `bash -s -- ${args.join(" ")}` : "bash";
	return `curl -sSL ${serverUrl}/${script} | ${pipe}`;
}

export function buildRelayCommand(opts: {
	serverUrl: string;
	key: string;
	disableAuth: boolean;
	codexNamesAgentpulse: boolean;
}): string {
	const args = opts.disableAuth ? [] : ["--key", opts.key];
	// Unchecked passes no flag, so a re-run keeps whatever policy is installed.
	if (opts.codexNamesAgentpulse) args.push("--codex-names", "agentpulse");
	return installCommand("setup-relay.sh", opts.serverUrl, args);
}

export type OnboardingPlan = {
	scopes: string[];
	command: string;
	files: string[];
	keyNote: string | null;
};

export function buildOnboardingPlan(opts: {
	location: OnboardingLocation;
	serverUrl: string;
	key: string;
	disableAuth: boolean;
}): OnboardingPlan {
	if (opts.location === "relay") {
		return {
			scopes: RELAY_KEY_SCOPES,
			command: buildRelayCommand({ ...opts, codexNamesAgentpulse: false }),
			files: [...HOOK_FILES, STATUSLINE_FILE],
			keyNote: opts.disableAuth ? null : RELAY_KEY_NOTE,
		};
	}
	return {
		scopes: LOCAL_KEY_SCOPES,
		command: installCommand(
			"setup.sh",
			opts.serverUrl,
			opts.disableAuth ? [] : ["--key", opts.key],
		),
		files: HOOK_FILES,
		keyNote: null,
	};
}

/**
 * An ingest key that can post hooks but that the relay installer refuses:
 * nothing grants the session-list reads (observe, or manage/* which imply it).
 */
export function relayKeyHint(scopes: readonly string[]): boolean {
	return (
		scopes.includes("ingest") &&
		!scopes.includes("observe") &&
		!scopes.includes("manage") &&
		!scopes.includes("*")
	);
}

/** Opening the dashboard on this machine suggests the agents run here too. */
export function defaultLocation(hostname: string): OnboardingLocation {
	return LOOPBACK_HOSTNAMES.has(hostname) ? "local" : "relay";
}

export type LocationState = {
	location: OnboardingLocation;
	revealedKey: string | null;
	notice: string | null;
};

/** A key minted for one option has the wrong scopes for the other. */
export function onLocationChange(state: LocationState, next: OnboardingLocation): LocationState {
	if (next === state.location) return state;
	return {
		location: next,
		revealedKey: null,
		notice: state.revealedKey ? SWITCHED_NOTICE : null,
	};
}
