import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
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

function ttyIo(answer: string, tty = true): ConsentIo & { asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		isTty: () => tty,
		prompt: async (question) => {
			asked.push(question);
			return answer;
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
		const io = ttyIo("enable");
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
		for (const word of ["yes", "ENABLE", "", "enable now"]) {
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

	test("an agent-session marker is refused before anything is asked", async () => {
		fx = await createFixture();
		const f = fx;
		for (const marker of [
			"CLAUDECODE",
			"AI_AGENT",
			"CLAUDE_CODE_SESSION_ID",
			"CLAUDE_CODE_ENTRYPOINT",
		]) {
			const io = ttyIo("enable");
			setConsentIoForTests(io);
			const deps = f.deps({ env: { PATH: process.env.PATH, HOME: f.home, [marker]: "1" } });
			expect(await enableAuto(deps, { allowMigrations: false, window: null }, say)).toEqual({
				ok: false,
				code: "agent_session",
			});
			expect(io.asked).toEqual([]);
		}
		expect(existsSync(consentPath(f))).toBe(false);
		expect(f.fake.calls).not.toContain("installTimer");
		// control: the same run without a marker passes, so the refusals above were the marker's
		setConsentIoForTests(ttyIo("enable"));
		expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
			ok: true,
		});
	}, 60_000);

	test("--allow-migrations needs its own typed words, not just 'enable'", async () => {
		fx = await createFixture();
		const f = fx;
		setConsentIoForTests(ttyIo("enable"));
		expect(await enableAuto(f.deps(), { allowMigrations: true, window: null }, say)).toEqual({
			ok: false,
			code: "not_confirmed",
		});
		expect(existsSync(consentPath(f))).toBe(false);
		setConsentIoForTests(ttyIo("allow migrations"));
		expect(await enableAuto(f.deps(), { allowMigrations: true, window: null }, say)).toEqual({
			ok: true,
		});
		expect(readJson(f).app.allowMigrations).toBe(true);
	}, 60_000);

	test("a malformed or empty window is refused before anything is asked", async () => {
		fx = await createFixture();
		const f = fx;
		for (const window of ["25:00-26:00", "2:00-4:00", "02:00-02:00", "02:00", "02:00-04:30;x"]) {
			const io = ttyIo("enable");
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
		setConsentIoForTests(ttyIo("enable"));
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
		setConsentIoForTests(ttyIo("enable"));
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

	test("when the timer can't be installed the consent goes back to what it was", async () => {
		fx = await createFixture();
		const f = fx;
		f.fake.installTimer = async () => {
			throw new Error("boom");
		};
		setConsentIoForTests(ttyIo("enable"));
		expect(await enableAuto(f.deps(), { allowMigrations: false, window: null }, say)).toEqual({
			ok: false,
			code: "timer_failed",
		});
		expect(readConsent(f.home)).toEqual(OFF);
	}, 60_000);
});

describe("auto off", () => {
	test("removes the timer and clears the consent, with no terminal and no word", async () => {
		fx = await createFixture();
		const f = fx;
		setConsentIoForTests(ttyIo("allow migrations"));
		await enableAuto(f.deps(), { allowMigrations: true, window: "01:00-02:00" }, say);
		expect(f.fake.timerInstalled).not.toBeNull();
		setConsentIoForTests(ttyIo("", false));
		expect(await disableAuto(f.deps())).toEqual({ ok: true });
		expect(f.fake.timerInstalled).toBeNull();
		expect(f.fake.calls).toContain("removeTimer");
		expect(readConsent(f.home)).toEqual(OFF);
	}, 60_000);
});

describe("the timer's PATH", () => {
	test("starts with the Bun that runs the updater, keeps only absolute entries and adds the system's", () => {
		const path = timerPath({ PATH: "/opt/x/bin:relative/bin::/usr/bin" }, "/home/u/.bun/bin/bun");
		expect(path.split(":")).toEqual([
			"/home/u/.bun/bin",
			"/opt/x/bin",
			"/usr/bin",
			"/usr/local/bin",
			"/bin",
		]);
	});
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
