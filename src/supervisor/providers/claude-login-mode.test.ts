/**
 * AGEN-117 P3 item 3 (T4): the permission mode is picked from the login, with no user line ever sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeForkMode } from "../../shared/session-resume.js";
import { HELPER_ACCOUNT, NO_LOGIN_ACCOUNT } from "../test-utils/claude-stream-harness.js";
import { type FakeClaude, makeFakeClaude } from "./__fixtures__/claude-fake.js";
import { claudeManifest, outLines, readClaudeFixture } from "./__fixtures__/claude-frames.js";
import {
	KNOWN_RESTRICTED_LOGINS,
	type LoginProbe,
	type ProbeResult,
	accountAgreesWithMode,
	createLoginProbe,
	describeLoginForLog,
	isNoLoginShape,
	matchesKnownRestrictedLogin,
	matchesLogin,
	pickForkMode,
	projectAccount,
} from "./claude-login-mode.js";
import type { RpcTimers } from "./codex-rpc.js";

/** The `account` of the initialize answer a recorded run printed. */
function recordedAccount(fixture: string): unknown {
	const answer = outLines(fixture).find(
		(m) =>
			m.type === "control_response" && m.response?.response && "account" in m.response.response,
	);
	return answer?.response.response.account;
}

/** A probe runner answering from fixtures, counting calls and asserting it was only ever asked to initialize. */
function scriptedProbe(answers: Partial<Record<ClaudeForkMode, ProbeResult>>) {
	const calls: ClaudeForkMode[] = [];
	const probe: LoginProbe = async (mode) => {
		calls.push(mode);
		return answers[mode] ?? { ok: false, why: "spawn" };
	};
	return { probe, calls };
}

const account = (fixture: string): ProbeResult => ({ ok: true, account: recordedAccount(fixture) });

describe("account matching", () => {
	test("the key fixture's full account matches the key entry", () => {
		const full =
			recordedAccount("key-fork-restricted-write-deny") ?? recordedAccount("key-restricted-clean");
		expect(full).toBeDefined();
		expect(matchesKnownRestrictedLogin(full)).toBe(true);
	});

	test("the token projection matches with apiKeySource absent and with null", () => {
		const entry = {
			apiProvider: "firstParty",
			tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
			apiKeySource: null,
		};
		expect(
			matchesLogin({ apiProvider: "firstParty", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }, entry),
		).toBe(true);
		expect(
			matchesLogin(
				{ apiProvider: "firstParty", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: null },
				entry,
			),
		).toBe(true);
		expect(
			matchesLogin(
				{ apiProvider: "firstParty", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: "x" },
				entry,
			),
		).toBe(false);
	});

	test("an extra unknown key beside a known projection still matches, and is never read back out", () => {
		const withExtra = {
			...(recordedAccount("key-restricted-clean") as object),
			email: "someone@example.com",
			orgId: "o-1",
		};
		expect(matchesKnownRestrictedLogin(withExtra)).toBe(true);
		expect(projectAccount(withExtra)).toEqual({
			apiProvider: "firstParty",
			tokenSource: "none",
			apiKeySource: "ANTHROPIC_API_KEY",
		});
		expect(describeLoginForLog(withExtra)).not.toContain("example.com");
	});

	test("both a token and a key together match nothing", () => {
		expect(
			matchesKnownRestrictedLogin({
				apiProvider: "firstParty",
				tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
				apiKeySource: "ANTHROPIC_API_KEY",
			}),
		).toBe(false);
	});

	test("a non-object account matches nothing and projects to null", () => {
		for (const value of [undefined, null, "firstParty", 5, [], ["a"]]) {
			expect(projectAccount(value)).toBeNull();
			expect(matchesKnownRestrictedLogin(value)).toBe(false);
			expect(isNoLoginShape(value)).toBe(false);
		}
	});

	test("the no-login shape is firstParty, none, no key source", () => {
		expect(isNoLoginShape(recordedAccount("no-login-ask"))).toBe(true);
		expect(isNoLoginShape(recordedAccount("helper-restricted"))).toBe(true);
		expect(isNoLoginShape(recordedAccount("helper-ask"))).toBe(false);
		expect(isNoLoginShape(recordedAccount("key-restricted-clean"))).toBe(false);
	});

	test("agreement: restricted needs a known login; ask needs anything but the no-login shape", () => {
		const key = recordedAccount("key-restricted-clean");
		const none = recordedAccount("no-login-ask");
		const helper = recordedAccount("helper-ask");
		expect(accountAgreesWithMode(key, "restricted")).toBe(true);
		expect(accountAgreesWithMode(helper, "restricted")).toBe(false);
		expect(accountAgreesWithMode(none, "restricted")).toBe(false);
		expect(accountAgreesWithMode(none, "ask")).toBe(false);
		expect(accountAgreesWithMode(helper, "ask")).toBe(true);
		expect(accountAgreesWithMode(key, "ask")).toBe(true);
		for (const odd of [
			undefined,
			null,
			"x",
			{ tokenSource: "futureThing" },
			{ apiProvider: "bedrock", tokenSource: "none" },
		]) {
			expect(accountAgreesWithMode(odd, "ask")).toBe(true);
			expect(accountAgreesWithMode(odd, "restricted")).toBe(false);
		}
		expect(accountAgreesWithMode(key, "bypass" as ClaudeForkMode)).toBe(false);
	});
});

describe("pickForkMode", () => {
	test("an env key under restricted: restricted, one probe", async () => {
		const { probe, calls } = scriptedProbe({ restricted: account("key-restricted-clean") });
		expect(await pickForkMode(probe)).toEqual({ mode: "restricted", probes: 1 });
		expect(calls).toEqual(["restricted"]);
	});

	test("a helper: the restricted probe sees no login, the ask probe sees the helper: ask, two probes", async () => {
		const { probe, calls } = scriptedProbe({
			restricted: account("helper-restricted"),
			ask: account("helper-ask"),
		});
		expect(await pickForkMode(probe)).toEqual({ mode: "ask", probes: 2 });
		expect(calls).toEqual(["restricted", "ask"]);
	});

	test("no login: claude_not_logged_in after two probes", async () => {
		const none: ProbeResult = account("no-login-ask");
		const { probe } = scriptedProbe({ restricted: none, ask: none });
		expect(await pickForkMode(probe)).toEqual({ refusal: "claude_not_logged_in", probes: 2 });
	});

	test("the ask probe with an unknown tokenSource, bedrock, absent, null or malformed account: ask", async () => {
		const shapes: unknown[] = [
			{ apiProvider: "firstParty", tokenSource: "someFutureSource" }, // named member: unknown tokenSource
			{ apiProvider: "bedrock", tokenSource: "none" },
			undefined,
			null,
			"garbled",
			[],
		];
		for (const shape of shapes) {
			const { probe } = scriptedProbe({
				restricted: account("no-login-ask"),
				ask: { ok: true, account: shape },
			});
			expect(await pickForkMode(probe), JSON.stringify(shape)).toEqual({ mode: "ask", probes: 2 });
		}
	});

	test("the restricted probe with an unknown tokenSource, or a known one under another provider, is not restricted", async () => {
		for (const shape of [
			{ apiProvider: "firstParty", tokenSource: "someFutureSource" },
			{ apiProvider: "bedrock", tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY" },
		]) {
			const { probe, calls } = scriptedProbe({
				restricted: { ok: true, account: shape },
				ask: account("helper-ask"),
			});
			const choice = await pickForkMode(probe);
			expect("mode" in choice && choice.mode).toBe("ask");
			expect(calls).toEqual(["restricted", "ask"]);
		}
	});

	test("a probe that fails (timeout or spawn) refuses rejected, and a second probe is not tried after the first fails", async () => {
		for (const why of ["timeout", "spawn"] as const) {
			const { probe, calls } = scriptedProbe({ restricted: { ok: false, why } });
			expect(await pickForkMode(probe)).toEqual({ refusal: "rejected", probes: 1 });
			expect(calls).toEqual(["restricted"]);
		}
		const { probe } = scriptedProbe({
			restricted: account("helper-restricted"),
			ask: { ok: false, why: "timeout" },
		});
		expect(await pickForkMode(probe)).toEqual({ refusal: "rejected", probes: 2 });
	});
});

describe("KNOWN_RESTRICTED_LOGINS table pin", () => {
	/** Projections of every run whose argv held --restricted and whose reply was a real model's. */
	function fixtureBackedEntries(): string[] {
		const found = new Set<string>();
		for (const [file, meta] of Object.entries(claudeManifest())) {
			if (!file.endsWith(".jsonl") || !meta.restricted) continue;
			const lines = readClaudeFixture(file);
			const account = lines
				.map((l) => l.frame)
				.find(
					(m) =>
						m.type === "control_response" &&
						m.response?.response &&
						"account" in m.response.response,
				)?.response.response.account;
			const realReply = lines.some(
				(l) =>
					l.dir === "out" &&
					l.frame.type === "assistant" &&
					typeof l.frame.message?.model === "string" &&
					l.frame.message.model !== "<synthetic>",
			);
			const projection = projectAccount(account);
			if (realReply && projection) found.add(JSON.stringify(projection));
		}
		return [...found].sort();
	}

	test("equals, by set equality, the entries that have a committed restricted fixture and a real reply", () => {
		const table = KNOWN_RESTRICTED_LOGINS.map((e) => JSON.stringify(projectAccount(e))).sort();
		expect(table).toEqual(fixtureBackedEntries());
	});

	test("the floor is one entry and the named member is the key entry", () => {
		expect(KNOWN_RESTRICTED_LOGINS.length).toBeGreaterThanOrEqual(1);
		expect(
			KNOWN_RESTRICTED_LOGINS.some(
				(e) => e.tokenSource === "none" && e.apiKeySource === "ANTHROPIC_API_KEY",
			),
		).toBe(true);
	});

	test("the helper under restricted has no real reply, so it is not in the table", () => {
		const helper = readClaudeFixture("helper-restricted");
		const reply = helper.find((l) => l.dir === "out" && l.frame.type === "assistant");
		expect(reply?.frame.message.model).toBe("<synthetic>");
		expect(KNOWN_RESTRICTED_LOGINS.some((e) => e.tokenSource === "apiKeyHelper")).toBe(false);
	});
});

describe("createLoginProbe (a fake claude that answers initialize)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function setup(config: Parameters<typeof makeFakeClaude>[1]) {
		const root = mkdtempSync(join(tmpdir(), "claude-login-probe-"));
		dirs.push(root);
		const fake = makeFakeClaude(join(root, "bin"), config);
		const probeCwd = join(root, "probe");
		return { fake, probeCwd, root };
	}
	const probeFor = (fake: FakeClaude, probeCwd: string, extra: Record<string, unknown> = {}) =>
		createLoginProbe({
			executable: fake.path,
			env: { PATH: process.env.PATH, ...fake.env },
			probeCwd,
			log: () => {},
			...extra,
		});

	test("returns the account the child reports, sends zero user lines, and leaves no child behind", async () => {
		const { fake, probeCwd } = setup({ account: recordedAccount("key-restricted-clean") });
		const result = await probeFor(fake, probeCwd)("restricted");
		expect(result).toEqual({ ok: true, account: recordedAccount("key-restricted-clean") });
		expect(fake.userLines()).toBe(0);
		expect(fake.controlSubtypes()).toEqual(["initialize"]);
		const pid = fake.pid();
		expect(pid).not.toBeNull();
		expect(() => process.kill(pid as number, 0)).toThrow(); // dead: signal 0 is a probe, not a signal
	});

	test("runs in the probe directory, never anywhere else, and uses the probe argv for the mode", async () => {
		const { fake, probeCwd } = setup({ account: {} });
		await probeFor(fake, probeCwd)("restricted");
		const argv = fake.starts()[0]?.argv ?? [];
		expect(argv).toContain("--restricted");
		for (const flag of ["--resume", "--fork-session", "--session-id"])
			expect(argv).not.toContain(flag);
		expect(readdirSync(probeCwd)).toEqual([]);
		await probeFor(fake, probeCwd)("ask");
		expect(fake.starts()[1]?.argv).not.toContain("--restricted");
	});

	test("the child's environment is the fork's: session markers stripped, the login variable kept", async () => {
		const { fake, probeCwd } = setup({ account: {} });
		const probe = createLoginProbe({
			executable: fake.path,
			env: {
				PATH: process.env.PATH,
				CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/leak.sock",
				AGENTPULSE_SKIP: "1",
				ANTHROPIC_API_KEY: "label-only-test-value",
				...fake.env,
			},
			probeCwd,
			log: () => {},
		});
		expect((await probe("ask")).ok).toBe(true);
		const keys = (fake.starts()[0] as unknown as { envKeys: string[] }).envKeys;
		expect(keys).toContain("ANTHROPIC_API_KEY");
		expect(keys).not.toContain("CLAUDE_CODE_MESSAGING_SOCKET");
		expect(keys).toContain("AGENTPULSE_SKIP");
		expect(fake.starts()[0]).toMatchObject({ skip: "1" });
	});

	test("a child that never answers initialize is a timeout on an injected clock, and is still dead afterwards", async () => {
		const pending: Array<() => void> = [];
		const timers: RpcTimers = {
			set: (callback) => {
				pending.push(callback);
				return pending.length;
			},
			clear: () => {},
		};
		const { fake, probeCwd } = setup({ initialize: "silent" });
		const run = probeFor(fake, probeCwd, { timers })("ask");
		// The probe's initialize is pending once its timer is armed; nothing is waited on by the clock.
		const deadline = Date.now() + 5_000;
		while (pending.length === 0) {
			if (Date.now() > deadline) throw new Error("the probe never armed its timer");
			await Bun.sleep(10);
		}
		for (const fire of pending) fire();
		expect(await run).toEqual({ ok: false, why: "timeout" });
		expect(fake.userLines()).toBe(0);
		const pid = fake.pid();
		expect(pid).not.toBeNull();
		expect(() => process.kill(pid as number, 0)).toThrow();
	});

	test("a missing executable is a spawn failure", async () => {
		const { probeCwd, root } = setup({});
		const result = await createLoginProbe({
			executable: join(root, "no-such-claude"),
			env: { PATH: process.env.PATH },
			probeCwd,
			log: () => {},
		})("ask");
		expect(result).toEqual({ ok: false, why: "spawn" });
	});

	test("an error answer to initialize is a failed probe", async () => {
		const { fake, probeCwd } = setup({ initialize: "error" });
		expect(await probeFor(fake, probeCwd)("ask")).toEqual({ ok: false, why: "initialize" });
	});
});

describe("login label logging", () => {
	test("names the labels Claude reported, never a free-form value", () => {
		expect(
			describeLoginForLog({
				apiProvider: "firstParty",
				tokenSource: "none",
				apiKeySource: "ANTHROPIC_API_KEY",
			}),
		).toBe("provider=firstParty tokenSource=none apiKeySource=ANTHROPIC_API_KEY");
		expect(describeLoginForLog({ tokenSource: "sk-ant-oat-should-never-print-123456" })).toContain(
			"tokenSource=other",
		);
		expect(describeLoginForLog("nope")).toBe("no account reported");
	});
});

describe("the whole choice, end to end through a fake claude that answers by flag (T14)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function world(config: Parameters<typeof makeFakeClaude>[1]) {
		const root = mkdtempSync(join(tmpdir(), "claude-login-e2e-"));
		dirs.push(root);
		const fake = makeFakeClaude(join(root, "bin"), config);
		const probe = createLoginProbe({
			executable: fake.path,
			env: { PATH: process.env.PATH, ...fake.env },
			probeCwd: join(root, "probe"),
			timings: { interruptMs: 0, stdinCloseMs: 1_000, termMs: 500, killMs: 500 },
			log: () => {},
		});
		return { fake, probe };
	}
	const pidsOf = (fake: FakeClaude) => fake.starts().map((s) => s.pid);
	const dead = (pid: number) => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	};

	test("a helper: the restricted child sees no login, the ask child sees the helper: mode ask after two children", async () => {
		const { fake, probe } = world({ account: HELPER_ACCOUNT, accountRestricted: NO_LOGIN_ACCOUNT });
		expect(await pickForkMode(probe)).toEqual({ mode: "ask", probes: 2 });
		expect(fake.userLines()).toBe(0);
		expect(fake.controlSubtypes()).toEqual(["initialize", "initialize"]);
		expect(fake.starts().map((s) => s.argv.includes("--restricted"))).toEqual([true, false]);
		const pids = pidsOf(fake);
		expect(pids).toHaveLength(2);
		for (const pid of pids) expect(dead(pid), `pid ${pid}`).toBe(true);
	}, 30_000);

	test("no login at all: claude_not_logged_in after two children, no fork child ever started, nothing sent", async () => {
		const { fake, probe } = world({ account: NO_LOGIN_ACCOUNT });
		expect(await pickForkMode(probe)).toEqual({ refusal: "claude_not_logged_in", probes: 2 });
		expect(fake.userLines()).toBe(0);
		expect(fake.controlSubtypes()).toEqual(["initialize", "initialize"]);
		const starts = fake.starts();
		expect(starts).toHaveLength(2);
		for (const start of starts) {
			for (const flag of ["--resume", "--fork-session", "--session-id"]) {
				expect(start.argv, flag).not.toContain(flag);
			}
		}
		for (const pid of pidsOf(fake)) expect(dead(pid), `pid ${pid}`).toBe(true);
	}, 30_000);

	test("an env key: restricted after one child, which is dead and was sent nothing", async () => {
		const { fake, probe } = world({ account: recordedAccount("key-restricted-clean") });
		expect(await pickForkMode(probe)).toEqual({ mode: "restricted", probes: 1 });
		expect(fake.userLines()).toBe(0);
		expect(fake.controlSubtypes()).toEqual(["initialize"]);
		for (const pid of pidsOf(fake)) expect(dead(pid), `pid ${pid}`).toBe(true);
	}, 30_000);
});

describe("what a probe's child is given and how long it is waited for (X16, X22)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("AGENTPULSE_SKIP=1 is set by the probe, whatever the person's environment says, in both modes", async () => {
		const root = mkdtempSync(join(tmpdir(), "claude-probe-skip-"));
		dirs.push(root);
		const fake = makeFakeClaude(join(root, "bin"), { account: {} });
		const probe = createLoginProbe({
			executable: fake.path,
			env: { PATH: process.env.PATH, AGENTPULSE_SKIP: "0", ...fake.env },
			probeCwd: join(root, "probe"),
			timings: { interruptMs: 0, stdinCloseMs: 1_000, termMs: 500, killMs: 500 },
			log: () => {},
		});
		await probe("restricted");
		await probe("ask");
		expect(fake.starts().map((s) => (s as unknown as { skip: string }).skip)).toEqual(["1", "1"]);
	}, 30_000);

	test("a child whose exit is never seen doesn't hang the probe: it returns after the wait and says so", async () => {
		const logged: string[] = [];
		const probe = createLoginProbe({
			executable: "unused",
			env: {},
			probeCwd: join(tmpdir(), `claude-probe-exit-${process.pid}`),
			exitWaitMs: 100,
			log: (line) => logged.push(line),
			spawn: (async () => ({
				link: { initialize: async () => ({ account: {} }) },
				pid: 1,
				exited: new Promise(() => {}),
				hasExited: () => false,
				stderrBytes: () => 0,
				stop: async () => ({ gone: false, checked: true }),
			})) as never,
		});
		const started = Date.now();
		expect(await probe("ask")).toEqual({ ok: true, account: {} });
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(logged.some((l) => l.includes("did not exit"))).toBe(true);
		rmSync(join(tmpdir(), `claude-probe-exit-${process.pid}`), { recursive: true, force: true });
	});
});
