import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateFileNoFollowForTests } from "../shared/private-read.js";
import { readConsent, readConsentWith } from "../shared/update-files.js";
import {
	type ConsentIo,
	disableAuto,
	enableAuto,
	setConsentIoForTests,
	timerPath,
	windowIsValid,
} from "./consent.js";
import { type Fixture, createFixture } from "./test-utils/fixture.js";

let fx: Fixture | null = null;
afterEach(async () => {
	setConsentIoForTests(null);
	await fx?.cleanup();
	fx = null;
});

const OFF = { on: false, allowMigrations: false, window: null };

describe("reading the consent", () => {
	let home: string;
	let dir: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "ap-consent-"));
		dir = join(home, ".agentpulse");
		mkdirSync(dir, { mode: 0o700 });
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));
	const put = (text: string, mode = 0o600) => {
		writeFileSync(join(dir, "update-consent.json"), text, { mode });
		chmodSync(join(dir, "update-consent.json"), mode);
	};
	const ON = JSON.stringify({ schema: 1, app: { on: true, allowMigrations: false, window: null } });

	test("missing, unparseable, readable by others, a symlink and somebody else's all read off", () => {
		expect(readConsent(home)).toEqual(OFF);
		put("{not json");
		expect(readConsent(home)).toEqual(OFF);
		put(ON, 0o644);
		expect(readConsent(home)).toEqual(OFF);
		rmSync(join(dir, "update-consent.json"));
		put(ON, 0o600);
		writeFileSync(join(dir, "real.json"), ON, { mode: 0o600 });
		rmSync(join(dir, "update-consent.json"));
		symlinkSync(join(dir, "real.json"), join(dir, "update-consent.json"));
		expect(readConsent(home)).toEqual(OFF);
		rmSync(join(dir, "update-consent.json"));
		put(ON, 0o600);
		// control: the same file is believed for its own owner, and not for any other uid
		const mine = process.getuid?.();
		const as = (uid: number | undefined) => (path: string, max: number) =>
			readPrivateFileNoFollowForTests(path, max, uid);
		expect(readConsentWith(home, as(mine)).on).toBe(true);
		expect(readConsentWith(home, as((mine ?? 0) + 1))).toEqual(OFF);
	});
});

/**
 * A terminal that answers the prompt: `"correct"` types the phrase the prompt asks for (it has a random part, so
 * it is read off the prompt), anything else is typed as given.
 */
function ttyIo(answer: string, tty = true): ConsentIo & { asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		isTty: () => tty,
		prompt: async (question) => {
			asked.push(question);
			return answer === "correct" ? (/"([^"]+)"/.exec(question)?.[1] ?? "") : answer;
		},
	};
}

const consentPath = (f: Fixture) => join(f.dir, "update-consent.json");
const readJson = (f: Fixture) => JSON.parse(readFileSync(consentPath(f), "utf-8"));
const say = () => {};

describe("auto on", () => {
	test("with a terminal and the typed word it writes a private consent file and installs the timer", async () => {
		fx = await createFixture();
		const f = fx;
		const io = ttyIo("correct");
		setConsentIoForTests(io);
		const result = await enableAuto(
			f.deps(),
			{ allowMigrations: false, window: "02:00-04:30" },
			say,
		);
		expect(result).toEqual({ ok: true });
		expect(readJson(f)).toEqual({
			schema: 1,
			app: { on: true, allowMigrations: false, window: "02:00-04:30" },
		});
		expect(statSync(consentPath(f)).mode & 0o777).toBe(0o600);
		expect(readConsent(f.home)).toEqual({
			on: true,
			allowMigrations: false,
			window: "02:00-04:30",
		});
		const timer = f.fake.timerInstalled;
		expect(timer?.home).toBe(f.home);
		expect(timer?.bundlePath).toBe(join(f.dir, "updater", "current", "updater.js"));
		expect(timer?.bunBin).toBe(process.execPath);
		expect(io.asked).toHaveLength(1);
	}, 60_000);

	test("no terminal, a wrong word, or an empty answer: refused, no file, no timer", async () => {
		fx = await createFixture();
		const f = fx;
		setConsentIoForTests(ttyIo("enable", false));
		expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
			ok: false,
			code: "not_a_terminal",
		});
		for (const word of ["yes", "ENABLE", "", "enable", "enable 000000", "allow migrations"]) {
			setConsentIoForTests(ttyIo(word));
			expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
				ok: false,
				code: "not_confirmed",
			});
		}
		expect(existsSync(consentPath(f))).toBe(false);
		expect(f.fake.timerInstalled).toBeNull();
		expect(f.fake.calls).not.toContain("installTimer");
	}, 60_000);

	test("an agent-session marker, from any of the agents, is refused before anything is asked, naming the variable", async () => {
		fx = await createFixture();
		const f = fx;
		for (const marker of [
			"CLAUDECODE",
			"AI_AGENT",
			"CLAUDE_CODE_SESSION_ID",
			"CLAUDE_CODE_ENTRYPOINT",
			"CODEX_THREAD_ID",
			"CODEX_SANDBOX",
			"CODEX_SANDBOX_NETWORK_DISABLED",
			"OPENCODE",
			"OPENCODE_SERVER_PASSWORD",
			"COPILOT_AGENT_SESSION",
			"GITHUB_COPILOT_CLI",
			"AGENTPULSE_KEY",
			"AGENTPULSE_SKIP",
		]) {
			const io = ttyIo("correct");
			setConsentIoForTests(io);
			const deps = f.deps({ env: { PATH: process.env.PATH, HOME: f.home, [marker]: "1" } });
			expect(await enableAuto(deps, { allowMigrations: false, window: null }, say)).toEqual({
				ok: false,
				code: "agent_session",
				detail: marker,
			});
			expect(io.asked).toEqual([]);
		}
		expect(existsSync(consentPath(f))).toBe(false);
		expect(f.fake.calls).not.toContain("installTimer");
		// controls: the variables a person legitimately has pass, and so does the one the shim sets
		for (const ok of [
			"CODEX_HOME",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"ANTHROPIC_API_KEY",
			"AGENTPULSE_UPDATER_REAL_SERVICES",
		]) {
			setConsentIoForTests(ttyIo("correct"));
			const deps = f.deps({ env: { PATH: process.env.PATH, HOME: f.home, [ok]: "1" } });
			expect({
				ok,
				got: await enableAuto(deps, { allowMigrations: false, window: null }, say),
			}).toEqual({ ok, got: { ok: true } });
			rmSync(consentPath(f), { force: true });
		}
	}, 60_000);

	test("the phrase has a random part that changes from one run to the next", async () => {
		fx = await createFixture();
		const f = fx;
		const seen = new Set<string>();
		for (let i = 0; i < 6; i++) {
			const io = ttyIo("wrong");
			setConsentIoForTests(io);
			await enableAuto(f.deps(), { allowMigrations: false, window: null }, say);
			seen.add(/"([^"]+)"/.exec(io.asked[0] ?? "")?.[1] ?? "");
		}
		expect(seen.size).toBeGreaterThan(1);
		for (const phrase of seen) expect(phrase).toMatch(/^enable [0-9a-f]{6}$/);
	}, 60_000);

	test("--allow-migrations needs its own typed words, not just 'enable'", async () => {
		fx = await createFixture();
		const f = fx;
		// the plain phrase isn't the migrations phrase
		setConsentIoForTests(ttyIo("enable"));
		expect(await enableAuto(f.deps(), { allowMigrations: true, window: null }, say)).toEqual({
			ok: false,
			code: "not_confirmed",
		});
		expect(existsSync(consentPath(f))).toBe(false);
		const io = ttyIo("correct");
		setConsentIoForTests(io);
		expect(await enableAuto(f.deps(), { allowMigrations: true, window: null }, say)).toEqual({
			ok: true,
		});
		expect(io.asked[0]).toContain("allow migrations");
		setConsentIoForTests(ttyIo("correct"));
		expect(await enableAuto(f.deps(), { allowMigrations: true, window: null }, say)).toEqual({
			ok: true,
		});
		expect(readJson(f).app.allowMigrations).toBe(true);
	}, 60_000);

	test("a malformed or empty window is refused before anything is asked", async () => {
		fx = await createFixture();
		const f = fx;
		for (const window of ["25:00-26:00", "2:00-4:00", "02:00-02:00", "02:00", "02:00-04:30;x"]) {
			const io = ttyIo("correct");
			setConsentIoForTests(io);
			expect(await enableAuto(f.deps(), { allowMigrations: false, window }, say)).toEqual({
				ok: false,
				code: "bad_window",
			});
			expect(io.asked).toEqual([]);
		}
		expect(windowIsValid("22:00-04:00")).toBe(true);
	}, 60_000);

	test("an install that would refuse to update is refused: a branch, no service manager, a container, Windows, a fork", async () => {
		fx = await createFixture();
		const f = fx;
		setConsentIoForTests(ttyIo("correct"));
		const request = { allowMigrations: false, window: null };
		f.writeInstallRecord({ track: "ref" });
		expect(await enableAuto(f.deps(), request, say)).toEqual({ ok: false, code: "tracking_ref" });
		f.writeInstallRecord({ service: "none" });
		expect(await enableAuto(f.deps(), request, say)).toEqual({
			ok: false,
			code: "no_service_manager",
		});
		f.writeInstallRecord({ repoUrl: "https://example.invalid/fork.git" });
		expect(await enableAuto(f.deps(), request, say)).toEqual({ ok: false, code: "fork_install" });
		f.writeInstallRecord({});
		expect(await enableAuto(f.deps({ platform: "win32" }), request, say)).toEqual({
			ok: false,
			code: "no_service_manager",
		});
		expect(await enableAuto(f.deps({ detectKind: () => "container" }), request, say)).toEqual({
			ok: false,
			code: "container",
		});
		expect(await enableAuto(f.deps({ detectKind: () => "kubernetes" }), request, say)).toEqual({
			ok: false,
			code: "kubernetes",
		});
		f.fake.preflightResult = "no_service_manager";
		expect(await enableAuto(f.deps(), request, say)).toEqual({
			ok: false,
			code: "no_service_manager",
		});
		expect(existsSync(consentPath(f))).toBe(false);
		expect(f.fake.timerInstalled).toBeNull();
		// control: the untouched install is accepted
		f.fake.preflightResult = "ok";
		expect(await enableAuto(f.deps(), request, say)).toEqual({ ok: true });
	}, 60_000);

	test("the relay's clients section is kept across on and off", async () => {
		fx = await createFixture();
		const f = fx;
		const clients = { on: true, components: ["relay", "statusline"] };
		writeFileSync(consentPath(f), `${JSON.stringify({ schema: 1, clients })}\n`, { mode: 0o600 });
		setConsentIoForTests(ttyIo("correct"));
		expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
			ok: true,
		});
		expect(readJson(f)).toEqual({
			schema: 1,
			app: { on: true, allowMigrations: false, window: null },
			clients,
		});
		expect(await disableAuto(f.deps())).toEqual({ ok: true });
		expect(readJson(f)).toEqual({ schema: 1, app: OFF, clients });
	}, 60_000);

	test("a consent file that isn't a plain file of this account is never replaced: the relay's clients section can't be lost (B11)", async () => {
		fx = await createFixture();
		const f = fx;
		const clients = { on: true, components: ["relay", "statusline"] };
		const doc = `${JSON.stringify({ schema: 1, clients })}\n`;
		const plants: [string, () => void][] = [
			[
				"a symlink",
				() => {
					const real = join(f.dir, "real-consent.json");
					writeFileSync(real, doc, { mode: 0o600 });
					symlinkSync(real, consentPath(f));
				},
			],
			[
				"a second hard link",
				() => {
					writeFileSync(consentPath(f), doc, { mode: 0o600 });
					linkSync(consentPath(f), join(f.dir, "other-name.json"));
				},
			],
			[
				"an owned file that isn't a schema-1 document",
				() => writeFileSync(consentPath(f), "{not json", { mode: 0o600 }),
			],
		];
		for (const [label, plant] of plants) {
			rmSync(consentPath(f), { force: true });
			plant();
			const before = lstatSync(consentPath(f));
			setConsentIoForTests(ttyIo("correct"));
			expect(
				await enableAuto(f.deps(), { allowMigrations: false, window: null }, say),
				label,
			).toEqual({
				ok: false,
				code: "consent_unwritable",
			});
			expect(await disableAuto(f.deps()), label).toEqual({ ok: false, code: "consent_unwritable" });
			const after = lstatSync(consentPath(f));
			expect(after.ino, label).toBe(before.ino);
			expect(after.isSymbolicLink(), label).toBe(before.isSymbolicLink());
			if (label === "a symlink") {
				expect(readFileSync(join(f.dir, "real-consent.json"), "utf-8")).toBe(doc);
			} else if (label === "a second hard link") {
				expect(readFileSync(consentPath(f), "utf-8")).toBe(doc);
			}
			expect(f.fake.timerInstalled, label).toBeNull();
		}
		// control: with no file at all the same call writes a fresh one
		rmSync(consentPath(f), { force: true });
		rmSync(join(f.dir, "other-name.json"), { force: true });
		setConsentIoForTests(ttyIo("correct"));
		expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
			ok: true,
		});
	}, 60_000);

	test("when the timer can't be installed the consent file is byte for byte what it was", async () => {
		fx = await createFixture();
		const f = fx;
		f.fake.installTimer = async () => {
			throw new Error("boom");
		};
		// on, with a window and a migrations flag, plus the relay's section, in a spelling this writer wouldn't produce
		const original = `{\n  "schema": 1,\n  "app": {"on": true, "allowMigrations": true, "window": "01:00-02:00"},\n  "clients": {"on": true, "components": ["relay"]}\n}\n`;
		writeFileSync(consentPath(f), original, { mode: 0o600 });
		setConsentIoForTests(ttyIo("correct"));
		expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
			ok: false,
			code: "timer_failed",
		});
		expect(readFileSync(consentPath(f), "utf-8")).toBe(original);
		expect(statSync(consentPath(f)).mode & 0o777).toBe(0o600);
		// and with no file before, none after
		rmSync(consentPath(f));
		setConsentIoForTests(ttyIo("correct"));
		await enableAuto(f.deps(), { allowMigrations: false, window: null }, say);
		expect(existsSync(consentPath(f))).toBe(false);
	}, 60_000);

	test("consent the updater wouldn't believe is consent_unwritable, with no timer left behind", async () => {
		fx = await createFixture();
		const f = fx;
		setConsentIoForTests(ttyIo("correct"));
		// a directory others can write into appears after the install record was read: what is written there reads as off
		f.fake.preflight = async () => {
			chmodSync(f.dir, 0o777);
			return "ok";
		};
		try {
			expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
				ok: false,
				code: "consent_unwritable",
			});
		} finally {
			chmodSync(f.dir, 0o700);
		}
		expect(f.fake.timerInstalled).toBeNull();
		expect(f.fake.calls).not.toContain("installTimer");
		expect(f.fake.calls).toContain("removeTimer");
		f.fake.preflight = async () => "ok";
		// control: the same machine with a private directory is accepted
		setConsentIoForTests(ttyIo("correct"));
		expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
			ok: true,
		});
	}, 60_000);
});

describe("auto off", () => {
	test("removes the timer and clears the consent, with no terminal and no word", async () => {
		fx = await createFixture();
		const f = fx;
		setConsentIoForTests(ttyIo("correct"));
		await enableAuto(f.deps(), { allowMigrations: true, window: "01:00-02:00" }, say);
		expect(f.fake.timerInstalled).not.toBeNull();
		setConsentIoForTests(ttyIo("", false));
		expect(await disableAuto(f.deps())).toEqual({ ok: true });
		expect(f.fake.timerInstalled).toBeNull();
		expect(f.fake.calls).toContain("removeTimer");
		expect(readConsent(f.home)).toEqual(OFF);
	}, 60_000);
});

describe("auto off, when the timer can't be removed", () => {
	test("the consent is already cleared, and the failure is said", async () => {
		fx = await createFixture();
		const f = fx;
		setConsentIoForTests(ttyIo("correct"));
		await enableAuto(f.deps(), { allowMigrations: false, window: null }, say);
		expect(readConsent(f.home).on).toBe(true);
		f.fake.removeTimer = async () => {
			throw new Error("boom");
		};
		expect(await disableAuto(f.deps())).toEqual({ ok: false, code: "timer_failed" });
		expect(readConsent(f.home)).toEqual(OFF);
	}, 60_000);
});

describe("the timer's PATH", () => {
	test("is the Bun's and git's directories then fixed system ones, never the caller's whole PATH", () => {
		const path = timerPath("/home/u/.bun/bin/bun", "/opt/x/bin");
		expect(path.split(":")).toEqual([
			"/home/u/.bun/bin",
			"/opt/x/bin",
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		]);
		// a directory with a separator or a newline in it is dropped, a relative one too
		expect(timerPath("/b/bun", "rel/bin")).not.toContain("rel");
		expect(timerPath("/b/bun", "/x\ny")).not.toContain("x");
	});

	test("the job's PATH holds git's directory from the caller's PATH and none of its other entries", async () => {
		fx = await createFixture();
		const f = fx;
		setConsentIoForTests(ttyIo("correct"));
		const gitDir = Bun.which("git")?.replace(/\/git$/, "") ?? "";
		const deps = f.deps({
			env: { PATH: `/tmp/attacker-writable:${gitDir}`, HOME: f.home },
		});
		expect(await enableAuto(deps, { allowMigrations: false, window: null }, say)).toEqual({
			ok: true,
		});
		const path = f.fake.timerInstalled?.path ?? "";
		expect(path).not.toContain("attacker-writable");
		expect(path.split(":")).toContain(gitDir);
	}, 60_000);
});

describe("who may call the timer", () => {
	test("only consent.ts and the service manager itself name installTimer / removeTimer in production code", async () => {
		const { readdirSync, readFileSync: read } = await import("node:fs");
		const dir = join(import.meta.dir);
		const offenders = readdirSync(dir)
			.filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
			.filter((n) => /\.(installTimer|removeTimer)\(/.test(read(join(dir, n), "utf-8")))
			.sort();
		// updater.ts (the scheduled job's code) is not among them: it must never replace its own unit
		expect(offenders).toEqual(["consent.ts"]);
	});
});
