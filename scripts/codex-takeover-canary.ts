/**
 * The live canary for taking a Codex session over and resuming one (AGEN-115, phase 5). Driven from
 * `codex-approvals-live.ts --real --only bind-codex,recover-codex,bind-codex-daemon,bind-codex-directory`.
 * It never runs in CI and spends real model usage.
 *
 * Every scenario: a real Codex under the run's throwaway CODEX_HOME, the real routes, the real report gate and
 * the real supervisor resumer; no terminal UI; nothing is killed but this run's own children and processes whose
 * environment names this run's exact CODEX_HOME (`lib/codex-own-pids.ts`). A precondition that doesn't hold
 * reports `instrumentInvalid` and is a failure of its own kind, so a scenario can't pass by measuring nothing.
 * Each claim has a control or a mutation that must make it fail (`--mutate <name>`; see `MUTATIONS`).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { runCodex, startCodex } from "./lib/codex-canary-spawn.js";
import { ownCodexPids } from "./lib/codex-own-pids.js";

export const TAKEOVER_SCENARIO_IDS = [
	"bind-codex",
	"recover-codex",
	"bind-codex-daemon",
	"bind-codex-directory",
] as const;

/** `--mutate`: each one breaks the thing a scenario claims, and the scenario must then fail. */
export const MUTATIONS = {
	"drop-overrides": "bind-codex: thread/resume is sent with no approval or sandbox overrides",
	"fresh-thread": "bind-codex: thread/resume is replaced by thread/start (a new conversation)",
	"takeover-values":
		"recover-codex: thread/resume carries the takeover's privileges, not the launch's",
	"no-daemon": "bind-codex-daemon: the daemon is never started, so nothing holds the thread",
	"no-comparison":
		"bind-codex-directory: the host's directory comparison is skipped (the candidate is trusted)",
} as const;

// biome-ignore lint/suspicious/noExplicitAny: the script talks to the server's rows and the DTOs loosely
type Any = any;

export interface CanaryCtx {
	root: string;
	home: string;
	codexHome: string;
	base: string;
	supervisorId: string;
	hostName: string;
	gate: Any;
	request: (path: string, options?: RequestInit) => Promise<Any>;
	managed: Any;
	getDb: () => Any;
	t: Record<string, Any>;
	eq: Any;
	and: Any;
	desc: Any;
	personHeaders: () => Promise<Headers>;
	until: <T>(what: string, ms: number, fn: () => Promise<T | undefined | false> | T) => Promise<T>;
	expect: (name: string, ok: unknown, detail?: unknown) => void;
	childGroups: Set<number>;
	sessions: string[];
	intervals: Array<ReturnType<typeof setInterval>>;
	mutate: string | null;
	holdMinutes: number;
	onlyHome: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MINUTE = 60_000;

// ── Codex helpers ───────────────────────────────────────────────────────────

function codexOptions(ctx: CanaryCtx, cwd: string, codexHome = ctx.codexHome) {
	return { codexHome, home: ctx.home, cwd, timeoutMs: 4 * MINUTE };
}

function findRollout(codexHome: string, threadId: string): string | null {
	const walk = (dir: string): string | null => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				const found = walk(full);
				if (found) return found;
			} else if (entry.name.endsWith(`-${threadId}.jsonl`)) return full;
		}
		return null;
	};
	const sessionsDir = join(codexHome, "sessions");
	return existsSync(sessionsDir) ? walk(sessionsDir) : null;
}

const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter(Boolean);

function rolloutPolicies(path: string): Array<{ approval: unknown; sandbox: unknown }> {
	return lines(path)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((entry) => entry?.type === "turn_context")
		.map((entry) => ({
			approval: entry.payload?.approval_policy,
			sandbox: entry.payload?.sandbox_policy?.type ?? entry.payload?.sandbox_policy,
		}));
}

/** One `codex exec` turn that creates a thread under the throwaway home. Returns its id, or why not. */
function makeThread(
	ctx: CanaryCtx,
	dir: string,
	prompt: string,
	bypass: boolean,
): { threadId: string | null; why?: string; rollout: string | null } {
	mkdirSync(dir, { recursive: true });
	if (!existsSync(join(dir, ".git"))) spawnSync("git", ["init", "-q"], { cwd: dir });
	const run = runCodex(
		[
			"exec",
			"--json",
			"--skip-git-repo-check",
			...(bypass ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
			prompt,
		],
		codexOptions(ctx, dir),
	);
	let threadId: string | null = null;
	for (const line of (run.stdout ?? "").split("\n")) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
				threadId = parsed.thread_id;
			}
		} catch {}
	}
	if (!threadId) {
		return {
			threadId: null,
			why: `exec gave no thread (exit ${run.status}): ${(run.stderr ?? "").slice(-300)}`,
			rollout: null,
		};
	}
	return { threadId, rollout: findRollout(ctx.codexHome, threadId) };
}

interface StdioAnswer {
	ok: boolean;
	result?: Any;
	error?: string;
}

/** A throwaway stdio `codex app-server`: initialize, one `thread/resume`, gone. A refused resume appends nothing. */
async function stdioResume(
	ctx: CanaryCtx,
	threadId: string,
	codexHome: string,
	params: Record<string, unknown> = {},
): Promise<StdioAnswer> {
	const child = startCodex(["app-server"], codexOptions(ctx, ctx.root, codexHome));
	let buffer = "";
	const waiting = new Map<number, (value: Any) => void>();
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			try {
				const message = JSON.parse(line);
				if (typeof message.id === "number") waiting.get(message.id)?.(message);
			} catch {}
		}
	});
	child.stderr?.on("data", () => {});
	child.stdin?.on("error", () => {});
	const call = (id: number, method: string, body: unknown) =>
		new Promise<Any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
			waiting.set(id, (value) => {
				clearTimeout(timer);
				resolve(value);
			});
			child.stdin?.write(`${JSON.stringify({ id, method, params: body })}\n`);
		});
	try {
		await call(1, "initialize", {
			clientInfo: { name: "canary-probe", title: "canary-probe", version: "0" },
			capabilities: { experimentalApi: true },
		});
		const answer = await call(2, "thread/resume", { threadId, excludeTurns: true, ...params });
		return answer.error
			? { ok: false, error: String(answer.error.message ?? answer.error) }
			: { ok: true, result: answer.result };
	} catch (error) {
		return { ok: false, error: String(error) };
	} finally {
		try {
			child.stdin?.end();
		} catch {}
		await sleep(300);
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}
	}
}

// ── A minimal WebSocket client over the daemon's unix socket ────────────────

function wsFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	const mask = randomBytes(4);
	const head: number[] = [0x81];
	if (payload.length < 126) head.push(0x80 | payload.length);
	else if (payload.length < 65536) head.push(0x80 | 126, payload.length >> 8, payload.length & 255);
	else throw new Error("frame too large for this client");
	const masked = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] as number)));
	return Buffer.concat([Buffer.from(head), mask, masked]);
}

/** Connects to the daemon's control socket, runs initialize and a plain thread/resume, and leaves. */
async function daemonResume(ctx: CanaryCtx, threadId: string): Promise<StdioAnswer> {
	const dir = join(ctx.codexHome, "app-server-control");
	const previous = process.cwd();
	process.chdir(dir);
	const socket = net.connect({ path: "app-server-control.sock" });
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", () => {
				process.chdir(previous);
				resolve();
			});
			socket.once("error", (error) => {
				process.chdir(previous);
				reject(error);
			});
		});
		let chunks = Buffer.alloc(0);
		let upgraded = false;
		const messages: Any[] = [];
		const waiters: Array<() => void> = [];
		socket.on("data", (data) => {
			chunks = Buffer.concat([chunks, data]);
			if (!upgraded) {
				const end = chunks.indexOf("\r\n\r\n");
				if (end < 0) return;
				upgraded = chunks.subarray(0, end).toString().startsWith("HTTP/1.1 101");
				chunks = chunks.subarray(end + 4);
				if (!upgraded) return;
			}
			for (;;) {
				if (chunks.length < 2) return;
				const opcode = (chunks[0] as number) & 15;
				let length = (chunks[1] as number) & 127;
				let offset = 2;
				if (length === 126) {
					if (chunks.length < 4) return;
					length = chunks.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (chunks.length < 10) return;
					length = Number(chunks.readBigUInt64BE(2));
					offset = 10;
				}
				if (chunks.length < offset + length) return;
				const body = chunks.subarray(offset, offset + length);
				chunks = chunks.subarray(offset + length);
				if (opcode === 1) {
					try {
						messages.push(JSON.parse(body.toString("utf8")));
					} catch {}
					for (const waiter of waiters.splice(0)) waiter();
				}
			}
		});
		socket.write(
			`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		const reply = async (id: number): Promise<Any> => {
			const deadline = Date.now() + 30_000;
			for (;;) {
				const found = messages.find((m) => m.id === id);
				if (found) return found;
				if (Date.now() > deadline) throw new Error(`no answer to ${id}`);
				await new Promise<void>((resolve) => {
					waiters.push(resolve);
					setTimeout(resolve, 500);
				});
			}
		};
		await sleep(300);
		if (!upgraded) return { ok: false, error: "the control socket didn't upgrade" };
		socket.write(
			wsFrame(
				JSON.stringify({
					id: 1,
					method: "initialize",
					params: {
						clientInfo: { name: "canary-ws", title: "canary-ws", version: "0" },
						capabilities: { experimentalApi: true },
					},
				}),
			),
		);
		await reply(1);
		socket.write(wsFrame(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId } })));
		const answer = await reply(2);
		return answer.error
			? { ok: false, error: String(answer.error.message ?? answer.error) }
			: { ok: true, result: answer.result };
	} catch (error) {
		return { ok: false, error: String(error) };
	} finally {
		socket.destroy();
	}
}

// ── Server-side helpers ─────────────────────────────────────────────────────

function insertObserved(ctx: CanaryCtx, threadId: string, cwd: string, name: string) {
	ctx.sessions.push(threadId);
	return ctx
		.getDb()
		.insert(ctx.t.sessions)
		.values({
			sessionId: threadId,
			agentType: "codex_cli",
			cwd,
			displayName: name,
			lastActivityAt: new Date(Date.now() - 2 * 60 * MINUTE).toISOString(),
			isWorking: false,
			status: "idle",
		});
}

async function actionFor(ctx: CanaryCtx, sessionId: string, type: string) {
	const rows = await ctx
		.getDb()
		.select()
		.from(ctx.t.controlActions)
		.where(
			ctx.and(
				ctx.eq(ctx.t.controlActions.sessionId, sessionId),
				ctx.eq(ctx.t.controlActions.actionType, type),
			),
		)
		.orderBy(ctx.desc(ctx.t.controlActions.createdAt));
	return rows[0] as Any;
}

async function post(ctx: CanaryCtx, path: string, body?: unknown) {
	const res = await fetch(`${ctx.base}/api/v1${path}`, {
		method: "POST",
		headers: await ctx.personHeaders(),
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: res.status, body: (await res.json().catch(() => null)) as Any };
}

/** Takes the session over (or resumes it) and waits for the host to settle the action. */
async function settle(ctx: CanaryCtx, sessionId: string, kind: "bind" | "resume") {
	const sent =
		kind === "bind"
			? await post(ctx, `/sessions/${sessionId}/bind`, {
					targetSupervisorId: ctx.supervisorId,
					sameMachineConfirmed: true,
				})
			: await post(ctx, `/sessions/${sessionId}/resume`);
	if (sent.status !== 202) return { sent, action: null as Any };
	const action = await ctx
		.until(`the ${kind} action to settle`, 150_000, async () => {
			const row = await actionFor(ctx, sessionId, "resume");
			return row && (row.status === "succeeded" || row.status === "failed") ? row : undefined;
		})
		.catch(() => actionFor(ctx, sessionId, "resume"));
	return { sent, action };
}

const managedRow = async (ctx: CanaryCtx, sessionId: string) =>
	(
		await ctx
			.getDb()
			.select()
			.from(ctx.t.managedSessions)
			.where(ctx.eq(ctx.t.managedSessions.sessionId, sessionId))
	)[0] as Any;
const sessionRow = async (ctx: CanaryCtx, sessionId: string) =>
	(
		await ctx
			.getDb()
			.select()
			.from(ctx.t.sessions)
			.where(ctx.eq(ctx.t.sessions.sessionId, sessionId))
	)[0] as Any;

/** What every resume the host sends answers, for the "exactly these values" claims. */
interface Wire {
	resumes: Array<{ params: Any; result?: Any; error?: string }>;
	turnStarts: Any[];
}

function installTap(ctx: CanaryCtx, rpc: Any): { wire: Wire; restore: () => void } {
	const wire: Wire = { resumes: [], turnStarts: [] };
	const proto = rpc.RpcClient.prototype as Any;
	const original = proto.request;
	proto.request = function (method: string, params: Any, ...rest: Any[]) {
		let sent = params;
		if (method === "thread/resume" && ctx.mutate === "drop-overrides") {
			sent = { threadId: params.threadId, excludeTurns: params.excludeTurns };
		}
		if (method === "thread/resume" && ctx.mutate === "takeover-values") {
			sent = { ...params, approvalPolicy: "untrusted", sandbox: "workspace-write" };
		}
		if (method === "thread/resume" && ctx.mutate === "fresh-thread") {
			return original.call(
				this,
				"thread/start",
				{
					cwd: params.cwd ?? undefined,
					experimentalRawEvents: false,
					persistExtendedHistory: true,
					sessionStartSource: "startup",
				},
				...rest,
			);
		}
		if (method === "turn/start") wire.turnStarts.push(JSON.parse(JSON.stringify(params)));
		const promise = original.call(this, method, sent, ...rest) as Promise<Any>;
		if (method === "thread/resume") {
			const entry: Wire["resumes"][number] = { params: JSON.parse(JSON.stringify(sent)) };
			wire.resumes.push(entry);
			promise.then(
				(result) => {
					entry.result = {
						approvalPolicy: result?.approvalPolicy,
						sandbox: result?.sandbox,
						threadId: result?.thread?.id,
						cwd: result?.cwd ?? result?.thread?.cwd,
					};
				},
				(error) => {
					entry.error = String(error?.message ?? error).slice(0, 200);
				},
			);
		}
		return promise;
	};
	return {
		wire,
		restore: () => {
			proto.request = original;
		},
	};
}

/** The supervisor's control loop with the real resumer: claim over HTTP, hand to the real handler. */
async function startPump(ctx: CanaryCtx): Promise<void> {
	const { createControlActionHandler } = await import("../src/supervisor/control-actions.js");
	const { createSessionResumer, resolveNeutralCwd } = await import(
		"../src/supervisor/services/session-resume.js"
	);
	const { createManagedThreadRecord } = await import(
		"../src/supervisor/services/managed-thread-record.js"
	);
	const claude = await import("../src/supervisor/providers/claude.js");
	const { executeCleanupWorkArea } = await import("../src/supervisor/services/cleanup-workarea.js");
	const record = createManagedThreadRecord({
		path: join(ctx.home, ".agentpulse", "managed-threads.json"),
	});
	(ctx as Any).record = record;
	const resumeSession = createSessionResumer({
		gate: ctx.gate,
		hostName: ctx.hostName,
		trustedRoots: [ctx.root],
		record,
		hold: new Set<string>(),
		neutralCwd: () => resolveNeutralCwd(ctx.home),
		providers: {
			managedCodexRuntimeHolds: ctx.managed.managedCodexRuntimeHolds,
			resumeManagedCodexSession: ctx.managed.resumeManagedCodexSession,
		},
	});
	const handler = createControlActionHandler({
		gate: ctx.gate,
		trustedRoots: [ctx.root],
		providers: {
			stopManagedCodexSession: ctx.managed.stopManagedCodexSession,
			promptManagedCodexSession: ctx.managed.promptManagedCodexSession,
			hasManagedCodexRuntime: ctx.managed.hasManagedCodexRuntime,
			promptClaudeHeadlessSession: claude.promptClaudeHeadlessSession,
			promptClaudeInteractiveSession: claude.promptClaudeInteractiveSession,
		},
		executeCleanupWorkArea,
		resumeSession,
	});
	let pumping = false;
	ctx.intervals.push(
		setInterval(() => {
			if (pumping) return;
			pumping = true;
			void (async () => {
				try {
					const result = (await ctx.request(
						`/supervisors/${ctx.supervisorId}/control-actions/claim`,
						{ method: "POST" },
					)) as { action: Any | null };
					if (result.action) await handler(result.action);
				} catch (error) {
					console.error("[takeover] control loop:", String(error));
				} finally {
					pumping = false;
				}
			})();
		}, 700),
	);
}

const approvalRows = async (ctx: CanaryCtx, sessionId: string) =>
	(await ctx
		.getDb()
		.select()
		.from(ctx.t.codexApprovals)
		.where(ctx.eq(ctx.t.codexApprovals.sessionId, sessionId))) as Any[];

async function sendPrompt(ctx: CanaryCtx, sessionId: string, text: string) {
	return post(ctx, `/sessions/${sessionId}/prompt`, { prompt: text });
}

async function assistantSaid(
	ctx: CanaryCtx,
	sessionId: string,
	needle: string,
	since: number,
): Promise<boolean> {
	const rows = (await ctx
		.getDb()
		.select()
		.from(ctx.t.events)
		.where(ctx.eq(ctx.t.events.sessionId, sessionId))) as Any[];
	return rows.some(
		(row) =>
			row.category === "assistant_message" &&
			String(row.content ?? "").includes(needle) &&
			Date.parse(
				`${String(row.createdAt).replace(" ", "T")}${String(row.createdAt).includes("Z") ? "" : "Z"}`,
			) >= since,
	);
}

function treeListeners(pids: number[]): string {
	if (pids.length === 0) return "";
	return spawnSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")], {
		encoding: "utf8",
	}).stdout.trim();
}

/** Answers the next approval for a session: waits for the row, decides it, waits for it to close. */
async function answerNext(
	ctx: CanaryCtx,
	sessionId: string,
	decision: "accept" | "decline",
	seen: Set<string>,
) {
	const row = (await ctx.until("an approval request", 180_000, async () =>
		(await approvalRows(ctx, sessionId)).find((r) => !seen.has(r.id) && r.status === "pending"),
	)) as Any;
	seen.add(row.id);
	const detail = (await (
		await fetch(`${ctx.base}/api/v1/sessions/${sessionId}/approvals/${row.id}`, {
			headers: await ctx.personHeaders(),
		})
	).json()) as Any;
	const res = await post(ctx, `/sessions/${sessionId}/approvals/${row.id}/decision`, {
		decision,
		...(decision === "accept"
			? { presentationHash: detail.presentationHash ?? row.presentationHash }
			: {}),
	});
	await ctx.until("the row to close", 90_000, async () =>
		(await approvalRows(ctx, sessionId)).find((r) => r.id === row.id && r.status === "closed"),
	);
	return {
		shownCwd: detail.presentation?.cwd as string | undefined,
		command: detail.presentation?.command as string | undefined,
		answerStatus: res.status,
	};
}

// ── The scenarios ───────────────────────────────────────────────────────────

const TAKEOVER_POLICY = { approvalPolicy: "untrusted", sandboxType: "workspaceWrite" } as const;

async function bindCodex(ctx: CanaryCtx, tap: { wire: Wire }): Promise<Record<string, Any>> {
	const out: Record<string, Any> = {};
	const dir = join(ctx.root, "project-bind-codex");
	const sentinel = `SENT${randomBytes(3).toString("hex")}`;
	const made = makeThread(
		ctx,
		dir,
		`Remember the code word ${sentinel}. First run exactly this one shell command: touch pre-touch.txt   Then reply with only the word ready.`,
		true,
	);
	if (!made.threadId || !made.rollout)
		return { instrumentInvalid: `no thread: ${made.why ?? "no rollout"}` };
	const threadId = made.threadId;
	out.threadId = threadId;
	const policies = rolloutPolicies(made.rollout);
	out.recordedPolicies = policies;
	out.preTouchRan = existsSync(join(dir, "pre-touch.txt"));
	if (
		!out.preTouchRan ||
		!policies.some((p) => p.approval === "never" && p.sandbox === "danger-full-access")
	) {
		return {
			...out,
			instrumentInvalid:
				"the first turn wasn't run wide (no touch, or the rollout isn't never/danger-full-access)",
		};
	}

	// The control: a no-override resume on a COPY of the home answers the wide pair (overrides and settings persist).
	const copy = join(ctx.root, "codex-home-probe");
	mkdirSync(copy, { recursive: true });
	for (const name of [
		"sessions",
		"state_5.sqlite",
		"state_5.sqlite-wal",
		"state_5.sqlite-shm",
		"config.toml",
		"auth.json",
	]) {
		if (existsSync(join(ctx.codexHome, name)))
			cpSync(join(ctx.codexHome, name), join(copy, name), { recursive: true });
	}
	// No credential goes into the copy: a resume reads the rollout, it doesn't call the model.
	const probe = await stdioResume(ctx, threadId, copy);
	rmSync(copy, { recursive: true, force: true });
	out.controlNoOverrideResume = probe.ok
		? { approvalPolicy: probe.result?.approvalPolicy, sandbox: probe.result?.sandbox }
		: { error: probe.error };
	const wide = probe.ok && probe.result?.approvalPolicy === "never";
	if (!wide)
		return {
			...out,
			instrumentInvalid:
				"a resume with no overrides didn't answer the wide policy, so a narrowing can't be told from the thread's own",
		};

	await insertObserved(ctx, threadId, dir, "canary takeover");
	const { sent, action } = await settle(ctx, threadId, "bind");
	out.bindStatus = sent.status;
	out.bindBody = sent.body;
	out.action = action ? { status: action.status, error: action.error } : null;
	const last = tap.wire.resumes[tap.wire.resumes.length - 1];
	out.resumeSent = last?.params;
	out.resumeAnswered = last?.result ?? { error: last?.error };
	ctx.expect("bind-codex: the takeover was accepted", sent.status === 202, sent);
	ctx.expect("bind-codex: the resume action succeeded", action?.status === "succeeded", action);
	ctx.expect(
		"bind-codex: the answer is exactly untrusted / workspace-write",
		last?.result?.approvalPolicy === TAKEOVER_POLICY.approvalPolicy &&
			JSON.stringify(last?.result?.sandbox ?? "").includes("workspaceWrite"),
		last,
	);
	if (action?.status !== "succeeded") return out;
	const row = await managedRow(ctx, threadId);
	const session = await sessionRow(ctx, threadId);
	out.afterBind = {
		managedState: row?.managedState,
		providerSyncError: row?.providerSyncError,
		affinity: row?.hostAffinityReason,
		endedAt: session?.endedAt,
		providerThreadId: row?.providerThreadId,
	};
	ctx.expect(
		"bind-codex: managed, no sync error, not ended, on the same thread",
		row?.managedState === "managed" &&
			row?.providerSyncError == null &&
			session?.endedAt == null &&
			row?.providerThreadId === threadId,
		out.afterBind,
	);

	// Same conversation: the sentinel from the first turn comes back on thread id = session id.
	const t0 = Date.now() - 1000;
	await sendPrompt(
		ctx,
		threadId,
		"What was the code word I asked you to remember? Reply with only that word. Do not run any command.",
	);
	const recalled = await ctx
		.until(
			"the sentinel",
			150_000,
			async () => (await assistantSaid(ctx, threadId, sentinel, t0)) || undefined,
		)
		.catch(() => false);
	out.sentinelRecalled = Boolean(recalled);
	ctx.expect(
		"bind-codex: a prompt recalls the first turn's sentinel (same conversation)",
		recalled,
	);
	const turn = tap.wire.turnStarts[tap.wire.turnStarts.length - 1];
	out.turnStartThreadId = turn?.threadId;
	ctx.expect(
		"bind-codex: turn/start names the session id as its thread",
		turn?.threadId === threadId,
		turn,
	);

	// The narrowing holds in behaviour: a plain touch (which the wide policy ran unasked) now asks.
	const seen = new Set<string>();
	await sendPrompt(
		ctx,
		threadId,
		"Run exactly this one shell command and then stop. Do not do anything else: touch narrowed-declined.txt",
	);
	const declined = await answerNext(ctx, threadId, "decline", seen).catch(
		(error) => ({ error: String(error) }) as Any,
	);
	out.declined = declined;
	await sleep(15_000);
	out.declinedFileExists = existsSync(join(dir, "narrowed-declined.txt"));
	ctx.expect(
		"bind-codex: after the takeover a plain touch asks for approval",
		!declined.error,
		declined,
	);
	ctx.expect(
		"bind-codex: the shown directory is the thread's",
		!declined.shownCwd || realpathSync(declined.shownCwd) === realpathSync(dir),
		declined,
	);
	ctx.expect("bind-codex: declining leaves no file", !out.declinedFileExists);
	await sendPrompt(
		ctx,
		threadId,
		"Run exactly this one shell command and then stop. Do not do anything else: touch narrowed-accepted.txt",
	);
	const accepted = await answerNext(ctx, threadId, "accept", seen).catch(
		(error) => ({ error: String(error) }) as Any,
	);
	await sleep(10_000);
	out.acceptedFileExists = existsSync(join(dir, "narrowed-accepted.txt"));
	ctx.expect(
		"bind-codex: accepting creates the file",
		!accepted.error && out.acceptedFileExists,
		accepted,
	);

	// Stop leaves nothing: control that the tree existed before.
	const before = ownCodexPids(ctx.codexHome);
	const listeners = treeListeners(before);
	out.beforeStop = { ownCodexProcesses: before.length, tcpListeners: listeners || "none" };
	ctx.expect("bind-codex: the tree existed before Stop (the control)", before.length > 0);
	ctx.expect("bind-codex: no TCP listener while running", listeners === "", listeners);
	await post(ctx, `/sessions/${threadId}/stop`);
	await sleep(3000);
	const after = ownCodexPids(ctx.codexHome);
	out.afterStop = { ownCodexProcesses: after.length };
	ctx.expect("bind-codex: Stop leaves no process of this run's", after.length === 0, after);
	return out;
}

async function recoverCodex(ctx: CanaryCtx, tap: { wire: Wire }): Promise<Record<string, Any>> {
	const out: Record<string, Any> = {};
	const dir = join(ctx.root, "project-recover-codex");
	mkdirSync(dir, { recursive: true });
	spawnSync("git", ["init", "-q"], { cwd: dir });
	const sentinel = `RECV${randomBytes(3).toString("hex")}`;
	const sessionId = crypto.randomUUID();
	ctx.sessions.push(sessionId);
	// default approval (Codex's own) and read-only: neither the takeover's pair nor the thread's wide one.
	await ctx
		.getDb()
		.insert(ctx.t.launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "codex_cli",
			cwd: dir,
			requestedSupervisorId: ctx.supervisorId,
			requestedLaunchMode: "managed_codex",
			status: "validated",
			approvalPolicy: "default",
			sandboxMode: "read-only",
			baseInstructions: "",
			taskPrompt: `Remember the code word ${sentinel}. Reply with only the word ready. Do not run any command.`,
		});
	const claim = await ctx.request(`/supervisors/${ctx.supervisorId}/launches/claim`, {
		method: "POST",
	});
	const launch = (claim as Any).launchRequest;
	ctx.gate.noteLaunch(launch.id, launch.launchCorrelationId, launch.cwd);
	const started = await ctx.managed.launchManagedCodexRequest(launch, {
		reportState: (body: Any) => ctx.gate.reportState(body),
		reportEvents: (batch: Any) => ctx.gate.reportEvents(sessionId, batch),
		// What the supervisor's own launch does: the thread is recorded before the first report names it.
		recordThread: (launchId: string, threadId: string) => {
			out.recordedThread = threadId;
			(ctx as Any).record.write(launchId, threadId);
		},
	});
	ctx.childGroups.add(started.pid);
	const launchResume = tap.wire.resumes.length;
	await ctx
		.until(
			"the launch turn",
			150_000,
			async () => (await assistantSaid(ctx, sessionId, "ready", 0)) || undefined,
		)
		.catch(() => {});
	const first = await managedRow(ctx, sessionId);
	out.launched = { managedState: first?.managedState, threadId: first?.providerThreadId };
	if (!first?.providerThreadId)
		return { ...out, instrumentInvalid: "the launch never produced a thread" };

	// The host's process dies: SIGKILL its group, and forget it the way a restart does.
	try {
		process.kill(-started.pid, "SIGKILL");
	} catch {}
	await sleep(1500);
	await ctx.managed.disposeAllManagedCodexRuntimes().catch(() => {});
	// The server learns the host restarted: the same host registers again.
	const enrolled = await fetch(`${ctx.base}/api/v1/admin/supervisors/enroll`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${(ctx as Any).manageKey}`,
		},
		body: JSON.stringify({ name: ctx.hostName, supervisorId: ctx.supervisorId }),
	});
	const { token } = (await enrolled.json()) as { token: string };
	const registered = await fetch(`${ctx.base}/api/v1/supervisors/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: ctx.hostName,
			platform: "macos",
			arch: "arm64",
			version: "1.0.0",
			enrollmentToken: token,
			capabilities: (ctx as Any).capabilities,
			trustedRoots: [ctx.root],
		}),
	});
	out.reRegisterStatus = registered.status;
	if (registered.ok) {
		const body = (await registered.json()) as Any;
		(ctx as Any).adoptCredential?.(body.supervisorCredential, body.supervisor.id);
	}
	const degraded = await ctx
		.until("the session to read degraded", 30_000, async () => {
			const row = await managedRow(ctx, sessionId);
			return row?.managedState === "degraded" ? row : undefined;
		})
		.catch(() => null);
	if (!degraded)
		return {
			...out,
			instrumentInvalid: "the session didn't read degraded after the host restarted",
		};

	const { sent, action } = await settle(ctx, sessionId, "resume");
	out.resumeStatus = sent.status;
	out.action = action ? { status: action.status, error: action.error } : null;
	const last = tap.wire.resumes[tap.wire.resumes.length - 1];
	out.resumeSent = last?.params;
	out.resumeAnswered = last?.result ?? { error: last?.error };
	out.resumesSinceLaunch = tap.wire.resumes.length - launchResume;
	ctx.expect(
		"recover-codex: the resume was accepted and succeeded",
		sent.status === 202 && action?.status === "succeeded",
		{ sent, action },
	);
	ctx.expect(
		"recover-codex: the launch's own read-only sandbox, not the takeover's",
		JSON.stringify(last?.result?.sandbox ?? "").includes("readOnly"),
		last,
	);
	if (action?.status !== "succeeded") return out;
	const row = await managedRow(ctx, sessionId);
	const session = await sessionRow(ctx, sessionId);
	out.after = {
		managedState: row?.managedState,
		providerSyncError: row?.providerSyncError,
		endedAt: session?.endedAt,
		providerThreadId: row?.providerThreadId,
	};
	ctx.expect(
		"recover-codex: managed, no sync error, not ended, same thread",
		row?.managedState === "managed" &&
			row?.providerSyncError == null &&
			session?.endedAt == null &&
			row?.providerThreadId === first.providerThreadId,
		out.after,
	);
	const t0 = Date.now() - 1000;
	await sendPrompt(
		ctx,
		sessionId,
		"What was the code word I asked you to remember? Reply with only that word. Do not run any command.",
	);
	const recalled = await ctx
		.until(
			"the sentinel",
			150_000,
			async () => (await assistantSaid(ctx, sessionId, sentinel, t0)) || undefined,
		)
		.catch(() => false);
	out.sentinelRecalled = Boolean(recalled);
	ctx.expect("recover-codex: a prompt recalls the sentinel on the same thread", recalled);
	await post(ctx, `/sessions/${sessionId}/stop`);
	await sleep(2000);
	return out;
}

async function bindCodexDirectory(
	ctx: CanaryCtx,
	tap: { wire: Wire },
): Promise<Record<string, Any>> {
	const out: Record<string, Any> = {};
	const ok = "Reply with only the word ok. Do not run any command.";

	// 1. A candidate that is not the thread's directory: cwd_mismatch, and no resume was issued.
	const x = join(ctx.root, "dir-x");
	const y = join(ctx.root, "dir-y");
	mkdirSync(y, { recursive: true });
	const t1 = makeThread(ctx, x, ok, false);
	if (!t1.threadId || !t1.rollout)
		return { instrumentInvalid: `no thread: ${t1.why ?? "no rollout"}` };
	const before = lines(t1.rollout).length;
	await insertObserved(ctx, t1.threadId, ctx.mutate === "no-comparison" ? x : y, "mismatch");
	const resumesBefore = tap.wire.resumes.length;
	const mismatch = await settle(ctx, t1.threadId, "bind");
	out.mismatch = {
		status: mismatch.sent.status,
		action: mismatch.action && { status: mismatch.action.status, error: mismatch.action.error },
		rolloutLinesBefore: before,
		rolloutLinesAfter: lines(t1.rollout).length,
		resumeRequests: tap.wire.resumes.length - resumesBefore,
	};
	ctx.expect(
		"bind-codex-directory: candidate Y is refused",
		mismatch.action?.status === "failed" &&
			/directory doesn't match|recorded directory/.test(String(mismatch.action?.error)),
		mismatch.action,
	);
	ctx.expect(
		"bind-codex-directory: no resume was issued for Y (rollout unchanged)",
		lines(t1.rollout).length === before && tap.wire.resumes.length === resumesBefore,
		out.mismatch,
	);
	ctx.expect(
		"bind-codex-directory: the refused attempt left no rows",
		!(await managedRow(ctx, t1.threadId)),
	);

	// 2. The thread's own directory passes, and a symlink to it does too.
	const t2 = makeThread(ctx, join(ctx.root, "dir-x2"), ok, false);
	if (t2.threadId) {
		await insertObserved(ctx, t2.threadId, join(ctx.root, "dir-x2"), "plain");
		const pass = await settle(ctx, t2.threadId, "bind");
		out.exact = { status: pass.action?.status, error: pass.action?.error };
		ctx.expect(
			"bind-codex-directory: the thread's own directory passes",
			pass.action?.status === "succeeded",
			pass.action,
		);
		await post(ctx, `/sessions/${t2.threadId}/stop`);
		await sleep(2000);
	}
	const real3 = join(ctx.root, "dir-x3");
	const t3 = makeThread(ctx, real3, ok, false);
	const link = join(ctx.root, "dir-x3-link");
	if (t3.threadId) {
		symlinkSync(real3, link);
		await insertObserved(ctx, t3.threadId, link, "symlink");
		const pass = await settle(ctx, t3.threadId, "bind");
		out.symlink = { status: pass.action?.status, error: pass.action?.error };
		ctx.expect(
			"bind-codex-directory: a symlink to the thread's directory passes",
			pass.action?.status === "succeeded",
			pass.action,
		);
		await post(ctx, `/sessions/${t3.threadId}/stop`);
		await sleep(2000);
	}

	// 3. A hostile project config: a refusal, with nothing run (D7: refused trusted or not).
	const hostile = join(ctx.root, "dir-hostile");
	const t4 = makeThread(ctx, hostile, ok, false);
	if (t4.threadId && t4.rollout) {
		const markers = {
			notify: join(hostile, "marker-notify"),
			mcp: join(hostile, "marker-mcp"),
			roots: join(hostile, "marker-roots"),
		};
		mkdirSync(join(hostile, ".codex"), { recursive: true });
		writeFileSync(
			join(hostile, ".codex", "config.toml"),
			[
				`notify = ["touch", "${markers.notify}"]`,
				`sandbox_workspace_write = { writable_roots = ["${join(ctx.root, "elsewhere")}"] }`,
				"[mcp_servers.canary]",
				`command = "touch"`,
				`args = ["${markers.mcp}"]`,
			].join("\n"),
		);
		const linesBefore = lines(t4.rollout).length;
		await insertObserved(ctx, t4.threadId, hostile, "hostile");
		const refused = await settle(ctx, t4.threadId, "bind");
		await sleep(2000);
		out.hostile = {
			status: refused.action?.status,
			error: refused.action?.error,
			markers: Object.fromEntries(Object.entries(markers).map(([k, v]) => [k, existsSync(v)])),
			rolloutLinesBefore: linesBefore,
			rolloutLinesAfter: lines(t4.rollout).length,
		};
		ctx.expect(
			"bind-codex-directory: a hostile project config is refused",
			refused.action?.status === "failed" &&
				/\.codex\/config\.toml/.test(String(refused.action?.error)),
			refused.action,
		);
		ctx.expect(
			"bind-codex-directory: nothing ran (no marker)",
			!Object.values(out.hostile.markers).some(Boolean),
			out.hostile.markers,
		);
		ctx.expect(
			"bind-codex-directory: the refused attempt appended nothing to the thread",
			out.hostile.rolloutLinesAfter === linesBefore,
			out.hostile,
		);
		ctx.expect(
			"bind-codex-directory: no rows survive the refusal",
			!(await managedRow(ctx, t4.threadId)),
		);
	}

	// 4. A directory with a FIFO as its config: thread/read answers and the mismatch refuses without hanging.
	const fifoDir = join(ctx.root, "dir-fifo");
	const t5 = makeThread(ctx, fifoDir, ok, false);
	if (t5.threadId && t5.rollout) {
		mkdirSync(join(fifoDir, ".codex"), { recursive: true });
		spawnSync("mkfifo", [join(fifoDir, ".codex", "config.toml")]);
		await insertObserved(ctx, t5.threadId, y, "fifo");
		const started = Date.now();
		const refused = await settle(ctx, t5.threadId, "bind");
		out.fifo = {
			status: refused.action?.status,
			error: refused.action?.error,
			ms: Date.now() - started,
		};
		ctx.expect(
			"bind-codex-directory: a FIFO config doesn't hang the refusal",
			refused.action?.status === "failed" && out.fifo.ms < 90_000,
			out.fifo,
		);
	}

	// 5. core.fsmonitor: nothing runs on thread/read (control: git status there does run it).
	const gitDir = join(ctx.root, "dir-fsmonitor");
	const t6 = makeThread(ctx, gitDir, ok, false);
	if (t6.threadId) {
		const marker = join(gitDir, "marker-fsmonitor");
		const hook = join(gitDir, "fsmonitor-hook.sh");
		writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nprintf '\\0'\n`, { mode: 0o755 });
		spawnSync("git", ["config", "core.fsmonitor", hook], { cwd: gitDir });
		spawnSync("git", ["add", "-A"], { cwd: gitDir });
		spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=canary", "commit", "-qm", "x"], {
			cwd: gitDir,
		});
		const clear = () => {
			try {
				require("node:fs").rmSync(marker, { force: true });
			} catch {}
		};
		clear();
		await insertObserved(ctx, t6.threadId, y, "fsmonitor");
		await settle(ctx, t6.threadId, "bind");
		out.fsmonitor = { markerAfterBind: existsSync(marker) };
		clear();
		spawnSync("git", ["status"], { cwd: gitDir });
		out.fsmonitor = { ...out.fsmonitor, markerAfterGitStatus: existsSync(marker) };
		ctx.expect(
			"bind-codex-directory: the fsmonitor control ran (git status touches the marker)",
			out.fsmonitor.markerAfterGitStatus === true,
			out.fsmonitor,
		);
		ctx.expect(
			"bind-codex-directory: no fsmonitor hook ran during the takeover attempt",
			out.fsmonitor.markerAfterBind === false,
			out.fsmonitor,
		);
	}

	// 6. An exclude rule: a generic refusal, no resume, nothing reported.
	const excluded = join(ctx.root, "dir-excluded");
	const t7 = makeThread(ctx, excluded, ok, false);
	if (t7.threadId && t7.rollout) {
		const rulesFile = join(ctx.home, ".agentpulse", "exclude");
		mkdirSync(join(ctx.home, ".agentpulse"), { recursive: true, mode: 0o700 });
		writeFileSync(rulesFile, `${excluded}\n`, { mode: 0o600 });
		await sleep(2500);
		out.rulesState = ctx.gate.rulesState?.();
		const linesBefore = lines(t7.rollout).length;
		await insertObserved(ctx, t7.threadId, excluded, "excluded");
		const resumesBefore2 = tap.wire.resumes.length;
		const refused = await settle(ctx, t7.threadId, "bind");
		out.excluded = {
			status: refused.action?.status,
			error: refused.action?.error,
			resumeRequests: tap.wire.resumes.length - resumesBefore2,
			rolloutLinesAfter: lines(t7.rollout).length,
			rolloutLinesBefore: linesBefore,
		};
		ctx.expect(
			"bind-codex-directory: an excluded directory is refused in the generic words",
			refused.action?.status === "failed" &&
				/refused this session/.test(String(refused.action?.error)),
			refused.action,
		);
		ctx.expect(
			"bind-codex-directory: no resume was issued for an excluded directory",
			tap.wire.resumes.length === resumesBefore2 && out.excluded.rolloutLinesAfter === linesBefore,
			out.excluded,
		);
		try {
			require("node:fs").rmSync(rulesFile, { force: true });
		} catch {}
	}
	return out;
}

async function bindCodexDaemon(ctx: CanaryCtx, tap: { wire: Wire }): Promise<Record<string, Any>> {
	const out: Record<string, Any> = {};
	const dir = join(ctx.root, "project-daemon");
	const made = makeThread(ctx, dir, "Reply with only the word ok. Do not run any command.", false);
	if (!made.threadId || !made.rollout)
		return { instrumentInvalid: `no thread: ${made.why ?? "no rollout"}` };
	const threadId = made.threadId;
	const opts = codexOptions(ctx, dir);
	const version = runCodex(["app-server", "daemon", "version"], opts);
	out.daemonVersion = (version.stdout ?? "").trim().slice(0, 200);
	let stopped = false;
	const stopDaemon = () => {
		stopped = true;
		return runCodex(["app-server", "daemon", "stop"], opts);
	};
	try {
		const start =
			ctx.mutate === "no-daemon"
				? { stdout: "(mutation: not started)", stderr: "" }
				: runCodex(["app-server", "daemon", "start"], opts);
		out.daemonStart =
			(start.stdout ?? "").trim().slice(0, 300) || (start.stderr ?? "").trim().slice(0, 300);
		await sleep(1500);
		const viaDaemon =
			ctx.mutate === "no-daemon"
				? await stdioResume(ctx, threadId, ctx.codexHome)
				: await daemonResume(ctx, threadId);
		out.daemonClientResume = viaDaemon.ok ? "accepted" : { error: viaDaemon.error };
		if (!viaDaemon.ok)
			return { ...out, instrumentInvalid: "a client of the daemon couldn't resume the thread" };
		await sleep(1000);
		// The client has left. What a TUI leaves behind is a daemon that still holds the thread.
		const probe = await stdioResume(ctx, threadId, ctx.codexHome);
		out.afterClientLeft = probe.ok ? "accepted (not held)" : probe.error;
		if (probe.ok || !/active writer/.test(probe.error ?? "")) {
			return {
				...out,
				instrumentInvalid:
					"after the client left, a stdio resume wasn't refused with 'active writer'; the daemon-held case isn't reproduced here",
			};
		}
		const linesBefore = lines(made.rollout).length;
		await insertObserved(ctx, threadId, dir, "daemon-held");
		const first = await settle(ctx, threadId, "bind");
		const second = await settle(ctx, threadId, "bind");
		out.heldBinds = [first.action, second.action].map(
			(a) => a && { status: a.status, error: a.error },
		);
		out.rolloutLines = { before: linesBefore, after: lines(made.rollout).length };
		ctx.expect(
			"bind-codex-daemon: each bind fails 'running' while the daemon holds the thread",
			[first.action, second.action].every(
				(a) => a?.status === "failed" && /still holds this session/.test(String(a?.error)),
			),
			out.heldBinds,
		);
		ctx.expect(
			"bind-codex-daemon: a refused bind appended nothing to the thread",
			out.rolloutLines.after === linesBefore,
			out.rolloutLines,
		);
		ctx.expect(
			"bind-codex-daemon: no rows survive and no owner was assigned",
			!(await managedRow(ctx, threadId)) && (await sessionRow(ctx, threadId))?.ownerUserId == null,
		);

		if (ctx.holdMinutes > 0) {
			// An observation, not a condition: how long a daemon with no client keeps the thread held.
			const startedAt = Date.now();
			let releasedAfter: number | null = null;
			const samples: Array<{ minute: number; held: boolean }> = [];
			for (let minute = 1; minute <= ctx.holdMinutes; minute++) {
				await sleep(MINUTE);
				const held = await stdioResume(ctx, threadId, ctx.codexHome);
				samples.push({ minute, held: !held.ok && /active writer/.test(held.error ?? "") });
				console.log(
					`[hold] minute ${minute}: ${samples[samples.length - 1]?.held ? "held" : "released"}`,
				);
				if (held.ok) {
					releasedAfter = Math.round((Date.now() - startedAt) / MINUTE);
					break;
				}
			}
			out.hold = {
				askedMinutes: ctx.holdMinutes,
				releasedAfterMinutes: releasedAfter,
				stillHeldAtEnd: releasedAfter === null,
				samplesHeld: samples.filter((s) => s.held).length,
			};
		}

		const stop = stopDaemon();
		out.daemonStop = (stop.stdout ?? "").trim().slice(0, 200);
		await sleep(1500);
		const resumeFirst = out.hold?.releasedAfterMinutes != null;
		const third = await settle(ctx, threadId, "bind");
		out.afterStop = third.action && { status: third.action.status, error: third.action.error };
		ctx.expect(
			"bind-codex-daemon: after `daemon stop` the same bind succeeds",
			third.action?.status === "succeeded",
			{ third: third.action, releasedByItselfFirst: resumeFirst },
		);
		await post(ctx, `/sessions/${threadId}/stop`);
		await sleep(2000);
	} finally {
		if (!stopped) stopDaemon();
	}
	const pidfile = join(ctx.codexHome, "app-server-daemon", "daemon.pid");
	out.daemonPidFileAfterStop = existsSync(pidfile)
		? readFileSync(pidfile, "utf8").slice(0, 120)
		: null;
	void tap;
	void statSync;
	return out;
}

/** Runs the named scenarios in order and returns their observations; every claim goes through `ctx.expect`. */
export async function runTakeoverScenarios(
	ctx: CanaryCtx,
	ids: readonly string[],
): Promise<Record<string, Any>> {
	const results: Record<string, Any> = {};
	const wanted = ids.filter((id) => (TAKEOVER_SCENARIO_IDS as readonly string[]).includes(id));
	if (wanted.length === 0) return results;
	const rpc = await import("../src/supervisor/providers/codex-rpc.js");
	await startPump(ctx);
	const tap = installTap(ctx, rpc);
	try {
		const table: Record<string, (c: CanaryCtx, t: { wire: Wire }) => Promise<Record<string, Any>>> =
			{
				"bind-codex": bindCodex,
				"recover-codex": recoverCodex,
				"bind-codex-daemon": bindCodexDaemon,
				"bind-codex-directory": bindCodexDirectory,
			};
		for (const id of wanted) {
			const observed = await (
				table[id] as (c: CanaryCtx, t: { wire: Wire }) => Promise<Record<string, Any>>
			)(ctx, tap);
			results[id] = observed;
			ctx.expect(
				`${id}: its preconditions held (an invalid instrument is not a pass)`,
				!observed.instrumentInvalid,
				observed.instrumentInvalid,
			);
		}
	} finally {
		tap.restore();
	}
	return results;
}
