/**
 * A real `codex` binary, no model call (AGEN-115, phase 3 step 11). Free: it starts `codex app-server` in a
 * THROWAWAY home (HOME and CODEX_HOME under a scratch root, update check off, no auth), against a
 * hand-written rollout, and asks it `thread/read` and `thread/resume`. Nothing is written to the real
 * `~/.codex`, no TUI is started, no turn is run, and the only processes signalled are the ones this file
 * spawned, by their own pid. The `codex --version` probe runs once, synchronously, at module load; the tests
 * are skipped, with the reason printed once, unless it is at the floor (0.163). A skip proves nothing and
 * doesn't tick the plan's item.
 *
 * What it measured, on Codex 0.163.0 (macOS arm64), 2026-11-05:
 *  - P3.11: `thread/read` answers `thread.originator` as the client's name at thread start:
 *    "agentpulse-supervisor" for this supervisor's own client, "codex-tui" for a TUI. It DISCRIMINATES, so the
 *    pre-upgrade branch of D11 stays.
 *  - D7 (was D9's branch): a project's `.codex/config.toml` is ignored unless the user's own config marks the
 *    directory trusted; once trusted, `thread/resume` applies it (its sandbox extras are in the answer) AND
 *    starts its MCP servers, before anything the host could compare. So trust is no allow signal: the file's
 *    presence refuses a takeover and a recovery. `notify` needs a turn to fire and can't be observed without
 *    a model call: not measured.
 *  - Layering: a PARENT directory's file is NOT applied to a child directory unless the parent is the git
 *    root, in which case it is. So the host walks up to the git root (or the trusted root with no git root);
 *    the walk is necessary, not just cheap.
 *  - `thread/read` never starts a project's MCP servers and never opens a FIFO where the config file would be.
 *  - The writer lock: a second process resuming the same thread while the first is alive is refused with
 *    "already has an active writer" (-32600).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ownCodexPids } from "../../../scripts/lib/codex-own-pids.js";
import { installFakeCodex } from "./__fixtures__/fake-codex.js";

const RECORDED = JSON.parse(
	readFileSync(new URL("./__fixtures__/codex-0.163-thread-resume.json", import.meta.url), "utf8"),
);
const FLOOR = [0, 163, 0];
const TEST_TIMEOUT_MS = 60_000;

const isInside = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);
const resolved = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

/** S3: nothing here spawns `codex` except through `throwawayCodex`, which checks the environment first. */
function assertThrowawayCodexEnv(env: Record<string, string>, scratch: string): void {
	const realHome = resolved(homedir());
	for (const key of ["HOME", "CODEX_HOME"] as const) {
		const value = env[key];
		if (!value || !value.startsWith("/")) throw new Error(`${key} must be an absolute path`);
		if (!isInside(value, scratch)) throw new Error(`${key} is outside the scratch root`);
		// A symlink inside the scratch root that leads into the real home is still the real home.
		if (isInside(resolved(value), realHome)) throw new Error(`${key} resolves into the real home`);
	}
	if (isInside(resolved(scratch), realHome))
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

function prepareHome(root: string) {
	for (const dir of ["home", "codex-home", "neutral", "work"])
		mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "codex-home", "config.toml"), "check_for_update_on_startup = false\n");
}

function baseEnv(root: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(root, "home"),
		CODEX_HOME: join(root, "codex-home"),
		AGENTPULSE_SKIP: "1",
	};
}

/** The one place a real `codex` is spawned, sync or async: always in the throwaway environment, checked first. */
function throwawayCodex(root: string) {
	const env = baseEnv(root);
	assertThrowawayCodexEnv(env, root);
	return {
		spawn: (args: string[], cwd: string): ChildProcess =>
			spawn("codex", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], detached: true }),
		spawnSync: (args: string[]) => spawnSync("codex", args, { env, encoding: "utf8" }),
	};
}

// The scratch root and the version probe exist at module load, so skipIf sees the answer when it registers.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ap-codex-real-")));
prepareHome(scratch);
const probe = throwawayCodex(scratch).spawnSync(["--version"]);
const skipReason: string | null = probe.error
	? `no codex on PATH (${probe.error.message})`
	: versionAtFloor(probe.stdout)
		? null
		: `codex is ${probe.stdout.trim()}, below the 0.163 floor`;
if (skipReason)
	console.log(`[codex-resume.real] SKIPPED: ${skipReason}. This proves nothing about Codex.`);

const spawned: ChildProcess[] = [];

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
	if (!skipReason) {
		// Nothing started here may outlive it (macOS: the environment is read with ps -E; elsewhere this selects nothing).
		expect(ownCodexPids(join(scratch, "codex-home"))).toEqual([]);
	}
	rmSync(scratch, { recursive: true, force: true });
});

class RealCodex {
	private readonly child: ChildProcess;
	private buffer = "";
	private id = 0;
	private readonly waiting = new Map<number, (message: any) => void>();
	constructor(readonly clientName: string) {
		this.child = throwawayCodex(scratch).spawn(["app-server"], join(scratch, "neutral"));
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
	/** An answer, or the test fails: a call that times out is a failure, never a value. */
	call(method: string, params: unknown, timeoutMs = 20_000): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = ++this.id;
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`${method} got no answer in ${timeoutMs} ms`));
			}, timeoutMs);
			this.waiting.set(id, (message) => {
				clearTimeout(timer);
				resolve(message);
			});
			this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
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

function writeRollout(threadId: string, cwd: string, originator = "codex_exec") {
	const dir = join(scratch, "codex-home", "sessions", "2026", "11", "05");
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
const WORKSPACE_WRITE = RECORDED.sandbox.workspaceWrite;
let counter = 0;
const newThreadId = () => `01a1ab50-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
const trust = (...dirs: string[]) =>
	writeFileSync(
		join(scratch, "codex-home", "config.toml"),
		`check_for_update_on_startup = false\n${dirs.map((d) => `[projects."${d}"]\ntrust_level = "trusted"\n`).join("")}`,
	);
const untrust = () =>
	writeFileSync(
		join(scratch, "codex-home", "config.toml"),
		"check_for_update_on_startup = false\n",
	);
const hostileConfig = (dir: string, marker: string) => {
	mkdirSync(join(dir, ".codex"), { recursive: true });
	writeFileSync(
		join(dir, ".codex", "config.toml"),
		`sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nwritable_roots = ["${join(scratch, "extra-root")}"]\nnetwork_access = true\n[mcp_servers.canary]\ncommand = "/usr/bin/touch"\nargs = ["${marker}"]\n`,
	);
};
const keys = (value: unknown) => Object.keys((value ?? {}) as object).sort();
const typeOf = (value: unknown) =>
	value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const real = (name: string, fn: () => Promise<void>) =>
	test.skipIf(skipReason !== null)(name, fn, TEST_TIMEOUT_MS);

describe("the throwaway guard", () => {
	const root = "/private/tmp/x";
	test("rejects a relative path, the real home, a path outside the scratch root and a symlink into the real home", () => {
		expect(() =>
			assertThrowawayCodexEnv({ HOME: "relative", CODEX_HOME: `${root}/c` }, root),
		).toThrow();
		expect(() =>
			assertThrowawayCodexEnv({ HOME: homedir(), CODEX_HOME: `${homedir()}/.codex` }, root),
		).toThrow();
		expect(() =>
			assertThrowawayCodexEnv({ HOME: "/private/tmp/x2/h", CODEX_HOME: `${root}/c` }, root),
		).toThrow();
		expect(() =>
			assertThrowawayCodexEnv({ HOME: `${root}/h`, CODEX_HOME: `${root}/c` }, root),
		).not.toThrow();

		const link = join(scratch, "link-into-real-home");
		symlinkSync(homedir(), link);
		expect(() =>
			assertThrowawayCodexEnv({ HOME: link, CODEX_HOME: join(scratch, "codex-home") }, scratch),
		).toThrow(/real home/);
		expect(() =>
			assertThrowawayCodexEnv(
				{ HOME: join(scratch, "home"), CODEX_HOME: join(scratch, "codex-home") },
				scratch,
			),
		).not.toThrow();
	});
});

describe("a real Codex, in a throwaway home, with no model call", () => {
	real(
		"P3.11: thread/read's originator is the client's name at thread start, so it tells the supervisor's own threads apart",
		async () => {
			const answers: Record<string, string> = {};
			for (const name of ["agentpulse-supervisor", "codex-tui"]) {
				const codex = new RealCodex(name);
				await codex.open();
				const started = await codex.call("thread/start", {
					cwd: join(scratch, "work"),
					experimentalRawEvents: false,
					persistExtendedHistory: true,
					sessionStartSource: "startup",
					approvalPolicy: "untrusted",
					sandbox: "workspace-write",
				});
				const read = await codex.call("thread/read", {
					threadId: started.result.thread.id,
					includeTurns: false,
				});
				answers[name] = read.result.thread.originator;
				codex.kill();
			}
			expect(answers).toEqual({
				"agentpulse-supervisor": "agentpulse-supervisor",
				"codex-tui": "codex-tui",
			});
		},
	);

	real(
		"thread/read answers the CURRENT directory; thread/resume with the takeover overrides answers exactly the sandbox the provider compares",
		async () => {
			const id = newThreadId();
			writeRollout(id, join(scratch, "work"));
			const codex = new RealCodex("agentpulse-supervisor");
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
		},
	);

	real(
		"a second process resuming the same thread while the first is alive is refused with 'active writer' (-32600)",
		async () => {
			const id = newThreadId();
			writeRollout(id, join(scratch, "work"));
			const first = new RealCodex("agentpulse-supervisor");
			await first.open();
			expect(
				(await first.call("thread/resume", { threadId: id, excludeTurns: true, ...OVERRIDES }))
					.result,
			).toBeDefined();
			const second = new RealCodex("agentpulse-supervisor");
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
		},
	);

	real(
		"D7: a project's own .codex/config.toml is ignored until the user trusts the directory; trusted, it applies and its MCP server runs",
		async () => {
			const work = join(scratch, "hostile");
			const marker = join(scratch, "mcp-marker");
			hostileConfig(work, marker);
			const untrustedId = newThreadId();
			writeRollout(untrustedId, work);
			const a = new RealCodex("agentpulse-supervisor");
			await a.open();
			expect(
				(await a.call("thread/resume", { threadId: untrustedId, excludeTurns: true, ...OVERRIDES }))
					.result.sandbox,
			).toEqual(WORKSPACE_WRITE);
			await Bun.sleep(1500);
			expect(existsSync(marker)).toBe(false);
			a.kill();

			trust(work);
			const trustedId = newThreadId();
			writeRollout(trustedId, work);
			const b = new RealCodex("agentpulse-supervisor");
			await b.open();
			const applied = await b.call("thread/resume", {
				threadId: trustedId,
				excludeTurns: true,
				...OVERRIDES,
			});
			expect(applied.result.sandbox.writableRoots).toEqual([join(scratch, "extra-root")]);
			for (let i = 0; i < 20 && !existsSync(marker); i++) await Bun.sleep(150);
			expect(existsSync(marker)).toBe(true);
			b.kill();
			untrust();
			rmSync(marker, { force: true });
		},
	);

	real(
		"a parent's config is layered into a child directory only when the parent is the git root",
		async () => {
			const parent = join(scratch, "layered");
			const child = join(parent, "child");
			mkdirSync(child, { recursive: true });
			const marker = join(scratch, "layer-marker");
			hostileConfig(parent, marker);
			trust(parent, child);

			const noGit = newThreadId();
			writeRollout(noGit, child);
			const a = new RealCodex("agentpulse-supervisor");
			await a.open();
			expect(
				(await a.call("thread/resume", { threadId: noGit, excludeTurns: true, ...OVERRIDES }))
					.result.sandbox,
			).toEqual(WORKSPACE_WRITE);
			await Bun.sleep(1200);
			expect(existsSync(marker)).toBe(false);
			a.kill();

			mkdirSync(join(parent, ".git"), { recursive: true });
			spawnSync("git", ["init", "-q", parent], { encoding: "utf8" });
			const withGit = newThreadId();
			writeRollout(withGit, child);
			const b = new RealCodex("agentpulse-supervisor");
			await b.open();
			const layered = await b.call("thread/resume", {
				threadId: withGit,
				excludeTurns: true,
				...OVERRIDES,
			});
			expect(layered.result.sandbox.writableRoots).toEqual([join(scratch, "extra-root")]);
			b.kill();
			untrust();
			rmSync(marker, { force: true });
		},
	);

	real(
		"thread/read alone, in a trusted hostile directory, starts no MCP server and never opens a FIFO where the config file would be",
		async () => {
			const marker = join(scratch, "read-marker");
			const hostile = join(scratch, "hostile-read");
			hostileConfig(hostile, marker);
			const fifoDir = join(scratch, "fifo-read");
			mkdirSync(join(fifoDir, ".codex"), { recursive: true });
			spawnSync("mkfifo", [join(fifoDir, ".codex", "config.toml")]);
			trust(hostile, fifoDir);

			const hostileId = newThreadId();
			writeRollout(hostileId, hostile);
			const fifoId = newThreadId();
			writeRollout(fifoId, fifoDir);
			const codex = new RealCodex("agentpulse-supervisor");
			await codex.open();
			const read = await codex.call("thread/read", { threadId: hostileId, includeTurns: false });
			expect(read.result.thread.cwd).toBe(hostile);
			// A FIFO opened for reading would block until a writer shows up; call() fails the test on a timeout.
			const fifoRead = await codex.call(
				"thread/read",
				{ threadId: fifoId, includeTurns: false },
				10_000,
			);
			expect(fifoRead.result.thread.cwd).toBe(fifoDir);
			await Bun.sleep(2500);
			expect(existsSync(marker)).toBe(false);
			codex.kill();
			untrust();
		},
	);

	real(
		"the recorded fixture still equals a real Codex: key sets, sandbox shapes, error shapes and field types",
		async () => {
			const id = newThreadId();
			writeRollout(id, join(scratch, "work"));
			const id2 = newThreadId();
			writeRollout(id2, join(scratch, "work"));
			const codex = new RealCodex("agentpulse-supervisor");
			await codex.open();
			const read = (await codex.call("thread/read", { threadId: id, includeTurns: false })).result;
			const resumed = (
				await codex.call("thread/resume", { threadId: id, excludeTurns: true, ...OVERRIDES })
			).result;
			const readOnly = (
				await codex.call("thread/resume", {
					threadId: id2,
					excludeTurns: true,
					sandbox: "read-only",
				})
			).result;
			const notLoaded = (
				await codex.call("thread/read", {
					threadId: "01a1aaff-0000-7000-8000-000000000000",
					includeTurns: false,
				})
			).error;
			const noRollout = (
				await codex.call("thread/resume", {
					threadId: "01a1aaff-0000-7000-8000-000000000000",
					excludeTurns: true,
				})
			).error;
			codex.kill();

			expect(keys(read)).toEqual(RECORDED.read.keys);
			expect(keys(read.thread)).toEqual(RECORDED.read.threadKeys);
			expect(keys(resumed)).toEqual(RECORDED.resume.keys);
			expect(keys(resumed.thread)).toEqual(RECORDED.resume.threadKeys);
			expect(keys(resumed.thread.status)).toEqual(RECORDED.resume.statusKeys);
			expect(keys(resumed.thread.environments[0])).toEqual(RECORDED.resume.environmentKeys);
			expect(resumed.sandbox).toEqual(RECORDED.sandbox.workspaceWrite);
			expect(readOnly.sandbox).toEqual(RECORDED.sandbox.readOnly);
			expect(keys(notLoaded)).toEqual(RECORDED.errors.notLoaded.keys);
			expect(keys(noRollout)).toEqual(RECORDED.errors.noRollout.keys);
			expect({
				"thread.id": typeOf(read.thread.id),
				"thread.cwd": typeOf(read.thread.cwd),
				"thread.originator": typeOf(read.thread.originator),
				"thread.status.type": typeOf(read.thread.status.type),
				"result.approvalPolicy": typeOf(resumed.approvalPolicy),
				"result.sandbox": typeOf(resumed.sandbox),
				"result.sandbox.type": typeOf(resumed.sandbox.type),
				"result.cwd": typeOf(resumed.cwd),
			}).toEqual(RECORDED.types);
		},
	);

	real(
		"the fake's answers have the same key sets as the real ones (the fixture-based test needs no binary; this ties the fake to the real thing directly)",
		async () => {
			const id = newThreadId();
			writeRollout(id, join(scratch, "work"));
			const codex = new RealCodex("agentpulse-supervisor");
			await codex.open();
			const realRead = (await codex.call("thread/read", { threadId: id, includeTurns: false }))
				.result;
			const realResume = (
				await codex.call("thread/resume", { threadId: id, excludeTurns: true, ...OVERRIDES })
			).result;
			codex.kill();

			const fakeDir = mkdtempSync(join(scratch, "fake-"));
			const executable = installFakeCodex(fakeDir);
			const child = spawn(executable, ["app-server"], {
				env: {
					...process.env,
					FAKE_CODEX_VERSION: "0.163.0",
					FAKE_CODEX_THREAD_ID: id,
					FAKE_CODEX_THREAD_CWD: join(scratch, "work"),
				},
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
					if (m.id !== undefined && m.method === undefined) answers.set(m.id, m);
				}
			});
			const ask = async (n: number, method: string, params: unknown) => {
				child.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`);
				for (let i = 0; i < 100 && !answers.has(n); i++) await Bun.sleep(20);
				if (!answers.has(n)) throw new Error(`the fake didn't answer ${method}`);
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
			expect(keys(fakeRead)).toEqual(keys(realRead));
			expect(keys(fakeRead.thread)).toEqual(keys(realRead.thread));
			expect(keys(fakeResume)).toEqual(keys(realResume));
			expect(keys(fakeResume.thread)).toEqual(keys(realResume.thread));
			expect(keys(fakeResume.sandbox)).toEqual(keys(realResume.sandbox));
		},
	);
});
