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
	CODEX_EVENT_ORDER,
	buildCodexHooksFile,
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
});
