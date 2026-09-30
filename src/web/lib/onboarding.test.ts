/**
 * Phase 4 (F6, F7, F37, D8; F164, F167, F179, F182, F184): the onboarding
 * choices behind FirstRunWelcome, the SetupPage "Remote relay" card and the
 * Settings key hint, as pure functions so the scope a key is minted with and
 * the command a user copies are pinned without a DOM.
 */
import { describe, expect, test } from "bun:test";
import {
	LOCAL_KEY_NOTE,
	LOCAL_KEY_SCOPES,
	RELAY_KEY_HINT,
	RELAY_KEY_NOTE,
	RELAY_KEY_SCOPES,
	REPLACE_LOCALHOST_NOTE,
	SWITCHED_NOTICE,
	buildOnboardingPlan,
	buildRelayCommand,
	defaultKeyName,
	defaultLocation,
	isLoopbackHostname,
	onLocationChange,
	relayKeyHint,
	withRelaySuffix,
} from "./onboarding.js";

const SERVER = "https://agentpulse.example.com";

describe("buildOnboardingPlan", () => {
	test("local: mints an ingest-only key, and the command carries no key (AGEN-49)", () => {
		const plan = buildOnboardingPlan({
			location: "local",
			serverUrl: SERVER,
			disableAuth: false,
		});
		expect(plan.scopes).toEqual(["ingest"]);
		expect(plan.scopes).toEqual(LOCAL_KEY_SCOPES);
		expect(plan.command).toBe(
			`read -rsp 'AgentPulse API key: ' AGENTPULSE_KEY && export AGENTPULSE_KEY && echo\ncurl -sSL ${SERVER}/setup.sh | bash`,
		);
		expect(plan.command).not.toContain("--key");
		expect(plan.keyNote).toBe(LOCAL_KEY_NOTE);
		expect(plan.files).toEqual(["~/.claude/settings.json", "~/.codex/hooks.json"]);
	});

	test("relay: mints an ingest+observe key, and the command carries no key (F167)", () => {
		const plan = buildOnboardingPlan({
			location: "relay",
			serverUrl: SERVER,
			disableAuth: false,
		});
		expect(plan.scopes).toEqual(["ingest", "observe"]);
		expect(plan.scopes).toEqual(RELAY_KEY_SCOPES);
		expect(plan.command).toBe(`curl -sSL ${SERVER}/setup-relay.sh | bash`);
		expect(plan.keyNote).toBe(RELAY_KEY_NOTE);
		expect(RELAY_KEY_NOTE).toBe(
			"Relay keys need Hook ingest + Observe. A key without Observe will be refused by the installer.",
		);
		expect(plan.files).toEqual([
			"~/.claude/settings.json",
			"~/.codex/hooks.json",
			"~/.claude/statusline-agentpulse.sh",
		]);
	});

	test("auth disabled: no key flag and no key note for either location", () => {
		const local = buildOnboardingPlan({
			location: "local",
			serverUrl: SERVER,
			disableAuth: true,
		});
		const relay = buildOnboardingPlan({
			location: "relay",
			serverUrl: SERVER,
			disableAuth: true,
		});
		expect(local.command).toBe(`curl -sSL ${SERVER}/setup.sh | bash`);
		expect(local.keyNote).toBeNull();
		expect(relay.command).toBe(`curl -sSL ${SERVER}/setup-relay.sh | bash`);
		expect(relay.keyNote).toBeNull();
	});
});

describe("buildRelayCommand — the SetupPage Codex-names checkbox (contract round 4 gap 5)", () => {
	test("unchecked renders no flag, so the installer keeps an existing policy (default codex)", () => {
		const command = buildRelayCommand({ serverUrl: SERVER, codexNamesAgentpulse: false });
		expect(command).toBe(`curl -sSL ${SERVER}/setup-relay.sh | bash`);
		expect(command).not.toContain("--codex-names");
	});

	test("checked appends --codex-names agentpulse to the exact rendered command", () => {
		expect(buildRelayCommand({ serverUrl: SERVER, codexNamesAgentpulse: true })).toBe(
			`curl -sSL ${SERVER}/setup-relay.sh | bash -s -- --codex-names agentpulse`,
		);
	});

	test("the key is never part of the command (F167: shell history, argv)", () => {
		for (const codexNamesAgentpulse of [false, true]) {
			expect(buildRelayCommand({ serverUrl: SERVER, codexNamesAgentpulse })).not.toContain("--key");
		}
	});
});

describe("relayKeyHint (Settings key list)", () => {
	const table: Array<[string[], boolean]> = [
		[["ingest"], true],
		[["ingest", "observe"], false],
		[["ingest", "manage"], false],
		[["*"], false],
		[["observe"], false],
		[[], false],
	];
	for (const [scopes, expected] of table) {
		test(`${JSON.stringify(scopes)} → ${expected}`, () => {
			expect(relayKeyHint(scopes)).toBe(expected);
		});
	}

	test("F182: the hint reads as a fact about the key, not a warning", () => {
		expect(RELAY_KEY_HINT).toBe("Can't be used by a relay (needs Hook ingest + Observe)");
	});
});

describe("defaultLocation and isLoopbackHostname", () => {
	for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
		test(`${host} → local`, () => {
			expect(defaultLocation(host)).toBe("local");
			expect(isLoopbackHostname(host)).toBe(true);
		});
	}
	test("a real hostname → relay", () => {
		expect(defaultLocation("agentpulse.example.com")).toBe("relay");
		expect(isLoopbackHostname("agentpulse.example.com")).toBe(false);
	});

	test("F179: the note for commands copied from a localhost dashboard", () => {
		expect(REPLACE_LOCALHOST_NOTE).toBe(
			"Replace localhost with an address the other machine can reach.",
		);
	});
});

describe("defaultKeyName (F184)", () => {
	test("a relay key is named after the machine with -relay", () => {
		expect(defaultKeyName("local")).toBe("my-laptop");
		expect(defaultKeyName("relay")).toBe("my-laptop-relay");
	});
});

describe("withRelaySuffix (F198)", () => {
	test("appends -relay to a plain name", () => {
		expect(withRelaySuffix("my-laptop")).toBe("my-laptop-relay");
	});

	test("does not double the suffix when it's already there", () => {
		expect(withRelaySuffix("my-laptop-relay")).toBe("my-laptop-relay");
	});

	test("falls back to the default name when blank", () => {
		expect(withRelaySuffix("")).toBe("my-laptop-relay");
		expect(withRelaySuffix("   ")).toBe("my-laptop-relay");
	});

	test("trims surrounding whitespace before checking the suffix", () => {
		expect(withRelaySuffix("  work-vm-relay  ")).toBe("work-vm-relay");
	});
});

describe("onLocationChange", () => {
	test("switching clears the key minted for the other option and says so", () => {
		const next = onLocationChange(
			{ location: "local", revealedKey: "ap_minted", notice: null },
			"relay",
		);
		expect(next).toEqual({ location: "relay", revealedKey: null, notice: SWITCHED_NOTICE });
		expect(SWITCHED_NOTICE).toBe("Switched — mint a key for this option");
	});

	test("switching with no minted key shows no notice", () => {
		expect(
			onLocationChange({ location: "relay", revealedKey: null, notice: null }, "local"),
		).toEqual({ location: "local", revealedKey: null, notice: null });
	});

	test("re-selecting the current option keeps the minted key", () => {
		const state = { location: "relay" as const, revealedKey: "ap_minted", notice: null };
		expect(onLocationChange(state, "relay")).toBe(state);
	});
});
