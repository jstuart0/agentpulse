/**
 * The Codex installers merge into an existing ~/.codex/hooks.json instead of
 * replacing it: another tool's hook entries and unknown top-level keys survive,
 * AgentPulse's own entries (the handlers whose command posts to
 * `/api/v1/hooks?event=`) are replaced or inserted, and a file that is not
 * usable JSON of the expected shape is left untouched.
 *
 * Three layers, all against throwaway directories:
 *  1. mergeCodexHooksFile (src/shared/hook-command.ts), the reference merge;
 *  2. every shell copy's ap_codex_merge_hooks_json, sourced from the real file
 *     (never reimplemented) and compared with the reference for the same input;
 *  3. whole installer runs (setup-hooks.sh and the rendered /setup.sh here;
 *     setup-relay.sh in installers-run.test.ts; the CLI in bin/cli.setup.test.ts).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import "../src/server/db/__test_db.js";
import {
	AGENTPULSE_HOOK_HEADER,
	AGENTPULSE_HOOK_MARKER,
	CODEX_EVENT_ORDER,
	buildBashHookCommand,
	buildCodexHooksFile,
	buildPowerShellHookCommand,
	mergeCodexHooksFile,
} from "../src/shared/hook-command.js";

const { setup } = await import("../src/server/routes/setup.js");

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const BASE = "http://localhost:3000";
const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(dir);
	return dir;
}

const OTHER_START = {
	matcher: "startup",
	hooks: [{ type: "command", command: "/opt/othertool/bin/on-start --quiet", timeout: 5 }],
};
const OTHER_PRE = {
	matcher: "Bash",
	hooks: [{ type: "command", command: "othertool guard --strict" }],
};
const OLD_FORMAT_COMMAND = `curl -sS --max-time 2 -o /dev/null -X POST 'http://localhost:3000/api/v1/hooks?event=Stop' -H 'Content-Type: application/json' -H 'X-Agent-Type: codex_cli' --data-binary @-`;

function otherToolsFile(): string {
	return `${JSON.stringify(
		{
			"x-other-tool": { enabled: true, level: [1, 2] },
			hooks: {
				SessionStart: [OTHER_START],
				PreToolUse: [OTHER_PRE],
				CustomEvent: [{ hooks: [{ type: "command", command: "othertool custom" }] }],
			},
		},
		null,
		2,
	)}\n`;
}

const OURS = buildCodexHooksFile({ baseUrl: BASE, direct: true });

/** Same-shape fixtures every merge copy must treat identically. */
const FIXTURES: { name: string; existing: string | null }[] = [
	{ name: "no file", existing: null },
	{ name: "empty file", existing: "" },
	{ name: "other tools' hooks plus an unknown top-level key", existing: otherToolsFile() },
	{ name: "already exactly ours", existing: OURS },
	{
		name: "an old AgentPulse entry in the previous command format",
		existing: JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: OLD_FORMAT_COMMAND, timeout: 9 }] }],
				PreToolUse: [OTHER_PRE],
			},
		}),
	},
	{
		name: "our handler sharing a group with another tool's handler",
		existing: JSON.stringify({
			hooks: {
				Stop: [
					{
						matcher: "x",
						hooks: [
							{ type: "command", command: "othertool stop" },
							{ type: "command", command: OLD_FORMAT_COMMAND },
						],
					},
				],
			},
		}),
	},
	{
		name: "a retired AgentPulse event no longer in the current set",
		existing: JSON.stringify({
			hooks: {
				Retired: [{ hooks: [{ type: "command", command: OLD_FORMAT_COMMAND }] }],
				Other: [{ hooks: [{ type: "command", command: "othertool" }] }],
			},
		}),
	},
	{
		name: "non-ASCII text in another tool's entry",
		existing: JSON.stringify({
			note: "café \u{1f600} \u007f",
			hooks: { Stop: [{ hooks: [{ type: "command", command: "echo café" }] }] },
		}),
	},
	{ name: "invalid JSON", existing: '{"hooks": {oops' },
	{ name: "top level is an array", existing: "[]" },
	{ name: "top level is null", existing: "null" },
	{ name: "hooks is not an object", existing: '{"hooks": []}' },
	{ name: "hooks is null", existing: '{"hooks": null}' },
	{ name: "one of our events holds a non-list", existing: '{"hooks": {"Stop": "mine"}}' },
	{
		name: "a non-list under an event that is not ours is left alone",
		existing: '{"hooks": {"custom": "mine"}}',
	},
	{
		name: "another tool's script that merely calls our URL is not ours",
		existing: JSON.stringify({
			hooks: {
				Stop: [
					{
						hooks: [
							{ type: "command", command: "curl http://localhost:3000/api/v1/hooks?event=Stop" },
						],
					},
				],
			},
		}),
	},
	{
		name: "a command with our header text but not our URL is not ours",
		existing: JSON.stringify({
			hooks: {
				Stop: [
					{
						hooks: [
							{
								type: "command",
								command: "curl -H 'X-Agent-Type: codex_cli' http://other.invalid/x",
							},
						],
					},
				],
			},
		}),
	},
	{
		name: "another tool's groups on both sides of ours",
		existing: JSON.stringify({
			hooks: {
				Stop: [
					{ matcher: "a", hooks: [{ type: "command", command: "before-tool" }] },
					{ hooks: [{ type: "command", command: OLD_FORMAT_COMMAND }] },
					{ matcher: "b", hooks: [{ type: "command", command: "after-tool" }] },
				],
			},
		}),
	},
	{
		name: "events named like Object.prototype members",
		existing:
			'{"hooks": {"constructor": [{"hooks": [{"type": "command", "command": "c"}]}], "__proto__": [{"hooks": [{"type": "command", "command": "p"}]}], "toString": "x", "hasOwnProperty": []}}',
	},
	{
		name: "a number beyond 2^53 in another tool's entry",
		existing: '{"x": 12345678901234567890, "hooks": {}}',
	},
	{ name: "an integer just past 2^53", existing: '{"x": 9007199254740993}' },
	{ name: "a number written 1.0", existing: '{"x": {"t": 1.0}, "hooks": {}}' },
	{ name: "an exponent number", existing: '{"x": 1E5}' },
	{ name: "negative zero", existing: '{"x": -0}' },
	{ name: "negative zero as a float", existing: '{"x": -0.0}' },
	{ name: "NaN", existing: '{"x": NaN}' },
	{ name: "Infinity", existing: '{"x": Infinity}' },
	{
		name: "plain integers and short decimals are kept exactly",
		existing: '{"x": [0, -7, 123456789012345, 0.5, -2.25, 12.125, 0.001], "hooks": {"Other": []}}',
	},
	{
		name: "a number-looking string is just a string",
		existing: '{"x": "12345678901234567890", "hooks": {}}',
	},
	{ name: "duplicate keys keep only the last", existing: '{"a": 1, "a": 2, "hooks": {}}' },
];

describe("mergeCodexHooksFile — the reference merge", () => {
	test("no existing file: the result is exactly the generator's file", () => {
		const r = mergeCodexHooksFile(null, OURS);
		expect(r).toEqual({ status: "changed", text: OURS });
	});

	test("another tool's SessionStart and PreToolUse hooks and an unknown top-level key survive; ours are current", () => {
		const r = mergeCodexHooksFile(otherToolsFile(), OURS);
		if (r.status !== "changed") throw new Error(`expected changed, got ${r.status}`);
		const merged = JSON.parse(r.text);
		const ours = JSON.parse(OURS).hooks;
		expect(merged["x-other-tool"]).toEqual({ enabled: true, level: [1, 2] });
		expect(merged.hooks.SessionStart).toEqual([OTHER_START, ours.SessionStart[0]]);
		expect(merged.hooks.PreToolUse).toEqual([OTHER_PRE, ours.PreToolUse[0]]);
		expect(merged.hooks.CustomEvent).toEqual([
			{ hooks: [{ type: "command", command: "othertool custom" }] },
		]);
		for (const event of CODEX_EVENT_ORDER) {
			expect(
				merged.hooks[event].some(
					(g: unknown) => JSON.stringify(g) === JSON.stringify(ours[event][0]),
				),
			).toBe(true);
		}
		// other entries keep their place; new events follow in generator order
		expect(Object.keys(merged)).toEqual(["x-other-tool", "hooks"]);
		expect(Object.keys(merged.hooks).slice(0, 3)).toEqual([
			"SessionStart",
			"PreToolUse",
			"CustomEvent",
		]);
	});

	test("idempotent: merging the merged file again is 'unchanged'", () => {
		const first = mergeCodexHooksFile(otherToolsFile(), OURS);
		if (first.status !== "changed") throw new Error("expected changed");
		expect(mergeCodexHooksFile(first.text, OURS).status).toBe("unchanged");
	});

	test("a differently formatted but equivalent file is 'unchanged' (the user's formatting is not rewritten)", () => {
		const compact = JSON.stringify(JSON.parse(OURS));
		expect(mergeCodexHooksFile(compact, OURS).status).toBe("unchanged");
	});

	test("an old AgentPulse entry is replaced, not duplicated", () => {
		const r = mergeCodexHooksFile(FIXTURES[4].existing, OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		const merged = JSON.parse(r.text);
		expect(merged.hooks.Stop).toHaveLength(1);
		expect(merged.hooks.Stop[0].hooks[0].command).not.toBe(OLD_FORMAT_COMMAND);
		expect(merged.hooks.Stop[0]).toEqual(JSON.parse(OURS).hooks.Stop[0]);
		expect(merged.hooks.PreToolUse[0]).toEqual(OTHER_PRE);
		expect(merged.hooks.PreToolUse).toHaveLength(2);
	});

	test("our handler in a shared group is removed from it; the other tool's handler stays", () => {
		const r = mergeCodexHooksFile(FIXTURES[5].existing, OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		const stop = JSON.parse(r.text).hooks.Stop;
		const commands = stop.flatMap((g: { hooks: { command: string }[] }) =>
			g.hooks.map((h) => h.command),
		);
		expect(commands.filter((c: string) => c === "othertool stop")).toHaveLength(1);
		expect(commands.filter((c: string) => c.includes("/api/v1/hooks?event="))).toHaveLength(1);
	});

	test("a retired AgentPulse event is cleaned out; another tool's event is kept", () => {
		const r = mergeCodexHooksFile(FIXTURES[6].existing, OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		const merged = JSON.parse(r.text);
		expect(merged.hooks.Retired).toBeUndefined();
		expect(merged.hooks.Other).toBeDefined();
	});

	test("other tools' entries whose text merely resembles ours are not taken: only the hook URL path marks ours", () => {
		const lookalike = JSON.stringify({
			hooks: {
				Stop: [
					{ hooks: [{ type: "command", command: "echo agentpulse codex_cli hooks" }] },
					{ hooks: [{ type: "command", command: "curl https://example.invalid/api/v1/hooks" }] },
					{ hooks: [{ type: "http", url: "http://x/api/v1/hooks?event=Stop" }] },
				],
			},
		});
		const r = mergeCodexHooksFile(lookalike, OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		expect(JSON.parse(r.text).hooks.Stop).toHaveLength(4);
	});

	const LOSSY = "has a number that cannot be kept exactly as written";
	for (const [name, reason] of [
		["a number beyond 2^53 in another tool's entry", LOSSY],
		["an integer just past 2^53", LOSSY],
		["a number written 1.0", LOSSY],
		["an exponent number", LOSSY],
		["negative zero", LOSSY],
		["negative zero as a float", LOSSY],
		["NaN", "is not valid JSON"],
		["Infinity", "is not valid JSON"],
	] as const) {
		test(`unusable, never rewritten: ${name}`, () => {
			const fixture = FIXTURES.find((f) => f.name === name);
			expect(mergeCodexHooksFile(fixture?.existing ?? null, OURS)).toEqual({
				status: "unusable",
				reason,
			});
		});
	}

	test("plain integers and short decimals survive byte for byte", () => {
		const fixture = FIXTURES.find((f) => f.name.startsWith("plain integers"));
		const r = mergeCodexHooksFile(fixture?.existing ?? null, OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		expect(r.text).toContain("123456789012345");
		expect(r.text).toContain("12.125");
		expect(r.text).toContain("0.001");
		expect(JSON.parse(r.text).x).toEqual([0, -7, 123456789012345, 0.5, -2.25, 12.125, 0.001]);
	});

	test("event names that are Object.prototype members do not throw or corrupt the result", () => {
		const fixture = FIXTURES.find((f) => f.name.startsWith("events named like"));
		const r = mergeCodexHooksFile(fixture?.existing ?? null, OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		const merged = JSON.parse(r.text);
		expect(Object.hasOwn(merged.hooks, "constructor")).toBe(true);
		expect(Object.hasOwn(merged.hooks, "__proto__")).toBe(true);
		expect(merged.hooks.toString).toBe("x");
		expect(merged.hooks.hasOwnProperty).toEqual([]);
		expect(r.text).toContain('"command": "c"');
		expect(r.text).toContain('"command": "p"');
		for (const event of CODEX_EVENT_ORDER) expect(merged.hooks[event]).toHaveLength(1);
	});

	test("our marker needs both the hook URL and the agent header; every generated command has both", () => {
		for (const direct of [false, true]) {
			for (const event of CODEX_EVENT_ORDER) {
				for (const build of [buildBashHookCommand, buildPowerShellHookCommand]) {
					const cmd = build({ baseUrl: BASE, direct, agent: "codex_cli", event });
					expect(cmd).toContain(AGENTPULSE_HOOK_MARKER);
					expect(cmd).toContain(AGENTPULSE_HOOK_HEADER);
				}
			}
		}
		expect(OLD_FORMAT_COMMAND).toContain(AGENTPULSE_HOOK_MARKER);
		expect(OLD_FORMAT_COMMAND).toContain(AGENTPULSE_HOOK_HEADER);
	});

	test("another tool's script that merely calls our URL is kept", () => {
		const fixture = FIXTURES.find((f) => f.name.startsWith("another tool's script"));
		const r = mergeCodexHooksFile(fixture?.existing ?? null, OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		const stop = JSON.parse(r.text).hooks.Stop;
		expect(stop).toHaveLength(2);
		expect(stop[0].hooks[0].command).toBe("curl http://localhost:3000/api/v1/hooks?event=Stop");
	});

	test("another tool's groups on both sides of ours keep their places", () => {
		const fixture = FIXTURES.find((f) => f.name.startsWith("another tool's groups"));
		const r = mergeCodexHooksFile(fixture?.existing ?? null, OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		const stop = JSON.parse(r.text).hooks.Stop;
		expect(
			stop.map((g: { hooks: { command: string }[] }) => g.hooks[0].command.slice(0, 11)),
		).toEqual([
			"before-tool",
			JSON.parse(OURS).hooks.Stop[0].hooks[0].command.slice(0, 11),
			"after-tool",
		]);
	});

	for (const name of [
		"invalid JSON",
		"top level is an array",
		"top level is null",
		"hooks is not an object",
		"hooks is null",
		"one of our events holds a non-list",
	]) {
		test(`unusable: ${name}`, () => {
			const fixture = FIXTURES.find((f) => f.name === name);
			const r = mergeCodexHooksFile(fixture?.existing ?? null, OURS);
			expect(r.status).toBe("unusable");
			if (r.status === "unusable") expect(r.reason.length).toBeGreaterThan(0);
		});
	}

	test("a non-list under an event that is not ours is kept and does not block the merge", () => {
		const r = mergeCodexHooksFile('{"hooks": {"custom": "mine"}}', OURS);
		if (r.status !== "changed") throw new Error("expected changed");
		expect(JSON.parse(r.text).hooks.custom).toBe("mine");
	});

	test("an empty file counts as nothing to preserve", () => {
		expect(mergeCodexHooksFile("  \n", OURS)).toEqual({ status: "changed", text: OURS });
	});
});

// ── every shell copy equals the reference ──

async function sourceBlock(site: string): Promise<string> {
	const source =
		site === "rendered /setup.sh"
			? await (await new Hono().route("/", setup).request("/setup.sh")).text()
			: readFileSync(join(ROOT, site), "utf-8");
	const start = source.indexOf("# >>> agentpulse-hook-cmd");
	const end = source.indexOf("# <<< agentpulse-hook-cmd");
	expect(start).toBeGreaterThan(-1);
	return source.slice(start, end + "# <<< agentpulse-hook-cmd".length);
}

async function runShellMerge(block: string, file: string) {
	const script = `${block}\nap_codex_merge_hooks_json "$AP_FILE"`;
	const proc = Bun.spawn(["bash", "-c", script], {
		stdin: new TextEncoder().encode(OURS),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: scratch("ap-merge-home-"),
			PYTHONDONTWRITEBYTECODE: "1",
			AP_FILE: file,
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, stdout, stderr };
}

for (const site of ["scripts/setup-relay.sh", "scripts/setup-hooks.sh", "rendered /setup.sh"]) {
	describe(`ap_codex_merge_hooks_json in ${site} equals mergeCodexHooksFile`, () => {
		for (const fixture of FIXTURES) {
			test(fixture.name, async () => {
				const dir = scratch("ap-merge-fixture-");
				const file = join(dir, "hooks.json");
				if (fixture.existing !== null) writeFileSync(file, fixture.existing);
				const expected = mergeCodexHooksFile(fixture.existing, OURS);
				const got = await runShellMerge(await sourceBlock(site), file);
				if (expected.status === "changed") {
					expect(got.code, got.stderr).toBe(0);
					expect(got.stdout).toBe(expected.text);
				} else if (expected.status === "unchanged") {
					expect(got.code, got.stderr).toBe(3);
				} else {
					expect(got.code, got.stderr).toBe(4);
					expect(got.stdout).toBe("");
					expect(got.stderr).toContain(file);
					expect(got.stderr).toContain(expected.reason);
				}
				// the merge itself never writes
				if (fixture.existing !== null) expect(readFileSync(file, "utf-8")).toBe(fixture.existing);
				else expect(existsSync(file)).toBe(false);
			});
		}
	});
}

for (const site of ["scripts/setup-relay.sh", "scripts/setup-hooks.sh", "rendered /setup.sh"]) {
	test(`${site}: a directory where hooks.json should be is reported as unreadable, not as bad JSON`, async () => {
		const dir = scratch("ap-merge-dir-");
		const file = join(dir, "hooks.json");
		mkdirSync(file);
		const got = await runShellMerge(await sourceBlock(site), file);
		expect(got.code).toBe(4);
		expect(got.stderr).toContain("could not be read");
		expect(got.stderr).not.toContain("not valid JSON");
		expect(got.stdout).toBe("");
	});
}

// ── whole installer runs (setup-hooks.sh and the rendered /setup.sh) ──

const SETUP_HOOKS = join(ROOT, "scripts/setup-hooks.sh");
const KEY = "ap_merge_key";

async function installerFile(site: string): Promise<{ file: string; served: boolean }> {
	if (site === "scripts/setup-hooks.sh") return { file: SETUP_HOOKS, served: false };
	const dir = scratch("ap-merge-served-");
	const file = join(dir, "setup.sh");
	writeFileSync(file, await (await new Hono().route("/", setup).request("/setup.sh")).text());
	return { file, served: true };
}

async function runInstaller(site: string, home: string) {
	const { file, served } = await installerFile(site);
	mkdirSync(join(home, ".codex"), { recursive: true });
	const args = served
		? ["--url", BASE, "--key", KEY]
		: ["--url", BASE, "--key", KEY, "--agent", "codex_cli"];
	const proc = Bun.spawn(["bash", file, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			PYTHONDONTWRITEBYTECODE: "1",
		},
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, out: out + err };
}

const backups = (home: string) =>
	readdirSync(join(home, ".codex")).filter((f) => f.includes("agentpulse-bak"));

for (const site of ["scripts/setup-hooks.sh", "rendered /setup.sh"]) {
	describe(`whole installer ${site}: Codex hooks.json is merged`, () => {
		test("other tools' hooks and an unknown key survive; a re-run is byte-identical with no write and no new backup", async () => {
			const home = scratch("ap-merge-home-");
			mkdirSync(join(home, ".codex"), { recursive: true });
			const hooksPath = join(home, ".codex", "hooks.json");
			writeFileSync(hooksPath, otherToolsFile());

			const run1 = await runInstaller(site, home);
			expect(run1.code, run1.out).toBe(0);
			const after1 = readFileSync(hooksPath, "utf-8");
			const parsed = JSON.parse(after1);
			expect(parsed["x-other-tool"]).toEqual({ enabled: true, level: [1, 2] });
			expect(parsed.hooks.SessionStart[0]).toEqual(OTHER_START);
			expect(parsed.hooks.PreToolUse[0]).toEqual(OTHER_PRE);
			expect(parsed.hooks.SessionStart).toHaveLength(2);
			expect(parsed.hooks.SessionStart[1].hooks[0].command).toContain(
				"/api/v1/hooks?event=SessionStart",
			);
			expect(Object.keys(parsed.hooks)).toEqual(
				expect.arrayContaining([...CODEX_EVENT_ORDER, "CustomEvent"]),
			);
			const expected = mergeCodexHooksFile(otherToolsFile(), OURS);
			expect(expected.status).toBe("changed");
			if (expected.status === "changed") expect(after1).toBe(expected.text);
			expect(backups(home)).toHaveLength(1);
			expect(readFileSync(join(home, ".codex", backups(home)[0]), "utf-8")).toBe(otherToolsFile());

			const old = new Date(Date.now() - 3600_000);
			utimesSync(hooksPath, old, old);
			const before = lstatSync(hooksPath);
			const run2 = await runInstaller(site, home);
			expect(run2.code, run2.out).toBe(0);
			expect(run2.out).toContain("Codex hooks unchanged");
			const after = lstatSync(hooksPath);
			expect(after.ino).toBe(before.ino);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(readFileSync(hooksPath, "utf-8")).toBe(after1);
			expect(backups(home)).toHaveLength(1);
		});

		test("an old AgentPulse entry is replaced, not duplicated", async () => {
			const home = scratch("ap-merge-home-");
			mkdirSync(join(home, ".codex"), { recursive: true });
			const hooksPath = join(home, ".codex", "hooks.json");
			writeFileSync(hooksPath, FIXTURES[4].existing as string);
			const run = await runInstaller(site, home);
			expect(run.code, run.out).toBe(0);
			const parsed = JSON.parse(readFileSync(hooksPath, "utf-8"));
			expect(parsed.hooks.Stop).toHaveLength(1);
			expect(JSON.stringify(parsed)).not.toContain("--data-binary @-");
			expect(parsed.hooks.PreToolUse[0]).toEqual(OTHER_PRE);
		});

		test("malformed JSON: the file is untouched, no backup, a clear message, the rest of setup still runs", async () => {
			const home = scratch("ap-merge-home-");
			mkdirSync(join(home, ".codex"), { recursive: true });
			const hooksPath = join(home, ".codex", "hooks.json");
			writeFileSync(hooksPath, '{"hooks": {oops');
			const run = await runInstaller(site, home);
			expect(run.code, run.out).toBe(0);
			expect(readFileSync(hooksPath, "utf-8")).toBe('{"hooks": {oops');
			expect(backups(home)).toHaveLength(0);
			expect(run.out).toContain("Codex hooks not updated");
			expect(run.out).toContain(hooksPath);
			expect(run.out).toContain("run this installer again");
			expect(existsSync(join(home, ".agentpulse", "exclude-check.sh"))).toBe(true);
			expect(run.out).not.toContain("Open Codex and run /hooks");
		});

		test("a symlinked hooks.json is still refused and its target untouched", async () => {
			const home = scratch("ap-merge-home-");
			mkdirSync(join(home, ".codex"), { recursive: true });
			const decoy = join(home, "decoy.json");
			writeFileSync(decoy, "should never change\n");
			symlinkSync(decoy, join(home, ".codex", "hooks.json"));
			const run = await runInstaller(site, home);
			expect(run.code).not.toBe(0);
			expect(run.out).toMatch(/refusing to write through a symlink/);
			expect(readFileSync(decoy, "utf-8")).toBe("should never change\n");

			writeFileSync(decoy, otherToolsFile());
			const run2 = await runInstaller(site, home);
			expect(run2.code).not.toBe(0);
			expect(run2.out).toMatch(/refusing to write through a symlink/);
			expect(readFileSync(decoy, "utf-8")).toBe(otherToolsFile());
		});
	});
}

describe("all copies produce the same file for the same input", () => {
	test("setup-hooks.sh and the rendered /setup.sh write byte-identical hooks.json from the same existing file", async () => {
		const results: string[] = [];
		for (const site of ["scripts/setup-hooks.sh", "rendered /setup.sh"]) {
			const home = scratch("ap-merge-home-");
			mkdirSync(join(home, ".codex"), { recursive: true });
			writeFileSync(join(home, ".codex", "hooks.json"), otherToolsFile());
			const run = await runInstaller(site, home);
			expect(run.code, run.out).toBe(0);
			results.push(readFileSync(join(home, ".codex", "hooks.json"), "utf-8"));
		}
		expect(results[0]).toBe(results[1]);
	});
});

describe("install-local.ps1's Codex merge (by reading; not executed on Windows)", () => {
	const ps = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");

	test("defines Merge-ApCodexHooksFile with the same marker and is used before the Codex write", () => {
		expect(ps).toContain("function Merge-ApCodexHooksFile");
		expect(ps).toContain("/api/v1/hooks?event=");
		const use = ps.indexOf("Merge-ApCodexHooksFile -Existing");
		const write = ps.indexOf("Write-ApFileNoFollow -Path $codexHooksFile");
		expect(use).toBeGreaterThan(-1);
		expect(write).toBeGreaterThan(use);
	});

	test("no longer compares the existing file with the generated file wholesale", () => {
		expect(ps).not.toContain("$existingCodexHooksJson -eq $newCodexHooksJson");
	});

	test("an unusable file is reported, left untouched and does not stop the install", () => {
		const fn = ps.slice(ps.indexOf("function Merge-ApCodexHooksFile"));
		expect(fn).toContain("Codex hooks not updated");
		expect(ps).toContain("Codex hooks not updated");
	});

	test("compares the files case-sensitively and keeps event names and handler keys case-sensitive", () => {
		const fn = ps.slice(
			ps.indexOf("function ConvertTo-ApOrdered"),
			ps.indexOf("# The POSIX `sh` equivalent"),
		);
		expect(fn).toContain("-ceq");
		expect(fn).not.toMatch(/\$after -eq \$before/);
		expect(fn).toContain("[System.StringComparer]::Ordinal");
		expect(fn).not.toContain("[ordered]@{}");
	});

	test("requires the agent header text as well as the hook URL, like every other copy", () => {
		const fn = ps.slice(
			ps.indexOf("function Test-ApAgentPulseHandler"),
			ps.indexOf("function Merge-ApCodexHooksFile"),
		);
		expect(fn).toContain(AGENTPULSE_HOOK_MARKER);
		expect(fn).toContain(AGENTPULSE_HOOK_HEADER);
	});

	test("refuses to write unless the other tools' entries survive the round trip through ConvertFrom-Json/ConvertTo-Json unchanged", () => {
		const fn = ps.slice(
			ps.indexOf("function Merge-ApCodexHooksFile"),
			ps.indexOf("# The POSIX `sh` equivalent"),
		);
		expect(fn).toContain("Get-ApCanonicalJson");
		expect(fn).toContain("cannot be kept exactly as written");
		expect(ps).toMatch(/function ConvertTo-ApHooksJson[\s\S]*-Depth 100/);
	});

	test("notes that duplicate JSON keys keep only the last", () => {
		expect(ps).toContain("Duplicate keys");
	});

	test("every System.Text.Json reference sits inside a try block of the two guarded functions, and the merge asks first", () => {
		const code = ps
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("\n");
		const refs = [...code.matchAll(/System\.Text\.Json/g)].map((m) => m.index as number);
		expect(refs.length).toBeGreaterThan(0);
		const guarded = ["function Test-ApJsonNodesAvailable", "function Get-ApCanonicalJson"].map(
			(name) => {
				const start = code.indexOf(name);
				const end = code.indexOf("\nfunction ", start + 1);
				return { start, end, body: code.slice(start, end) };
			},
		);
		for (const ref of refs) {
			const fn = guarded.find((g) => ref > g.start && ref < g.end);
			expect(fn, "a System.Text.Json reference outside the guarded functions").toBeDefined();
			const tryAt = (fn as { body: string; start: number }).body.indexOf("try {");
			expect(tryAt).toBeGreaterThan(-1);
			expect(ref - (fn as { start: number }).start).toBeGreaterThan(tryAt);
		}
		const merge = ps.slice(
			ps.indexOf("function Merge-ApCodexHooksFile"),
			ps.indexOf("# The POSIX `sh` equivalent"),
		);
		expect(merge.indexOf("Test-ApJsonNodesAvailable")).toBeGreaterThan(merge.indexOf("-eq ''"));
		expect(merge.indexOf("Test-ApJsonNodesAvailable")).toBeLessThan(
			merge.indexOf("ConvertFrom-Json"),
		);
		expect(merge).not.toContain("System.Text.Json");
	});

	test("the version gate is below 7.2 and an unusable type means the file is left alone with the stated message", () => {
		const fn = ps.slice(
			ps.indexOf("function Test-ApJsonNodesAvailable"),
			ps.indexOf("function Get-ApCanonicalJson"),
		);
		expect(fn).toContain("$PSVersionTable.PSVersion");
		expect(fn).toContain("-lt 7");
		expect(fn).toContain("-lt 2");
		expect(ps).toContain(
			"Codex hooks not updated: merging needs PowerShell 7.2 or later; $codexHooksFile was left untouched. Install PowerShell 7 and run this installer again.",
		);
		const call = ps.slice(ps.indexOf("$codexMerge = Merge-ApCodexHooksFile"));
		expect(call.indexOf("needs-pwsh7")).toBeLessThan(
			call.indexOf("Write-ApFileNoFollow -Path $codexHooksFile"),
		);
	});

	test("the Windows CI script runs the merge against another tool's hooks.json", () => {
		const ci = readFileSync(join(ROOT, "scripts/test-install-local.ps1"), "utf-8");
		expect(ci).toContain("Merge-ApCodexHooksFile -Existing");
		expect(ci).toContain("othertool start");
	});
});
