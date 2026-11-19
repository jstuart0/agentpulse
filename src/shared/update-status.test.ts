import { describe, expect, test } from "bun:test";
import type { UpdateStateName } from "./release-manifest.js";
import { updateCommandFor } from "./update-commands.js";
import {
	RED_UPDATE_STATES,
	UPDATE_OUTCOME_CODES,
	UPDATE_STATE_NAMES,
	isKnownUpdateState,
	publicUpdateStatus,
	releaseNotesUrl,
} from "./update-status.js";

/** Compiles only while the list names every `UpdateStateName`: a state added to the union fails here. */
const EVERY_STATE: Record<UpdateStateName, true> = {
	disabled: true,
	unverified: true,
	current_pulled: true,
	below_minimum: true,
	security: true,
	available: true,
	current: true,
};

describe("the state and outcome name lists", () => {
	test("UPDATE_STATE_NAMES is exactly the UpdateStateName union", () => {
		expect([...UPDATE_STATE_NAMES].sort() as string[]).toEqual(Object.keys(EVERY_STATE).sort());
	});

	test("the red states are security, current_pulled and below_minimum, all real states", () => {
		expect([...RED_UPDATE_STATES].sort()).toEqual([
			"below_minimum",
			"current_pulled",
			"security",
		] as never);
		for (const state of RED_UPDATE_STATES) expect(UPDATE_STATE_NAMES).toContain(state);
	});

	test("the outcome codes are the plan's closed set, once each", () => {
		expect(new Set(UPDATE_OUTCOME_CODES).size).toBe(UPDATE_OUTCOME_CODES.length);
		expect(UPDATE_OUTCOME_CODES.length).toBe(38);
		for (const code of [
			"no_consent",
			"dirty_tree",
			"symlinked_install",
			"updated",
			"rolled_back",
		]) {
			expect(UPDATE_OUTCOME_CODES).toContain(code as never);
		}
	});

	test("isKnownUpdateState accepts the union and refuses anything else", () => {
		expect(isKnownUpdateState("available")).toBe(true);
		expect(isKnownUpdateState("stale_manifest")).toBe(false);
		expect(isKnownUpdateState("unreachable")).toBe(false);
		expect(isKnownUpdateState("unknown")).toBe(false);
		expect(isKnownUpdateState("__proto__")).toBe(false);
	});
});

describe("releaseNotesUrl", () => {
	test("is built from a validated version only", () => {
		expect(releaseNotesUrl("0.12.0")).toBe(
			"https://github.com/jstuart0/agentpulse/releases/tag/v0.12.0",
		);
		expect(releaseNotesUrl("0.12.0-rc.1")).toBe(
			"https://github.com/jstuart0/agentpulse/releases/tag/v0.12.0-rc.1",
		);
		for (const bad of [
			"",
			"latest",
			"0.12",
			"1.2.3/../x",
			"1.2.3 rm",
			"1.2.3\n",
			"01.2.3",
			"a".repeat(60),
		]) {
			expect(releaseNotesUrl(bad)).toBeNull();
		}
	});
});

describe("updateCommandFor: fixed templates, the version inserted only after validation", () => {
	test("a local install on the release track: where to run it, the command, the recovery line", () => {
		expect(updateCommandFor("local", "0.12.0", "release")).toEqual([
			{ before: "Run this on the machine that runs the AgentPulse server." },
			{ before: "", command: "~/.agentpulse/bin/agentpulse update" },
			{
				before: "If that command isn't there, re-run install-local.sh on that machine.",
			},
		]);
	});

	test("a local install on a ref track is not updated for you, and never shows the ref", () => {
		const lines = updateCommandFor("local", "0.12.0", "ref");
		expect(lines).toEqual([
			{
				before:
					"This install follows a branch, so it isn't updated for you. Re-run the installer without --ref to follow releases.",
			},
		]);
		expect(JSON.stringify(lines)).not.toContain("main");
	});

	test("a container install has three lines, the third for a compose build from a checkout", () => {
		const lines = updateCommandFor("container", "0.12.0", null);
		expect(lines).toEqual([
			{
				before: "If you run the published image:",
				command: "docker pull ghcr.io/jstuart0/agentpulse:0.12.0",
				after: "then recreate the container.",
			},
			{
				before: "If you use docker-compose.image.yml:",
				command:
					"AGENTPULSE_TAG=0.12.0 docker compose -f docker-compose.yml -f docker-compose.image.yml pull && AGENTPULSE_TAG=0.12.0 docker compose -f docker-compose.yml -f docker-compose.image.yml up -d",
			},
			{
				before: "If you build it yourself, from your agentpulse checkout:",
				command: "git checkout v0.12.0 && docker compose up -d --build",
			},
		]);
	});

	test("a Kubernetes install is told to set both images", () => {
		expect(updateCommandFor("kubernetes", "0.12.0", null)).toEqual([
			{ before: "Set both images (agentpulse and agentpulse-backup) to tag 0.12.0." },
		]);
	});

	test("a source checkout gets the manual steps, then the restart line", () => {
		expect(updateCommandFor("source", "0.12.0", null)).toEqual([
			{
				before: "",
				command:
					"git fetch --tags && git checkout v0.12.0 && bun install --frozen-lockfile && bun run build",
			},
			{
				before: "Restart the server. To get automatic updates, install with install-local.sh.",
			},
		]);
	});

	test("an install kind this build doesn't know gets no command", () => {
		expect(updateCommandFor("bogus" as never, "0.12.0", null)).toBeNull();
	});

	test("a version that is not a release version produces no command at all", () => {
		for (const kind of ["local", "container", "kubernetes", "source"] as const) {
			for (const bad of ["", "$(reboot)", "1.2.3; rm -rf /", "1.2", "v1.2.3", "1.2.3\n&& id"]) {
				expect(updateCommandFor(kind, bad, "release")).toBeNull();
			}
		}
	});

	test("the local release-track command doesn't depend on the version, but a bad one is still refused", () => {
		expect(updateCommandFor("local", "0.12.0", "release")).not.toBeNull();
		expect(updateCommandFor("local", "oops", "release")).toBeNull();
	});
});

describe("publicUpdateStatus", () => {
	const full = {
		current: "0.11.0",
		latest: "0.12.0",
		state: "available" as const,
		stale: false,
		severity: "normal" as const,
		checkedAt: "2026-11-19T12:00:00.000Z",
		lastResult: "ok" as const,
		manifestIssuedAt: "2026-11-19T11:00:00.000Z",
		installKind: "local" as const,
		track: "release" as const,
		localApply: { auto: true, lastOutcome: "updated" as const, lastTarget: "0.12.0" },
	};

	test("keeps exactly the six public fields and drops everything else, localApply included", () => {
		const out = publicUpdateStatus(full);
		expect(Object.keys(out).sort()).toEqual(
			["checkedAt", "current", "latest", "severity", "stale", "state"].sort(),
		);
		expect(JSON.stringify(out)).not.toContain("updated");
	});

	test("a field added to UpdateStatus later is private until someone lists it", () => {
		const out = publicUpdateStatus({ ...full, somethingNew: "x" } as never);
		expect("somethingNew" in out).toBe(false);
	});
});
