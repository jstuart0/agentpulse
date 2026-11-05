/**
 * A real `codex` binary, no model call (AGEN-115, phase 3 step 11). Free: it starts `codex app-server` in a
 * THROWAWAY home (HOME and CODEX_HOME under a scratch root, update check off, no auth), against a
 * hand-written rollout, and asks it `thread/read` and `thread/resume`. Nothing is written to the real
 * `~/.codex`, no TUI is started, no turn is run, and the only processes signalled are the ones this file
 * spawned, by their own pid. It is skipped, with the reason printed, unless `codex --version` is at the
 * floor (0.163); a skip proves nothing and doesn't tick the plan's item.
 *
 * What it measured, on Codex 0.163.0 (macOS arm64), 2026-11-05, and the decisions that follow:
 *  - P3.11, the pre-upgrade path: `thread/read` answers `thread.originator` as the client's name at thread
 *    start: "agentpulse-supervisor" for this supervisor's own client, "codex-tui" for a TUI. It DISCRIMINATES,
 *    so the pre-upgrade branch of D11 stays (originator + UUIDv7 age + same directory).
 *  - D9's branch: a project's `.codex/config.toml` is ignored unless the user's own config marks the
 *    directory trusted; once trusted, `thread/resume` applies it (its sandbox extras show in the answer) AND
 *    starts its MCP servers (a marker command ran). The MCP-server arm takes effect, so the branch is ON: a
 *    takeover refuses `project_config` for an untrusted directory that has the file. The `notify` arm needs a
 *    turn to fire and can't be observed without a model call: not measured.
 *  - The writer lock: a second process resuming the same thread while the first is alive is refused with
 *    "already has an active writer" (-32600).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { installFakeCodex } from "./__fixtures__/fake-codex.js";

const FLOOR = [0, 163, 0];

/** S3: every codex process this file starts gets a throwaway environment, checked first. */
function assertThrowawayCodexEnv(env: Record<string, string>, scratch: string): void {
	for (const key of ["HOME", "CODEX_HOME"] as const) {
		const value = env[key];
		if (!value || !value.startsWith("/")) throw new Error(`${key} must be an absolute path`);
		if (value !== scratch && !value.startsWith(scratch + sep))
			throw new Error(`${key} is outside the scratch root`);
	}
	const realHome = homedir();
	if (scratch === realHome || scratch.startsWith(realHome + sep))
		throw new Error("the scratch root is inside the real home");
}

function versionAtFloor(text: string): boolean {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	if (!match) return false;
	const got = match.slice(1, 4).map(Number);
	for (let i = 0; i < 3; i++) {
		if (got[i] !== FLOOR[i]) return (got[i] as number) > (FLOOR[i] as number);
	}
	return true;
}

let scratch = "";
let skipReason: string | null = null;
const spawned: ChildProcess[] = [];

function baseEnv(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(home, "home"),
		CODEX_HOME: join(home, "codex-home"),
		AGENTPULSE_SKIP: "1",
	};
}

beforeAll(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "ap-codex-real-")));
	const probe = spawnSync("codex", ["--version"], {
		env: (() => {
			prepareHome(scratch);
			const e = baseEnv(scratch);
			assertThrowawayCodexEnv(e, scratch);
			return e;
		})(),
		encoding: "utf8",
	});
	if (probe.error) skipReason = `no codex on PATH (${probe.error.message})`;
	else if (!versionAtFloor(probe.stdout))
		skipReason = `codex is ${probe.stdout.trim()}, below the 0.163 floor`;
	if (skipReason)
		console.log(`[codex-resume.real] SKIPPED: ${skipReason}. This proves nothing about Codex.`);
});
afterAll(() => {
	for (const child of spawned) {
		try {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		} catch {
			try {
				child.kill("SIGKILL");
			} catch {}
		}
	}
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function prepareHome(root: string) {
	for (const dir of ["home", "codex-home", "neutral", "work"])
		mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "codex-home", "config.toml"), "check_for_update_on_startup = false\n");
}

class RealCodex {
	private readonly child: ChildProcess;
	private buffer = "";
	private id = 0;
	private readonly waiting = new Map<number, (message: any) => void>();
	constructor(
		root: string,
		readonly clientName: string,
	) {
		const env = baseEnv(root);
		assertThrowawayCodexEnv(env, root);
		this.child = spawn("codex", ["app-server"], {
			env,
			cwd: join(root, "neutral"),
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		spawned.push(this.child);
		this.child.stderr?.on("data", () => {});
		this.child.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
				const line = this.buffer.slice(0, nl);
				this.buffer = this.buffer.slice(nl + 1);
				try {
					const message = JSON.parse(line);
					if (message.id !== undefined && this.waiting.has(message.id)) {
						this.waiting.get(message.id)?.(message);
						this.waiting.delete(message.id);
					}
				} catch {}
			}
		});
	}
	call(method: string, params: unknown): Promise<any> {
		return new Promise((resolve) => {
			const id = ++this.id;
			this.waiting.set(id, resolve);
			this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
			setTimeout(() => resolve({ timeout: true }), 20_000);
		});
	}
	async open() {
		await this.call("initialize", {
			clientInfo: { name: this.clientName, title: this.clientName, version: "0.1.0" },
			capabilities: { experimentalApi: true },
		});
		this.child.stdin?.write(`${JSON.stringify({ method: "initialized" })}\n`);
	}
	/** Own pid only. */
	kill() {
		try {
			if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
		} catch {
			this.child.kill("SIGKILL");
		}
	}
}

function writeRollout(root: string, threadId: string, cwd: string, originator = "codex_exec") {
	const dir = join(root, "codex-home", "sessions", "2026", "11", "05");
	mkdirSync(dir, { recursive: true });
	const lines = [
		{
			timestamp: "2026-11-05T08:00:30.159Z",
			ordinal: 0,
			type: "session_meta",
			payload: {
				session_id: threadId,
				id: threadId,
				timestamp: "2026-11-05T08:00:27.928Z",
				cwd,
				runtime_workspace_roots: [cwd],
				originator,
				cli_version: "0.163.0",
				source: "exec",
				thread_source: "user",
				model_provider: "openai",
				history_mode: "paginated",
			},
		},
		{
			timestamp: "2026-11-05T08:00:31.000Z",
			ordinal: 1,
			type: "event_msg",
			payload: { type: "task_started", turn_id: "t1", started_at: 1793865631 },
		},
		{
			timestamp: "2026-11-05T08:00:32.000Z",
			ordinal: 2,
			type: "response_item",
			payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
		},
		{
			timestamp: "2026-11-05T08:00:33.000Z",
			ordinal: 3,
			type: "event_msg",
			payload: { type: "task_complete", turn_id: "t1" },
		},
	];
	writeFileSync(
		join(dir, `rollout-2026-11-05T08-00-27-${threadId}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

const OVERRIDES = { approvalPolicy: "untrusted", sandbox: "workspace-write" };
const WORKSPACE_WRITE = {
	type: "workspaceWrite",
	writableRoots: [],
	networkAccess: false,
	excludeTmpdirEnvVar: false,
	excludeSlashTmp: false,
};
let counter = 0;
const newThreadId = () => `01a1ab50-0000-7000-8000-${String(++counter).padStart(12, "0")}`;

function describeIfCodex(name: string, fn: () => void) {
	// Evaluated at registration, before beforeAll: gate each test at run time instead.
	describe(name, fn);
}

const guard = (fn: () => Promise<void>) => async () => {
	if (skipReason) {
		console.log(`[codex-resume.real] skipped: ${skipReason}`);
		return;
	}
	await fn();
};

describeIfCodex("a real Codex, in a throwaway home, with no model call", () => {
	test("the throwaway guard rejects the real home, a relative path and a path outside the scratch root", () => {
		const scratchRoot = "/private/tmp/x";
		expect(() =>
			assertThrowawayCodexEnv({ HOME: "relative", CODEX_HOME: "/private/tmp/x/c" }, scratchRoot),
		).toThrow();
		expect(() =>
			assertThrowawayCodexEnv({ HOME: homedir(), CODEX_HOME: `${homedir()}/.codex` }, scratchRoot),
		).toThrow();
		expect(() =>
			assertThrowawayCodexEnv(
				{ HOME: "/private/tmp/x2/h", CODEX_HOME: "/private/tmp/x/c" },
				scratchRoot,
			),
		).toThrow();
		expect(() =>
			assertThrowawayCodexEnv(
				{ HOME: "/private/tmp/x/h", CODEX_HOME: "/private/tmp/x/c" },
				scratchRoot,
			),
		).not.toThrow();
	});

	test(
		"P3.11: thread/read's originator is the client's name at thread start, so it tells the supervisor's own threads apart",
		guard(async () => {
			const answers: Record<string, string> = {};
			for (const name of ["agentpulse-supervisor", "codex-tui"]) {
				const codex = new RealCodex(scratch, name);
				await codex.open();
				const started = await codex.call("thread/start", {
					cwd: join(scratch, "work"),
					experimentalRawEvents: false,
					persistExtendedHistory: true,
					sessionStartSource: "startup",
					approvalPolicy: "untrusted",
					sandbox: "workspace-write",
				});
				const id = started.result?.thread?.id as string;
				const read = await codex.call("thread/read", { threadId: id, includeTurns: false });
				answers[name] = read.result?.thread?.originator;
				codex.kill();
			}
			expect(answers).toEqual({
				"agentpulse-supervisor": "agentpulse-supervisor",
				"codex-tui": "codex-tui",
			});
		}),
	);

	test(
		"thread/read answers the CURRENT directory; thread/resume with the takeover overrides answers exactly the sandbox the provider compares",
		guard(async () => {
			const id = newThreadId();
			writeRollout(scratch, id, join(scratch, "work"));
			const codex = new RealCodex(scratch, "agentpulse-supervisor");
			await codex.open();
			const read = await codex.call("thread/read", { threadId: id, includeTurns: false });
			expect(read.result.thread.cwd).toBe(join(scratch, "work"));
			expect(read.result.thread.status.type).toBe("notLoaded");
			const resumed = await codex.call("thread/resume", {
				threadId: id,
				excludeTurns: true,
				...OVERRIDES,
			});
			expect(resumed.result.approvalPolicy).toBe("untrusted");
			expect(resumed.result.sandbox).toEqual(WORKSPACE_WRITE);
			codex.kill();
		}),
	);

	test(
		"a second process resuming the same thread while the first is alive is refused with 'active writer' (-32600)",
		guard(async () => {
			const id = newThreadId();
			writeRollout(scratch, id, join(scratch, "work"));
			const first = new RealCodex(scratch, "agentpulse-supervisor");
			await first.open();
			const ok = await first.call("thread/resume", {
				threadId: id,
				excludeTurns: true,
				...OVERRIDES,
			});
			expect(ok.result).toBeDefined();
			const second = new RealCodex(scratch, "agentpulse-supervisor");
			await second.open();
			const refused = await second.call("thread/resume", {
				threadId: id,
				excludeTurns: true,
				...OVERRIDES,
			});
			expect(refused.error.code).toBe(-32600);
			expect(refused.error.message).toContain("active writer");
			first.kill();
			second.kill();
		}),
	);

	test(
		"D9: a project's own .codex/config.toml is ignored until the user trusts the directory; trusted, it applies and its MCP server runs",
		guard(async () => {
			const work = join(scratch, "hostile");
			mkdirSync(join(work, ".codex"), { recursive: true });
			const marker = join(scratch, "mcp-marker");
			writeFileSync(
				join(work, ".codex", "config.toml"),
				`sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nwritable_roots = ["${join(scratch, "extra-root")}"]\nnetwork_access = true\n[mcp_servers.canary]\ncommand = "/usr/bin/touch"\nargs = ["${marker}"]\n`,
			);
			// Untrusted: nothing applies.
			const untrustedId = newThreadId();
			writeRollout(scratch, untrustedId, work);
			const a = new RealCodex(scratch, "agentpulse-supervisor");
			await a.open();
			const ignored = await a.call("thread/resume", {
				threadId: untrustedId,
				excludeTurns: true,
				...OVERRIDES,
			});
			expect(ignored.result.sandbox).toEqual(WORKSPACE_WRITE);
			await Bun.sleep(1500);
			expect(existsSync(marker)).toBe(false);
			a.kill();

			// Trusted by the user's own config: it applies, and the provider's whole-object comparison would refuse it.
			writeFileSync(
				join(scratch, "codex-home", "config.toml"),
				`check_for_update_on_startup = false\n[projects."${work}"]\ntrust_level = "trusted"\n`,
			);
			const trustedId = newThreadId();
			writeRollout(scratch, trustedId, work);
			const b = new RealCodex(scratch, "agentpulse-supervisor");
			await b.open();
			const applied = await b.call("thread/resume", {
				threadId: trustedId,
				excludeTurns: true,
				...OVERRIDES,
			});
			expect(applied.result.sandbox.writableRoots).toEqual([join(scratch, "extra-root")]);
			expect(applied.result.sandbox).not.toEqual(WORKSPACE_WRITE);
			for (let i = 0; i < 20 && !existsSync(marker); i++) await Bun.sleep(150);
			expect(existsSync(marker)).toBe(true);
			b.kill();
			writeFileSync(
				join(scratch, "codex-home", "config.toml"),
				"check_for_update_on_startup = false\n",
			);
		}),
	);

	test(
		"the fake's answers have the same key sets as the real ones (thread/read, thread/resume, the thread, the sandbox)",
		guard(async () => {
			const id = newThreadId();
			writeRollout(scratch, id, join(scratch, "work"));
			const real = new RealCodex(scratch, "agentpulse-supervisor");
			await real.open();
			const realRead = (await real.call("thread/read", { threadId: id, includeTurns: false }))
				.result;
			const realResume = (
				await real.call("thread/resume", { threadId: id, excludeTurns: true, ...OVERRIDES })
			).result;
			real.kill();

			const fakeDir = mkdtempSync(join(scratch, "fake-"));
			const executable = installFakeCodex(fakeDir);
			const fakeEnv = {
				...process.env,
				FAKE_CODEX_VERSION: "0.163.0",
				FAKE_CODEX_THREAD_ID: id,
				FAKE_CODEX_THREAD_CWD: join(scratch, "work"),
			};
			const child = spawn(executable, ["app-server"], {
				env: fakeEnv,
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			});
			spawned.push(child);
			const answers = new Map<number, any>();
			let buf = "";
			child.stdout.on("data", (d: Buffer) => {
				buf += d.toString();
				for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
					const m = JSON.parse(buf.slice(0, nl));
					buf = buf.slice(nl + 1);
					if (m.id !== undefined) answers.set(m.id, m);
				}
			});
			const ask = async (n: number, method: string, params: unknown) => {
				child.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`);
				for (let i = 0; i < 100 && !answers.has(n); i++) await Bun.sleep(20);
				return answers.get(n).result;
			};
			await ask(1, "initialize", { clientInfo: { name: "x" }, capabilities: {} });
			const fakeRead = await ask(2, "thread/read", { threadId: id, includeTurns: false });
			const fakeResume = await ask(3, "thread/resume", {
				threadId: id,
				excludeTurns: true,
				...OVERRIDES,
			});
			try {
				process.kill(-(child.pid as number), "SIGKILL");
			} catch {}

			const keys = (value: unknown) => Object.keys(value as object).sort();
			expect(keys(fakeRead)).toEqual(keys(realRead));
			expect(keys(fakeRead.thread)).toEqual(keys(realRead.thread));
			expect(keys(fakeResume)).toEqual(keys(realResume));
			expect(keys(fakeResume.thread)).toEqual(keys(realResume.thread));
			expect(keys(fakeResume.sandbox)).toEqual(keys(realResume.sandbox));
		}),
	);
});
