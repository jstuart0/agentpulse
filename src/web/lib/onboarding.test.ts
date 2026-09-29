/**
 * Phase 4 (F6, F7, F37, D8): the onboarding choices behind FirstRunWelcome,
 * the SetupPage "Remote relay" card and the Settings key hint, as pure
 * functions so the scope a key is minted with and the command a user copies
 * are pinned without a DOM.
 */
import { describe, expect, test } from "bun:test";
import {
	RELAY_KEY_NOTE,
	SWITCHED_NOTICE,
	buildOnboardingPlan,
	buildRelayCommand,
	defaultLocation,
	onLocationChange,
	relayKeyHint,
} from "./onboarding.js";

const SERVER = "https://agentpulse.example.com";

describe("buildOnboardingPlan", () => {
	test("local: mints an ingest-only key and shows the /setup.sh command", () => {
		const plan = buildOnboardingPlan({
			location: "local",
			serverUrl: SERVER,
			key: "ap_local",
			disableAuth: false,
		});
		expect(plan.scopes).toEqual(["ingest"]);
		expect(plan.command).toBe(`curl -sSL ${SERVER}/setup.sh | bash -s -- --key ap_local`);
		expect(plan.keyNote).toBeNull();
		expect(plan.files).toEqual(["~/.claude/settings.json", "~/.codex/hooks.json"]);
	});

	test("relay: mints an ingest+observe key and shows the /setup-relay.sh command", () => {
		const plan = buildOnboardingPlan({
			location: "relay",
			serverUrl: SERVER,
			key: "ap_relay",
			disableAuth: false,
		});
		expect(plan.scopes).toEqual(["ingest", "observe"]);
		expect(plan.command).toBe(`curl -sSL ${SERVER}/setup-relay.sh | bash -s -- --key ap_relay`);
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
			key: "ignored",
			disableAuth: true,
		});
		const relay = buildOnboardingPlan({
			location: "relay",
			serverUrl: SERVER,
			key: "ignored",
			disableAuth: true,
		});
		expect(local.command).toBe(`curl -sSL ${SERVER}/setup.sh | bash`);
		expect(relay.command).toBe(`curl -sSL ${SERVER}/setup-relay.sh | bash`);
		expect(relay.keyNote).toBeNull();
	});
});

describe("buildRelayCommand — the SetupPage Codex-names checkbox (contract round 4 gap 5)", () => {
	test("unchecked renders no flag, so the installer keeps an existing policy (default codex)", () => {
		const command = buildRelayCommand({
			serverUrl: SERVER,
			key: "ap_relay",
			disableAuth: false,
			codexNamesAgentpulse: false,
		});
		expect(command).toBe(`curl -sSL ${SERVER}/setup-relay.sh | bash -s -- --key ap_relay`);
		expect(command).not.toContain("--codex-names");
	});

	test("checked appends --codex-names agentpulse to the exact rendered command", () => {
		expect(
			buildRelayCommand({
				serverUrl: SERVER,
				key: "ap_relay",
				disableAuth: false,
				codexNamesAgentpulse: true,
			}),
		).toBe(
			`curl -sSL ${SERVER}/setup-relay.sh | bash -s -- --key ap_relay --codex-names agentpulse`,
		);
	});

	test("checked with auth disabled still passes the flag through bash -s --", () => {
		expect(
			buildRelayCommand({
				serverUrl: SERVER,
				key: "",
				disableAuth: true,
				codexNamesAgentpulse: true,
			}),
		).toBe(`curl -sSL ${SERVER}/setup-relay.sh | bash -s -- --codex-names agentpulse`);
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
});

describe("defaultLocation", () => {
	for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
		test(`${host} → local`, () => {
			expect(defaultLocation(host)).toBe("local");
		});
	}
	test("a real hostname → relay", () => {
		expect(defaultLocation("agentpulse.example.com")).toBe("relay");
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
