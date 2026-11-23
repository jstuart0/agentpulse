/**
 * `bun relay.ts update auto on|off|status` (AGEN-155, 6.2): the only way the relay's own-file refresh is
 * turned on, on the machine itself. The terminal check and the prompt reader are one module-level value only a
 * test replaces (`setRelayConsentIoForTests`); no environment variable can stand in for a terminal.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConsent } from "../src/shared/update-files.ts";
import { relayUpdateCommand, setRelayConsentIoForTests } from "./relay.ts?module";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
afterEach(() => setRelayConsentIoForTests(null));

function home(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-relay-consent-")));
	roots.push(dir);
	return dir;
}

const consentPath = (h: string) => join(h, ".agentpulse", "update-consent.json");

/** A terminal that types `answer` (a function of the question, so a test can read the random phrase). */
function terminal(answer: (question: string) => string, asked: string[] = []) {
	setRelayConsentIoForTests({
		isTty: () => true,
		prompt: async (question) => {
			asked.push(question);
			return answer(question);
		},
	});
	return asked;
}

const phraseIn = (question: string) => /Type "([^"]+)"/.exec(question)?.[1] ?? "";

async function run(
	h: string,
	args: string[],
	env: Record<string, string | undefined> = {},
): Promise<{ result: Awaited<ReturnType<typeof relayUpdateCommand>>; said: string[] }> {
	const said: string[] = [];
	const result = await relayUpdateCommand(args, { home: h, env, say: (line) => said.push(line) });
	return { result, said };
}

const APP = { on: true, allowMigrations: true, window: "02:00-04:30" };

describe("relay update auto on", () => {
	test("with no terminal it refuses, and nothing is written", async () => {
		const h = home();
		setRelayConsentIoForTests({ isTty: () => false, prompt: async () => "enable" });
		const { result, said } = await run(h, ["auto", "on"]);
		expect(result).toEqual({ ok: false, code: "not_a_terminal" });
		expect(said.join("\n")).toContain("yourself in a terminal");
		expect(existsSync(consentPath(h))).toBe(false);
	});

	test("a wrong typed word refuses; the bare word `enable` without the random part is wrong too", async () => {
		for (const typed of ["yes", "enable", "ENABLE", ""]) {
			const h = home();
			terminal(() => typed);
			const { result } = await run(h, ["auto", "on"]);
			expect(result, typed).toEqual({ ok: false, code: "not_confirmed" });
			expect(existsSync(consentPath(h))).toBe(false);
		}
	});

	test("an agent-session marker in the environment refuses before anything is asked", async () => {
		for (const env of [
			{ CLAUDECODE: "1" },
			{ CODEX_THREAD_ID: "t-1" },
			{ AI_AGENT: "x" },
			{ AGENTPULSE_KEY: "k" },
			{ OPENCODE_SERVER: "1" },
		]) {
			const h = home();
			const asked = terminal(() => "never reached");
			const { result, said } = await run(h, ["auto", "on"], env);
			expect(result, JSON.stringify(env)).toEqual({ ok: false, code: "agent_session" });
			// the message names the variable (never a value), so a person can see what to unset
			expect(said.join("\n")).toContain(`${Object.keys(env)[0]} is set`);
			expect(asked).toEqual([]);
			expect(existsSync(consentPath(h))).toBe(false);
		}
	});

	test("the confirmation phrase has a random part that changes between runs", async () => {
		const seen = new Set<string>();
		for (let i = 0; i < 4; i++) {
			const h = home();
			const asked = terminal(() => "wrong");
			await run(h, ["auto", "on"]);
			seen.add(phraseIn(asked[0] ?? ""));
		}
		expect(seen.size).toBeGreaterThan(1);
		for (const phrase of seen) expect(phrase).toMatch(/^enable [0-9a-f]{6}$/);
	});

	test("typing the phrase writes clients consent 0600 for all three components", async () => {
		const h = home();
		terminal(phraseIn);
		const { result, said } = await run(h, ["auto", "on"]);
		expect(result).toEqual({ ok: true });
		expect(said.at(-1)).toBe("Automatic refresh is on.");
		expect(statSync(consentPath(h)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(consentPath(h), "utf-8"))).toEqual({
			schema: 1,
			clients: { on: true, components: ["relay", "statusline", "excludeCheck"] },
		});
		const status = await run(h, ["auto", "status"]);
		expect(status.said.join("\n")).toContain("relay, statusline, excludeCheck");
	});

	test("an existing `app` section survives byte for byte, `allowMigrations: true` included, and the app's own reader still reads it", async () => {
		const h = home();
		mkdirSync(join(h, ".agentpulse"), { mode: 0o700 });
		writeFileSync(consentPath(h), `${JSON.stringify({ schema: 1, app: APP })}\n`, { mode: 0o600 });
		terminal(phraseIn);
		expect((await run(h, ["auto", "on"])).result).toEqual({ ok: true });
		const doc = JSON.parse(readFileSync(consentPath(h), "utf-8"));
		expect(JSON.stringify(doc.app)).toBe(JSON.stringify(APP));
		expect(doc.app.allowMigrations).toBe(true);
		expect(doc.clients.on).toBe(true);
		expect(readConsent(h)).toEqual(APP);
	});

	test("a symlinked consent file is refused and what it points at is untouched", async () => {
		const h = home();
		mkdirSync(join(h, ".agentpulse"), { mode: 0o700 });
		const target = join(h, "dotfiles-consent.json");
		writeFileSync(target, `${JSON.stringify({ schema: 1, app: APP })}\n`, { mode: 0o600 });
		symlinkSync(target, consentPath(h));
		terminal(phraseIn);
		const { result } = await run(h, ["auto", "on"]);
		expect(result).toEqual({ ok: false, code: "consent_unwritable" });
		expect(readFileSync(target, "utf-8")).toBe(`${JSON.stringify({ schema: 1, app: APP })}\n`);
	});

	test("a consent file that isn't schema 1, or is writable by others, is never replaced", async () => {
		for (const prepare of [
			(path: string) => writeFileSync(path, "{ not json", { mode: 0o600 }),
			(path: string) => writeFileSync(path, '{"schema":2,"app":{"on":true}}\n', { mode: 0o600 }),
			(path: string) => {
				writeFileSync(path, `${JSON.stringify({ schema: 1, app: APP })}\n`, { mode: 0o600 });
				chmodSync(path, 0o666);
			},
		]) {
			const h = home();
			mkdirSync(join(h, ".agentpulse"), { mode: 0o700 });
			prepare(consentPath(h));
			const before = readFileSync(consentPath(h), "utf-8");
			terminal(phraseIn);
			expect((await run(h, ["auto", "on"])).result).toEqual({
				ok: false,
				code: "consent_unwritable",
			});
			expect(readFileSync(consentPath(h), "utf-8")).toBe(before);
		}
	});

	test("a symlinked ~/.agentpulse is refused", async () => {
		const h = home();
		const real = join(h, "real-dir");
		mkdirSync(real, { mode: 0o700 });
		symlinkSync(real, join(h, ".agentpulse"));
		terminal(phraseIn);
		expect((await run(h, ["auto", "on"])).result).toEqual({
			ok: false,
			code: "consent_unwritable",
		});
		expect(existsSync(join(real, "update-consent.json"))).toBe(false);
	});
});

describe("relay update auto off, status and usage", () => {
	test("off clears `clients` and leaves `app` as it was, and needs no terminal", async () => {
		const h = home();
		mkdirSync(join(h, ".agentpulse"), { mode: 0o700 });
		writeFileSync(
			consentPath(h),
			`${JSON.stringify({ schema: 1, app: APP, clients: { on: true, components: ["relay"] } })}\n`,
			{ mode: 0o600 },
		);
		setRelayConsentIoForTests({ isTty: () => false, prompt: async () => "" });
		const { result } = await run(h, ["auto", "off"]);
		expect(result).toEqual({ ok: true });
		const doc = JSON.parse(readFileSync(consentPath(h), "utf-8"));
		expect(doc.clients).toEqual({ on: false, components: [] });
		expect(JSON.stringify(doc.app)).toBe(JSON.stringify(APP));
		expect((await run(h, ["auto", "status"])).said.join("\n")).toContain("off");
	});

	test("anything else is a usage error", async () => {
		const h = home();
		for (const args of [
			[],
			["auto"],
			["auto", "maybe"],
			["now", "on"],
			["auto", "on", "--force"].slice(0, 1),
		]) {
			const { result, said } = await run(h, args);
			expect(result, JSON.stringify(args)).toEqual({ ok: false, code: "bad_usage" });
			expect(said[0]).toContain("Usage: relay.ts update auto on|off|status");
		}
		expect(existsSync(consentPath(h))).toBe(false);
	});
});

describe("the entry point", () => {
	test("`bun relay.ts update auto on` with no terminal exits 1 and prints why (a real subprocess, its own HOME)", () => {
		const h = home();
		const proc = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "relay.ts"), "update", "auto", "on"],
			{
				env: { PATH: process.env.PATH ?? "", HOME: h, AGENTPULSE_TEST_RELAY_ACCOUNT_HOME: "" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(proc.exitCode).toBe(1);
		expect(proc.stdout.toString()).toContain("terminal");
		expect(existsSync(consentPath(h))).toBe(false);
	});
});
