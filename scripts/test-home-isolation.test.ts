/**
 * No test may look at the real account's `~/.agentpulse/exclude`.
 *
 * The relay and the supervisor warn when rules exist under the account's home
 * that their own HOME never reads. They find that home through the operating
 * system's user database, which ignores HOME, so a test that only sets a
 * throwaway HOME still has the process lstat the real account's directory.
 * Every test that starts a relay in process passes `accountHome`, and every
 * test that spawns the relay or the supervisor sets the test-only environment
 * override. This file holds the tree to that, and holds the overrides to
 * their word.
 *
 * The scan is a tripwire, not a proof: it reads source text, so a start
 * hidden behind a helper this scan cannot see is not seen. The named members
 * and counts below keep it from passing on an empty population.
 *
 * Known blind spots, accepted for a tripwire:
 *  - the relay's path held in a variable (`spawn([process.execPath, relayPath])`
 *    shows no relay token inside the call, so it is not recognised as a spawn of
 *    the relay);
 *  - the arguments held in a const and passed by name (`spawn(cmd, args)`);
 *  - an aliased import (`import { spawn as run }`), whose calls match no name
 *    searched for.
 * The override's name must be written as code in the call (an identifier key,
 * as every test here does): the same name inside a comment, a string or a
 * template does not count as setting it.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveAccountHome } from "../src/supervisor/services/exclude-rules-watch.js";

const ROOT = join(import.meta.dir, "..");
const SELF = "scripts/test-home-isolation.test.ts";
const RELAY_ENV = "AGENTPULSE_TEST_RELAY_ACCOUNT_HOME";
const SUPERVISOR_ENV = "AGENTPULSE_TEST_SUPERVISOR_ACCOUNT_HOME";

/**
 * `source` with the inside of comments, strings, templates and regular expressions blanked to spaces
 * (same length, so offsets and line numbers still line up): text that only names a call is not a call.
 * A `/` starts a regular expression when what precedes it cannot end an expression.
 */
function codeOnly(source: string): string {
	const out = source.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	let lastSignificant = "";
	for (let i = 0; i < source.length; i++) {
		const ch = source[i] as string;
		const next = source[i + 1];
		if (ch === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			const stop = end < 0 ? source.length : end;
			blank(i, stop);
			i = stop - 1;
		} else if (ch === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end < 0 ? source.length : end + 2;
			blank(i, stop);
			i = stop - 1;
		} else if (ch === '"' || ch === "'" || ch === "`") {
			let k = i + 1;
			while (k < source.length && source[k] !== ch) k += source[k] === "\\" ? 2 : 1;
			blank(i, k + 1);
			i = k;
			lastSignificant = ch;
		} else if (ch === "/" && (lastSignificant === "" || "(,=:[!&|?{};".includes(lastSignificant))) {
			let k = i + 1;
			let inClass = false;
			while (k < source.length && (source[k] !== "/" || inClass)) {
				if (source[k] === "\\") k++;
				else if (source[k] === "[") inClass = true;
				else if (source[k] === "]") inClass = false;
				k++;
			}
			blank(i, k + 1);
			i = k;
			lastSignificant = "/";
		} else if (!/\s/.test(ch)) {
			lastSignificant = ch;
		}
	}
	return out.join("");
}

/** The text of the call whose opening parenthesis is at `open` (through its matching close), skipping strings and template literals. */
function callText(source: string, open: number): string {
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < source.length; i++) {
		const ch = source[i] as string;
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return source.slice(open, i + 1);
	}
	return source.slice(open);
}

/** Where the braces that follow a declaration begin and end, from `open` (an opening parenthesis of its parameters); empty when there are none. */
function declarationRange(source: string, open: number): [number, number] {
	const afterParams = open + callText(source, open).length;
	const braceAt = source.indexOf("{", afterParams);
	if (braceAt < 0) return [afterParams, afterParams];
	let depth = 0;
	for (let i = braceAt; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return [braceAt, i + 1];
	}
	return [braceAt, source.length];
}

const START_RE = /(?<![A-Za-z0-9_$])((?:[A-Za-z0-9_$]+\.)?)startRelay\s*\(/g;
const SPAWN_RE =
	/(?<![A-Za-z0-9_$])(?:Bun\.spawn(?:Sync)?|spawn(?:Sync)?|execFileSync|execFile)\s*\(/g;
const RELAY_TOKEN_RE = /\bRELAY(?:_PATH)?\b|relay\.ts/;
const SUPERVISOR_TOKEN_RE = /\bSUPERVISOR(?:_PATH)?\b|supervisor\/index/;

/** What a test file does that would reach the real account's home, as one line per offence. */
function findUninjectedStarts(original: string): string[] {
	const offences: string[] = [];
	const source = codeOnly(original);
	const lineOf = (index: number) => source.slice(0, index).split("\n").length;
	/** What the call at `open` holds as written (strings and all), found by reading the code-only form. */
	const argumentsOf = (open: number) => original.slice(open, open + callText(source, open).length);
	/** The same call with comments, strings and templates blanked: a name that must be code is looked for here. */
	const codeArgumentsOf = (open: number) =>
		source.slice(open, open + callText(source, open).length);

	for (const match of source.matchAll(START_RE)) {
		const index = match.index as number;
		const before = source.slice(Math.max(0, index - 24), index);
		const open = index + match[0].length - 1;
		if (/\bfunction\s+$/.test(before)) {
			// a local wrapper: whatever it starts must carry the injection itself
			const [from, to] = declarationRange(source, open);
			const body = original.slice(from, to);
			if (!/accountHome|AGENTPULSE_TEST_RELAY_ACCOUNT_HOME/.test(body)) {
				offences.push(`line ${lineOf(index)}: a startRelay wrapper that injects no accountHome`);
			}
			continue;
		}
		const isMember = match[1] !== "";
		const hasLocalWrapper = /\bfunction\s+startRelay\s*\(/.test(source);
		if (!isMember && hasLocalWrapper) continue; // a call of the file's own wrapper, checked at its definition
		if (!/\baccountHome\b/.test(argumentsOf(open))) {
			offences.push(`line ${lineOf(index)}: startRelay called without accountHome`);
		}
	}

	for (const match of source.matchAll(SPAWN_RE)) {
		const index = match.index as number;
		const open = index + match[0].length - 1;
		const text = argumentsOf(open);
		const code = codeArgumentsOf(open);
		if (RELAY_TOKEN_RE.test(text) && !code.includes(RELAY_ENV)) {
			offences.push(`line ${lineOf(index)}: the relay is spawned without ${RELAY_ENV}`);
		}
		if (SUPERVISOR_TOKEN_RE.test(text) && !code.includes(SUPERVISOR_ENV)) {
			offences.push(`line ${lineOf(index)}: the supervisor is spawned without ${SUPERVISOR_ENV}`);
		}
	}
	return offences;
}

function testFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) testFiles(full, out);
		else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) out.push(full);
	}
	return out;
}

describe("the checker sees what it is there to see (planted shapes)", () => {
	test("a startRelay call with no accountHome is an offence; the same call with it is not", () => {
		expect(
			findUninjectedStarts("const r = await R.startRelay({ a: 1 }, { timers: false });"),
		).toEqual(["line 1: startRelay called without accountHome"]);
		expect(
			findUninjectedStarts(
				"const r = await R.startRelay({ a: 1 }, { accountHome: () => undefined });",
			),
		).toEqual([]);
	});

	test("a local wrapper must inject, and calls of a wrapper that does are fine", () => {
		const bad =
			"async function startRelay(o) { return R.startRelay(cfg, {}); }\nawait startRelay({});";
		expect(findUninjectedStarts(bad).length).toBeGreaterThan(0);
		const hidden =
			"async function startRelay(o) { return somethingElse(o); }\nawait startRelay({});";
		expect(findUninjectedStarts(hidden)).toEqual([
			"line 1: a startRelay wrapper that injects no accountHome",
		]);
		const good =
			"async function startRelay(o) { return R.startRelay(cfg, { accountHome: () => undefined }); }\nawait startRelay({});";
		expect(findUninjectedStarts(good)).toEqual([]);
	});

	test("a spawn of the relay needs the relay override, one of the supervisor the supervisor's, and a spawn of something else needs neither", () => {
		const bare = 'Bun.spawn([process.execPath, RELAY, "--port", "0"], { env: { HOME: home } });';
		expect(findUninjectedStarts(bare)).toEqual([
			`line 1: the relay is spawned without ${RELAY_ENV}`,
		]);
		const fine = `Bun.spawn([process.execPath, RELAY], { env: { HOME: home, ${RELAY_ENV}: "" } });`;
		expect(findUninjectedStarts(fine)).toEqual([]);
		const supervisor = 'spawn("bun", [join(root, "src/supervisor/index.ts")], { env: {} });';
		expect(findUninjectedStarts(supervisor)).toEqual([
			`line 1: the supervisor is spawned without ${SUPERVISOR_ENV}`,
		]);
		expect(findUninjectedStarts('Bun.spawn(["bash", "statusline.sh"], { env: {} });')).toEqual([]);
	});

	test("text inside a string, a template, a regular expression or a comment is not code: a guard test may name a spawn in a string", () => {
		const plantedInStrings = [
			"const a = 'const c = execFileSync(\"curl\", [RELAY])';",
			"const b = realSource.replace('Bun.spawn([\"powershell\"', 'Bun.spawn([RELAY');",
			"const c = `Bun.spawn([RELAY, ${x}])`;",
			"const d = /[\"']Bun\\.spawn\\(RELAY/;",
			'// Bun.spawn([RELAY, "--port"], { env: {} })',
			"/* R.startRelay({}, {}) */",
			'const e = "R.startRelay({})";',
		].join("\n");
		expect(findUninjectedStarts(plantedInStrings)).toEqual([]);
		// ...and code after such text is still read as code
		expect(
			findUninjectedStarts(
				`${plantedInStrings}\nBun.spawn([process.execPath, RELAY], { env: {} });`,
			),
		).toEqual(["line 8: the relay is spawned without AGENTPULSE_TEST_RELAY_ACCOUNT_HOME"]);
	});

	test("the override's name inside a comment in the spawn call does not count as setting it", () => {
		const inBlockComment = `Bun.spawn([process.execPath, RELAY], { env: { HOME: home /* ${RELAY_ENV}: "" */ } });`;
		expect(findUninjectedStarts(inBlockComment)).toEqual([
			`line 1: the relay is spawned without ${RELAY_ENV}`,
		]);
		const inLineComment = `Bun.spawn(\n  [process.execPath, RELAY],\n  { env: { HOME: home } }, // ${RELAY_ENV}\n);`;
		expect(findUninjectedStarts(inLineComment)).toEqual([
			`line 1: the relay is spawned without ${RELAY_ENV}`,
		]);
		const supervisorInComment = `spawn("bun", [join(root, "src/supervisor/index.ts")], { env: {} /* ${SUPERVISOR_ENV} */ });`;
		expect(findUninjectedStarts(supervisorInComment)).toEqual([
			`line 1: the supervisor is spawned without ${SUPERVISOR_ENV}`,
		]);
	});

	test("a call whose arguments span lines and hold strings with parentheses is read to its end", () => {
		const source = `await R.startRelay(\n  { note: "(" },\n  {\n    accountHome: () => undefined,\n  },\n);`;
		expect(findUninjectedStarts(source)).toEqual([]);
	});
});

describe("no test in the tree reaches the real account's home", () => {
	const files = testFiles(ROOT).filter((f) => relative(ROOT, f) !== SELF);

	test("the scan covers the tree it is meant to: the files that start relays are in it, with the starts it knows about", () => {
		expect(files.length).toBeGreaterThan(50);
		const count = (rel: string, re: RegExp) =>
			(readFileSync(join(ROOT, rel), "utf-8").match(re) ?? []).length;
		expect(count("scripts/relay.test.ts", /\bstartTestRelay\s*\(/g)).toBeGreaterThanOrEqual(10);
		expect(count("scripts/relay.test.ts", START_RE)).toBeGreaterThanOrEqual(1);
		expect(count("scripts/statusline.test.ts", START_RE)).toBeGreaterThanOrEqual(1);
		expect(count("scripts/relay-exclude-e2e.test.ts", SPAWN_RE)).toBeGreaterThanOrEqual(1);
		expect(count("scripts/relay-e2e.test.ts", SPAWN_RE)).toBeGreaterThanOrEqual(1);
		expect(count("scripts/relay-dedup-e2e.test.ts", SPAWN_RE)).toBeGreaterThanOrEqual(1);
	});

	test("every in-process relay start injects accountHome, and every spawned relay or supervisor sets its override", () => {
		const offences = files.flatMap((file) =>
			findUninjectedStarts(readFileSync(file, "utf-8")).map((o) => `${relative(ROOT, file)}: ${o}`),
		);
		expect(offences).toEqual([]);
	});
});

describe("the overrides do what the scan relies on", () => {
	test("the supervisor's lookup: the override wins, an empty one means no account home, and without one the user database answers", () => {
		expect(resolveAccountHome({ [SUPERVISOR_ENV]: "/somewhere/else" })).toBe("/somewhere/else");
		expect(resolveAccountHome({ [SUPERVISOR_ENV]: "" })).toBeUndefined();
		expect(typeof resolveAccountHome({})).toBe("string");
	});

	/** Starts the real relay with a throwaway HOME and the given override, reads its startup output, and stops it (its own pid only). */
	async function relayOutput(account: string | undefined) {
		const dir = mkdtempSync(join(tmpdir(), "ap-home-isolation-"));
		const home = join(dir, "home");
		const accountDir = join(dir, "account");
		mkdirSync(join(home), { recursive: true });
		mkdirSync(join(accountDir, ".agentpulse"), { recursive: true });
		writeFileSync(join(accountDir, ".agentpulse", "exclude"), `${join(dir, "secret")}\n`);
		const configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				remote_url: "http://127.0.0.1:1",
				api_key: "ap_TEST_isolation_0123456789",
				port: 0,
			}),
			{ mode: 0o600 },
		);
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			AGENTPULSE_RELAY_SYNC_MS: "3600000",
		};
		if (account !== undefined) env[RELAY_ENV] = account === "<account>" ? accountDir : account;
		const proc = spawn(
			process.execPath,
			[join(ROOT, "scripts", "relay.ts"), "--config", configPath, "--port", "0"],
			{
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		proc.stdout.on("data", (c) => {
			output += c;
		});
		proc.stderr.on("data", (c) => {
			output += c;
		});
		try {
			const deadline = Date.now() + 15_000;
			while (!/Local:\s+http:\/\/localhost:\d+/.test(output) && Date.now() < deadline) {
				await Bun.sleep(25);
			}
			return { output, accountDir };
		} finally {
			proc.kill();
			await new Promise((resolve) => proc.once("exit", resolve));
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("a spawned relay: with the override naming a directory that holds rules it warns about them (the seam is read), with an empty one it says nothing", async () => {
		const named = await relayOutput("<account>");
		expect(named.output).toContain("not being applied");
		expect(named.output).toContain(named.accountDir);
		const empty = await relayOutput("");
		expect(empty.output).not.toContain("not being applied");
	}, 60_000);
});
