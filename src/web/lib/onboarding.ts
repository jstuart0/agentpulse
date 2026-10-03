/**
 * Onboarding choices shared by FirstRunWelcome, the SetupPage "Remote relay"
 * card and the Settings key list: which scopes a key is minted with, and which
 * install command the user copies.
 */

import { withHiddenKey } from "./hidden-key-prompt.js";

export type OnboardingLocation = "local" | "relay";

/** Direct hooks only post events; never manage (that's Settings' job). */
export const LOCAL_KEY_SCOPES = ["ingest"];
/** The relay posts hooks and reads the session list (names, CLAUDE.md). */
export const RELAY_KEY_SCOPES = ["ingest", "observe"];

export const RELAY_KEY_NOTE =
	"Relay keys need Hook ingest + Observe. A key without Observe will be refused by the installer.";
/**
 * AGEN-49: the local install command no longer carries the key (it used to
 * be `--key ap_...`, which lands in both `ps` and shell history). The
 * installer already accepts $AGENTPULSE_KEY (F234), so a hidden terminal
 * prompt hands it over without ever putting the value in the command text.
 */
export const LOCAL_KEY_NOTE =
	"The key stays out of this command — paste it when prompted. For a scripted/non-interactive install, set $AGENTPULSE_KEY before running the command instead (that form is visible in shell history).";
export const SWITCHED_NOTICE = "Switched — mint a key for this option";
export const RELAY_KEY_HINT = "Can't be used by a relay (needs Hook ingest + Observe)";
export const REPLACE_LOCALHOST_NOTE =
	"Replace localhost with an address the other machine can reach.";
const DEFAULT_KEY_NAME = "my-laptop";

const HOOK_FILES = ["~/.claude/settings.json", "~/.codex/hooks.json"];
const STATUSLINE_FILE = "~/.claude/statusline-agentpulse.sh";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function installCommand(script: string, serverUrl: string, args: string[]) {
	const pipe = args.length > 0 ? `bash -s -- ${args.join(" ")}` : "bash";
	return `curl -sSL ${serverUrl}/${script} | ${pipe}`;
}

/**
 * F167: the key never goes into the command, where it would land in shell
 * history and in bash's argv. The installer asks for it on the terminal.
 */
export function buildRelayCommand(opts: {
	serverUrl: string;
	codexNamesAgentpulse: boolean;
}): string {
	// Unchecked passes no flag, so a re-run keeps whatever policy is installed.
	const args = opts.codexNamesAgentpulse ? ["--codex-names", "agentpulse"] : [];
	return installCommand("setup-relay.sh", opts.serverUrl, args);
}

/**
 * AGEN-49/H1 (xander): same principle as buildRelayCommand, applied to the
 * direct (non-relay) installer. The key is read at a hidden prompt (see
 * hidden-key-prompt.ts: `stty -echo`, not `read -s`, which dash lacks, nor
 * `read -rsp`, whose `-p` means "coprocess" in zsh). That keeps the key out
 * of shell history; the bare `export` hands the already-read value to the
 * piped-in setup.sh's environment without the value itself ever appearing in
 * the command line. A blank answer (Ctrl-D, empty Enter) skips the install
 * with an error instead of running curl unauthenticated. setup.sh already falls back to $AGENTPULSE_KEY —
 * no server-side change needed.
 */
function buildLocalCommand(opts: { serverUrl: string; disableAuth: boolean }): string {
	const install = installCommand("setup.sh", opts.serverUrl, []);
	if (opts.disableAuth) return install;
	return withHiddenKey(
		"ap_key",
		`export AGENTPULSE_KEY="$ap_key"; ${install}`,
		"nothing was installed.",
	);
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
	disableAuth: boolean;
}): OnboardingPlan {
	if (opts.location === "relay") {
		return {
			scopes: RELAY_KEY_SCOPES,
			command: buildRelayCommand({ serverUrl: opts.serverUrl, codexNamesAgentpulse: false }),
			files: [...HOOK_FILES, STATUSLINE_FILE],
			keyNote: opts.disableAuth ? null : RELAY_KEY_NOTE,
		};
	}
	return {
		scopes: LOCAL_KEY_SCOPES,
		command: buildLocalCommand({ serverUrl: opts.serverUrl, disableAuth: opts.disableAuth }),
		files: HOOK_FILES,
		keyNote: opts.disableAuth ? null : LOCAL_KEY_NOTE,
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

export function isLoopbackHostname(hostname: string): boolean {
	return LOOPBACK_HOSTNAMES.has(hostname);
}

/** Opening the dashboard on this machine suggests the agents run here too. */
export function defaultLocation(hostname: string): OnboardingLocation {
	return isLoopbackHostname(hostname) ? "local" : "relay";
}

/** Relay keys are named so they're recognizable in the Settings key list. */
export function defaultKeyName(location: OnboardingLocation): string {
	return location === "relay" ? `${DEFAULT_KEY_NAME}-relay` : DEFAULT_KEY_NAME;
}

/**
 * F198: appends "-relay" for a relay key name, unless the name the user
 * typed already ends with it — SetupPage's "Remote relay" card shares one
 * name field between the local (hook) key and the relay key, so a name
 * copied or retyped from an earlier relay key must not double up into
 * "my-laptop-relay-relay".
 */
export function withRelaySuffix(name: string): string {
	const trimmed = name.trim() || DEFAULT_KEY_NAME;
	return trimmed.endsWith("-relay") ? trimmed : `${trimmed}-relay`;
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
