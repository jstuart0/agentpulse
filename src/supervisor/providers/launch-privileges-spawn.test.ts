/**
 * What the supervisor really hands each agent: the argv Claude Code is spawned with
 * (headless, headless resume, interactive bridge command) and the parameters a managed
 * Codex thread is started with. The Codex path runs against a fake `codex app-server`
 * (a Bun WebSocket server in a temp dir that logs every request), so the real
 * spawnServer / RpcClient / thread/start code is what's exercised.
 *
 * Every refusal is checked to happen before anything is spawned.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchPrivilegeError, resolveLaunchPrivileges } from "../../shared/launch-privileges.js";
import type { LaunchRequest } from "../../shared/types.js";
import { launchClaudeHeadlessRequest, promptClaudeHeadlessSession } from "./claude-headless.js";
import { launchClaudeInteractiveRequest } from "./claude-interactive.js";
import {
	type ClaudePromptAction,
	buildLaunchBaseArgs,
	buildResumeBaseArgs,
} from "./claude-shared.js";
import { assertCodexThreadPrivileges, launchManagedCodexRequest } from "./codex-managed.js";

let home: string;
let fakeClaude: string;
let fakeCodex: string;
let codexLog: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"HOME",
	"AGENTPULSE_CLAUDE_COMMAND",
	"AGENTPULSE_CODEX_COMMAND",
	"AGENTPULSE_SUPERVISOR_DRY_RUN",
	"FAKE_CODEX_LOG",
	"FAKE_CODEX_FORCE_APPROVAL",
	"FAKE_CODEX_FORCE_SANDBOX",
	"FAKE_CODEX_SANDBOX_EXTRAS",
];

const FAKE_CODEX_SOURCE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
const log = (entry) => appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
log({ argv: process.argv.slice(2) });
const listen = new URL(process.argv[process.argv.indexOf("--listen") + 1]);
const SANDBOX_TYPE = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" };
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(listen.port),
  fetch(req, server) { return server.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
  websocket: {
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      log({ method: m.method, params: m.params });
      const reply = (result) => ws.send(JSON.stringify({ id: m.id, result }));
      if (m.method === "thread/start") {
        const approval = process.env.FAKE_CODEX_FORCE_APPROVAL || m.params.approvalPolicy || "on-request";
        const sandbox = process.env.FAKE_CODEX_FORCE_SANDBOX || m.params.sandbox || "read-only";
        reply({ thread: { id: "thr-1", cwd: m.params.cwd, status: "idle", source: "fake" }, approvalPolicy: approval, sandbox: { type: SANDBOX_TYPE[sandbox], ...(sandbox === "read-only" ? { networkAccess: false } : {}), ...(sandbox === "workspace-write" ? { writableRoots: [], networkAccess: false } : {}), ...JSON.parse(process.env.FAKE_CODEX_SANDBOX_EXTRAS || "{}") } });
      } else if (m.method === "thread/name/set") {
        reply({});
        ws.send(JSON.stringify({ method: "thread/name/updated", params: { threadId: m.params.threadId, threadName: m.params.name } }));
      } else if (m.method === "turn/start") reply({ turn: { id: "turn-1" } });
      else reply({ protocolVersion: "fake" });
    },
  },
});
`;

beforeAll(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	home = mkdtempSync(join(tmpdir(), "ap-privileges-spawn-"));
	mkdirSync(join(home, "work"), { recursive: true });
	fakeClaude = join(home, "fake-claude");
	writeFileSync(fakeClaude, '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', { mode: 0o755 });
	fakeCodex = join(home, "fake-codex");
	writeFileSync(fakeCodex, FAKE_CODEX_SOURCE, { mode: 0o755 });
	codexLog = join(home, "codex.log");
	process.env.HOME = home;
	process.env.AGENTPULSE_CLAUDE_COMMAND = fakeClaude;
	process.env.AGENTPULSE_CODEX_COMMAND = fakeCodex;
	process.env.FAKE_CODEX_LOG = codexLog;
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync(codexLog, { force: true });
	process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
	process.env.FAKE_CODEX_FORCE_APPROVAL = "";
	process.env.FAKE_CODEX_FORCE_SANDBOX = "";
	process.env.FAKE_CODEX_SANDBOX_EXTRAS = "";
});

function launch(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
	const id = crypto.randomUUID();
	return {
		id: `launch-${id}`,
		templateId: null,
		launchCorrelationId: id,
		agentType: "claude_code",
		cwd: join(home, "work"),
		baseInstructions: "be careful",
		taskPrompt: "do the thing",
		model: "sonnet-test",
		approvalPolicy: null,
		sandboxMode: null,
		requestedLaunchMode: "headless",
		env: {},
		launchSpec: {} as LaunchRequest["launchSpec"],
		status: "claimed",
		...overrides,
	} as LaunchRequest;
}

function fakeProc() {
	const closed = () =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
	return {
		pid: 4242,
		stdout: closed(),
		stderr: closed(),
		exited: Promise.resolve(0),
		kill: () => {},
	} as unknown as ReturnType<typeof Bun.spawn>;
}

/** Captures the argv Bun.spawn is called with and returns a process that exits cleanly. */
function captureSpawn() {
	const calls: string[][] = [];
	const realSpawn = Bun.spawn.bind(Bun);
	const spy = spyOn(Bun, "spawn").mockImplementation(((options: { cmd: string[] }) => {
		// The config's executable-version probe is real; only the agent itself is faked.
		if (options.cmd.at(-1) === "--version") return realSpawn(options as never);
		calls.push([...options.cmd]);
		return fakeProc();
	}) as unknown as typeof Bun.spawn);
	return { calls, restore: () => spy.mockRestore() };
}

const NO_REPORT = async () => {};
const TAIL = [
	"--print",
	"--verbose",
	"--output-format",
	"stream-json",
	"--include-partial-messages",
	"--",
	"do the thing",
];

describe("Claude Code headless launch argv", () => {
	let spawn: ReturnType<typeof captureSpawn>;
	beforeEach(() => {
		spawn = captureSpawn();
	});
	afterEach(() => spawn.restore());

	const cases: Array<[string, string | null, string[]]> = [
		["unset", null, []],
		["default", "default", []],
		["manual", "manual", ["--permission-mode", "default"]],
		["suggest", "suggest", ["--permission-mode", "default"]],
		["untrusted", "untrusted", ["--permission-mode", "default"]],
	];
	for (const [label, approvalPolicy, flags] of cases) {
		test(`approvalPolicy ${label}: the exact argv`, async () => {
			const request = launch({ approvalPolicy: approvalPolicy as LaunchRequest["approvalPolicy"] });
			const result = await launchClaudeHeadlessRequest(request, NO_REPORT);
			await result.monitor;
			const expected = [
				fakeClaude,
				"--session-id",
				request.launchCorrelationId,
				"--model",
				"sonnet-test",
				...flags,
				"--append-system-prompt",
				"be careful",
				...TAIL,
			];
			expect(spawn.calls).toEqual([expected]);
			expect(result.metadata.command).toEqual(expected);
			expect(result.metadata.privileges).toEqual({
				enforcedArgs: flags,
				agentDefaults: flags.length === 0 ? ["approvalPolicy", "sandboxMode"] : ["sandboxMode"],
			});
		});
	}

	const refused: Array<[string, Partial<LaunchRequest>]> = [
		["auto", { approvalPolicy: "auto" }],
		["on-failure", { approvalPolicy: "on-failure" }],
		["read-only sandbox", { sandboxMode: "read-only" }],
		["workspace-write sandbox", { sandboxMode: "workspace-write" }],
		["an unknown policy", { approvalPolicy: "bypassPermissions" as never }],
		["an unknown sandbox", { sandboxMode: "everything" as never }],
	];
	for (const [label, overrides] of refused) {
		test(`${label}: refused before any process is spawned`, async () => {
			await expect(
				launchClaudeHeadlessRequest(launch(overrides), NO_REPORT),
			).rejects.toBeInstanceOf(LaunchPrivilegeError);
			expect(spawn.calls).toEqual([]);
		});
	}

	test("a refused launch is not rescued by dry-run mode", async () => {
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "true";
		await expect(
			launchClaudeHeadlessRequest(launch({ approvalPolicy: "auto" }), NO_REPORT),
		).rejects.toBeInstanceOf(LaunchPrivilegeError);
	});

	test("no launch ever carries a bypass flag, whatever the settings", async () => {
		for (const approvalPolicy of [null, "default", "manual", "suggest", "untrusted"] as const) {
			const result = await launchClaudeHeadlessRequest(launch({ approvalPolicy }), NO_REPORT);
			await result.monitor;
		}
		const joined = spawn.calls.flat().join(" ");
		expect(joined).not.toContain("bypassPermissions");
		expect(joined).not.toContain("--dangerously");
		expect(joined).not.toContain("acceptEdits");
		expect(spawn.calls).toHaveLength(5);
	});
});

describe("Claude Code headless resume argv", () => {
	let spawn: ReturnType<typeof captureSpawn>;
	beforeEach(() => {
		spawn = captureSpawn();
	});
	afterEach(() => spawn.restore());

	function action(overrides: Partial<ClaudePromptAction> = {}): ClaudePromptAction {
		return {
			sessionId: "sess-1",
			prompt: "keep going",
			cwd: join(home, "work"),
			model: "sonnet-test",
			approvalPolicy: null,
			sandboxMode: null,
			...overrides,
		};
	}

	test("carries the launch's permission mode after --model", async () => {
		const result = await promptClaudeHeadlessSession(
			action({ approvalPolicy: "manual" }),
			NO_REPORT,
		);
		await result.monitor;
		expect(spawn.calls).toEqual([
			[
				fakeClaude,
				"--resume",
				"sess-1",
				"--model",
				"sonnet-test",
				"--permission-mode",
				"default",
				"--print",
				"--verbose",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
				"--",
				"keep going",
			],
		]);
	});

	test("a recorded default resumes with no privilege flags", async () => {
		const result = await promptClaudeHeadlessSession(action(), NO_REPORT);
		await result.monitor;
		expect(spawn.calls[0]).toEqual([
			fakeClaude,
			"--resume",
			"sess-1",
			"--model",
			"sonnet-test",
			"--print",
			"--verbose",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--",
			"keep going",
		]);
	});

	test("a resume that didn't carry the privileges is refused, not run with defaults", async () => {
		for (const missing of [
			{ approvalPolicy: undefined },
			{ sandboxMode: undefined },
			{ approvalPolicy: undefined, sandboxMode: undefined },
		]) {
			await expect(promptClaudeHeadlessSession(action(missing), NO_REPORT)).rejects.toBeInstanceOf(
				LaunchPrivilegeError,
			);
		}
		expect(spawn.calls).toEqual([]);
	});

	test("a resume with a value the mapping refuses is refused", async () => {
		for (const bad of [
			{ approvalPolicy: "auto" },
			{ sandboxMode: "read-only" },
			{ sandboxMode: 7 },
		]) {
			await expect(promptClaudeHeadlessSession(action(bad), NO_REPORT)).rejects.toBeInstanceOf(
				LaunchPrivilegeError,
			);
		}
		expect(spawn.calls).toEqual([]);
	});
});

describe("Claude Code argv builders", () => {
	test("privilege flags sit between --model and --append-system-prompt, and are plain argv elements", () => {
		const args = buildLaunchBaseArgs(launch({ approvalPolicy: "untrusted" }), "claude");
		expect(args.slice(3)).toEqual([
			"--model",
			"sonnet-test",
			"--permission-mode",
			"default",
			"--append-system-prompt",
			"be careful",
		]);
	});

	test("buildResumeBaseArgs refuses an action with no privileges", () => {
		expect(() => buildResumeBaseArgs({ sessionId: "s", prompt: "p", cwd: "/x" }, "claude")).toThrow(
			LaunchPrivilegeError,
		);
	});
});

describe("Claude Code interactive launch", () => {
	beforeEach(() => {
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "true";
	});

	function bridgeCommand(metadata: { interactiveBridge: { configPath: string } }): string[] {
		return JSON.parse(readFileSync(metadata.interactiveBridge.configPath, "utf8")).command;
	}

	test("the bridge's argv carries the permission mode; the shell string stays fully quoted", async () => {
		const request = launch({
			approvalPolicy: "manual",
			requestedLaunchMode: "interactive_terminal",
			cwd: join(home, "work"),
			taskPrompt: "it's a 'quoted' $(prompt); rm -rf /",
		});
		const result = await launchClaudeInteractiveRequest(request);
		const metadata = result.metadata as unknown as {
			interactiveBridge: { configPath: string };
			shellCommand: string;
			privileges: unknown;
		};
		expect(bridgeCommand(metadata)).toEqual([
			fakeClaude,
			"--session-id",
			request.launchCorrelationId,
			"--model",
			"sonnet-test",
			"--permission-mode",
			"default",
			"--append-system-prompt",
			"be careful",
			"--",
			"it's a 'quoted' $(prompt); rm -rf /",
		]);
		expect(metadata.privileges).toEqual({
			enforcedArgs: ["--permission-mode", "default"],
			agentDefaults: ["sandboxMode"],
		});
		// cd 'dir'; exec 'python3' 'script' '--config' 'path'  — every element single-quoted
		expect(metadata.shellCommand).toMatch(/^cd '[^']*'; exec ('[^']*' )*'[^']*'$/);
		expect(metadata.shellCommand).not.toContain("--permission-mode");
		expect(metadata.shellCommand).not.toContain("rm -rf");
	});

	test("an unset policy puts no privilege flag in the bridge argv", async () => {
		const request = launch({ requestedLaunchMode: "interactive_terminal" });
		const result = await launchClaudeInteractiveRequest(request);
		const argv = bridgeCommand(result.metadata as never);
		expect(argv).not.toContain("--permission-mode");
		expect(argv.slice(0, 5)).toEqual([
			fakeClaude,
			"--session-id",
			request.launchCorrelationId,
			"--model",
			"sonnet-test",
		]);
	});

	test("a refused combination is refused before the bridge directory or config is written", async () => {
		const request = launch({ approvalPolicy: "auto", requestedLaunchMode: "interactive_terminal" });
		await expect(launchClaudeInteractiveRequest(request)).rejects.toBeInstanceOf(
			LaunchPrivilegeError,
		);
		expect(existsSync(join(home, ".agentpulse", "interactive", request.launchCorrelationId))).toBe(
			false,
		);
	});
});

describe("assertCodexThreadPrivileges", () => {
	const privileges = (a: string | null, s: string | null) => {
		const r = resolveLaunchPrivileges("codex_cli", a, s);
		if (!r.ok) throw new Error("expected resolvable");
		return r;
	};

	test("passes when the agent reports what was requested", () => {
		expect(
			assertCodexThreadPrivileges(
				{ approvalPolicy: "untrusted", sandbox: { type: "readOnly" } },
				privileges("untrusted", "read-only"),
			),
		).toMatchObject({ approvalPolicy: "untrusted", sandbox: "readOnly", permissive: false });
	});

	test("a requested approval policy the agent didn't apply fails the launch", () => {
		expect(() =>
			assertCodexThreadPrivileges(
				{ approvalPolicy: "on-request", sandbox: { type: "readOnly" } },
				privileges("untrusted", null),
			),
		).toThrow(LaunchPrivilegeError);
	});

	test("a requested sandbox the agent didn't apply, or didn't report, fails the launch", () => {
		for (const sandbox of [
			{ type: "readOnly" },
			{ type: "dangerFullAccess" },
			{},
			null,
			undefined,
		]) {
			expect(() =>
				assertCodexThreadPrivileges(
					{ approvalPolicy: "on-request", sandbox },
					privileges(null, "workspace-write"),
				),
			).toThrow(LaunchPrivilegeError);
		}
	});

	test("defaults are not checked, only reported", () => {
		expect(
			assertCodexThreadPrivileges(
				{ approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } },
				privileges(null, null),
			),
		).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspaceWrite", permissive: false });
	});
});

describe("managed Codex launch against a fake app-server", () => {
	const callbacks = {
		reportState: async () => ({ session: { displayName: "fake-session" }, managedSession: {} }),
		reportEvents: async () => {},
	} as never;

	function codexLaunch(overrides: Partial<LaunchRequest> = {}) {
		return launch({
			agentType: "codex_cli",
			requestedLaunchMode: "managed_codex",
			model: "gpt-test",
			...overrides,
		});
	}

	function logged(): Array<Record<string, unknown>> {
		if (!existsSync(codexLog)) return [];
		return readFileSync(codexLog, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	function threadStartParams() {
		return logged().find((e) => e.method === "thread/start")?.params as Record<string, unknown>;
	}

	async function run(overrides: Partial<LaunchRequest>) {
		const result = await launchManagedCodexRequest(codexLaunch(overrides), callbacks);
		result.runtime.dispose();
		return result;
	}

	test("approvalPolicy and sandboxMode become thread/start parameters; the server argv carries no privilege flags", async () => {
		const result = await run({ approvalPolicy: "untrusted", sandboxMode: "read-only" });
		const params = threadStartParams();
		expect(params.approvalPolicy).toBe("untrusted");
		expect(params.sandbox).toBe("read-only");
		const argv = logged()[0].argv as string[];
		expect(argv[0]).toBe("app-server");
		expect(argv).not.toContain("--sandbox");
		expect(argv).not.toContain("--ask-for-approval");
		expect(result.metadata.privileges).toEqual({
			enforcedArgs: ["--sandbox", "read-only", "--ask-for-approval", "untrusted"],
			agentDefaults: [],
			reportedByAgent: {
				approvalPolicy: "untrusted",
				sandbox: "readOnly",
				networkAccess: false,
				writableRoots: [],
				permissive: false,
			},
			permissive: false,
		});
	});

	test("each sandbox value is passed through unchanged", async () => {
		for (const sandbox of ["read-only", "workspace-write", "danger-full-access"] as const) {
			rmSync(codexLog, { force: true });
			await run({ sandboxMode: sandbox });
			expect(threadStartParams().sandbox).toBe(sandbox);
		}
	});

	test("unset or default sends neither parameter and records what the agent reported as its default", async () => {
		for (const value of [null, "default"] as const) {
			rmSync(codexLog, { force: true });
			const result = await run({ approvalPolicy: value, sandboxMode: value });
			const params = threadStartParams();
			expect("approvalPolicy" in params).toBe(false);
			expect("sandbox" in params).toBe(false);
			expect(result.metadata.privileges).toEqual({
				enforcedArgs: [],
				agentDefaults: ["approvalPolicy", "sandboxMode"],
				reportedByAgent: {
					approvalPolicy: "on-request",
					sandbox: "readOnly",
					networkAccess: false,
					writableRoots: [],
					permissive: false,
				},
				permissive: false,
			});
		}
	});

	test("danger-full-access is sent only when it was requested", async () => {
		const sent: unknown[] = [];
		for (const overrides of [
			{},
			{ sandboxMode: "default" as const },
			{ sandboxMode: "workspace-write" as const },
			{ approvalPolicy: "untrusted" as const },
			{ sandboxMode: "danger-full-access" as const },
		]) {
			rmSync(codexLog, { force: true });
			await run(overrides);
			sent.push(threadStartParams().sandbox);
		}
		expect(sent).toEqual([
			undefined,
			undefined,
			"workspace-write",
			undefined,
			"danger-full-access",
		]);
	});

	test("a combination the mapping refuses never starts the app-server", async () => {
		for (const overrides of [
			{ approvalPolicy: "auto" as const },
			{ approvalPolicy: "on-failure" as const },
			{ sandboxMode: "everything" as never },
		]) {
			await expect(
				launchManagedCodexRequest(codexLaunch(overrides), callbacks),
			).rejects.toBeInstanceOf(LaunchPrivilegeError);
		}
		expect(logged()).toEqual([]);
	});

	test("dry-run refuses the same way and reports the enforcement", async () => {
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "true";
		await expect(
			launchManagedCodexRequest(codexLaunch({ approvalPolicy: "auto" }), callbacks),
		).rejects.toBeInstanceOf(LaunchPrivilegeError);
		const result = await launchManagedCodexRequest(
			codexLaunch({ sandboxMode: "read-only" }),
			callbacks,
		);
		expect(result.metadata.privileges).toEqual({
			enforcedArgs: ["--sandbox", "read-only"],
			agentDefaults: ["approvalPolicy"],
		});
	});

	test("an app-server that applies something other than what was requested fails the launch", async () => {
		process.env.FAKE_CODEX_FORCE_SANDBOX = "read-only";
		await expect(
			launchManagedCodexRequest(codexLaunch({ sandboxMode: "workspace-write" }), callbacks),
		).rejects.toBeInstanceOf(LaunchPrivilegeError);
		// No turn was started for the refused thread.
		expect(logged().some((e) => e.method === "turn/start")).toBe(false);

		process.env.FAKE_CODEX_FORCE_SANDBOX = "";
		process.env.FAKE_CODEX_FORCE_APPROVAL = "never";
		await expect(
			launchManagedCodexRequest(codexLaunch({ approvalPolicy: "untrusted" }), callbacks),
		).rejects.toBeInstanceOf(LaunchPrivilegeError);
		expect(logged().some((e) => e.method === "turn/start")).toBe(false);
	});
});

describe("a dash-leading prompt can never become an option", () => {
	let spawn: ReturnType<typeof captureSpawn>;
	beforeEach(() => {
		spawn = captureSpawn();
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
	});
	afterEach(() => spawn.restore());

	const DASH_PROMPTS = [
		"--permission-mode=bypassPermissions",
		"--dangerously-skip-permissions",
		"-p",
		"- fix the bug",
		"--",
	];

	test("headless launch: the prompt is the last element, directly after --; a dash-leading one is refused before spawn", async () => {
		const ok = launch({ taskPrompt: "fix the bug" });
		await (await launchClaudeHeadlessRequest(ok, NO_REPORT)).monitor;
		expect(spawn.calls[0].slice(-2)).toEqual(["--", "fix the bug"]);
		spawn.calls.length = 0;
		for (const taskPrompt of DASH_PROMPTS) {
			await expect(
				launchClaudeHeadlessRequest(launch({ taskPrompt }), NO_REPORT),
			).rejects.toBeInstanceOf(LaunchPrivilegeError);
		}
		expect(spawn.calls).toEqual([]);
	});

	test("headless resume: same", async () => {
		const resume = (prompt: string): ClaudePromptAction => ({
			sessionId: "s",
			prompt,
			cwd: join(home, "work"),
			model: null,
			approvalPolicy: null,
			sandboxMode: null,
		});
		await (await promptClaudeHeadlessSession(resume("go on"), NO_REPORT)).monitor;
		expect(spawn.calls[0].slice(-2)).toEqual(["--", "go on"]);
		spawn.calls.length = 0;
		for (const prompt of DASH_PROMPTS) {
			await expect(promptClaudeHeadlessSession(resume(prompt), NO_REPORT)).rejects.toBeInstanceOf(
				LaunchPrivilegeError,
			);
		}
		expect(spawn.calls).toEqual([]);
	});

	test("interactive launch: bridge argv ends --, prompt; dash-leading is refused before the bridge is written", async () => {
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "true";
		const ok = launch({ taskPrompt: "fix the bug", requestedLaunchMode: "interactive_terminal" });
		const result = await launchClaudeInteractiveRequest(ok);
		const argv = JSON.parse(
			readFileSync(
				(result.metadata as unknown as { interactiveBridge: { configPath: string } })
					.interactiveBridge.configPath,
				"utf8",
			),
		).command as string[];
		expect(argv.slice(-2)).toEqual(["--", "fix the bug"]);
		for (const taskPrompt of DASH_PROMPTS) {
			const request = launch({ taskPrompt, requestedLaunchMode: "interactive_terminal" });
			await expect(launchClaudeInteractiveRequest(request)).rejects.toBeInstanceOf(
				LaunchPrivilegeError,
			);
			expect(
				existsSync(join(home, ".agentpulse", "interactive", request.launchCorrelationId)),
			).toBe(false);
		}
	});

	test("an empty prompt uses the default text, which is not dash-leading", async () => {
		await (await launchClaudeHeadlessRequest(launch({ taskPrompt: "  " }), NO_REPORT)).monitor;
		expect(spawn.calls[0].slice(-2)).toEqual(["--", "Continue working on this project."]);
	});
});

describe("env that could undo the permissions is refused", () => {
	let spawn: ReturnType<typeof captureSpawn>;
	beforeEach(() => {
		spawn = captureSpawn();
	});
	afterEach(() => spawn.restore());

	test("headless launch, resume and interactive launch refuse CLAUDE_CONFIG_DIR, HOME, NODE_OPTIONS before spawning", async () => {
		for (const name of [
			"CLAUDE_CONFIG_DIR",
			"HOME",
			"NODE_OPTIONS",
			"CLAUDE_CODE_MANAGED_SETTINGS_PATH",
		]) {
			const env = { [name]: "/tmp/evil" };
			await expect(launchClaudeHeadlessRequest(launch({ env }), NO_REPORT)).rejects.toBeInstanceOf(
				LaunchPrivilegeError,
			);
			await expect(
				promptClaudeHeadlessSession(
					{
						sessionId: "s",
						prompt: "go",
						cwd: join(home, "work"),
						approvalPolicy: null,
						sandboxMode: null,
						env,
					},
					NO_REPORT,
				),
			).rejects.toBeInstanceOf(LaunchPrivilegeError);
			const interactive = launch({ env, requestedLaunchMode: "interactive_terminal" });
			await expect(launchClaudeInteractiveRequest(interactive)).rejects.toBeInstanceOf(
				LaunchPrivilegeError,
			);
		}
		expect(spawn.calls).toEqual([]);
	});

	test("an ordinary env and the API key variables still pass through", async () => {
		const request = launch({ env: { MY_VAR: "1", ANTHROPIC_API_KEY: "k" } });
		await (await launchClaudeHeadlessRequest(request, NO_REPORT)).monitor;
		expect(spawn.calls).toHaveLength(1);
	});
});

describe("Claude danger-full-access is accepted as the agent's own behaviour", () => {
	test("no flag is added and the record says nothing was enforced for it", async () => {
		const spawn = captureSpawn();
		try {
			const result = await launchClaudeHeadlessRequest(
				launch({ sandboxMode: "danger-full-access" }),
				NO_REPORT,
			);
			await result.monitor;
			expect(spawn.calls[0]).not.toContain("--permission-mode");
			expect(result.metadata.privileges).toEqual({
				enforcedArgs: [],
				agentDefaults: ["approvalPolicy", "sandboxMode"],
			});
		} finally {
			spawn.restore();
		}
	});
});

describe("managed Codex: what Codex actually applied", () => {
	const callbacks = {
		reportState: async () => ({ session: { displayName: "fake-session" }, managedSession: {} }),
		reportEvents: async () => {},
	} as never;
	const codexLaunch = (over: Partial<LaunchRequest>) =>
		launch({ agentType: "codex_cli", requestedLaunchMode: "managed_codex", ...over });

	test("a requested workspace-write that came back with network access or extra writable roots fails the launch", async () => {
		for (const extras of [{ networkAccess: true }, { writableRoots: ["/etc"] }]) {
			process.env.FAKE_CODEX_SANDBOX_EXTRAS = JSON.stringify(extras);
			await expect(
				launchManagedCodexRequest(codexLaunch({ sandboxMode: "workspace-write" }), callbacks),
			).rejects.toBeInstanceOf(LaunchPrivilegeError);
		}
		process.env.FAKE_CODEX_SANDBOX_EXTRAS = JSON.stringify({ networkAccess: true });
		await expect(
			launchManagedCodexRequest(codexLaunch({ sandboxMode: "read-only" }), callbacks),
		).rejects.toBeInstanceOf(LaunchPrivilegeError);
	});

	test("a null policy is not refused, but a permissive echo (dangerFullAccess or never) is recorded as permissive", async () => {
		for (const force of [
			{ FAKE_CODEX_FORCE_SANDBOX: "danger-full-access", FAKE_CODEX_FORCE_APPROVAL: "" },
			{ FAKE_CODEX_FORCE_SANDBOX: "", FAKE_CODEX_FORCE_APPROVAL: "never" },
		]) {
			Object.assign(process.env, force);
			const result = await launchManagedCodexRequest(codexLaunch({}), callbacks);
			result.runtime.dispose();
			const privileges = result.metadata.privileges as {
				permissive: boolean;
				enforcedArgs: string[];
				reportedByAgent: { sandbox: string; approvalPolicy: string };
			};
			expect(privileges.permissive).toBe(true);
			expect(privileges.enforcedArgs).toEqual([]);
		}
	});

	test("an explicit danger-full-access is allowed and recorded permissive", async () => {
		const result = await launchManagedCodexRequest(
			codexLaunch({ sandboxMode: "danger-full-access" }),
			callbacks,
		);
		result.runtime.dispose();
		expect((result.metadata.privileges as { permissive: boolean }).permissive).toBe(true);
	});
});

describe("an interactive resume finds the bridge in this host's own records", () => {
	let shortHome: string;
	let previousHome: string | undefined;
	const listeners: Array<{ stop: () => void }> = [];

	beforeEach(() => {
		// Unix socket paths are short; the shared temp home is too long for one.
		shortHome = mkdtempSync("/tmp/apx-");
		previousHome = process.env.HOME;
		process.env.HOME = shortHome;
	});
	afterEach(() => {
		for (const l of listeners.splice(0)) l.stop();
		process.env.HOME = previousHome;
		rmSync(shortHome, { recursive: true, force: true });
	});

	function listen(path: string, received: string[]) {
		const server = Bun.listen({
			unix: path,
			socket: {
				data(_s, data) {
					received.push(new TextDecoder().decode(data));
				},
			},
		});
		listeners.push(server);
		chmodSync(path, 0o600);
	}

	test("the prompt goes to the supervisor's own socket for that session, never to the path the action carries", async () => {
		const { promptClaudeInteractiveSession } = await import("./claude-interactive.js");
		const dir = join(shortHome, ".agentpulse", "interactive", "sess-1");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		writeFileSync(join(dir, "bridge.json"), "{}");
		writeFileSync(join(dir, "owner.json"), JSON.stringify({ app: "iTerm", windowId: "7" }));
		const own: string[] = [];
		const attacker: string[] = [];
		listen(join(dir, "control.sock"), own);
		const attackerPath = join(shortHome, "attacker.sock");
		listen(attackerPath, attacker);

		const states: Array<Record<string, unknown>> = [];
		const result = await promptClaudeInteractiveSession(
			{
				sessionId: "sess-1",
				prompt: "hello there",
				cwd: shortHome,
				interactiveBridge: { socketPath: attackerPath, configPath: "/x", controlDir: "/x" },
				terminalOwner: { app: "Terminal", windowId: "evil" },
			},
			{
				reportState: async (b: Record<string, unknown>) => {
					states.push(b);
					return { session: {}, managedSession: {} };
				},
				reportEvents: async () => {},
			} as never,
		);
		await Bun.sleep(100);
		expect(own.join("")).toBe("hello there\n");
		expect(attacker).toEqual([]);
		expect((result.metadata as { terminalOwner: unknown }).terminalOwner).toEqual({
			app: "iTerm",
			windowId: "7",
		});
		expect(
			(result.metadata as { interactiveBridge: { socketPath: string } }).interactiveBridge
				.socketPath,
		).toBe(join(dir, "control.sock"));
	});

	test("a session this host never opened a bridge for, or an id that is a path, is refused", async () => {
		const { promptClaudeInteractiveSession } = await import("./claude-interactive.js");
		// An id that would normalise to a real bridge ('sub/../real') must not find it.
		const real = join(shortHome, ".agentpulse", "interactive", "real");
		mkdirSync(real, { recursive: true });
		writeFileSync(join(real, "bridge.json"), "{}");
		for (const sessionId of [
			"no-such-session",
			"../../etc",
			"a/b",
			"",
			"sub/../real",
			"../interactive/real",
		]) {
			await expect(
				promptClaudeInteractiveSession(
					{
						sessionId,
						prompt: "x",
						cwd: shortHome,
						interactiveBridge: { socketPath: "/tmp/anything.sock", configPath: "", controlDir: "" },
					},
					undefined,
				),
			).rejects.toThrow("owned interactive bridge");
		}
	});
});

describe("the bridge directory and socket are checked before anything is sent", () => {
	let shortHome: string;
	let previousHome: string | undefined;
	const servers: Array<{ stop: () => void }> = [];

	beforeEach(() => {
		shortHome = mkdtempSync("/tmp/apx-");
		previousHome = process.env.HOME;
		process.env.HOME = shortHome;
	});
	afterEach(() => {
		for (const s of servers.splice(0)) s.stop();
		process.env.HOME = previousHome;
		rmSync(shortHome, { recursive: true, force: true });
	});

	function bridge(id: string, opts: { dirMode?: number; sockMode?: number } = {}) {
		const dir = join(shortHome, ".agentpulse", "interactive", id);
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, opts.dirMode ?? 0o700);
		writeFileSync(join(dir, "bridge.json"), "{}");
		const sock = join(dir, "control.sock");
		servers.push(Bun.listen({ unix: sock, socket: { data() {} } }));
		chmodSync(sock, opts.sockMode ?? 0o600);
		return dir;
	}

	test("a private directory and socket of ours are accepted", async () => {
		const { readOwnedBridge } = await import("./claude-interactive.js");
		bridge("ok-1");
		expect((await readOwnedBridge("ok-1"))?.socketPath).toContain("ok-1/control.sock");
	});

	test.each([0o750, 0o755, 0o770, 0o707, 0o702])(
		"a directory with mode %o is refused",
		async (dirMode) => {
			const { readOwnedBridge } = await import("./claude-interactive.js");
			bridge("loose-dir", { dirMode });
			expect(await readOwnedBridge("loose-dir")).toBeNull();
		},
	);

	test.each([0o660, 0o666, 0o640, 0o606])("a socket with mode %o is refused", async (sockMode) => {
		const { readOwnedBridge } = await import("./claude-interactive.js");
		bridge("loose-sock", { sockMode });
		expect(await readOwnedBridge("loose-sock")).toBeNull();
	});

	test("a symlinked directory, a symlinked socket and a plain file named control.sock are refused", async () => {
		const { readOwnedBridge } = await import("./claude-interactive.js");
		const real = bridge("real-bridge");
		const base = join(shortHome, ".agentpulse", "interactive");
		symlinkSync(real, join(base, "linked-dir"));
		expect(await readOwnedBridge("linked-dir")).toBeNull();

		const dir = join(base, "linked-sock");
		mkdirSync(dir, { mode: 0o700 });
		chmodSync(dir, 0o700);
		writeFileSync(join(dir, "bridge.json"), "{}");
		symlinkSync(join(real, "control.sock"), join(dir, "control.sock"));
		expect(await readOwnedBridge("linked-sock")).toBeNull();

		const file = join(base, "file-sock");
		mkdirSync(file, { mode: 0o700 });
		chmodSync(file, 0o700);
		writeFileSync(join(file, "bridge.json"), "{}");
		writeFileSync(join(file, "control.sock"), "", { mode: 0o600 });
		expect(await readOwnedBridge("file-sock")).toBeNull();
	});

	test("a directory with no socket yet is not a bridge", async () => {
		const { readOwnedBridge } = await import("./claude-interactive.js");
		const dir = join(shortHome, ".agentpulse", "interactive", "no-sock");
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o700);
		writeFileSync(join(dir, "bridge.json"), "{}");
		expect(await readOwnedBridge("no-sock")).toBeNull();
	});

	test("the owner check: an entry owned by another uid is refused (pure check over lstat results)", async () => {
		const { isPrivateOwnStat } = await import("./claude-interactive.js");
		const stat = (over: Record<string, unknown>) =>
			({
				uid: 501,
				mode: 0o40700,
				isSymbolicLink: () => false,
				isDirectory: () => true,
				isSocket: () => false,
				...over,
			}) as never;
		expect(isPrivateOwnStat(stat({}), "directory", 501)).toBe(true);
		expect(isPrivateOwnStat(stat({ uid: 0 }), "directory", 501)).toBe(false);
		expect(isPrivateOwnStat(stat({ isSymbolicLink: () => true }), "directory", 501)).toBe(false);
		expect(isPrivateOwnStat(stat({ mode: 0o40770 }), "directory", 501)).toBe(false);
		expect(isPrivateOwnStat(stat({}), "socket", 501)).toBe(false);
	});

	test("creating a bridge refuses a launch id that isn't a plain name, before any directory exists", async () => {
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "true";
		for (const launchCorrelationId of ["../evil", "a/b", "", "x".repeat(200), "with space"]) {
			await expect(
				launchClaudeInteractiveRequest(
					launch({ launchCorrelationId, requestedLaunchMode: "interactive_terminal" }),
				),
			).rejects.toThrow("interactive bridge name");
		}
		expect(existsSync(join(shortHome, ".agentpulse"))).toBe(false);
		expect(existsSync(join(shortHome, "evil"))).toBe(false);
	});
});
