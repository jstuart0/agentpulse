/**
 * Runs the generated hook command the way Codex does: `<login shell> -lc
 * "<command>"` as ONE argument, with the real curl, against a receiver this
 * test starts on a random loopback port. On macOS the login shell is zsh,
 * which the old inlined check had never been parsed by; `bash -lc` is the
 * Linux shape. The throwaway HOME holds no profile files, so nothing from a
 * real user's profile is sourced (the system-wide profile still runs; on
 * macOS its path helper moves the system directories ahead of any stub, which
 * is why this uses a real receiver and not a stub curl).
 *
 * Cases per shell: no rules file (sent), an excluded directory (not sent),
 * invalid rules (not sent, marker written), the skip variable (not sent),
 * and rules that don't match (sent).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBashExcludeScript, buildBashHookCommand } from "../src/shared/hook-command.js";

setDefaultTimeout(30_000);

const PAYLOAD = JSON.stringify({ session_id: "sess-login-1", hook_event_name: "Stop" });

interface Received {
	url: string;
	agent: string | null;
	body: string;
}

const received: Received[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			received.push({
				url: new URL(req.url).pathname + new URL(req.url).search,
				agent: req.headers.get("x-agent-type"),
				body: await req.text(),
			});
			return new Response("ok");
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

function detect(bin: string): string | null {
	try {
		const absolute = execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf-8" }).trim();
		execFileSync(absolute, ["-c", "true"], { stdio: "ignore" });
		return absolute;
	} catch {
		return null;
	}
}

const SHELLS = [
	{ name: "zsh", bin: detect("zsh") },
	{ name: "bash", bin: detect("bash") },
];

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ap-login-shell-")));
let runIndex = 0;

interface Sandbox {
	home: string;
	tmp: string;
	cwd: string;
}

function newSandbox(): Sandbox {
	const root = join(scratch, `run-${++runIndex}`);
	const sb = { home: join(root, "home"), tmp: join(root, "tmp"), cwd: join(root, "work") };
	for (const dir of Object.values(sb)) mkdirSync(dir, { recursive: true });
	return sb;
}

function installRules(sb: Sandbox, lines: string[], mode = 0o600): void {
	const dir = join(sb.home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o700);
	writeFileSync(join(dir, "exclude"), `${lines.join("\n")}\n`);
	chmodSync(join(dir, "exclude"), mode);
	writeFileSync(join(dir, "exclude-check.sh"), buildBashExcludeScript());
	chmodSync(join(dir, "exclude-check.sh"), 0o500);
}

function payloads(sb: Sandbox): string[] {
	return readdirSync(sb.tmp).filter((n) => n.startsWith("agentpulse-hook."));
}

/** Runs `<shell> -lc "<command>"` and waits for the detached body to finish; returns what the receiver saw. */
async function runLoginHook(
	bin: string,
	sb: Sandbox,
	env: Record<string, string> = {},
): Promise<{ sent: Received[]; exitCode: number | null; stdout: string; stderr: string }> {
	const command = buildBashHookCommand({
		baseUrl,
		direct: false,
		agent: "codex_cli",
		event: "Stop",
	});
	received.length = 0;
	const result = spawnSync(bin, ["-lc", command], {
		cwd: sb.cwd,
		input: PAYLOAD,
		encoding: "utf-8",
		env: {
			PATH: "/usr/bin:/bin",
			HOME: sb.home,
			TMPDIR: sb.tmp,
			...env,
		},
	});
	const deadline = Date.now() + 15_000;
	while (payloads(sb).length > 0 && Date.now() < deadline) await Bun.sleep(25);
	expect(payloads(sb), "the detached body finished and removed the payload").toEqual([]);
	return {
		sent: [...received],
		exitCode: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

for (const { name, bin } of SHELLS) {
	if (!bin) {
		test.skip(`${name} not installed: login-shell run skipped`, () => {});
		continue;
	}

	describe(`the hook command run as \`${name} -lc "<command>"\``, () => {
		test("no rules file: sent once, silently", async () => {
			const sb = newSandbox();
			const run = await runLoginHook(bin, sb);
			expect(run.exitCode).toBe(0);
			expect(run.stdout).toBe("");
			expect(run.stderr).toBe("");
			expect(run.sent).toHaveLength(1);
			expect(run.sent[0]?.url).toBe("/api/v1/hooks?event=Stop");
			expect(run.sent[0]?.agent).toBe("codex_cli");
			expect(run.sent[0]?.body).toBe(PAYLOAD);
		});

		test("a rule that matches the working directory: not sent, the native marker still written", async () => {
			const sb = newSandbox();
			installRules(sb, [sb.cwd]);
			const run = await runLoginHook(bin, sb);
			expect(run.exitCode).toBe(0);
			expect(run.stdout).toBe("");
			expect(run.stderr).toBe("");
			expect(run.sent).toEqual([]);
			expect(existsSync(join(sb.home, ".agentpulse", "codex-native", "sess-login-1"))).toBe(true);
		});

		test("rules that do not match: sent", async () => {
			const sb = newSandbox();
			installRules(sb, [join(sb.home, "somewhere-else")]);
			const run = await runLoginHook(bin, sb);
			expect(run.exitCode).toBe(0);
			expect(run.sent).toHaveLength(1);
		});

		test("invalid rules (group-writable file): not sent, the invalid marker is written", async () => {
			const sb = newSandbox();
			installRules(sb, [join(sb.home, "x")], 0o660);
			const run = await runLoginHook(bin, sb);
			expect(run.exitCode).toBe(0);
			expect(run.stdout).toBe("");
			expect(run.stderr).toBe("");
			expect(run.sent).toEqual([]);
			expect(existsSync(join(sb.home, ".agentpulse", "exclude.invalid"))).toBe(true);
		});

		test("the skip variable: not sent", async () => {
			const sb = newSandbox();
			const run = await runLoginHook(bin, sb, { AGENTPULSE_SKIP: "1" });
			expect(run.exitCode).toBe(0);
			expect(run.sent).toEqual([]);
		});

		test("the parent returns well inside the 1 s SessionEnd budget", async () => {
			const sb = newSandbox();
			const command = buildBashHookCommand({
				baseUrl,
				direct: false,
				agent: "codex_cli",
				event: "SessionEnd",
			});
			installRules(sb, [join(sb.home, "somewhere-else")]);
			const started = performance.now();
			spawnSync(bin, ["-lc", command], {
				cwd: sb.cwd,
				input: PAYLOAD,
				env: { PATH: "/usr/bin:/bin", HOME: sb.home, TMPDIR: sb.tmp },
			});
			const parentMs = performance.now() - started;
			const deadline = Date.now() + 15_000;
			while (payloads(sb).length > 0 && Date.now() < deadline) await Bun.sleep(25);
			expect(parentMs).toBeLessThan(500);
		});
	});
}
