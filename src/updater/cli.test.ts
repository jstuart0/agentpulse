import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, runCli } from "./cli.js";
import { type Fixture, createFixture } from "./test-utils/fixture.js";

let fx: Fixture | null = null;
afterEach(async () => {
	await fx?.cleanup();
	fx = null;
});

function io() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) },
	};
}

describe("parseArgs", () => {
	test("the subcommands and flags", () => {
		expect(parseArgs(["update"])).toEqual({ kind: "update", options: { mode: "manual" } });
		expect(parseArgs(["update", "--to", "v0.12.0", "--allow-downgrade", "--wait"])).toEqual({
			kind: "update",
			options: { mode: "manual", to: "0.12.0", allowDowngrade: true, wait: true },
		});
		expect(parseArgs(["update", "--to", "0.12.0"])).toMatchObject({ options: { to: "0.12.0" } });
		expect(parseArgs(["update", "--auto"])).toEqual({ kind: "update", options: { mode: "auto" } });
		expect(parseArgs(["update", "rollback"])).toEqual({ kind: "rollback" });
		expect(parseArgs(["update", "status"])).toEqual({ kind: "status" });
		expect(parseArgs(["update", "auto", "on"])).toEqual({ kind: "auto_consent" });
	});
	test("a flag that isn't there, a missing or malformed version are usage errors", () => {
		for (const argv of [
			["update", "--allow-downgrades"],
			["update", "--to"],
			["update", "--to", "main"],
			["update", "--to", "v1.2.3;rm"],
			["update", "status", "x"],
		]) {
			expect(parseArgs(argv).kind).toBe("usage");
		}
	});
	test("the flag the web copy names is --allow-downgrade", () => {
		const copy = readFileSync(
			join(import.meta.dir, "..", "web", "lib", "update-outcome-copy.ts"),
			"utf-8",
		);
		expect(copy).toContain("--allow-downgrade");
		expect(parseArgs(["update", "--allow-downgrade"])).toMatchObject({
			options: { allowDowngrade: true },
		});
	});
});

describe("runCli", () => {
	test("usage errors exit 2 and print usage", async () => {
		const { io: i, err } = io();
		expect(await runCli(["update", "--bogus"], i)).toBe(2);
		expect(err.join("\n")).toContain("Usage: agentpulse update");
	});
	test("update auto isn't available in this build", async () => {
		const { io: i, err } = io();
		expect(await runCli(["update", "auto", "on"], i)).toBe(2);
		expect(err.join("\n")).toContain("aren't available");
	});
	test("an outcome prints its sentence and next step; up to date exits 0, a refusal exits 1", async () => {
		fx = await createFixture();
		const f = fx;
		f.publish({ latest: "0.11.0" });
		const a = io();
		expect(await runCli(["update"], a.io, f.deps())).toBe(0);
		expect(a.out.join("\n")).toContain("AgentPulse is already up to date.");
		const b = io();
		expect(await runCli(["update", "rollback"], b.io, f.deps())).toBe(1);
		expect(b.out.join("\n")).toContain("There is no earlier copy to go back to.");
	}, 60_000);
	test("status says what the machine knows, including that client scripts aren't refreshed here", async () => {
		fx = await createFixture();
		const a = io();
		expect(await runCli(["update", "status"], a.io, fx.deps())).toBe(0);
		const text = a.out.join("\n");
		expect(text).toContain("Installed: 0.11.0");
		expect(text).toContain("Automatic updates: off");
		expect(text).toContain("not refreshed here");
	}, 60_000);
});
