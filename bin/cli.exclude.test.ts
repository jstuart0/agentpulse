/**
 * `agentpulse exclude check|add|list` — real subprocess runs
 * against a temp HOME, matching bin/cli.setup.test.ts's convention.
 * Never touches the real ~/.agentpulse or the real relay on :4000 —
 * AGENTPULSE_RELAY_LOCAL_URL is always pointed at an unreachable port or
 * a local stub this file controls.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	utimesSync,
	writeFileSync as writeFileSyncNode,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every case starts a bun process; several take 2.5-3.6 s of the 5 s default on a loaded machine.
setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "cli.ts");
const UNREACHABLE_RELAY = "http://127.0.0.1:1";

async function runCli(
	home: string,
	cliArgs: string[],
	opts: { cwd?: string; env?: Record<string, string> } = {},
) {
	const proc = Bun.spawn(["bun", CLI, ...cliArgs], {
		cwd: opts.cwd ?? home,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			AGENTPULSE_RELAY_LOCAL_URL: UNREACHABLE_RELAY,
			...opts.env,
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, stdout, stderr, out: stdout + stderr };
}

async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "ap-cli-exclude-"));
}

describe("agentpulse --help", () => {
	test("mentions exclude check, add, and list", async () => {
		const home = await tempHome();
		try {
			const res = await runCli(home, ["--help"]);
			expect(res.code).toBe(0);
			expect(res.stdout).toContain("exclude check");
			expect(res.stdout).toContain("exclude add");
			expect(res.stdout).toContain("exclude list");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude check", () => {
	test("an excluded directory prints EXCLUDED, the matching rule and line, exits 0", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), `${dir}\n`);

			const res = await runCli(home, ["exclude", "check", dir], { cwd: dir });
			expect(res.code).toBe(0);
			expect(res.stdout).toContain("EXCLUDED");
			expect(res.stdout).toContain(dir);
			expect(res.stdout).toContain("line 1");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a clean directory exits 1", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "clean");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), `${join(home, "work")}\n`);

			const res = await runCli(home, ["exclude", "check", dir], { cwd: dir });
			expect(res.code).toBe(1);
			expect(res.stdout).toContain("NOT EXCLUDED");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("an invalid rules file exits 2, prints the line number, the fix-it hint, and the full per-sender table", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), "/a/work/*\n");

			const res = await runCli(home, ["exclude", "check"]);
			expect(res.code).toBe(2);
			expect(res.stdout).toContain("RULES INVALID");
			expect(res.stdout).toContain("line 1");
			expect(res.stdout.toLowerCase()).toContain("wildcard");
			expect(res.stdout).toContain("Sender");
			expect(res.stdout).toContain("Codex CLI");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--json on each of the three verdicts is parseable and matches the text form's facts", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), `${dir}\n`);

			const excludedRes = await runCli(home, ["exclude", "check", dir, "--json"], { cwd: dir });
			const excludedJson = JSON.parse(excludedRes.stdout);
			expect(excludedJson.excluded).toBe(true);
			expect(excludedJson.rulesState).toBe("ok");

			const cleanDir = join(home, "clean");
			await mkdir(cleanDir, { recursive: true });
			const notExcludedRes = await runCli(home, ["exclude", "check", cleanDir, "--json"]);
			const notExcludedJson = JSON.parse(notExcludedRes.stdout);
			expect(notExcludedJson.excluded).toBe(false);

			await writeFile(join(home, ".agentpulse", "exclude"), "/a/work/*\n");
			const invalidRes = await runCli(home, ["exclude", "check", "--json"]);
			const invalidJson = JSON.parse(invalidRes.stdout);
			expect(invalidJson.rulesState).toBe("invalid");
			expect(invalidJson.rulesLine).toBe(1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("NO_COLOR set → no ANSI escapes in any of the three verdict outputs", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), `${dir}\n`);

			const excludedRes = await runCli(home, ["exclude", "check", dir], {
				cwd: dir,
				env: { NO_COLOR: "1" },
			});
			expect(excludedRes.out.includes(String.fromCharCode(27))).toBe(false);

			const cleanDir = join(home, "clean");
			await mkdir(cleanDir, { recursive: true });
			const notExcludedRes = await runCli(home, ["exclude", "check", cleanDir], {
				env: { NO_COLOR: "1" },
			});
			expect(notExcludedRes.out.includes(String.fromCharCode(27))).toBe(false);

			await writeFile(join(home, ".agentpulse", "exclude"), "/a/work/*\n");
			const invalidRes = await runCli(home, ["exclude", "check"], { env: { NO_COLOR: "1" } });
			expect(invalidRes.out.includes(String.fromCharCode(27))).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("under RULES INVALID with Claude direct hooks installed, the Claude row says STILL REPORTING, never 'nothing is being sent from this machine'", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await writeFile(
				join(home, ".claude", "settings.json"),
				JSON.stringify({
					hooks: {
						SessionStart: [
							{
								matcher: "",
								hooks: [
									{
										type: "http",
										url: "http://localhost:4000/api/v1/hooks",
										allowedEnvVars: ["AGENTPULSE_API_KEY"],
										headers: { Authorization: "Bearer $AGENTPULSE_API_KEY" },
									},
								],
							},
						],
					},
				}),
			);
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), "/a/work/*\n");

			const res = await runCli(home, ["exclude", "check"]);
			expect(res.code).toBe(2);
			expect(res.stdout).toContain("STILL REPORTING");
			expect(res.stdout.toLowerCase()).not.toContain("nothing is being sent from this machine");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("an old relay stub that 404s exclude-check reports the Relay row not enforced; no supervisor stamp reports not detected; a hooks file lacking the snippet reports Codex not enforced", async () => {
		const home = await tempHome();
		const stub = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch() {
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const dir = join(home, "clean");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".codex"), { recursive: true });
			await writeFile(join(home, ".codex", "hooks.json"), '{"hooks":{}}');

			const res = await runCli(home, ["exclude", "check", dir], {
				env: { AGENTPULSE_RELAY_LOCAL_URL: `http://127.0.0.1:${stub.port}` },
			});
			expect(res.stdout).toContain("Relay");
			expect(res.stdout).toContain("not enforced");
			expect(res.stdout).toContain("not detected");
			expect(res.stdout).toContain("Codex CLI");
		} finally {
			stub.stop(true);
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude check: the Supervisor row", () => {
	/** The Supervisor row for a home whose supervisor stamp holds `stamp` (a fresh one, as a running supervisor writes). */
	async function supervisorRow(stamp: Record<string, unknown> | null): Promise<string> {
		const home = await tempHome();
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
			if (stamp) {
				await writeFile(
					join(home, ".agentpulse", "supervisor-exclude-state.json"),
					`${JSON.stringify({ version: "1.0.0", at: new Date().toISOString(), ...stamp })}\n`,
					{ mode: 0o600 },
				);
			}
			const res = await runCli(home, ["exclude", "check", dir], { cwd: dir });
			return (
				res.stdout
					.split("\n")
					.find((l) => l.includes("Supervisor"))
					?.trim() ?? ""
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	test("a stamp that blames the saved gate state says so, and does not say enforced", async () => {
		const row = await supervisorRow({ rulesState: "invalid", cause: "state_file" });
		expect(row).toContain("saved state");
		expect(row).toContain("supervisor log");
		expect(row).not.toMatch(/\benforced\b(?!,)/);
	});

	test("an ordinary stamp, and one blaming the exclude file, still read enforced", async () => {
		expect(await supervisorRow({ rulesState: "ok" })).toContain("enforced");
		expect(await supervisorRow({ rulesState: "invalid", cause: "exclude_file" })).toContain(
			"enforced",
		);
	});
});

describe("agentpulse exclude check — the Relay row against a relay that answers", () => {
	/** A stand-in relay: answers the check endpoint the way the real one does, with whatever verdict it is told to. */
	async function relayRow(
		answer: (url: URL) => Response,
		rules: "excluded-dir" | "clean-dir",
	): Promise<{ row: string; out: string; code: number | null }> {
		const home = await tempHome();
		const asked: string[] = [];
		const stub = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				const url = new URL(req.url);
				asked.push(url.pathname + url.search);
				return answer(url);
			},
		});
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
			await writeFile(
				join(home, ".agentpulse", "exclude"),
				rules === "excluded-dir" ? `${dir}\n` : `${join(home, "elsewhere")}\n`,
				{ mode: 0o600 },
			);
			const res = await runCli(home, ["exclude", "check", dir], {
				cwd: dir,
				env: { AGENTPULSE_RELAY_LOCAL_URL: `http://127.0.0.1:${stub.port}` },
			});
			expect(asked.some((a) => a.startsWith("/api/v1/relay/exclude-check?cwd="))).toBe(true);
			const row =
				res.stdout
					.split("\n")
					.find((l) => l.includes("Relay"))
					?.trim() ?? "";
			return { row, out: res.stdout, code: res.code };
		} finally {
			stub.stop(true);
			await rm(home, { recursive: true, force: true });
		}
	}

	test("a relay that answers the endpoint, and agrees, reads enforced", async () => {
		const excluded = await relayRow(
			() => Response.json({ excluded: true, reason: "path", rulesState: "ok" }),
			"excluded-dir",
		);
		expect(excluded.row).toContain("enforced");
		expect(excluded.row).not.toContain("not enforced");
		const clean = await relayRow(
			() => Response.json({ excluded: false, reason: null, rulesState: "ok" }),
			"clean-dir",
		);
		expect(clean.row).toContain("enforced");
		expect(clean.row).not.toContain("not enforced");
	});

	test("a relay whose embedded evaluator disagrees with this command's is not called enforced, and the table says how they differ", async () => {
		const { row, out } = await relayRow(
			() => Response.json({ excluded: false, reason: null, rulesState: "ok" }),
			"excluded-dir",
		);
		expect(row).toContain("not enforced");
		expect(row).toContain("disagree");
		expect(row).toContain("relay: not excluded");
		expect(row).toContain("this command: excluded");
		expect(out).toContain("warning: Relay");
	});

	test("a relay that answers 200 without a verdict still reads enforced (it answered; there is nothing to compare)", async () => {
		const { row } = await relayRow(() => new Response("{}", { status: 200 }), "excluded-dir");
		expect(row).toContain("enforced");
		expect(row).not.toContain("not enforced");
	});

	test("a relay that 403s the endpoint (a different version, a proxy) is not enforced", async () => {
		const { row } = await relayRow(() => new Response("no", { status: 403 }), "excluded-dir");
		expect(row).toContain("not enforced");
	});

	test("the Claude direct row says what is true: path rules are not applied, the server honours the skip variable, the request still leaves this machine", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await writeFile(
				join(home, ".claude", "settings.json"),
				JSON.stringify({
					hooks: {
						SessionStart: [
							{
								matcher: "",
								hooks: [
									{
										type: "http",
										url: "https://agentpulse.example.test/api/v1/hooks",
										headers: { Authorization: "Bearer ap_literal" },
									},
								],
							},
						],
					},
				}),
			);
			const dir = join(home, "clean");
			await mkdir(dir, { recursive: true });
			const res = await runCli(home, ["exclude", "check", dir]);
			const row =
				res.stdout
					.split("\n")
					.find((l) => l.includes("Claude Code"))
					?.trim() ?? "";
			expect(row).toContain(
				"path rules not applied; AGENTPULSE_SKIP is honoured by the server (the request still leaves this machine)",
			);
			expect(row).not.toContain("AGENTPULSE_SKIP only");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude add", () => {
	test("a relative dir is resolved, validated, written at mode 0600, with the three caveats printed", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			const res = await runCli(home, ["exclude", "add", "sub"], { cwd: home });
			expect(res.code).toBe(0);
			expect(res.stdout).toContain("Applies to new events");
			expect(res.stdout).toContain("Sessions already reported are not removed");
			expect(res.stdout).toContain("will look stalled on the dashboard");

			const written = await readFile(join(home, ".agentpulse", "exclude"), "utf-8");
			expect(written).toContain(sub);

			const { stat } = await import("node:fs/promises");
			const mode = (await stat(join(home, ".agentpulse", "exclude"))).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a dir resolving to a path with a '.'/'..' segment is refused and writes nothing", async () => {
		const home = await tempHome();
		try {
			const res = await runCli(home, ["exclude", "add", "/a/notsecret/../secret"]);
			expect(res.code).not.toBe(0);
			expect(res.out.toLowerCase()).toContain("resolve");

			const { existsSync } = await import("node:fs");
			expect(existsSync(join(home, ".agentpulse", "exclude"))).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("'.' resolves the current working directory", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "here");
			await mkdir(sub, { recursive: true });
			const res = await runCli(home, ["exclude", "add", "."], { cwd: sub });
			expect(res.code).toBe(0);
			const written = await readFile(join(home, ".agentpulse", "exclude"), "utf-8");
			// macOS's /tmp -> /private/tmp (and /var -> /private/var) symlink
			// means the CLI's own path.resolve(".") can legitimately differ in
			// that one leading segment from this test's own `sub` string —
			// compare the suffix, which is what actually proves "." resolved
			// to the right directory.
			expect(written.trim().endsWith(sub.replace(/^\/private/, ""))).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("never widens permissions on an existing file", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			const rulesPath = join(home, ".agentpulse", "exclude");
			await writeFile(rulesPath, "/a/work\n", { mode: 0o644 });
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });

			await runCli(home, ["exclude", "add", sub]);

			const { stat } = await import("node:fs/promises");
			const mode = (await stat(rulesPath)).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	// Writes go through a temp-file-then-rename —
	// confirms no leftover temp file after a normal, successful add (the
	// atomicity guarantee itself — a failure between write and rename never
	// leaves the target empty or partial — is unit-tested directly against
	// writePrivateFileAtomicNoFollow's injectable rename provider in
	// src/shared/private-file.test.ts, the only place that seam is reachable
	// from; this CLI is a subprocess and can't inject into it).
	test("leaves no leftover temp file in .agentpulse after a normal add", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			await runCli(home, ["exclude", "add", sub]);
			const entries = readdirSync(join(home, ".agentpulse")).sort();
			// the rules file and the installed check; no temp or lock file left over
			expect(entries).toEqual(["exclude", "exclude-check.sh"]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a symlinked .agentpulse with a good (user-owned, not group/world-writable) target works", async () => {
		const home = await tempHome();
		try {
			const realDir = join(home, "real-agentpulse");
			await mkdir(realDir, { recursive: true, mode: 0o700 });
			chmodSync(realDir, 0o700);
			symlinkSync(realDir, join(home, ".agentpulse"));
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });

			const res = await runCli(home, ["exclude", "add", sub]);
			expect(res.code).toBe(0);
			expect(res.out).not.toContain(".js:");
			expect(res.out).not.toContain("Error:");
			const written = await readFile(join(realDir, "exclude"), "utf-8");
			expect(written).toContain(sub);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a symlinked .agentpulse with a group-writable target is refused, one clear line, no stack trace", async () => {
		const home = await tempHome();
		try {
			const realDir = join(home, "real-agentpulse");
			await mkdir(realDir, { recursive: true });
			chmodSync(realDir, 0o770);
			symlinkSync(realDir, join(home, ".agentpulse"));
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });

			const res = await runCli(home, ["exclude", "add", sub]);
			expect(res.code).not.toBe(0);
			expect(res.out.toLowerCase()).toContain("writable");
			expect(res.out).not.toContain("at Object");
			expect(res.out).not.toContain(".js:");
			expect(res.out.split("\n").filter((l) => l.trim().length > 0).length).toBeLessThanOrEqual(2);
			chmodSync(realDir, 0o700);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32")(
		"a ~/.agentpulse that is a regular file is refused with one clear line, nothing written",
		async () => {
			const home = await tempHome();
			try {
				writeFileSyncNode(join(home, ".agentpulse"), "not a directory");
				const sub = join(home, "sub");
				await mkdir(sub, { recursive: true });
				const res = await runCli(home, ["exclude", "add", sub]);
				expect(res.code).not.toBe(0);
				expect(res.out).toContain("is not a directory");
				expect(readFileSync(join(home, ".agentpulse"), "utf-8")).toBe("not a directory");
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"a ~/.agentpulse that is a link to a regular file, or to nowhere, is refused with one clear line",
		async () => {
			for (const target of ["a-file", "nowhere"]) {
				const home = await tempHome();
				try {
					if (target === "a-file") writeFileSyncNode(join(home, target), "x");
					symlinkSync(join(home, target), join(home, ".agentpulse"));
					const sub = join(home, "sub");
					await mkdir(sub, { recursive: true });
					const res = await runCli(home, ["exclude", "add", sub]);
					expect(res.code, target).not.toBe(0);
					expect(res.out, target).toMatch(/does not resolve to a directory|could not be resolved/);
					expect(res.out).not.toContain("at Object");
				} finally {
					await rm(home, { recursive: true, force: true });
				}
			}
		},
	);

	test("the rules file itself being a symlink is refused, one clear line, no stack trace", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			const realFile = join(home, "real-exclude");
			await writeFile(realFile, "/a/work\n");
			symlinkSync(realFile, join(home, ".agentpulse", "exclude"));
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });

			const res = await runCli(home, ["exclude", "add", sub]);
			expect(res.code).not.toBe(0);
			expect(res.out.toLowerCase()).toContain("symlink");
			expect(res.out).not.toContain("at Object");
			expect(res.out).not.toContain(".js:");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("an already-invalid rules file is refused outright, unchanged, exit non-zero, line number and reason printed", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			const rulesPath = join(home, ".agentpulse", "exclude");
			await writeFile(rulesPath, "/a/work/*\n");
			const before = await readFile(rulesPath, "utf-8");
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });

			const res = await runCli(home, ["exclude", "add", sub]);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("line 1");
			expect(res.out.toLowerCase()).toContain("wildcard");

			const after = await readFile(rulesPath, "utf-8");
			expect(after).toBe(before);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("adding the same directory twice does not duplicate the rule", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			await runCli(home, ["exclude", "add", sub]);
			const res = await runCli(home, ["exclude", "add", sub]);
			expect(res.code).toBe(0);

			const rulesPath = join(home, ".agentpulse", "exclude");
			const content = await readFile(rulesPath, "utf-8");
			const matches = content.split("\n").filter((l) => l.trim() === sub);
			expect(matches.length).toBe(1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a trailing-slash spelling of an already-added directory does not duplicate the rule", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			await runCli(home, ["exclude", "add", sub]);
			const res = await runCli(home, ["exclude", "add", `${sub}/`]);
			expect(res.code).toBe(0);

			const rulesPath = join(home, ".agentpulse", "exclude");
			const content = await readFile(rulesPath, "utf-8");
			const matches = content.split("\n").filter((l) => l.trim().length > 0);
			expect(matches.length).toBe(1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a symlinked spelling of an already-added directory does not duplicate the rule", async () => {
		const home = await tempHome();
		try {
			const real = join(home, "real-target");
			await mkdir(real, { recursive: true });
			const link = join(home, "link-to-target");
			symlinkSync(real, link);

			await runCli(home, ["exclude", "add", real]);
			const res = await runCli(home, ["exclude", "add", link]);
			expect(res.code).toBe(0);

			const rulesPath = join(home, ".agentpulse", "exclude");
			const content = await readFile(rulesPath, "utf-8");
			const matches = content.split("\n").filter((l) => l.trim().length > 0);
			expect(matches.length).toBe(1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("neither HOME nor USERPROFILE set fails with a clear message, not a silent '~' fallback", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			const proc = Bun.spawn(["bun", CLI, "exclude", "add", sub], {
				cwd: home,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					AGENTPULSE_RELAY_LOCAL_URL: UNREACHABLE_RELAY,
					// Deliberately no HOME, no USERPROFILE.
				},
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			await proc.exited;
			expect(proc.exitCode).not.toBe(0);
			expect((stdout + stderr).toLowerCase()).toContain("home");
			expect(existsSync(join(home, "~"))).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude list", () => {
	test("prints every rule with its line number, in file order, and the resolved rules-file path", async () => {
		const home = await tempHome();
		try {
			const a = join(home, "a-dir");
			const b = join(home, "b-dir");
			await mkdir(a, { recursive: true });
			await mkdir(b, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), `${a}\n${b}\n`);

			const res = await runCli(home, ["exclude", "list"]);
			expect(res.code).toBe(0);
			const lines = res.stdout.split("\n");
			const aIndex = lines.findIndex((l) => l.includes(a));
			const bIndex = lines.findIndex((l) => l.includes(b));
			expect(aIndex).toBeGreaterThanOrEqual(0);
			expect(bIndex).toBeGreaterThan(aIndex);
			expect(lines[aIndex]).toContain("1:");
			expect(lines[bIndex]).toContain("2:");
			expect(res.stdout).toContain(".agentpulse");
			expect(res.stdout).toContain("exclude");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("warns for a rule whose directory doesn't exist", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			const ghost = join(home, "never-created");
			await writeFile(join(home, ".agentpulse", "exclude"), `${ghost}\n`);

			const res = await runCli(home, ["exclude", "list"]);
			expect(res.code).toBe(0);
			expect(res.stdout.toLowerCase()).toContain("warning");
			expect(res.stdout.toLowerCase()).toContain("does not exist");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	// Every hook event pays for evaluating the whole rules file, so a long
	// one is worth a nudge. The threshold is 50.
	async function listWithRuleCount(count: number) {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			const rules = Array.from({ length: count }, (_, i) => join(home, `proj-${i}`));
			await writeFile(join(home, ".agentpulse", "exclude"), `${rules.join("\n")}\n`);
			return await runCli(home, ["exclude", "list"]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	test("warns when there are more than 50 rules, and says why in plain words", async () => {
		const res = await listWithRuleCount(51);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/warning: 51 rules/i);
		expect(res.stdout).toContain("more than 50");
		expect(res.stdout).toContain("every hook event");
		expect(res.stdout).toContain("parent directory");
	});

	test("does not warn at exactly 50 rules", async () => {
		const res = await listWithRuleCount(50);
		expect(res.code).toBe(0);
		expect(res.stdout).not.toContain("more than 50");
		expect(res.stdout).not.toMatch(/warning: \d+ rules/i);
	});

	test("an invalid rules file exits 2", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), "/a/work/*\n");
			const res = await runCli(home, ["exclude", "list"]);
			expect(res.code).toBe(2);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude check — TypeScript/shell disagreement guard", () => {
	test("the real TypeScript and shell evaluators agree on an ordinary case (sanity: the guard doesn't false-positive)", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), `${dir}\n`);

			const res = await runCli(home, ["exclude", "check", dir], { cwd: dir });
			expect(res.code).toBe(0);
			expect(res.out).not.toContain("disagree");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	// A test-only seam (AGENTPULSE_TEST_FORCE_SHELL_RESULT,
	// guarded by scripts/check-no-exclude-provider-outside-tests.ts) makes
	// excludeCheck use a forced value instead of actually running the shell
	// snippet, so this can prove the exact exit code and message of the
	// disagreement path without needing the two real evaluators to ever
	// actually disagree.
	test("a forced TypeScript/shell disagreement exits 2 with a clear message naming both verdicts", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), `${dir}\n`);

			// TypeScript says excluded (dir matches the rule); force the shell
			// side to disagree.
			const res = await runCli(home, ["exclude", "check", dir], {
				cwd: dir,
				env: { AGENTPULSE_TEST_FORCE_SHELL_RESULT: "0" },
			});
			expect(res.code).toBe(2);
			expect(res.out).toContain("disagree");
			expect(res.out).toContain("TypeScript: excluded");
			expect(res.out).toContain("shell: not excluded");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a forced disagreement the other way (TypeScript says not excluded, shell says excluded) also exits 2", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "clean");
			await mkdir(dir, { recursive: true });

			const res = await runCli(home, ["exclude", "check", dir], {
				cwd: dir,
				env: { AGENTPULSE_TEST_FORCE_SHELL_RESULT: "1" },
			});
			expect(res.code).toBe(2);
			expect(res.out).toContain("disagree");
			expect(res.out).toContain("TypeScript: not excluded");
			expect(res.out).toContain("shell: excluded");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude check — reason text", () => {
	test("a path-rule match shows 'reason: a matching directory rule' in text, and reason: \"path\" in --json", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), `${dir}\n`);

			const textRes = await runCli(home, ["exclude", "check", dir], { cwd: dir });
			expect(textRes.stdout).toContain("reason: a matching directory rule");

			const jsonRes = await runCli(home, ["exclude", "check", dir, "--json"], { cwd: dir });
			const json = JSON.parse(jsonRes.stdout);
			expect(json.reason).toBe("path");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("AGENTPULSE_SKIP shows 'reason: AGENTPULSE_SKIP' in text, and reason: \"env\" in --json", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "work");
			await mkdir(dir, { recursive: true });

			const textRes = await runCli(home, ["exclude", "check", dir], {
				cwd: dir,
				env: { AGENTPULSE_SKIP: "1" },
			});
			expect(textRes.stdout).toContain("reason: AGENTPULSE_SKIP");

			const jsonRes = await runCli(home, ["exclude", "check", dir, "--json"], {
				cwd: dir,
				env: { AGENTPULSE_SKIP: "1" },
			});
			const json = JSON.parse(jsonRes.stdout);
			expect(json.reason).toBe("env");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("rules_invalid shows RULES INVALID (not a generic 'reason:' line) in text, and rulesReason/reason: \"rules_invalid\" in --json", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "exclude"), "/a/work/*\n");

			const textRes = await runCli(home, ["exclude", "check"]);
			expect(textRes.stdout).toContain("RULES INVALID");

			const jsonRes = await runCli(home, ["exclude", "check", "--json"]);
			const json = JSON.parse(jsonRes.stdout);
			expect(json.rulesState).toBe("invalid");
			expect(json.reason).toBe("rules_invalid");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a clean directory (no rule matched) is NOT EXCLUDED, reason: null in --json", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "clean");
			await mkdir(dir, { recursive: true });

			const textRes = await runCli(home, ["exclude", "check", dir], { cwd: dir });
			expect(textRes.stdout).toContain("NOT EXCLUDED");

			const jsonRes = await runCli(home, ["exclude", "check", dir, "--json"], { cwd: dir });
			const json = JSON.parse(jsonRes.stdout);
			expect(json.excluded).toBe(false);
			expect(json.reason).toBeNull();
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	// "no_cwd" is the one ExcludeDecisionReason this CLI can never actually
	// surface: excludeCheck always computes targetDir via path.resolve(),
	// which is always a non-empty absolute string — evaluateExclusion's
	// no_cwd branch requires a null/undefined/empty/relative cwd, none of
	// which this CLI can ever produce. Documented here rather than silently
	// left untested: the other three reasons (env, path, rules_invalid) plus
	// null are covered above; no_cwd's text mapping has no CLI-reachable
	// path to assert against.
});

describe("agentpulse exclude check — long rule lists", () => {
	async function checkWithRuleCount(count: number) {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			const rules = Array.from({ length: count }, (_, i) => join(home, `proj-${i}`));
			await writeFile(join(home, ".agentpulse", "exclude"), `${rules.join("\n")}\n`);
			return await runCli(home, ["exclude", "check", home]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	test("warns above 50 rules with the same plain-words message as list", async () => {
		const res = await checkWithRuleCount(51);
		expect(res.stdout).toMatch(/warning: 51 rules/i);
		expect(res.stdout).toContain("more than 50");
		expect(res.stdout).toContain("every hook event");
		expect(res.stdout).toContain("parent directory");
	});

	test("no warning at exactly 50", async () => {
		const res = await checkWithRuleCount(50);
		expect(res.stdout).not.toMatch(/warning: \d+ rules/i);
	});
});

describe("agentpulse exclude check — the invalid marker is never written through a link", () => {
	test.skipIf(process.platform === "win32")(
		"a group-writable directory with a planted marker symlink: the victim keeps its content",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, "exclude"), "/a/work\n");
				const victim = join(home, "victim.txt");
				await writeFile(victim, "precious");
				symlinkSync(victim, join(dir, "exclude.invalid"));
				chmodSync(dir, 0o770);
				const res = await runCli(home, ["exclude", "check", home]);
				chmodSync(dir, 0o700);
				expect(res.code).toBe(2);
				expect(readFileSync(victim, "utf-8")).toBe("precious");
				expect(lstatSync(join(dir, "exclude.invalid")).isSymbolicLink()).toBe(true);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"a trusted directory with an invalid file and a planted marker symlink: the victim keeps its content",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(dir, { recursive: true });
				chmodSync(dir, 0o700);
				await writeFile(join(dir, "exclude"), "/a/work/*\n");
				const victim = join(home, "victim.txt");
				await writeFile(victim, "precious");
				symlinkSync(victim, join(dir, "exclude.invalid"));
				const res = await runCli(home, ["exclude", "check", home]);
				expect(res.code).toBe(2);
				expect(readFileSync(victim, "utf-8")).toBe("precious");
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);
});

describe("agentpulse exclude check — a stale invalid marker once the rules file is gone", () => {
	test.skipIf(process.platform === "win32")(
		"is cleared in a trusted directory (so the statusline stops saying 'invalid') and left in a group-writable one",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(dir, { recursive: true });
				chmodSync(dir, 0o700);
				const marker = join(dir, "exclude.invalid");
				writeFileSyncNode(marker, "");
				const res = await runCli(home, ["exclude", "check", home]);
				expect(res.code).toBe(1);
				expect(existsSync(marker)).toBe(false);

				writeFileSyncNode(marker, "");
				chmodSync(dir, 0o770);
				const res2 = await runCli(home, ["exclude", "check", home]);
				chmodSync(dir, 0o700);
				expect(res2.code).not.toBe(2);
				expect(existsSync(marker), "an untrusted directory's marker is not removed").toBe(true);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);
});

describe("agentpulse exclude add installs the exclusion check", () => {
	test("someone with pasted hook config and no script gets the script when they add a rule", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			const res = await runCli(home, ["exclude", "add", sub]);
			expect(res.code).toBe(0);
			const script = join(home, ".agentpulse", "exclude-check.sh");
			const { buildBashExcludeScript } = await import("../src/shared/hook-command.js");
			expect(readFileSync(script, "utf-8")).toBe(buildBashExcludeScript());
			if (process.platform !== "win32") expect(lstatSync(script).mode & 0o777).toBe(0o500);
			expect(res.out).toContain("Exclusion check");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("adding a rule that is already there still refreshes a stale script", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			await runCli(home, ["exclude", "add", sub]);
			const script = join(home, ".agentpulse", "exclude-check.sh");
			chmodSync(script, 0o600);
			writeFileSyncNode(script, "#!/bin/sh\nexit 0\n");
			const res = await runCli(home, ["exclude", "add", sub]);
			expect(res.code).toBe(0);
			expect(res.out).toContain("already excluded");
			const { buildBashExcludeScript } = await import("../src/shared/hook-command.js");
			expect(readFileSync(script, "utf-8")).toBe(buildBashExcludeScript());
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude check — the installed script's verdict is cross-checked", () => {
	test.skipIf(process.platform === "win32")(
		"a stale installed script that disagrees with the TypeScript evaluator is caught (exit 2), proving the installed copy is what runs",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, "work");
				await mkdir(dir, { recursive: true });
				await mkdir(join(home, ".agentpulse"), { recursive: true });
				chmodSync(join(home, ".agentpulse"), 0o700);
				await writeFile(join(home, ".agentpulse", "exclude"), `${dir}\n`, { mode: 0o600 });
				const script = join(home, ".agentpulse", "exclude-check.sh");
				writeFileSyncNode(
					script,
					"#!/bin/sh\n# agentpulse-exclude-check 00000000000000\nexit 42\n",
				);
				chmodSync(script, 0o500);
				const res = await runCli(home, ["exclude", "check", dir], { cwd: dir });
				expect(res.code).toBe(2);
				expect(res.stderr).toContain("disagree");
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"only exit 42 means send: an empty installed script on a directory the evaluator allows is a disagreement, not a pass",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, "work");
				await mkdir(dir, { recursive: true });
				await mkdir(join(home, ".agentpulse"), { recursive: true });
				chmodSync(join(home, ".agentpulse"), 0o700);
				await writeFile(join(home, ".agentpulse", "exclude"), `${join(home, "other")}\n`, {
					mode: 0o600,
				});
				const script = join(home, ".agentpulse", "exclude-check.sh");
				writeFileSyncNode(script, "");
				chmodSync(script, 0o500);
				const res = await runCli(home, ["exclude", "check", dir], { cwd: dir });
				expect(res.code).toBe(2);
				expect(res.stderr).toContain("disagree");
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"with no script installed the generator's text is run instead, and agrees",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, "work");
				await mkdir(dir, { recursive: true });
				await mkdir(join(home, ".agentpulse"), { recursive: true });
				chmodSync(join(home, ".agentpulse"), 0o700);
				await writeFile(join(home, ".agentpulse", "exclude"), `${dir}\n`, { mode: 0o600 });
				const res = await runCli(home, ["exclude", "check", dir], { cwd: dir });
				expect(res.code).toBe(0);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);
});

describe("agentpulse exclude add / check — the PowerShell check on Windows (the Windows branch forced on, never executed on Windows)", () => {
	const FORCE = { AGENTPULSE_TEST_FORCE_PS_SCRIPT: "1" };

	test("exclude add installs both checks, the .ps1 without a byte order mark", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			const res = await runCli(home, ["exclude", "add", sub], { env: FORCE });
			expect(res.code).toBe(0);
			const { buildBashExcludeScript, buildPowerShellExcludeScript } = await import(
				"../src/shared/hook-command.js"
			);
			expect(readFileSync(join(home, ".agentpulse", "exclude-check.sh"), "utf-8")).toBe(
				buildBashExcludeScript(),
			);
			const ps = readFileSync(join(home, ".agentpulse", "exclude-check.ps1"));
			expect(ps.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
			expect(ps.toString("utf-8")).toBe(buildPowerShellExcludeScript());
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("without the Windows branch, only the shell check is installed", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			await runCli(home, ["exclude", "add", sub]);
			expect(existsSync(join(home, ".agentpulse", "exclude-check.ps1"))).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("exclude check: hooks that run the .ps1 are enforced only while that file is current", async () => {
		const home = await tempHome();
		try {
			const sub = join(home, "sub");
			await mkdir(sub, { recursive: true });
			await runCli(home, ["exclude", "add", sub], { env: FORCE });
			await mkdir(join(home, ".copilot", "hooks"), { recursive: true });
			await writeFile(
				join(home, ".copilot", "hooks", "agentpulse.json"),
				'{"powershell":"Join-Path $apDir \'exclude-check.ps1\'"}',
			);
			const row = async () => {
				const res = await runCli(home, ["exclude", "check", join(home, "clean")], { env: FORCE });
				return (
					res.stdout
						.split("\n")
						.find((l) => l.includes("Copilot CLI"))
						?.trim() ?? ""
				);
			};
			await mkdir(join(home, "clean"), { recursive: true });
			expect(await row()).toContain("enforced");
			await rm(join(home, ".agentpulse", "exclude-check.ps1"));
			expect(await row()).toContain("not enforced: the check script is missing");
			expect(await row()).toContain("exclude-check.ps1");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude check — the Claude row reads the settings a session in that directory would", () => {
	const relayHook = {
		type: "http",
		url: "http://localhost:4000/api/v1/hooks",
		headers: { "X-Agent-Type": "claude_code" },
	};
	const directHook = {
		type: "http",
		url: "https://agentpulse.example.test/api/v1/hooks",
		headers: { Authorization: "Bearer ap_literal" },
	};
	const settingsWith = (hook: Record<string, unknown>) =>
		JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [hook] }] } });

	/** Plants settings files (path relative to the home, content) and returns the Claude row for the `project` directory. */
	async function claudeRow(
		files: Record<string, string>,
		env: Record<string, string> = {},
	): Promise<string> {
		const home = await tempHome();
		try {
			for (const [rel, content] of Object.entries(files)) {
				await mkdir(join(home, rel, ".."), { recursive: true });
				await writeFile(join(home, rel), content);
			}
			const project = join(home, "project");
			await mkdir(project, { recursive: true });
			const res = await runCli(home, ["exclude", "check", project], {
				env: Object.fromEntries(
					Object.entries(env).map(([k, v]) => [k, v.replace("<home>", home)]),
				),
			});
			return (
				res.stdout
					.split("\n")
					.find((l) => l.includes("Claude Code"))
					?.trim() ?? ""
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	for (const file of ["settings.json", "settings.local.json"]) {
		test(`a direct hook in the project's .claude/${file} beside a relay hook at the user level: the row is direct`, async () => {
			const row = await claudeRow({
				".claude/settings.json": settingsWith(relayHook),
				[`project/.claude/${file}`]: settingsWith(directHook),
			});
			expect(row).toContain("direct");
			expect(row).toContain("path rules not applied");
		});

		test(`a relay hook only in the project's .claude/${file}: the row is relay`, async () => {
			const row = await claudeRow({ [`project/.claude/${file}`]: settingsWith(relayHook) });
			expect(row).toContain("relay");
		});

		test(`a project's .claude/${file} that cannot be read: the row says the hooks are not known, even beside a direct hook`, async () => {
			const row = await claudeRow({
				".claude/settings.json": settingsWith(directHook),
				[`project/.claude/${file}`]: "{ not json",
			});
			expect(row.toLowerCase()).toContain("could not be read");
			expect(row).not.toContain("path rules not applied");
		});
	}

	test("a relay hook listed before a direct one in the same file: any direct hook makes the row direct", async () => {
		const row = await claudeRow({
			".claude/settings.json": JSON.stringify({
				hooks: {
					SessionStart: [{ matcher: "", hooks: [relayHook] }],
					Stop: [{ matcher: "", hooks: [directHook] }],
				},
			}),
		});
		expect(row).toContain("direct");
		expect(row).toContain("path rules not applied");
	});

	test("settings of another directory are not this one's", async () => {
		const row = await claudeRow({
			".claude/settings.json": settingsWith(relayHook),
			"elsewhere/.claude/settings.json": settingsWith(directHook),
		});
		expect(row).toContain("relay");
		expect(row).not.toContain("direct");
	});

	test("CLAUDE_CONFIG_DIR names the user-level settings directory instead of ~/.claude", async () => {
		const row = await claudeRow(
			{
				".claude/settings.json": settingsWith(directHook),
				"cfg/settings.json": settingsWith(relayHook),
			},
			{ CLAUDE_CONFIG_DIR: "<home>/cfg" },
		);
		expect(row).toContain("relay");
		expect(row).not.toContain("direct");
	});

	test("an unreadable user-level file beside a direct project hook, in either place: not known", async () => {
		const row = await claudeRow({
			".claude/settings.json": "{ not json",
			"project/.claude/settings.json": settingsWith(directHook),
		});
		expect(row.toLowerCase()).toContain("could not be read");
	});
});

describe("agentpulse exclude check — sender probes", () => {
	function claudeSettings(hook: Record<string, unknown>) {
		return JSON.stringify({
			hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "http", ...hook }] }] },
		});
	}

	async function senderRow(settings: string, sender: string): Promise<string> {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await writeFile(join(home, ".claude", "settings.json"), settings);
			const dir = join(home, "clean");
			await mkdir(dir, { recursive: true });
			const res = await runCli(home, ["exclude", "check", dir]);
			return (
				res.stdout
					.split("\n")
					.find((l) => l.includes(sender))
					?.trim() ?? ""
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	test("a relay-form hook (loopback URL, no Authorization) that also lists allowedEnvVars is the relay row, not direct", async () => {
		const row = await senderRow(
			claudeSettings({
				url: "http://localhost:4000/api/v1/hooks",
				async: true,
				allowedEnvVars: ["AGENTPULSE_SKIP"],
				headers: { "X-Agent-Type": "claude_code", "X-AgentPulse-Skip": "$AGENTPULSE_SKIP" },
			}),
			"Claude Code",
		);
		expect(row).toContain("relay");
		expect(row).not.toContain("path rules not applied");
		expect(row).not.toContain("STILL REPORTING");
	});

	test("a direct hook with a literal key and no allowedEnvVars is the direct row", async () => {
		const row = await senderRow(
			claudeSettings({
				url: "https://agentpulse.example.test/api/v1/hooks",
				async: true,
				headers: { Authorization: "Bearer ap_literal", "X-Agent-Type": "claude_code" },
			}),
			"Claude Code",
		);
		expect(row).toContain("direct");
		expect(row).toContain("path rules not applied");
	});

	test("a direct hook against a local server (loopback URL, but carrying a key) is still direct", async () => {
		const row = await senderRow(
			claudeSettings({
				url: "http://localhost:3000/api/v1/hooks",
				async: true,
				headers: { Authorization: "Bearer ap_literal", "X-Agent-Type": "claude_code" },
			}),
			"Claude Code",
		);
		expect(row).toContain("direct");
	});

	test("a direct env-form hook with allowedEnvVars on a remote URL is direct", async () => {
		const row = await senderRow(
			claudeSettings({
				url: "https://agentpulse.example.test/api/v1/hooks",
				async: true,
				allowedEnvVars: ["AGENTPULSE_API_KEY", "AGENTPULSE_SKIP"],
				headers: { Authorization: "Bearer $AGENTPULSE_API_KEY" },
			}),
			"Claude Code",
		);
		expect(row).toContain("direct");
	});

	test("only hooks aimed at the AgentPulse hooks path decide the Claude mode: an unrelated HTTP hook listed first is ignored", async () => {
		const settings = JSON.stringify({
			hooks: {
				SessionStart: [
					{
						matcher: "",
						hooks: [
							{
								type: "http",
								url: "https://metrics.example.test/collect",
								headers: { Authorization: "Bearer someone-elses" },
							},
							{
								type: "http",
								url: "http://localhost:4000/api/v1/hooks",
								headers: { "X-Agent-Type": "claude_code" },
							},
						],
					},
				],
			},
		});
		const row = await senderRow(settings, "Claude Code");
		expect(row).toContain("relay");
		expect(row).not.toContain("direct");
	});

	test("a loopback HTTP hook that is not the AgentPulse path is not a Claude row at all", async () => {
		const row = await senderRow(
			claudeSettings({ url: "http://localhost:9999/metrics", async: true }),
			"Claude Code",
		);
		expect(row).toBe("");
	});

	test("a settings.json that can't be parsed prints a warning row instead of dropping the Claude row", async () => {
		const row = await senderRow("{ this is not json", "Claude Code");
		expect(row).toContain("Claude Code");
		expect(row.toLowerCase()).toContain("could not be read");
	});

	test("a settings.json that can't be parsed is also a warning line below the table", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await writeFile(join(home, ".claude", "settings.json"), "{ nope");
			const res = await runCli(home, ["exclude", "check", home]);
			expect(res.stdout).toContain("warning: Claude Code:");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	async function hookFileRow(fileName: string[], content: string, sender: string): Promise<string> {
		const home = await tempHome();
		try {
			const file = join(home, ...fileName);
			await mkdir(join(file, ".."), { recursive: true });
			await writeFile(file, content);
			const dir = join(home, "clean");
			await mkdir(dir, { recursive: true });
			const res = await runCli(home, ["exclude", "check", dir]);
			return (
				res.stdout
					.split("\n")
					.find((l) => l.includes(sender))
					?.trim() ?? ""
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	const GATE_TEXT = '{"c":"/bin/sh \\"$d/exclude-check.sh\\""}';

	/** Runs `exclude check` in a home that may hold the hook file, a rules file and an installed script. */
	async function senderRows(opts: {
		codex?: string;
		copilot?: string;
		rules?: boolean;
		script?: "current" | "stale" | "untrusted" | "none";
	}): Promise<{ codex: string; copilot: string; out: string }> {
		const home = await tempHome();
		try {
			if (opts.codex !== undefined) {
				await mkdir(join(home, ".codex"), { recursive: true });
				await writeFile(join(home, ".codex", "hooks.json"), opts.codex);
			}
			if (opts.copilot !== undefined) {
				await mkdir(join(home, ".copilot", "hooks"), { recursive: true });
				await writeFile(join(home, ".copilot", "hooks", "agentpulse.json"), opts.copilot);
			}
			const agentpulse = join(home, ".agentpulse");
			await mkdir(agentpulse, { recursive: true });
			chmodSync(agentpulse, 0o700);
			if (opts.rules) await writeFile(join(agentpulse, "exclude"), `${join(home, "elsewhere")}\n`);
			const script = join(agentpulse, "exclude-check.sh");
			const { buildBashExcludeScript } = await import("../src/shared/hook-command.js");
			if (opts.script === "current")
				await writeFile(script, buildBashExcludeScript(), { mode: 0o500 });
			if (opts.script === "stale")
				await writeFile(script, "#!/bin/sh\n# agentpulse-exclude-check 00000000000000\nexit 42\n", {
					mode: 0o500,
				});
			if (opts.script === "untrusted") {
				await writeFile(script, buildBashExcludeScript());
				chmodSync(script, 0o770);
			}
			const dir = join(home, "clean");
			await mkdir(dir, { recursive: true });
			const res = await runCli(home, ["exclude", "check", dir]);
			const row = (sender: string) =>
				res.stdout
					.split("\n")
					.find((l) => l.includes(sender))
					?.trim() ?? "";
			return { codex: row("Codex CLI"), copilot: row("Copilot CLI"), out: res.stdout };
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	test("a Codex hooks file carrying the gate, with the current script installed, is enforced and says to approve it", async () => {
		const { codex, copilot } = await senderRows({
			codex: GATE_TEXT,
			copilot: GATE_TEXT,
			script: "current",
		});
		expect(codex).toContain("enforced");
		expect(codex).not.toContain("not enforced");
		expect(codex).toContain("Codex only runs hooks you have approved: run /hooks in Codex");
		expect(copilot).toContain("enforced");
		expect(copilot).not.toContain("not enforced");
		expect(copilot).not.toContain("/hooks");
	});

	for (const state of ["none", "stale", "untrusted"] as const) {
		// "untrusted" is a POSIX owner/mode judgement; Windows has its own ACL test
		test.skipIf(state === "untrusted" && process.platform === "win32")(
			`the check script ${state === "none" ? "missing" : state}: both rows say not enforced and name the fix`,
			async () => {
				const { codex, copilot } = await senderRows({
					codex: GATE_TEXT,
					copilot: GATE_TEXT,
					script: state,
				});
				for (const row of [codex, copilot]) {
					expect(row).toContain("not enforced");
					expect(row).toContain(
						state === "none" ? "missing" : state === "stale" ? "out of date" : "can't be trusted",
					);
					expect(row).toContain("agentpulse setup");
					expect(row).toContain("agentpulse exclude add");
				}
			},
		);
	}

	test("a hand-written rules file and no script: the check says the hooks send nothing", async () => {
		const { out } = await senderRows({ codex: GATE_TEXT, rules: true, script: "none" });
		expect(out).toContain("send NOTHING");
		expect(out).toContain("fail closed");
	});

	test("no rules file and no script: no fail-closed warning", async () => {
		const { out } = await senderRows({ codex: GATE_TEXT, script: "none" });
		expect(out).not.toContain("send NOTHING");
	});

	test("a symlinked installed script is untrusted: the rows say not enforced and name the link, though its target is a perfect copy", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".codex"), { recursive: true });
			await writeFile(join(home, ".codex", "hooks.json"), GATE_TEXT);
			await mkdir(join(home, ".copilot", "hooks"), { recursive: true });
			await writeFile(join(home, ".copilot", "hooks", "agentpulse.json"), GATE_TEXT);
			const agentpulse = join(home, ".agentpulse");
			await mkdir(agentpulse, { recursive: true });
			chmodSync(agentpulse, 0o700);
			await writeFile(join(agentpulse, "exclude"), `${join(home, "elsewhere")}\n`);
			const { buildBashExcludeScript } = await import("../src/shared/hook-command.js");
			const real = join(home, "real-check.sh");
			await writeFile(real, buildBashExcludeScript(), { mode: 0o500 });
			symlinkSync(real, join(agentpulse, "exclude-check.sh"));
			await mkdir(join(home, "clean"), { recursive: true });
			const res = await runCli(home, ["exclude", "check", join(home, "clean")]);
			const row = (sender: string) =>
				res.stdout
					.split("\n")
					.find((l) => l.includes(sender))
					?.trim() ?? "";
			for (const sender of ["Codex CLI", "Copilot CLI"]) {
				expect(row(sender), sender).toContain("not enforced");
				expect(row(sender), sender).toContain("can't be trusted");
				expect(row(sender), sender).toContain("symlink");
			}
			expect(res.stdout).toContain("hooks send NOTHING");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a hooks file from before exclude rules (no gate) is not enforced", async () => {
		const { codex } = await senderRows({ codex: '{"hooks":{}}', script: "current" });
		expect(codex).toContain("not enforced");
	});

	test("a hooks file with neither snippet is not enforced", async () => {
		const row = await hookFileRow([".codex", "hooks.json"], '{"hooks":{}}', "Codex CLI");
		expect(row).toContain("not enforced");
	});
});

describe("agentpulse exclude add — safe, serialised, validated writes", () => {
	async function rulesAfter(home: string): Promise<string> {
		return readFile(join(home, ".agentpulse", "exclude"), "utf-8");
	}

	test.skipIf(process.platform === "win32")(
		"the rules file is replaced atomically: a new inode, never rewritten in place",
		async () => {
			const home = await tempHome();
			try {
				await mkdir(join(home, ".agentpulse"), { recursive: true });
				const rulesPath = join(home, ".agentpulse", "exclude");
				await writeFile(rulesPath, "/a/work\n", { mode: 0o600 });
				const before = lstatSync(rulesPath).ino;
				const sub = join(home, "sub");
				await mkdir(sub, { recursive: true });
				const res = await runCli(home, ["exclude", "add", sub]);
				expect(res.code).toBe(0);
				expect(lstatSync(rulesPath).ino).not.toBe(before);
				expect(readdirSync(join(home, ".agentpulse")).sort()).toEqual([
					"exclude",
					"exclude-check.sh",
				]);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"a fresh lock file held by someone else makes add wait, then refuse, writing nothing",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(dir, { recursive: true });
				chmodSync(dir, 0o700);
				await writeFile(join(dir, "exclude"), "/a/work\n", { mode: 0o600 });
				await writeFile(join(dir, "exclude.lock"), `${process.pid}\n`);
				const sub = join(home, "sub");
				await mkdir(sub, { recursive: true });
				const res = await runCli(home, ["exclude", "add", sub]);
				expect(res.code).not.toBe(0);
				expect(res.out.toLowerCase()).toContain("another");
				expect(await rulesAfter(home)).toBe("/a/work\n");
				expect(existsSync(join(dir, "exclude.lock")), "someone else's lock is left alone").toBe(
					true,
				);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"a stale lock file is broken and the add goes through, leaving no lock behind",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(dir, { recursive: true });
				chmodSync(dir, 0o700);
				const lock = join(dir, "exclude.lock");
				await writeFile(lock, "999999\n");
				const old = new Date(Date.now() - 10 * 60 * 1000);
				utimesSync(lock, old, old);
				const sub = join(home, "sub");
				await mkdir(sub, { recursive: true });
				const res = await runCli(home, ["exclude", "add", sub]);
				expect(res.code).toBe(0);
				expect(await rulesAfter(home)).toContain(sub);
				expect(existsSync(lock)).toBe(false);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"an old lock that is a directory does not hang the add: the stale lock is moved aside and the add finishes",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(join(dir, "exclude.lock"), { recursive: true });
				chmodSync(dir, 0o700);
				const old = new Date(Date.now() - 10 * 60 * 1000);
				utimesSync(join(dir, "exclude.lock"), old, old);
				await writeFile(join(dir, "exclude"), "/a/work\n", { mode: 0o600 });
				const sub = join(home, "sub");
				await mkdir(sub, { recursive: true });
				const proc = Bun.spawn(["bun", CLI, "exclude", "add", sub], {
					cwd: home,
					stdout: "pipe",
					stderr: "pipe",
					env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
				});
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					proc.kill();
				}, 15_000);
				await proc.exited;
				clearTimeout(timer);
				expect(timedOut, "the command finished instead of spinning").toBe(false);
				expect(await readFile(join(dir, "exclude"), "utf-8")).toContain(sub);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test("several adds started together all land", async () => {
		const home = await tempHome();
		try {
			const subs: string[] = [];
			for (let i = 0; i < 6; i++) {
				const sub = join(home, `proj-${i}`);
				await mkdir(sub, { recursive: true });
				subs.push(sub);
			}
			const results = await Promise.all(subs.map((sub) => runCli(home, ["exclude", "add", sub])));
			for (const r of results) expect(r.code).toBe(0);
			const content = await rulesAfter(home);
			for (const sub of subs) expect(content).toContain(sub);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32")(
		"an unreadable existing rules file aborts with nothing written and its mode untouched",
		async () => {
			if (process.getuid?.() === 0) return;
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(dir, { recursive: true });
				chmodSync(dir, 0o700);
				const rulesPath = join(dir, "exclude");
				await writeFile(rulesPath, "/a/work\n", { mode: 0o600 });
				chmodSync(rulesPath, 0o000);
				const sub = join(home, "sub");
				await mkdir(sub, { recursive: true });
				const res = await runCli(home, ["exclude", "add", sub]);
				chmodSync(rulesPath, 0o600);
				expect(res.code).not.toBe(0);
				expect(res.out.toLowerCase()).toMatch(/unreadable|read/);
				expect(await rulesAfter(home)).toBe("/a/work\n");
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"the write-side directory check refuses a group-writable directory that has no rules file yet",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(dir, { recursive: true });
				chmodSync(dir, 0o770);
				const sub = join(home, "sub");
				await mkdir(sub, { recursive: true });
				const res = await runCli(home, ["exclude", "add", sub]);
				chmodSync(dir, 0o700);
				expect(res.code).not.toBe(0);
				expect(res.out.toLowerCase()).toContain("writable");
				expect(existsSync(join(dir, "exclude"))).toBe(false);
				expect(existsSync(join(dir, "exclude.invalid"))).toBe(false);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"a successful add clears a stale invalid-rules marker",
		async () => {
			const home = await tempHome();
			try {
				const dir = join(home, ".agentpulse");
				await mkdir(dir, { recursive: true });
				chmodSync(dir, 0o700);
				writeFileSyncNode(join(dir, "exclude.invalid"), "");
				const sub = join(home, "sub");
				await mkdir(sub, { recursive: true });
				const res = await runCli(home, ["exclude", "add", sub]);
				expect(res.code).toBe(0);
				expect(existsSync(join(dir, "exclude.invalid"))).toBe(false);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	// A rule is only worth writing if the rules parser reads it back as the
	// same directory. These names can't survive the file format.
	const unwritable: [string, string, RegExp][] = [
		["star", "has*star", /wildcard/i],
		["question mark", "has?mark", /wildcard/i],
		["open bracket", "has[bracket", /wildcard/i],
		["close bracket", "has]bracket", /wildcard/i],
		["trailing space", "ends-with-space ", /trailing (space|tab)|ends with/i],
		["trailing tab", "ends-with-tab\t", /trailing (space|tab)|ends with/i],
		["newline", "line\nbreak", /newline/i],
	];
	for (const [label, name, why] of unwritable) {
		test(`a directory name with a ${label} is refused with the reason, and nothing is written`, async () => {
			const home = await tempHome();
			try {
				const dir = join(home, name);
				await mkdir(dir, { recursive: true });
				const res = await runCli(home, ["exclude", "add", dir]);
				expect(res.code).not.toBe(0);
				expect(res.out).toMatch(why);
				expect(existsSync(join(home, ".agentpulse", "exclude"))).toBe(false);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	}

	test("a directory name with an inner space is fine (control)", async () => {
		const home = await tempHome();
		try {
			const dir = join(home, "my project");
			await mkdir(dir, { recursive: true });
			const res = await runCli(home, ["exclude", "add", dir]);
			expect(res.code).toBe(0);
			expect(await rulesAfter(home)).toContain("my project");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("duplicate detection folds case on macOS and Windows, and keeps two rules on Linux", async () => {
		const home = await tempHome();
		try {
			await runCli(home, ["exclude", "add", join(home, "Nowhere-Yet")]);
			const res = await runCli(home, ["exclude", "add", join(home, "nowhere-yet")]);
			expect(res.code).toBe(0);
			const lines = (await rulesAfter(home)).split("\n").filter((l) => l.trim().length > 0);
			expect(lines.length).toBe(process.platform === "linux" ? 2 : 1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse exclude check: rules under the account's home that this process never reads", () => {
	async function worlds() {
		const home = await tempHome();
		const account = await tempHome();
		await mkdir(join(account, ".agentpulse"), { recursive: true });
		await writeFile(join(account, ".agentpulse", "exclude"), "/somewhere/private\n");
		return { home, account };
	}

	test("a warning names both homes and the file, in the text output; the answer and the exit status are what they were", async () => {
		const { home, account } = await worlds();
		try {
			const plain = await runCli(home, ["exclude", "check", home]);
			const mismatched = await runCli(home, ["exclude", "check", home], {
				env: { AGENTPULSE_TEST_ACCOUNT_HOME: account },
			});
			expect(mismatched.code).toBe(plain.code);
			expect(mismatched.out).toContain("NOT EXCLUDED");
			expect(mismatched.out).toContain("not being applied");
			expect(mismatched.out).toContain(account);
			expect(mismatched.out).toContain(home);
			expect(plain.out).not.toContain("not being applied");
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(account, { recursive: true, force: true });
		}
	});

	test("with --json the output is still one JSON document, and it carries the warning in a field of its own", async () => {
		const { home, account } = await worlds();
		try {
			const { stdout } = await runCli(home, ["exclude", "check", home, "--json"], {
				env: { AGENTPULSE_TEST_ACCOUNT_HOME: account },
			});
			const json = JSON.parse(stdout) as { homeWarning?: string | null; excluded: boolean };
			expect(json.excluded).toBe(false);
			expect(json.homeWarning).toContain("not being applied");
			const plain = JSON.parse(
				(await runCli(home, ["exclude", "check", home, "--json"])).stdout,
			) as { homeWarning?: string | null };
			expect(plain.homeWarning ?? null).toBeNull();
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(account, { recursive: true, force: true });
		}
	});
});
