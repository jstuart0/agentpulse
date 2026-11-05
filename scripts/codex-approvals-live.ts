/**
 * Phase 0 spike driver for managed Codex approvals (AGEN-87).
 *
 * Drives a real `codex app-server` over WebSocket and records every frame in
 * both directions. It never runs in CI and spends real model usage, so every
 * scenario has a kill timer and runs only in a throwaway directory.
 *
 *   bun scripts/codex-approvals-live.ts --spike --work <dir> --raw <dir> [--only S2,S4]
 *   bun scripts/codex-approvals-live.ts --scrub --raw <dir> --out <fixtures dir> --work <dir>
 *   bun scripts/codex-approvals-live.ts --real --work <dir> [--minutes 12] [--only argv,decline,fc-accept,fc-decline,fc-patch,followup]
 *
 * `--real` is the per-release canary (D18). It drives a real Codex through the whole of AgentPulse and
 * nothing else: a throwaway server on 127.0.0.1 with a temp SQLite database, the real report gate and
 * tracker, a real managed launch, and a person's answer through the real HTTP routes. It exits non-zero
 * unless every one of these held:
 *   - the protocol verdict is `supported`;
 *   - an approved command that writes its own argv wrote exactly the arguments the person was shown;
 *   - a declined command left no effect;
 *   - an approved file change left content equal to the diff the person was shown (add), and an approved
 *     mixed patch (update, move, delete) left the disk as the shown changes say;
 *   - a declined file change left no effect;
 *   - with a request pending, no process in the Codex child's tree has a listening socket (`lsof`), and
 *     after stop none of that tree is left;
 *   - `followup` (AGEN-91): a prompt sent to a live session through `POST /sessions/:id/prompt` and a real
 *     control-action handler starts a second turn on the same Codex process and thread, still asks for
 *     approval in the launch directory, is refused while that turn is pending, and ends cleanly when
 *     declined. The follow-up's `turn/start` and the `turn/completed` Codex sends are compared with the
 *     recorded 0.163 fixture.
 * An `--only` id that names no scenario exits 2 before anything starts.
 * Codex is asked in a way that cannot be answered without an approval (escalated command, exact patch
 * text); if it asks nothing anyway, that scenario fails, because a canary that passes without asking
 * proves nothing. It uses a throwaway CODEX_HOME holding only a copy of `auth.json`, which is deleted at
 * the end; `~/.codex` is never written and the running supervisor is never touched. It spends real model
 * usage, and a kill timer (`--minutes`, default 12) ends everything whatever else happens.
 *
 * `--work` must sit under a scratch location (path containing /scratchpad/ or
 * the OS temp dir), never in a repo checkout or a home directory.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

type Frame = { t: number; dir: "in" | "out"; frame: any };
type Obs = Record<string, unknown>;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

/** The scenarios `--real` knows, in the order a default run takes them. */
const REAL_SCENARIO_IDS = ["argv", "decline", "fc-accept", "fc-decline", "fc-patch", "followup"];

/** `--only` is checked before anything starts: an id that matches nothing would otherwise run zero scenarios and pass. */
function realScenarioIds(raw: string | undefined): string[] {
	const ids = raw === undefined ? REAL_SCENARIO_IDS : raw.split(",");
	const unknown = ids.filter((id) => !REAL_SCENARIO_IDS.includes(id));
	if (unknown.length > 0) {
		console.error(
			`[real] unknown scenario ${unknown.map((id) => JSON.stringify(id)).join(", ")}; known: ${REAL_SCENARIO_IDS.join(", ")}`,
		);
		process.exit(2);
	}
	return ids;
}

function assertScratch(dir: string) {
	const abs = resolve(dir);
	const ok =
		abs.includes("/scratchpad/") ||
		abs.startsWith(resolve(tmpdir())) ||
		abs.startsWith("/private/tmp/");
	if (!ok || abs.startsWith(`${resolve(homedir())}/dev/`)) {
		throw new Error(`refusing to run Codex in ${abs}: not a scratch directory`);
	}
	return abs;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const CODEX_HOME = process.env.SPIKE_CODEX_HOME ?? "";

/** Native pids in a process group, wrapper included. */
const groupPids = (pgid: number): number[] => {
	const r = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
	return r.stdout.split("\n").filter(Boolean).map(Number);
};
const lsofListeners = (pids: number[]): string => {
	if (!pids.length) return "";
	const r = spawnSync("lsof", ["-nP", "-a", "-i", "-p", pids.join(",")], { encoding: "utf8" });
	return `${r.stdout}${r.stderr}`.trim();
};
const argvOf = (pid: number) =>
	spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

/** One `codex app-server` over stdio (JSONL), spawned in its own process group. */
const liveSessions = new Set<Session>();

class Session {
	frames: Frame[] = [];
	t0 = Date.now();
	srv!: ChildProcess;
	nextId = 1;
	pend = new Map<number, (v: any) => void>();
	serverRequests: any[] = [];
	onServerRequest: (m: any) => void = () => {};
	onNotification: (m: any) => void = () => {};
	closed = false;
	threadId = "";
	spawnArgv: string[] = [];
	private buf = "";
	constructor(
		public work: string,
		public name: string,
		public extraArgs: string[] = [],
	) {}
	log(...a: unknown[]) {
		console.log(`[${this.name} ${((Date.now() - this.t0) / 1000).toFixed(1)}s]`, ...a);
	}
	async start() {
		if (!CODEX_HOME) throw new Error("SPIKE_CODEX_HOME must name a throwaway CODEX_HOME");
		mkdirSync(this.work, { recursive: true });
		if (!existsSync(join(this.work, ".git"))) spawnSync("git", ["init", "-q"], { cwd: this.work });
		this.spawnArgv = ["codex", ...this.extraArgs, "app-server"];
		this.srv = spawn(this.spawnArgv[0]!, this.spawnArgv.slice(1), {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.work,
			detached: true,
			env: { ...process.env, CODEX_HOME, AGENTPULSE_SKIP: "1" },
		});
		liveSessions.add(this);
		this.srv.stdin!.on("error", () => {});
		this.srv.stderr!.on("data", () => {});
		this.srv.stdout!.on("data", (d: Buffer) => {
			this.buf += d.toString("utf8");
			for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
				const line = this.buf.slice(0, i);
				this.buf = this.buf.slice(i + 1);
				if (line.trim()) this.onMessage(line);
			}
		});
		this.srv.on("exit", (code, sig) => {
			this.closed = true;
			this.record("in", { _event: "child_exit", code, sig });
		});
		await this.rq("initialize", {
			clientInfo: { name: "spike", title: "spike", version: "0" },
			capabilities: { experimentalApi: true },
		});
	}
	record(dir: "in" | "out", frame: any) {
		this.frames.push({ t: Date.now() - this.t0, dir, frame });
	}
	onMessage(text: string) {
		const m = JSON.parse(text);
		this.record("in", m);
		if ("method" in m && "id" in m) {
			this.serverRequests.push(m);
			this.log("SERVER-REQUEST", m.method, "id=", JSON.stringify(m.id));
			this.onServerRequest(m);
			return;
		}
		if ("id" in m) {
			const p = this.pend.get(m.id);
			this.pend.delete(m.id);
			p?.(m.error ? { _error: m.error } : m.result);
			return;
		}
		if (!/delta|outputDelta/i.test(m.method)) this.log("notif", m.method);
		this.onNotification(m);
	}
	send(frame: any) {
		this.record("out", frame);
		this.srv.stdin!.write(`${JSON.stringify(frame)}\n`);
	}
	rq(method: string, params: any, timeoutMs = 30_000): Promise<any> {
		return new Promise((res) => {
			const id = this.nextId++;
			this.pend.set(id, res);
			this.send({ id, method, params });
			setTimeout(() => {
				if (this.pend.has(id)) {
					this.pend.delete(id);
					res({ _timeout: true });
				}
			}, timeoutMs);
		});
	}
	respond(m: any, result: any) {
		this.send({ id: m.id, result });
	}
	respondError(m: any, code: number, message: string) {
		this.send({ id: m.id, error: { code, message } });
	}
	async thread(params: Record<string, unknown> = {}) {
		const st = await this.rq("thread/start", {
			cwd: this.work,
			approvalPolicy: "on-request",
			sandbox: "read-only",
			experimentalRawEvents: false,
			persistExtendedHistory: true,
			...params,
		});
		this.threadId = st.thread?.id;
		return st;
	}
	async turn(prompt: string, extra: Record<string, unknown> = {}) {
		const t = await this.rq("turn/start", {
			threadId: this.threadId,
			input: [{ type: "text", text: prompt }],
			cwd: this.work,
			...extra,
		});
		return t.turn?.id as string;
	}
	waitFor(pred: (m: any) => boolean, ms: number): Promise<any | null> {
		return new Promise((res) => {
			const seen = this.frames.find((f) => f.dir === "in" && pred(f.frame));
			if (seen) return res(seen.frame);
			const prev = this.onNotification;
			const prevReq = this.onServerRequest;
			const done = (v: any) => {
				clearTimeout(timer);
				this.onNotification = prev;
				this.onServerRequest = prevReq;
				res(v);
			};
			const timer = setTimeout(() => done(null), ms);
			this.onNotification = (m) => {
				prev(m);
				if (pred(m)) done(m);
			};
			this.onServerRequest = (m) => {
				prevReq(m);
				if (pred(m)) done(m);
			};
		});
	}
	/** Kill the whole group (wrapper and native binary). */
	stop() {
		try {
			this.srv.stdin!.end();
		} catch {}
		try {
			process.kill(-this.srv.pid!, "SIGKILL");
		} catch {}
	}
	fileExists(name: string) {
		return existsSync(join(this.work, name));
	}
	save(rawDir: string, obs: Obs) {
		mkdirSync(rawDir, { recursive: true });
		writeFileSync(
			join(rawDir, `${this.name}.jsonl`),
			`${this.frames.map((f) => JSON.stringify(f)).join("\n")}\n`,
		);
		writeFileSync(join(rawDir, `${this.name}.obs.json`), JSON.stringify(obs, null, 2));
	}
}

const CMD = (file: string) =>
	`Run exactly this shell command with escalated permissions, do not do anything else: touch ${file}`;
const FC = (file: string, line: string) =>
	`Use the apply_patch tool to create a new file named ${file} containing exactly one line: ${line}. Do nothing else. Do not run shell commands.`;
const isCmdReq = (m: any) => m.method === "item/commandExecution/requestApproval" && "id" in m;
const isFcReq = (m: any) => m.method === "item/fileChange/requestApproval" && "id" in m;
const isTurnDone = (m: any) => m.method === "turn/completed";
const frameMethods = (s: Session) =>
	s.frames
		.filter((f) => f.dir === "in" && f.frame.method && !/delta|outputDelta/i.test(f.frame.method))
		.map(
			(f) =>
				`${(f.t / 1000).toFixed(1)} ${f.frame.method}${f.frame.id !== undefined ? "(req)" : ""}`,
		);

type Scenario = (ctx: { work: string; raw: string }) => Promise<Obs>;
const scenarios: Record<string, { id: string; run: Scenario; killMs: number }> = {};
function def(id: string, killMs: number, run: Scenario) {
	scenarios[id] = { id, run, killMs };
}

// S1: no answer for a long time. Optional duration override (minutes) via --minutes.
def("S1", 29 * 60_000, async ({ work, raw }) => {
	const minutes = Number(opt("--minutes") ?? 26);
	const s = new Session(join(work, "S1"), "S1");
	await s.start();
	await s.thread();
	await s.turn(CMD("s1-long.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	const reqAt = req ? s.frames.find((f) => f.frame === req)?.t : null;
	const marks: Record<string, unknown>[] = [];
	const deadline = Date.now() + minutes * 60_000;
	let lastMark = 0;
	let lastTick = Date.now();
	let maxGapMs = 0;
	while (Date.now() < deadline) {
		await sleep(5000);
		maxGapMs = Math.max(maxGapMs, Date.now() - lastTick - 5000);
		lastTick = Date.now();
		const afterReq = s.frames.filter(
			(f) =>
				reqAt != null &&
				f.t > reqAt &&
				f.dir === "in" &&
				f.frame.method &&
				!/delta|outputDelta/i.test(f.frame.method),
		);
		if (Date.now() - lastMark > 120_000) {
			lastMark = Date.now();
			marks.push({
				minute: +((Date.now() - s.t0) / 60000).toFixed(1),
				notificationsAfterRequest: afterReq.map((f) => f.frame.method),
				wsClosed: s.closed,
				srvAlive: s.srv.exitCode === null,
				maxTickGapMs: maxGapMs,
				fileExists: s.fileExists("s1-long.txt"),
			});
			s.log("mark", JSON.stringify(marks.at(-1)));
		}
		if (s.closed || s.srv.exitCode !== null) break;
		if (afterReq.some((f) => /serverRequest\/resolved|turn\/completed/.test(f.frame.method))) break;
	}
	const gaveUp = s.frames.find(
		(f) =>
			reqAt != null &&
			f.t > reqAt &&
			/serverRequest\/resolved|turn\/completed/.test(f.frame.method ?? ""),
	);
	const obs: Obs = {
		gotRequest: !!req,
		waitedMinutes: +((Date.now() - s.t0 - (reqAt ?? 0)) / 60000).toFixed(2),
		fileCreatedWithoutAnswer: s.fileExists("s1-long.txt"),
		wsClosed: s.closed,
		srvAlive: s.srv.exitCode === null,
		resolvedOrCompletedAfterRequest: gaveUp
			? { at: gaveUp.t / 1000, method: gaveUp.frame.method, params: gaveUp.frame.params }
			: null,
		maxTickGapMs: maxGapMs,
		marks,
	};
	if (req) {
		const tid = s.frames.find((f) => f.frame.method === "turn/started")?.frame.params?.turn?.id;
		await s.rq("turn/interrupt", { threadId: s.threadId, turnId: tid });
		await sleep(2000);
	}
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S2: close the child's stdin with a request pending.
def("S2", 4 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S2"), "S2");
	await s.start();
	await s.thread();
	await s.turn(CMD("s2-stdin.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	await sleep(1000);
	const pgid = s.srv.pid!;
	const before = groupPids(pgid);
	s.srv.stdin!.end();
	const checks: Obs[] = [];
	let waited = 0;
	for (const wait of [500, 1500, 3000, 6000, 10000]) {
		await sleep(wait);
		waited += wait;
		checks.push({
			afterMs: waited,
			groupPidsAlive: groupPids(pgid).length,
			exited: s.closed,
			fileExists: s.fileExists("s2-stdin.txt"),
		});
	}
	const exit = s.frames.find((f) => f.frame._event === "child_exit");
	const obs: Obs = {
		gotRequest: !!req,
		groupPidsBeforeClose: before.length,
		checks,
		exitFrame: exit?.frame ?? null,
		exitAtMs: exit?.t ?? null,
	};
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S3: SIGKILL the parent (the supervisor) with one pending, under stdio.
def("S3", 4 * 60_000, async ({ work, raw }) => {
	const dir = join(work, "S3");
	mkdirSync(dir, { recursive: true });
	const pidfile = join(dir, "helper.json");
	try {
		require("node:fs").rmSync(pidfile);
	} catch {}
	const helper = spawn("bun", [import.meta.path, "--parent-helper", dir, pidfile], {
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, SPIKE_CODEX_HOME: CODEX_HOME },
	});
	let info: any = null;
	for (let i = 0; i < 120 && !info; i++) {
		await sleep(1000);
		if (existsSync(pidfile)) info = JSON.parse(readFileSync(pidfile, "utf8"));
	}
	if (!info) {
		helper.kill("SIGKILL");
		return { error: "helper never reached a pending request" };
	}
	const before = groupPids(info.pgid);
	process.kill(helper.pid!, "SIGKILL");
	const checks: Obs[] = [];
	let waited = 0;
	for (const wait of [500, 1500, 3000, 6000, 10000]) {
		await sleep(wait);
		waited += wait;
		checks.push({
			afterMs: waited,
			groupPidsAlive: groupPids(info.pgid).length,
			fileExists: existsSync(join(dir, "s3-kill.txt")),
		});
	}
	const leftover = groupPids(info.pgid);
	for (const p of leftover) {
		try {
			process.kill(p, "SIGKILL");
		} catch {}
	}
	const obs: Obs = {
		helperKilled: true,
		groupPidsBeforeKill: before.length,
		checks,
		leftoverKilledByHarness: leftover.length,
	};
	writeFileSync(join(raw, "S3.obs.json"), JSON.stringify(obs, null, 2));
	return obs;
});

// S4 + S5 + S6: a real file-change request, answered with accept after a watch window.
def("S4", 5 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S4"), "S4");
	await s.start();
	await s.thread();
	await s.turn(FC("fc4.txt", "hello from fc4"));
	const req = await s.waitFor(isFcReq, 120_000);
	const reqFrame = s.frames.find((f) => f.frame === req);
	// Hold for 6 s unanswered to see whether patchUpdated trails the request.
	await sleep(6000);
	const beforeAnswer = frameMethods(s);
	const answeredAt = Date.now() - s.t0;
	if (req) s.respond(req, { decision: "accept" });
	await s.waitFor(isTurnDone, 90_000);
	await sleep(1500);
	const afterAnswer = frameMethods(s);
	const content = existsSync(join(s.work, "fc4.txt"))
		? readFileSync(join(s.work, "fc4.txt"), "utf8")
		: null;
	const fcItems = s.frames
		.filter(
			(f) =>
				f.dir === "in" &&
				/^item\/(started|completed)$/.test(f.frame.method ?? "") &&
				f.frame.params?.item?.type === "fileChange",
		)
		.map((f) => ({ t: f.t, method: f.frame.method, item: f.frame.params.item }));
	const patchUpdated = s.frames
		.filter((f) => f.dir === "in" && /patchUpdated/.test(f.frame.method ?? ""))
		.map((f) => ({ t: f.t, params: f.frame.params }));
	const obs: Obs = {
		requestAtMs: reqFrame?.t,
		answeredAtMs: answeredAt,
		requestParamsKeys: req ? Object.keys(req.params) : null,
		availableDecisionsPresent: req ? "availableDecisions" in req.params : null,
		requestParams: req?.params,
		methodsBeforeAnswer: beforeAnswer,
		methodsAfterAnswer: afterAnswer,
		fileChangeItems: fcItems,
		patchUpdated,
		patchUpdatedBeforeRequest: patchUpdated.filter((p) => reqFrame && p.t < reqFrame.t).length,
		patchUpdatedAfterRequestBeforeAnswer: patchUpdated.filter(
			(p) => reqFrame && p.t >= reqFrame.t && p.t < answeredAt,
		).length,
		patchUpdatedAfterAnswer: patchUpdated.filter((p) => p.t >= answeredAt).length,
		fileContent: content,
	};
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S5 (streaming patch events enabled) and S6 (modify an existing file): does a patchUpdated trail the request, and does the result equal the shown diff?
def("S5", 5 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S5"), "S5", [
		"-c",
		"features.apply_patch_streaming_events=true",
	]);
	await s.start();
	writeFileSync(join(s.work, "existing.txt"), "line one\nline two\nline three\n");
	await s.thread();
	await s.turn(
		"Use the apply_patch tool to change line two of existing.txt to 'line TWO changed' and also create a new file named extra.txt containing one line: extra. Do it in a single patch. Do not run shell commands.",
	);
	const req = await s.waitFor(isFcReq, 120_000);
	const reqFrame = s.frames.find((f) => f.frame === req);
	await sleep(6000);
	const answeredAt = Date.now() - s.t0;
	if (req) s.respond(req, { decision: "accept" });
	await s.waitFor(isTurnDone, 90_000);
	await sleep(1500);
	const items = s.frames
		.filter(
			(f) =>
				f.dir === "in" &&
				/^item\/(started|completed)$/.test(f.frame.method ?? "") &&
				f.frame.params?.item?.type === "fileChange",
		)
		.map((f) => ({
			t: f.t,
			method: f.frame.method,
			changes: f.frame.params.item.changes,
			status: f.frame.params.item.status,
		}));
	const patch = s.frames.filter(
		(f) =>
			f.dir === "in" &&
			/patchUpdated|apply_patch|fileChange\/(output|patch)/i.test(f.frame.method ?? ""),
	);
	const rd = (n: string) =>
		existsSync(join(s.work, n)) ? readFileSync(join(s.work, n), "utf8") : null;
	const obs: Obs = {
		requestAtMs: reqFrame?.t,
		answeredAtMs: answeredAt,
		requestParams: req?.params,
		fileChangeItems: items,
		patchEvents: patch.map((f) => ({ t: f.t, method: f.frame.method, params: f.frame.params })),
		patchEventsBeforeRequest: patch.filter((f) => reqFrame && f.t < reqFrame.t).length,
		patchEventsBetweenRequestAndAnswer: patch.filter(
			(f) => reqFrame && f.t >= reqFrame.t && f.t < answeredAt,
		).length,
		patchEventsAfterAnswer: patch.filter((f) => f.t >= answeredAt).length,
		existingAfter: rd("existing.txt"),
		extraAfter: rd("extra.txt"),
	};
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S7: decline and cancel on file-change, then the next turn on the same thread.
def("S7", 6 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S7"), "S7");
	await s.start();
	await s.thread();
	const obs: Obs = {};
	for (const decision of ["decline", "cancel"] as const) {
		const before = s.frames.length;
		s.frames.push({ t: Date.now() - s.t0, dir: "out", frame: { _marker: `begin-${decision}` } });
		await s.turn(FC(`fc7-${decision}.txt`, `hello ${decision}`));
		const req = await s.waitFor(
			(m) => isFcReq(m) && !s.frames.slice(0, before).some((f) => f.frame === m),
			120_000,
		);
		await sleep(1500);
		if (req) s.respond(req, { decision });
		const done = await s.waitFor(
			(m) => isTurnDone(m) && s.frames.indexOf(s.frames.find((f) => f.frame === m)!) >= before,
			90_000,
		);
		await sleep(2000);
		const slice = s.frames.slice(before);
		obs[decision] = {
			gotRequest: !!req,
			fileExists: s.fileExists(`fc7-${decision}.txt`),
			turnStatus: done?.params?.turn?.status ?? null,
			resolvedSeen: slice.some((f) => f.frame.method === "serverRequest/resolved"),
			fileChangeItemStatuses: slice
				.filter(
					(f) =>
						f.dir === "in" &&
						/^item\/completed$/.test(f.frame.method ?? "") &&
						f.frame.params?.item?.type === "fileChange",
				)
				.map((f) => f.frame.params.item.status),
			lastAgentMessage: slice
				.filter(
					(f) =>
						f.dir === "in" &&
						f.frame.method === "item/completed" &&
						f.frame.params?.item?.type === "agentMessage",
				)
				.map((f) => String(f.frame.params.item.text).slice(0, 200)),
		};
	}
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S8: cancel on a command. Turn fate, session fate (next turn works?).
def("S8", 6 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S8"), "S8");
	await s.start();
	await s.thread();
	const tid = await s.turn(CMD("s8-cancel.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	await sleep(1500);
	const listed = req?.params?.availableDecisions ?? null;
	if (req) s.respond(req, { decision: "cancel" });
	const done = await s.waitFor(isTurnDone, 90_000);
	await sleep(2000);
	const itemStatuses = s.frames
		.filter(
			(f) =>
				f.dir === "in" &&
				f.frame.method === "item/completed" &&
				f.frame.params?.item?.type === "commandExecution",
		)
		.map((f) => f.frame.params.item.status);
	const resolved = s.frames.some((f) => f.frame.method === "serverRequest/resolved");
	// Next turn on the same thread (read-only, harmless).
	const next = await s.turn("Reply with the single word ok. Do not run any commands.");
	const done2 = await s.waitFor((m) => isTurnDone(m) && m.params?.turn?.id === next, 90_000);
	const obs: Obs = {
		turnId: tid ? "recorded" : null,
		availableDecisions: listed,
		cancelListed: Array.isArray(listed) ? listed.includes("cancel") : null,
		turnStatusAfterCancel: done?.params?.turn?.status ?? null,
		commandItemStatuses: itemStatuses,
		resolvedSeen: resolved,
		fileExists: s.fileExists("s8-cancel.txt"),
		nextTurnStatus: done2?.params?.turn?.status ?? null,
	};
	s.save(raw, obs);
	s.stop();
	return obs;
});

// Command accept / decline fixtures plus S12 (-32601), S14 (rename), S15, S16, S17.
def("C1", 6 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "C1"), "command-accept");
	await s.start();
	const init = s.frames.find((f) => f.dir === "in" && f.frame.result?.userAgent)?.frame.result;
	await s.thread();
	await s.turn(CMD("accepted.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	await sleep(500);
	if (req) s.respond(req, { decision: "accept" });
	await s.waitFor(isTurnDone, 90_000);
	await sleep(1500);
	const obs: Obs = {
		userAgent: init?.userAgent,
		environmentId: req?.params?.environmentId,
		requestParams: req?.params,
		fileExists: s.fileExists("accepted.txt"),
	};
	s.save(raw, obs);
	s.stop();
	return obs;
});

def("C2", 4 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "C2"), "command-decline");
	await s.start();
	await s.thread();
	await s.turn(CMD("declined.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	await sleep(1000);
	if (req) s.respond(req, { decision: "decline" });
	await s.waitFor(isTurnDone, 90_000);
	await sleep(1000);
	const obs: Obs = { fileExists: s.fileExists("declined.txt") };
	s.save(raw, obs);
	s.stop();
	return obs;
});

def("S12", 4 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S12"), "S12");
	await s.start();
	await s.thread();
	await s.turn(CMD("s12.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	await sleep(500);
	if (req) s.respondError(req, -32601, "Method not found");
	const done = await s.waitFor(isTurnDone, 60_000);
	await sleep(1500);
	const obs: Obs = {
		turnStatus: done?.params?.turn?.status ?? null,
		turnCompleted: !!done,
		hung: !done,
		commandItemStatuses: s.frames
			.filter(
				(f) =>
					f.dir === "in" &&
					f.frame.method === "item/completed" &&
					f.frame.params?.item?.type === "commandExecution",
			)
			.map((f) => f.frame.params.item.status),
		resolvedSeen: s.frames.some((f) => f.frame.method === "serverRequest/resolved"),
		fileExists: s.fileExists("s12.txt"),
	};
	if (!done) {
		const tid = s.frames.find((f) => f.frame.method === "turn/started")?.frame.params?.turn?.id;
		await s.rq("turn/interrupt", { threadId: s.threadId, turnId: tid });
		await sleep(1500);
	}
	s.save(raw, obs);
	s.stop();
	return obs;
});

def("S14", 4 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S14"), "S14");
	await s.start();
	await s.thread();
	await s.turn(CMD("s14.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	await sleep(1000);
	const at = s.frames.length;
	const rename = await s.rq("thread/name/set", {
		threadId: s.threadId,
		name: "renamed while pending",
	});
	await sleep(4000);
	const mid = s.frames
		.slice(at)
		.filter((f) => f.dir === "in" && f.frame.method)
		.map((f) => f.frame.method);
	if (req) s.respond(req, { decision: "accept" });
	await s.waitFor(isTurnDone, 60_000);
	await sleep(1000);
	const obs: Obs = {
		renameResult: rename,
		methodsAfterRename: mid,
		requestResolvedByRename: mid.includes("serverRequest/resolved"),
		fileCreatedAfterLateAccept: s.fileExists("s14.txt"),
	};
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S16: a script that writes its own argv; compare with the shown command.
def("S16", 4 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S16"), "S16");
	await s.start();
	writeFileSync(
		join(s.work, "argv.sh"),
		'#!/bin/sh\nprintf "%s\\n" "$0" "$@" > argv-out.txt\nps -o args= -p $$ >> argv-out.txt\n',
		{ mode: 0o755 },
	);
	await s.thread();
	await s.turn(
		"Run exactly this shell command with escalated permissions, do not do anything else: ./argv.sh alpha 'beta gamma' delta",
	);
	const req = await s.waitFor(isCmdReq, 120_000);
	await sleep(500);
	if (req) s.respond(req, { decision: "accept" });
	await s.waitFor(isTurnDone, 90_000);
	await sleep(1000);
	const out = s.fileExists("argv-out.txt")
		? readFileSync(join(s.work, "argv-out.txt"), "utf8")
		: null;
	const obs: Obs = {
		shownCommand: req?.params?.command,
		shownCwd: req?.params?.cwd,
		scriptWroteArgv: out,
	};
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S19: under stdio with a request pending, is there any listening socket, and what was the spawn's argv?
def("S19", 4 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S19"), "S19");
	await s.start();
	await s.thread();
	await s.turn(CMD("s19.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	await sleep(1000);
	const pgid = s.srv.pid!;
	const pids = groupPids(pgid);
	const listeners = spawnSync(
		"lsof",
		["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")],
		{ encoding: "utf8" },
	).stdout.trim();
	const anyNet = lsofListeners(pids);
	const unixSocks = spawnSync("lsof", ["-nP", "-a", "-U", "-p", pids.join(",")], {
		encoding: "utf8",
	})
		.stdout.trim()
		.split("\n")
		.slice(1);
	const obs: Obs = {
		gotRequest: !!req,
		spawnArgv: s.spawnArgv,
		processArgvs: pids.map((p) => argvOf(p).replace(/^.*\/bin\/codex/, "<native>/codex")),
		hasListenFlag: pids.some((p) => /--listen/.test(argvOf(p))),
		tcpListeners: listeners || "none",
		anyInternetSockets: anyNet || "none",
		unixSocketCountExcludingPipes: unixSocks.filter(Boolean).length,
		unixSocketLines: unixSocks.filter(Boolean).map((l) => l.replace(/\s+/g, " ").slice(0, 160)),
		pidCount: pids.length,
	};
	if (req) s.respond(req, { decision: "decline" });
	await sleep(1500);
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S9/S10/S11/S13: methods that may not be triggerable. Each tries once, bounded.
def("S13", 3 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S13"), "S13");
	await s.start();
	const st = await s.rq("thread/start", {
		cwd: s.work,
		experimentalRawEvents: false,
		persistExtendedHistory: true,
	});
	s.threadId = st.thread?.id;
	const obs: Obs = {
		approvalPolicy: st.approvalPolicy,
		sandbox: st.sandbox,
		approvalsReviewer: st.approvalsReviewer,
		permissionProfile: st.permissionProfile ?? null,
		note: "thread/start with no approvalPolicy or sandbox; values come from the machine's config",
	};
	await s.turn(CMD("s13.txt"));
	const req = await s.waitFor((m) => isCmdReq(m) || isTurnDone(m), 60_000);
	obs.commandReachedApprovalWithDefaults = !!req && isCmdReq(req);
	if (req && isCmdReq(req)) s.respond(req, { decision: "decline" });
	await sleep(3000);
	obs.fileExists = s.fileExists("s13.txt");
	s.save(raw, obs);
	s.stop();
	return obs;
});

def("S9", 3 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S9"), "S9", [
		"-c",
		"features.exec_permission_approvals=true",
		"-c",
		"features.request_permissions_tool=true",
	]);
	await s.start();
	await s.thread();
	await s.turn(
		"Call the request_permissions tool once to ask for network access and write access to the current directory, then stop. Do not run shell commands.",
	);
	const req = await s.waitFor(
		(m) =>
			(m.method === "item/permissions/requestApproval" && "id" in m) ||
			isCmdReq(m) ||
			isTurnDone(m),
		90_000,
	);
	const obs: Obs = {
		triggered: !!req && req.method === "item/permissions/requestApproval",
		firstEvent: req?.method ?? null,
	};
	if (obs.triggered) {
		s.respond(req, { permissions: {} });
		const done = await s.waitFor(isTurnDone, 60_000);
		obs.afterEmptyGrant = {
			turnCompleted: !!done,
			resolvedSeen: s.frames.some((f) => f.frame.method === "serverRequest/resolved"),
			itemStatuses: s.frames
				.filter((f) => f.dir === "in" && f.frame.method === "item/completed")
				.map((f) => `${f.frame.params?.item?.type}:${f.frame.params?.item?.status ?? ""}`),
			agentText: s.frames
				.filter(
					(f) =>
						f.dir === "in" &&
						f.frame.method === "item/completed" &&
						f.frame.params?.item?.type === "agentMessage",
				)
				.map((f) => String(f.frame.params.item.text).slice(0, 300)),
		};
	} else if (req && isCmdReq(req)) {
		s.respond(req, { decision: "decline" });
	}
	s.save(raw, obs);
	s.stop();
	return obs;
});

def("S10", 3 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S10"), "S10", [
		"-c",
		"features.default_mode_request_user_input=true",
	]);
	await s.start();
	await s.thread();
	await s.turn(
		"Call the request_user_input tool once to ask me to choose between 'red' and 'blue', then stop. Do not run shell commands.",
	);
	const req = await s.waitFor(
		(m) => (m.method === "item/tool/requestUserInput" && "id" in m) || isCmdReq(m) || isTurnDone(m),
		90_000,
	);
	const obs: Obs = {
		triggered: !!req && req.method === "item/tool/requestUserInput",
		firstEvent: req?.method ?? null,
		params: req?.params,
	};
	if (obs.triggered) {
		s.respond(req, { answers: {} });
		const done = await s.waitFor(isTurnDone, 45_000);
		obs.emptyAnswers = { turnCompleted: !!done, hung: !done };
		if (!done) {
			const tid = s.frames.find((f) => f.frame.method === "turn/started")?.frame.params?.turn?.id;
			await s.rq("turn/interrupt", { threadId: s.threadId, turnId: tid });
			await sleep(1500);
		}
	}
	s.save(raw, obs);
	s.stop();
	return obs;
});

def("S11", 4 * 60_000, async ({ work, raw }) => {
	const s = new Session(join(work, "S11"), "S11");
	await s.start();
	const st = await s.thread({
		dynamicTools: [
			{
				name: "spike_echo",
				description:
					"Echo the given text back. Always call this tool when asked to call spike_echo.",
				inputSchema: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
				},
			},
		],
	});
	const obs: Obs = { threadStartError: st?._error ?? null };
	await s.turn(
		"Call the spike_echo tool once with text hello, then reply with the word done. Do not run shell commands.",
	);
	const req = await s.waitFor(
		(m) => (m.method === "item/tool/call" && "id" in m) || isTurnDone(m),
		90_000,
	);
	obs.toolCallTriggered = !!req && req.method === "item/tool/call";
	obs.toolCallParams = req?.params;
	if (obs.toolCallTriggered) {
		s.respond(req, { contentItems: [], success: false });
		const done = await s.waitFor(isTurnDone, 60_000);
		obs.afterRefusal = { turnCompleted: !!done, turnStatus: done?.params?.turn?.status ?? null };
	}
	obs.elicitation = "see S11b";
	obs.legacyApplyPatchApproval =
		"not_triggerable: no v1 conversation API in the 0.163.0 ClientRequest schema (thread/start only)";
	s.save(raw, obs);
	s.stop();
	return obs;
});

// S11b: MCP elicitation, through a tiny local MCP server (SPIKE_MCP_SERVER).
def("S11b", 3 * 60_000, async ({ work, raw }) => {
	const server = process.env.SPIKE_MCP_SERVER ?? "";
	const s = new Session(join(work, "S11b"), "S11b", [
		"-c",
		'mcp_servers.spike.command="bun"',
		"-c",
		`mcp_servers.spike.args=["${server}"]`,
		"-c",
		'mcp_servers.spike.default_tools_approval_mode="approve"',
	]);
	await s.start();
	await s.thread();
	await s.turn(
		"Call the ask_color tool from the spike MCP server once, then reply with the word done. Do not run shell commands.",
	);
	const req = await s.waitFor(
		(m) =>
			("id" in m && /elicitation|requestApproval|requestUserInput/.test(m.method ?? "")) ||
			isTurnDone(m),
		90_000,
	);
	const obs: Obs = { firstServerRequest: req?.method ?? null, params: req?.params };
	if (req && "id" in req && req.method === "mcpServer/elicitation/request") {
		s.respond(req, { action: "decline" });
		const done = await s.waitFor(isTurnDone, 60_000);
		obs.afterDecline = { turnCompleted: !!done, turnStatus: done?.params?.turn?.status ?? null };
	} else if (req && "id" in req) {
		obs.note = "a different server request came first";
		s.respond(
			req,
			req.method === "item/commandExecution/requestApproval" ? { decision: "decline" } : {},
		);
		await s.waitFor(isTurnDone, 30_000);
	}
	s.save(raw, obs);
	s.stop();
	return obs;
});

// Hidden mode: the parent that S3 kills.
async function parentHelper(dir: string, pidfile: string) {
	const s = new Session(dir, "S3a");
	await s.start();
	await s.thread();
	await s.turn(CMD("s3-kill.txt"));
	const req = await s.waitFor(isCmdReq, 120_000);
	if (!req) process.exit(2);
	writeFileSync(pidfile, JSON.stringify({ pgid: s.srv.pid, pids: groupPids(s.srv.pid!) }));
	await sleep(10 * 60_000);
}

function scrubString(v: string, ctx: { work: string; uuids: Map<string, string> }): string {
	let out = v;
	const home = homedir();
	const user = userInfo().username;
	const host = hostname();
	const hostShort = host.split(".")[0]!;
	out = out.split(ctx.work).join("/WORK");
	out = out.split(resolve(ctx.work, "..")).join("/WORKROOT");
	out = out.split(home).join("/HOME");
	out = out.replace(/\/private\/tmp\/[^\s"']*/g, "/TMP");
	out = out.replace(/\/var\/folders\/[^\s"']*/g, "/TMP");
	if (user.length > 2) out = out.split(user).join("USER");
	if (hostShort.length > 2) out = out.split(hostShort).join("HOST");
	out = out.replace(/\b(rs|msg|call|fc|ws)_[0-9A-Za-z]{16,}/g, "$1_REDACTED");
	out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
		let m = ctx.uuids.get(u);
		if (!m) {
			m = `00000000-0000-4000-8000-${String(ctx.uuids.size + 1).padStart(12, "0")}`;
			ctx.uuids.set(u, m);
		}
		return m;
	});
	return out;
}
function scrub(v: any, ctx: { work: string; uuids: Map<string, string> }): any {
	if (typeof v === "string") return scrubString(v, ctx);
	if (Array.isArray(v)) return v.map((x) => scrub(x, ctx));
	if (v && typeof v === "object") {
		const o: any = {};
		for (const [k, x] of Object.entries(v)) o[scrubString(k, ctx)] = scrub(x, ctx);
		return o;
	}
	return v;
}

// ---- D18 shape-fingerprint recipe (S18) ----
const SHAPE_ROOTS = [
	"CommandExecutionRequestApprovalParams.json",
	"CommandExecutionRequestApprovalResponse.json",
	"FileChangeRequestApprovalParams.json",
	"FileChangeRequestApprovalResponse.json",
	"v2/ServerRequestResolvedNotification.json",
	"v2/FileChangePatchUpdatedNotification.json",
];

/** The fileChange thread item with the definitions it reaches, cut from the v2 bundle. */
function fileChangeItemSchema(dir: string): any {
	const bundle = JSON.parse(
		readFileSync(join(dir, "codex_app_server_protocol.v2.schemas.json"), "utf8"),
	);
	const defs = bundle.definitions as Record<string, any>;
	const variant = defs.ThreadItem.oneOf.find(
		(v: any) => v.properties?.type?.enum?.[0] === "fileChange",
	);
	const needed: Record<string, any> = {};
	const visit = (node: any) => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== "object") return;
		for (const [k, v] of Object.entries(node)) {
			if (k === "$ref" && typeof v === "string" && v.startsWith("#/definitions/")) {
				const name = v.slice("#/definitions/".length);
				if (!needed[name]) {
					needed[name] = defs[name];
					visit(defs[name]);
				}
			} else visit(v);
		}
	};
	visit(variant);
	return { ...variant, definitions: needed };
}

/** Sorted keys; descriptions dropped except inside a decision enum definition. */
function canonicalShape(node: any, inDecision = false, key = ""): any {
	if (Array.isArray(node)) return node.map((n) => canonicalShape(n, inDecision));
	if (!node || typeof node !== "object") return node;
	const out: any = {};
	for (const k of Object.keys(node).sort()) {
		if (k === "description" && typeof node[k] === "string" && !inDecision) continue;
		out[k] = canonicalShape(
			node[k],
			inDecision || (/ApprovalDecision$/.test(k) && key === "definitions"),
			k,
		);
	}
	return out;
}

function shapeHashes(dir: string): Record<string, string> {
	const h = (v: any) =>
		new Bun.CryptoHasher("sha256").update(JSON.stringify(canonicalShape(v))).digest("hex");
	const out: Record<string, string> = {};
	for (const f of SHAPE_ROOTS) out[f] = h(JSON.parse(readFileSync(join(dir, f), "utf8")));
	out.FileChangeThreadItem = h(fileChangeItemSchema(dir));
	out.combined = new Bun.CryptoHasher("sha256")
		.update(JSON.stringify(Object.entries(out)))
		.digest("hex");
	return out;
}

/** Split a shell command line into words: single and double quotes, backslash escapes. No expansion. */
function shellWords(text: string): string[] {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			else current += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "\\" && i + 1 < text.length) current += text[++i];
			else current += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "\\" && i + 1 < text.length) {
			current += text[++i];
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) words.push(current);
			current = "";
			inWord = false;
		} else {
			current += ch;
			inWord = true;
		}
	}
	if (quote) throw new Error(`unterminated quote in: ${text}`);
	if (inWord) words.push(current);
	return words;
}

/** The arguments after `script` in a shown command, looking through one `shell -lc "<command>"` wrapper. */
function argsAfterScript(shown: string, script: string): string[] {
	let words = shellWords(shown);
	if (words.length === 3 && /^-\w*c$/.test(words[1]!)) words = shellWords(words[2]!);
	const at = words.indexOf(script);
	if (at < 0) throw new Error(`${script} is not in the shown command: ${shown}`);
	return words.slice(at + 1);
}

/** TCP listeners, and any `--listen` flag, across a Codex child's process group. */
function listenersIn(pgid: number): { pids: number[]; listeners: string; listenFlag: boolean } {
	const pids = groupPids(pgid);
	const listeners = pids.length
		? spawnSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")], {
				encoding: "utf8",
			}).stdout.trim()
		: "";
	return { pids, listeners, listenFlag: pids.some((pid) => /--listen/.test(argvOf(pid))) };
}

/**
 * The whole path with a real Codex. Everything it touches is under `work` (a scratch directory): the
 * throwaway CODEX_HOME, a HOME for the supervisor's config, the SQLite database, and the project
 * directories Codex runs in. A kill timer ends it whatever happens, and every Codex child is in its own
 * process group, so the shutdown reaches the native binary too.
 */
async function real(workArg: string, minutes: number, only: string[]): Promise<number> {
	const root = assertScratch(workArg);
	const codexHome = join(root, "codex-home");
	const home = join(root, "home");
	for (const dir of [codexHome, home, join(home, ".agentpulse")]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const realAuth = join(homedir(), ".codex", "auth.json");
	if (!existsSync(realAuth))
		throw new Error("no ~/.codex/auth.json to copy; sign in to Codex first");
	copyFileSync(realAuth, join(codexHome, "auth.json"));
	chmodSync(join(codexHome, "auth.json"), 0o600);

	process.env.HOME = home;
	process.env.CODEX_HOME = codexHome;
	process.env.AGENTPULSE_SKIP = "1";
	process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
	process.env.SQLITE_PATH = join(root, "server.db");
	process.env.DATA_DIR = root;
	process.env.AGENTPULSE_CODEX_COMMAND = "";
	// Real model usage and real processes: a hard stop whatever else happens.
	const killTimer = setTimeout(
		() => {
			console.error(`[real] kill timer (${minutes} min) fired; shutting everything down`);
			void cleanup(2);
		},
		minutes * 60 * 1000,
	);

	const results: Record<string, unknown> = {};
	const sessions: string[] = [];
	let server: ReturnType<typeof Bun.serve> | undefined;
	let intervals: Array<ReturnType<typeof setInterval>> = [];
	let dispose: (() => Promise<void>) | undefined;
	let cleaned = false;
	async function cleanup(code: number): Promise<number> {
		if (cleaned) return code;
		cleaned = true;
		clearTimeout(killTimer);
		for (const timer of intervals) clearInterval(timer);
		try {
			await dispose?.();
		} catch {}
		server?.stop(true);
		rmSync(join(codexHome, "auth.json"), { force: true });
		const left = spawnSync("pgrep", ["-f", `${codexHome}|${root}`], { encoding: "utf8" })
			.stdout.split("\n")
			.filter(Boolean)
			.filter((pid) => Number(pid) !== process.pid);
		// Only this run's own Codex processes count: another campaign's `codex exec` may be running on
		// this machine, so a machine-wide check would fail for the wrong reason. Ours are the ones whose
		// environment names our throwaway CODEX_HOME. Nothing is signalled here; this only looks.
		const codexLeft = spawnSync("pgrep", ["-x", "codex"], { encoding: "utf8" })
			.stdout.split("\n")
			.filter(Boolean)
			.filter((pid) =>
				spawnSync("ps", ["-Eww", "-p", pid, "-o", "command="], {
					encoding: "utf8",
				}).stdout.includes(`CODEX_HOME=${codexHome}`),
			);
		console.log(
			JSON.stringify({
				authCopyRemoved: !existsSync(join(codexHome, "auth.json")),
				leftover: left,
				ownCodexLeft: codexLeft,
			}),
		);
		console.log(JSON.stringify({ results }, null, 2));
		if (code === 2) process.exit(2);
		return code;
	}

	try {
		const { config } = await import("../src/server/config.js");
		const { initializeDatabase, getDb } = await import("../src/server/db/client.js");
		await initializeDatabase();
		(config as Record<string, unknown>).disableAuth = false;
		const { app } = await import("../src/server/app.js");
		const { createApiKey } = await import("../src/server/auth/api-key.js");
		const {
			launchRequests,
			codexApprovals,
			managedSessions,
			events,
			sessions: sessionsTable,
			controlActions,
		} = await import("../src/server/db/schema/index.js");
		const team = await import("../src/server/test-utils/team-fixtures.js");
		const { eq, desc } = await import("drizzle-orm");
		const { createReportGate } = await import("../src/supervisor/services/report-gate.js");
		const { createReportOutbox } = await import("../src/supervisor/services/report-outbox.js");
		const { createRulesWatch } = await import("../src/supervisor/services/exclude-rules-watch.js");
		const resilience = await import("../src/supervisor/services/report-resilience.js");
		const approvals = await import("../src/supervisor/providers/codex-approvals.js");
		const managed = await import("../src/supervisor/providers/codex-managed.js");

		server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
		const base = `http://127.0.0.1:${server.port}`;
		process.env.AGENTPULSE_SERVER_URL = base;
		console.log("[real] throwaway server on", base);

		// A person, a manage key to enroll with, and an enrolled host: the real flow over real HTTP.
		const person = await team.seedLocalUser("real-person", "admin");
		const manage = await createApiKey("real-manage", ["manage"]);
		const json = { "Content-Type": "application/json" };
		const supervisorConfigModule = await import("../src/supervisor/config.js");
		const supervisorConfig = await supervisorConfigModule.withExecutableCapabilities(
			supervisorConfigModule.buildDefaultConfig(),
		);
		results.registeredFeatures = supervisorConfig.capabilities.features;
		const enrolled = await fetch(`${base}/api/v1/admin/supervisors/enroll`, {
			method: "POST",
			headers: { ...json, Authorization: `Bearer ${manage.key}` },
			body: JSON.stringify({ name: "real-host" }),
		});
		const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
		const registered = await fetch(`${base}/api/v1/supervisors/register`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({
				hostName: "real-host",
				platform: "macos",
				arch: "arm64",
				version: "1.0.0",
				enrollmentToken,
				// What the real supervisor registers with on this machine, so the server's own feature gates
				// (a Codex host without `codex_follow_up_prompts` is refused prompts) are the ones under test.
				capabilities: supervisorConfig.capabilities,
				trustedRoots: [root],
			}),
		});
		const reg = (await registered.json()) as {
			supervisor: { id: string };
			supervisorCredential: string;
			serverFeatures?: string[];
		};
		const supervisorId = reg.supervisor.id;
		results.serverFeatures = reg.serverFeatures;

		const request = async (path: string, options?: RequestInit) => {
			let res: Response;
			try {
				res = await fetch(`${base}/api/v1${path}`, {
					...options,
					headers: { ...json, "X-AgentPulse-Supervisor-Token": reg.supervisorCredential },
					signal: AbortSignal.timeout(15_000),
				});
			} catch (cause) {
				throw new resilience.SupervisorNetworkError(cause);
			}
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new resilience.SupervisorRequestError(res.status, res.statusText, body.error);
			}
			return res.json();
		};
		const rules = createRulesWatch({ home });
		const gate = createReportGate({
			request,
			supervisorId,
			home,
			version: "real",
			rules,
			outbox: createReportOutbox({ home, supervisorId }),
			credentialTripwire: resilience.createCredentialTripwire({ now: Date.now }),
			onCredentialRejected: async () => {},
		});
		const tracker = approvals.createCodexApprovalTracker({ gate });
		tracker.setServerFeatures(reg.serverFeatures);
		approvals.configureCodexApprovals(tracker);
		intervals = [
			setInterval(() => void tracker.tick().catch(() => {}), 1000),
			setInterval(
				() =>
					void request(`/supervisors/${supervisorId}/heartbeat`, { method: "POST" }).catch(
						() => {},
					),
				20_000,
			),
		];
		dispose = managed.disposeAllManagedCodexRuntimes;

		const personHeaders = async () => {
			const headers = await team.cookieHeadersFor(person.id);
			headers.set("Origin", base);
			headers.set("Content-Type", "application/json");
			return headers;
		};
		const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
		async function until<T>(
			what: string,
			ms: number,
			fn: () => Promise<T | undefined | false> | T,
		) {
			const deadline = Date.now() + ms;
			for (;;) {
				const value = await fn();
				if (value) return value as T;
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
				await sleepMs(500);
			}
		}

		type Plan = {
			name: string;
			decision: "accept" | "decline";
			prompt: (dir: string) => string;
			/** Files to put in the directory before Codex starts. */
			seed?: Record<string, string>;
			/** Read the directory after the answer, for the report. */
			observe?: (dir: string) => unknown;
			/** How long to wait for a request before reporting that none came. */
			askWaitMs?: number;
		};
		const failures: string[] = [];
		const expect = (name: string, ok: unknown, detail?: unknown) => {
			if (!ok) {
				failures.push(name);
				console.error(`[real] FAILED: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
			}
		};
		const listing = (dir: string) =>
			Object.fromEntries(
				readdirSync(dir)
					.filter((name) => name !== ".git")
					.map((name) => [name, readFileSync(join(dir, name), "utf8")]),
			);

		async function scenario(plan: Plan) {
			const { name, decision } = plan;
			const dir = join(root, `project-${name}`);
			mkdirSync(dir, { recursive: true });
			spawnSync("git", ["init", "-q"], { cwd: dir });
			for (const [file, content] of Object.entries(plan.seed ?? {})) {
				writeFileSync(join(dir, file), content);
			}
			const sessionId = `real-${name}-${crypto.randomUUID().slice(0, 6)}`;
			sessions.push(sessionId);
			await getDb()
				.insert(launchRequests)
				.values({
					launchCorrelationId: sessionId,
					agentType: "codex_cli",
					cwd: dir,
					requestedSupervisorId: supervisorId,
					requestedLaunchMode: "managed_codex",
					status: "validated",
					baseInstructions: "",
					taskPrompt: plan.prompt(dir),
				});
			const claim = await request(`/supervisors/${supervisorId}/launches/claim`, {
				method: "POST",
			});
			const launch = (claim as { launchRequest: any }).launchRequest;
			gate.noteLaunch(launch.id, launch.launchCorrelationId, launch.cwd);
			const started = await managed.launchManagedCodexRequest(launch, {
				reportState: (body: any) => gate.reportState(body),
				reportEvents: (events: any) => gate.reportEvents(sessionId, events),
			});
			const out: Record<string, unknown> = { sessionId };
			const verdict = await until("the protocol verdict", 30_000, async () => {
				const [row] = await getDb()
					.select()
					.from(managedSessions)
					.where(eq(managedSessions.sessionId, sessionId));
				return (row?.providerCapabilitySnapshot as any)?.agentpulseApprovals as string | undefined;
			});
			out.verdict = verdict;
			const row = await until(
				"an approval request from real Codex",
				plan.askWaitMs ?? 180_000,
				async () =>
					(
						await getDb()
							.select()
							.from(codexApprovals)
							.where(eq(codexApprovals.sessionId, sessionId))
					)[0],
			).catch((error) => {
				out.asked = false;
				out.sawNoRequest = String(error);
				return undefined;
			});
			if (!row) {
				// What the session's timeline says Codex did instead, cut short.
				const recent = await getDb()
					.select({ type: events.eventType, content: events.content })
					.from(events)
					.where(eq(events.sessionId, sessionId))
					.orderBy(desc(events.id))
					.limit(6);
				out.timeline = recent.map((e) => `${e.type}: ${(e.content ?? "").slice(0, 240)}`);
			}
			if (!row) {
				out.directoryAfter = plan.observe ? plan.observe(dir) : listing(dir);
				await managed.stopManagedCodexSession(sessionId).catch(() => {});
				out.treeAfterStop = await treeAfterStop(started.pid);
				return out;
			}
			out.asked = true;
			// With the request pending, nothing in Codex's tree may be listening on a socket.
			const tree = listenersIn(started.pid);
			out.pendingTree = {
				processes: tree.pids.length,
				tcpListeners: tree.listeners || "none",
				listenFlag: tree.listenFlag,
			};
			expect(
				`${name}: the Codex child's tree is not empty while a request is pending`,
				tree.pids.length > 0,
			);
			expect(
				`${name}: a listening socket in the child's tree`,
				tree.listeners === "",
				tree.listeners,
			);
			expect(`${name}: a --listen flag in the child's tree`, !tree.listenFlag);
			const list = await (
				await fetch(`${base}/api/v1/sessions/${sessionId}/approvals`, {
					headers: await personHeaders(),
				})
			).json();
			const summary = (list as any).approvals[0];
			const detail = (await (
				await fetch(`${base}/api/v1/sessions/${sessionId}/approvals/${summary.id}`, {
					headers: await personHeaders(),
				})
			).json()) as {
				presentation?: {
					command?: string | null;
					changes?: Array<{ path: string; kind: string; movePath: string | null; diff: string }>;
				};
			};
			out.shownCommand = detail.presentation?.command ?? null;
			out.shownDiffs = detail.presentation?.changes?.map((c) => ({
				path: c.path,
				kind: c.kind,
				movePath: c.movePath,
				diff: c.diff,
			}));
			out.shown = {
				approvable: summary.approvable,
				kind: summary.requestKind,
				preview: summary.preview,
				changes: detail.presentation?.changes?.map((c) => ({
					path: c.path.replace(dir, "<dir>"),
					kind: c.kind,
					movePath: c.movePath?.replace(dir, "<dir>") ?? null,
				})),
			};
			const answered = await fetch(
				`${base}/api/v1/sessions/${sessionId}/approvals/${summary.id}/decision`,
				{
					method: "POST",
					headers: await personHeaders(),
					body: JSON.stringify({
						decision,
						...(decision === "accept" ? { presentationHash: summary.presentationHash } : {}),
					}),
				},
			);
			out.answerStatus = answered.status;
			const closed = await until("the row to close", 90_000, async () => {
				const [current] = await getDb()
					.select()
					.from(codexApprovals)
					.where(eq(codexApprovals.id, row.id));
				return current?.status === "closed" ? current : undefined;
			});
			out.closedReason = closed.closedReason;
			// Let a turn that goes on (or a retry) settle before judging the filesystem.
			await sleepMs(decision === "accept" ? 8_000 : 20_000);
			out.directoryAfter = plan.observe ? plan.observe(dir) : listing(dir);
			const all = await getDb()
				.select()
				.from(codexApprovals)
				.where(eq(codexApprovals.sessionId, sessionId));
			out.approvalRows = all.map((r) => ({
				status: r.status,
				closedReason: r.closedReason,
				decision: r.decision,
			}));
			await managed.stopManagedCodexSession(sessionId);
			out.treeAfterStop = await treeAfterStop(started.pid);
			expect(`${name}: processes left after stop`, out.treeAfterStop === "none", out.treeAfterStop);
			return out;
		}
		async function treeAfterStop(pgid: number): Promise<string> {
			const deadline = Date.now() + 15_000;
			for (;;) {
				const left = groupPids(pgid).filter(pidAlive);
				if (left.length === 0) return "none";
				if (Date.now() > deadline) return `still running: ${left.join(",")}`;
				await sleepMs(300);
			}
		}

		const ESCALATE =
			"with escalated permissions (ask for approval, do not try it inside the sandbox first)";
		const command = (name: string, marker: string, decision: "accept" | "decline"): Plan => ({
			name,
			decision,
			prompt: () =>
				`Run exactly this one shell command ${ESCALATE} and then stop. Do not do anything else: touch ${marker}`,
		});
		const patchFor = (file: string, line: string) =>
			["*** Begin Patch", `*** Add File: ${file}`, `+${line}`, "*** End Patch"].join("\n");
		const writeFile = (
			name: string,
			file: string,
			line: string,
			decision: "accept" | "decline",
		): Plan => ({
			name,
			decision,
			prompt: () =>
				`Call apply_patch once, and use no other tool, with exactly this patch text, then stop:\n${patchFor(file, line)}`,
		});
		/**
		 * AGEN-91: a prompt sent to a live Codex session. Everything between the person and Codex is the real
		 * thing: the prompt route, the server's queue, a control-action claim over HTTP, and the supervisor's
		 * own `createControlActionHandler`. A tap on the RPC client records the frames Codex actually sent and
		 * got, so the wire shape is judged against what the app-server did, not against what our code meant.
		 */
		async function followupScenario() {
			const name = "followup";
			const rpc = await import("../src/supervisor/providers/codex-rpc.js");
			const { createControlActionHandler } = await import("../src/supervisor/control-actions.js");
			const claude = await import("../src/supervisor/providers/claude.js");
			const { executeCleanupWorkArea } = await import(
				"../src/supervisor/services/cleanup-workarea.js"
			);
			const { boundaryOf } = await import("../src/server/services/ai/turn-identity.js");
			const { aiWatcherRuns } = await import("../src/server/db/schema/index.js");
			const { and, asc } = await import("drizzle-orm");

			// The tap: observation only, every call goes straight through.
			const wire = { turnStarts: [] as any[], frames: [] as any[] };
			const proto = rpc.RpcClient.prototype as any;
			const originalRequest = proto.request;
			const originalReceive = proto.receive;
			const partial = new WeakMap<object, string>();
			proto.request = function (method: string, params: unknown, ...rest: unknown[]) {
				if (method === "turn/start") wire.turnStarts.push(JSON.parse(JSON.stringify(params)));
				return originalRequest.call(this, method, params, ...rest);
			};
			proto.receive = function (chunk: Uint8Array | string) {
				const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
				const lines = ((partial.get(this) ?? "") + text).split("\n");
				partial.set(this, lines.pop() ?? "");
				for (const line of lines) {
					if (!line.includes('"turn')) continue;
					try {
						const frame = JSON.parse(line);
						if (
							frame.method === "turn/started" ||
							frame.method === "turn/completed" ||
							frame.result?.turn?.id
						) {
							wire.frames.push(frame);
						}
					} catch {}
				}
				return originalReceive.call(this, chunk);
			};

			// The supervisor's control loop: claim over HTTP, hand to the real handler.
			const handler = createControlActionHandler({
				gate,
				trustedRoots: [root],
				providers: {
					stopManagedCodexSession: managed.stopManagedCodexSession,
					promptManagedCodexSession: managed.promptManagedCodexSession,
					hasManagedCodexRuntime: managed.hasManagedCodexRuntime,
					promptClaudeHeadlessSession: claude.promptClaudeHeadlessSession,
					promptClaudeInteractiveSession: claude.promptClaudeInteractiveSession,
				},
				executeCleanupWorkArea,
			});
			const claimedMetadata = new Map<string, string[]>();
			let pumping = false;
			intervals.push(
				setInterval(() => {
					if (pumping) return;
					pumping = true;
					void (async () => {
						try {
							const result = (await request(`/supervisors/${supervisorId}/control-actions/claim`, {
								method: "POST",
							})) as { action: any | null };
							if (!result.action) return;
							claimedMetadata.set(
								result.action.id,
								Object.keys(result.action.metadata ?? {}).sort(),
							);
							await handler(result.action);
						} catch (error) {
							console.error("[real] control loop:", String(error));
						} finally {
							pumping = false;
						}
					})();
				}, 700),
			);

			const dir = join(root, `project-${name}`);
			mkdirSync(dir, { recursive: true });
			spawnSync("git", ["init", "-q"], { cwd: dir });
			const sessionId = `real-${name}-${crypto.randomUUID().slice(0, 6)}`;
			sessions.push(sessionId);
			await getDb().insert(launchRequests).values({
				launchCorrelationId: sessionId,
				agentType: "codex_cli",
				cwd: dir,
				requestedSupervisorId: supervisorId,
				requestedLaunchMode: "managed_codex",
				status: "validated",
				// "on-request" isn't a launchable value; `default` leaves Codex on its own policy, which in this
				// throwaway CODEX_HOME is on-request (the other scenarios rely on the same).
				approvalPolicy: "default",
				sandboxMode: "workspace-write",
				baseInstructions: "",
				taskPrompt: "Reply with the single word ready. Do not run any command or use any tool.",
			});
			const workingNow = async () =>
				(
					await getDb()
						.select({ w: sessionsTable.isWorking })
						.from(sessionsTable)
						.where(eq(sessionsTable.sessionId, sessionId))
				)[0]?.w;
			const out: Record<string, unknown> = { sessionId };
			let sawWorkingInLaunchTurn = false;
			const sampler = setInterval(
				() =>
					void workingNow()
						.then((w) => {
							if (w) sawWorkingInLaunchTurn = true;
						})
						.catch(() => {}),
				200,
			);
			intervals.push(sampler);

			const claim = await request(`/supervisors/${supervisorId}/launches/claim`, {
				method: "POST",
			});
			const launch = (claim as { launchRequest: any }).launchRequest;
			gate.noteLaunch(launch.id, launch.launchCorrelationId, launch.cwd);
			const started = await managed.launchManagedCodexRequest(launch, {
				reportState: (body: any) => gate.reportState(body),
				reportEvents: (batch: any) => gate.reportEvents(sessionId, batch),
			});
			const managedRow = async () =>
				(
					await getDb()
						.select()
						.from(managedSessions)
						.where(eq(managedSessions.sessionId, sessionId))
				)[0];
			out.verdict = await until("the protocol verdict", 30_000, async () => {
				return ((await managedRow())?.providerCapabilitySnapshot as any)?.agentpulseApprovals as
					| string
					| undefined;
			}).catch(() => undefined);

			// The launch turn: working while it runs, idle after, and no turn boundary for a watcher to wake on.
			await until("the launch turn to end", 120_000, async () => {
				return sawWorkingInLaunchTurn && (await workingNow()) === false ? true : undefined;
			}).catch(() => {});
			clearInterval(sampler);
			out.workingDuringLaunchTurn = sawWorkingInLaunchTurn;
			out.workingAfterLaunchTurn = await workingNow();
			const launchEvents = await getDb()
				.select({ type: events.eventType, category: events.category })
				.from(events)
				.where(eq(events.sessionId, sessionId))
				.orderBy(asc(events.id));
			out.launchTurnEventTypes = launchEvents.map((e) => e.type);
			out.launchTurnBoundaries = launchEvents
				.filter((e) => boundaryOf({ eventType: e.type, category: e.category }) !== null)
				.map((e) => e.type);
			out.watcherRunsAfterLaunch = (
				await getDb().select().from(aiWatcherRuns).where(eq(aiWatcherRuns.sessionId, sessionId))
			).length;
			const processStart = () =>
				spawnSync("ps", ["-o", "lstart=", "-p", String(started.pid)], {
					encoding: "utf8",
				}).stdout.trim();
			const pidBefore = started.pid;
			const startedBefore = processStart();

			const prompt = `Run exactly this one shell command ${ESCALATE} and then stop. Do not do anything else: touch followup-declined.txt`;
			const sendPrompt = async (text: string) => {
				const res = await fetch(`${base}/api/v1/sessions/${sessionId}/prompt`, {
					method: "POST",
					headers: await personHeaders(),
					body: JSON.stringify({ prompt: text }),
				});
				return { status: res.status, body: (await res.json().catch(() => null)) as any };
			};
			const finalAction = (id: string, ms: number) =>
				until(`control action ${id} to finish`, ms, async () => {
					const [row] = await getDb()
						.select()
						.from(controlActions)
						.where(eq(controlActions.id, id));
					return row && (row.status === "succeeded" || row.status === "failed") ? row : undefined;
				});

			const first = await sendPrompt(prompt);
			out.promptRouteStatus = first.status;
			const firstAction = first.body?.action?.id
				? await finalAction(first.body.action.id, 60_000).catch(() => undefined)
				: undefined;
			out.actionStatus = firstAction?.status;
			out.actionError = firstAction?.error ?? null;
			out.actionMetadataAfter = firstAction?.metadata ?? null;
			out.queuedMetadataKeys = first.body?.action?.id
				? (claimedMetadata.get(first.body.action.id) ?? null)
				: null;

			const row = await until("an approval request in the follow-up turn", 180_000, async () => {
				return (
					await getDb().select().from(codexApprovals).where(eq(codexApprovals.sessionId, sessionId))
				)[0];
			}).catch((error) => {
				out.asked = false;
				out.sawNoRequest = String(error);
				return undefined;
			});
			if (!row) {
				const recent = await getDb()
					.select({ type: events.eventType, content: events.content })
					.from(events)
					.where(eq(events.sessionId, sessionId))
					.orderBy(desc(events.id))
					.limit(6);
				out.timeline = recent.map((e) => `${e.type}: ${(e.content ?? "").slice(0, 240)}`);
			} else {
				out.asked = true;
				out.workingWhilePending = await workingNow();
				const detail = (await (
					await fetch(`${base}/api/v1/sessions/${sessionId}/approvals/${row.id}`, {
						headers: await personHeaders(),
					})
				).json()) as { presentation?: { cwd?: string | null; command?: string | null } };
				out.shownCwd = detail.presentation?.cwd ?? null;
				out.shownCommand = detail.presentation?.command ?? null;

				// A second prompt while the turn is pending: refused by the host that holds the thread.
				const second = await sendPrompt("Say hello.");
				out.secondPromptRouteStatus = second.status;
				const secondAction = second.body?.action?.id
					? await finalAction(second.body.action.id, 30_000).catch(() => undefined)
					: undefined;
				out.secondActionStatus = secondAction?.status;
				out.secondActionError = secondAction?.error ?? null;

				const list = (await (
					await fetch(`${base}/api/v1/sessions/${sessionId}/approvals`, {
						headers: await personHeaders(),
					})
				).json()) as any;
				const answered = await fetch(
					`${base}/api/v1/sessions/${sessionId}/approvals/${list.approvals[0].id}/decision`,
					{
						method: "POST",
						headers: await personHeaders(),
						body: JSON.stringify({ decision: "decline" }),
					},
				);
				out.declineStatus = answered.status;
				await until("the row to close", 90_000, async () => {
					const [current] = await getDb()
						.select()
						.from(codexApprovals)
						.where(eq(codexApprovals.id, row.id));
					return current?.status === "closed" ? current : undefined;
				}).catch(() => {});
			}

			// The end of the turn: an event, then the working flag clears.
			const ended = await until("the follow-up turn's end event", 120_000, async () =>
				(await getDb().select().from(events).where(eq(events.sessionId, sessionId))).find(
					(e) =>
						e.eventType === "HeadlessPromptCompleted" || e.eventType === "HeadlessPromptFailed",
				),
			).catch(() => undefined);
			out.endEvent = ended ? { type: ended.eventType, content: ended.content } : null;
			await until("the working flag to clear", 30_000, async () =>
				(await workingNow()) === false ? true : undefined,
			).catch(() => {});
			await sleepMs(3_000);
			out.workingAfterDecline = await workingNow();
			out.directoryAfter = listing(dir);

			const allEvents = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
			out.submittedRows = allEvents
				.filter((e) => e.eventType === "HeadlessPromptSubmitted")
				.map((e) => e.content);
			out.pid = {
				before: pidBefore,
				startedBefore,
				startedAfter: processStart(),
				alive: pidAlive(started.pid),
			};
			out.threadId = (await managedRow())?.providerThreadId ?? null;
			out.wire = {
				turnStartParamKeys: wire.turnStarts.map((p) => Object.keys(p).sort()),
				followUpInput: wire.turnStarts[1]?.input ?? null,
				frames: wire.frames.map((f) =>
					f.method
						? {
								method: f.method,
								paramKeys: Object.keys(f.params ?? {}).sort(),
								turnKeys: Object.keys(f.params?.turn ?? {}).sort(),
								threadId: f.params?.threadId ?? null,
								turnId: f.params?.turn?.id ?? null,
								status: f.params?.turn?.status ?? null,
							}
						: { responseTurnId: f.result.turn.id, resultKeys: Object.keys(f.result).sort() },
				),
			};

			// Put the client back as it was, then stop the session.
			proto.request = originalRequest;
			proto.receive = originalReceive;
			await managed.stopManagedCodexSession(sessionId).catch(() => {});
			out.treeAfterStop = await treeAfterStop(started.pid);
			expect(`${name}: processes left after stop`, out.treeAfterStop === "none", out.treeAfterStop);

			// ---- assertions ----
			expect(
				`${name}: the protocol verdict is supported`,
				out.verdict === "supported",
				out.verdict,
			);
			expect(
				`${name}: the host registered with codex_follow_up_prompts`,
				(supervisorConfig.capabilities.features as string[]).includes("codex_follow_up_prompts"),
				supervisorConfig.capabilities.features,
			);
			expect(
				`${name}: isWorking was true during the launch turn`,
				out.workingDuringLaunchTurn === true,
			);
			expect(
				`${name}: isWorking was false after the launch turn`,
				out.workingAfterLaunchTurn === false,
			);
			expect(
				`${name}: the launch turn wrote no turn boundary`,
				(out.launchTurnBoundaries as string[]).length === 0,
				out.launchTurnBoundaries,
			);
			expect(`${name}: no watcher run was queued`, out.watcherRunsAfterLaunch === 0);
			expect(`${name}: the prompt route accepted the prompt`, first.status === 202, first.body);
			expect(`${name}: the action succeeded`, out.actionStatus === "succeeded", out.actionError);
			const metaAfter = (out.actionMetadataAfter ?? {}) as Record<string, unknown>;
			expect(
				`${name}: the action carries a turnId and the thread`,
				typeof metaAfter.turnId === "string" &&
					metaAfter.turnId !== "" &&
					metaAfter.threadId === out.threadId,
				metaAfter,
			);
			const queuedKeys = (out.queuedMetadataKeys ?? []) as string[];
			expect(
				`${name}: the queued metadata names no env, approvalPolicy, sandboxMode or model`,
				out.queuedMetadataKeys !== null &&
					["env", "approvalPolicy", "sandboxMode", "model"].every((k) => !queuedKeys.includes(k)),
				out.queuedMetadataKeys,
			);
			expect(
				`${name}: exactly one HeadlessPromptSubmitted, with the prompt's text`,
				JSON.stringify(out.submittedRows) === JSON.stringify([prompt]),
				out.submittedRows,
			);
			expect(
				`${name}: Codex asked for approval in the follow-up turn`,
				out.asked === true,
				out.sawNoRequest ?? out.timeline,
			);
			if (out.asked === true) {
				const real = (p: string) => {
					try {
						return realpathSync(p);
					} catch {
						return p;
					}
				};
				expect(
					`${name}: the approval's presentation.cwd is the launch directory`,
					typeof out.shownCwd === "string" && real(out.shownCwd as string) === real(dir),
					{ shown: out.shownCwd, launch: dir },
				);
				expect(
					`${name}: isWorking was true while the approval was pending`,
					out.workingWhilePending === true,
				);
				expect(
					`${name}: a second prompt while pending was refused with the busy message`,
					out.secondActionStatus === "failed" &&
						String(out.secondActionError).includes("hasn't ended its current turn"),
					{
						route: out.secondPromptRouteStatus,
						status: out.secondActionStatus,
						error: out.secondActionError,
					},
				);
				expect(`${name}: the decline was accepted`, out.declineStatus === 200, out.declineStatus);
			}
			expect(
				`${name}: no file after the decline`,
				!has(out, "followup-declined.txt"),
				out.directoryAfter,
			);
			expect(`${name}: a turn-end event was written`, out.endEvent !== null, out.endEvent);
			expect(`${name}: isWorking is false after the decline`, out.workingAfterDecline === false);
			const pid = out.pid as any;
			expect(
				`${name}: the Codex process is the same across both turns`,
				pid.alive === true && pid.startedBefore !== "" && pid.startedBefore === pid.startedAfter,
				pid,
			);

			// The wire, against what Codex really sent and the recorded 0.163 fixture.
			const fixtureFrames = readFileSync(
				join(
					import.meta.dir,
					"../src/supervisor/providers/__fixtures__/codex-0.163/command-accept.jsonl",
				),
				"utf8",
			)
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line).frame)
				.filter(Boolean);
			const fixtureStart = fixtureFrames.find((f: any) => f.method === "turn/start")?.params;
			const fixtureDone = fixtureFrames.find((f: any) => f.method === "turn/completed")?.params;
			const keys = (o: unknown) => Object.keys((o ?? {}) as object).sort();
			const [launchStart, followStart] = wire.turnStarts;
			expect(
				`${name}: two turn/start requests went out`,
				wire.turnStarts.length === 2,
				wire.turnStarts.length,
			);
			expect(
				`${name}: the follow-up's turn/start is exactly {threadId, input}`,
				JSON.stringify(keys(followStart)) === JSON.stringify(["input", "threadId"]) &&
					followStart?.threadId === out.threadId &&
					JSON.stringify(followStart?.input) === JSON.stringify([{ type: "text", text: prompt }]),
				followStart,
			);
			expect(
				`${name}: the launch's turn/start has the keys the 0.163 fixture recorded`,
				JSON.stringify(keys(launchStart)) === JSON.stringify(keys(fixtureStart)),
				{ live: keys(launchStart), fixture: keys(fixtureStart) },
			);
			expect(
				`${name}: the follow-up's input item has the fixture's shape`,
				JSON.stringify(keys(followStart?.input?.[0])) ===
					JSON.stringify(keys(fixtureStart?.input?.[0])),
				{ live: keys(followStart?.input?.[0]), fixture: keys(fixtureStart?.input?.[0]) },
			);
			const turnId = String(metaAfter.turnId ?? "");
			const completed = wire.frames.find(
				(f) => f.method === "turn/completed" && f.params?.turn?.id === turnId,
			);
			expect(
				`${name}: Codex's turn/completed for the follow-up carries the thread id at params.threadId`,
				completed?.params?.threadId === out.threadId,
				completed
					? { threadId: completed.params?.threadId }
					: "no turn/completed with that turn id",
			);
			expect(
				`${name}: turn/completed has at least the fixture's params and turn keys`,
				completed !== undefined &&
					keys(fixtureDone).every((k) => keys(completed.params).includes(k)) &&
					keys(fixtureDone?.turn).every((k) => keys(completed.params.turn).includes(k)),
				{
					live: [keys(completed?.params), keys(completed?.params?.turn)],
					fixture: [keys(fixtureDone), keys(fixtureDone?.turn)],
				},
			);
			expect(
				`${name}: turn/start's reply names the turn the action reported`,
				wire.frames.some((f) => f.result?.turn?.id === turnId),
			);
			return out;
		}

		const ARGV_SCRIPT = 'printf "%s\\n" "$0" "$@" > argv-out.txt\n';
		const run = async (id: string, plan: () => Plan) =>
			only.includes(id) ? await scenario(plan()) : { skipped: true };
		const every = (name: string, out: any) => {
			if (out.skipped) return;
			expect(
				`${name}: the protocol verdict is supported`,
				out.verdict === "supported",
				out.verdict,
			);
			expect(
				`${name}: Codex asked for approval`,
				out.asked === true,
				out.sawNoRequest ?? out.timeline,
			);
			expect(
				`${name}: the answer was accepted by the server`,
				out.answerStatus === 200,
				out.answerStatus,
			);
		};
		const has = (out: any, file: string) => Object.hasOwn(out.directoryAfter ?? {}, file);

		results.argv = await run("argv", () => ({
			name: "argv",
			decision: "accept",
			seed: { "argv.sh": ARGV_SCRIPT },
			prompt: () =>
				`Run exactly this shell command ${ESCALATE}, do not do anything else: sh argv.sh alpha 'beta gamma' delta`,
		}));
		results.decline = await run("decline", () => command("decline", "declined.txt", "decline"));
		results.fileChangeAccept = await run("fc-accept", () =>
			writeFile("fc-accept", "fc-accepted.txt", "hello from the real run", "accept"),
		);
		results.fileChangeDecline = await run("fc-decline", () =>
			writeFile("fc-decline", "fc-declined.txt", "should never exist", "decline"),
		);
		results.fileChangePatch = await run("fc-patch", () => ({
			name: "fc-patch",
			decision: "accept",
			seed: {
				"update-me.txt": "line one\nline two\nline three\n",
				"move-me.txt": "move me\n",
				"delete-me.txt": "delete me\n",
			},
			prompt: () =>
				[
					"Make all three changes in ONE apply_patch call, and use no other tool, with exactly this patch text:",
					"*** Begin Patch",
					"*** Update File: update-me.txt",
					"@@",
					" line one",
					"-line two",
					"+LINE TWO CHANGED",
					" line three",
					"*** Update File: move-me.txt",
					"*** Move to: moved.txt",
					"@@",
					"-move me",
					"+moved me",
					"*** Delete File: delete-me.txt",
					"*** End Patch",
					"Then stop.",
				].join("\n"),
		}));

		results.followup = only.includes("followup") ? await followupScenario() : { skipped: true };

		const argv = results.argv as any;
		every("argv", argv);
		if (!argv.skipped && argv.asked) {
			const written = String(argv.directoryAfter?.["argv-out.txt"] ?? "").split("\n");
			written.pop();
			try {
				const shownArgs = argsAfterScript(String(argv.shownCommand), "argv.sh");
				argv.shownArgs = shownArgs;
				expect("argv: $0 is the script the person was shown", written[0] === "argv.sh", written);
				expect(
					"argv: the command wrote exactly the arguments it was shown",
					JSON.stringify(written.slice(1)) === JSON.stringify(shownArgs),
					{ shown: shownArgs, wrote: written.slice(1) },
				);
			} catch (error) {
				expect("argv: the shown command could not be read", false, String(error));
			}
			expect("argv: the row closed applied", argv.closedReason === "applied", argv.closedReason);
		}

		const decline = results.decline as any;
		every("decline", decline);
		if (!decline.skipped) {
			expect("decline: no effect", !has(decline, "declined.txt"), decline.directoryAfter);
		}

		const fcAccept = results.fileChangeAccept as any;
		every("fc-accept", fcAccept);
		if (!fcAccept.skipped && fcAccept.asked) {
			const shown = fcAccept.shownDiffs?.[0];
			expect("fc-accept: shown as a file change", fcAccept.shown?.kind === "file_change");
			expect(
				"fc-accept: one add of the expected file",
				fcAccept.shownDiffs?.length === 1 && shown?.kind === "add",
			);
			expect(
				"fc-accept: the file's content equals the diff the person was shown",
				shown !== undefined && fcAccept.directoryAfter?.["fc-accepted.txt"] === shown.diff,
				{ shown: shown?.diff, wrote: fcAccept.directoryAfter?.["fc-accepted.txt"] },
			);
		}

		const fcDecline = results.fileChangeDecline as any;
		every("fc-decline", fcDecline);
		if (!fcDecline.skipped) {
			expect("fc-decline: shown as a file change", fcDecline.shown?.kind === "file_change");
			expect("fc-decline: no effect", !has(fcDecline, "fc-declined.txt"), fcDecline.directoryAfter);
		}

		const patch = results.fileChangePatch as any;
		every("fc-patch", patch);
		if (!patch.skipped && patch.asked) {
			const kinds = (patch.shownDiffs ?? []).map((c: any) => c.kind).sort();
			expect(
				"fc-patch: the person saw an update, a move and a delete",
				kinds.join() === "delete,update,update",
				kinds,
			);
			const after = patch.directoryAfter ?? {};
			expect(
				"fc-patch: the update landed",
				after["update-me.txt"] === "line one\nLINE TWO CHANGED\nline three\n",
				after["update-me.txt"],
			);
			expect(
				"fc-patch: the file moved",
				has(patch, "moved.txt") && !has(patch, "move-me.txt"),
				Object.keys(after),
			);
			expect("fc-patch: the file was deleted", !has(patch, "delete-me.txt"), Object.keys(after));
		}

		results.failures = failures;
		results.ok = failures.length === 0;
		return await cleanup(results.ok ? 0 : 1);
	} catch (error) {
		results.error = String(error instanceof Error ? error.stack : error);
		return await cleanup(1);
	}
}

if (flag("--real")) {
	const only = realScenarioIds(opt("--only"));
	process.exit(await real(opt("--work") ?? "", Number(opt("--minutes") ?? 12), only));
} else if (flag("--parent-helper")) {
	const i = args.indexOf("--parent-helper");
	await parentHelper(args[i + 1]!, args[i + 2]!);
} else if (flag("--spike")) {
	const work = assertScratch(opt("--work") ?? "");
	const raw = assertScratch(opt("--raw") ?? "");
	const only = (opt("--only") ?? Object.keys(scenarios).join(",")).split(",");
	for (const id of only) {
		const sc = scenarios[id];
		if (!sc) {
			console.log("unknown scenario", id);
			continue;
		}
		console.log(`=== ${id}`);
		const killer = setTimeout(() => {
			console.log(`KILL TIMER ${id}`);
			for (const live of liveSessions) live.stop();
			process.exit(9);
		}, sc.killMs);
		try {
			const obs = await sc.run({ work, raw });
			console.log(id, JSON.stringify(obs).slice(0, 1500));
		} catch (e) {
			console.log(id, "ERROR", String(e));
		}
		clearTimeout(killer);
	}
	process.exit(0);
} else if (flag("--schema-hash")) {
	console.log(JSON.stringify(shapeHashes(opt("--schema-hash")!), null, 2));
} else if (flag("--schema-subset")) {
	const src = opt("--schema-subset")!;
	const out = opt("--out")!;
	mkdirSync(join(out, "v2"), { recursive: true });
	for (const f of [...SHAPE_ROOTS, "ServerRequest.json"]) {
		writeFileSync(
			join(out, f),
			`${JSON.stringify(JSON.parse(readFileSync(join(src, f), "utf8")), null, 1)}\n`,
		);
	}
	writeFileSync(
		join(out, "FileChangeThreadItem.json"),
		`${JSON.stringify(fileChangeItemSchema(src), null, 1)}\n`,
	);
	const methods = JSON.parse(readFileSync(join(src, "ServerRequest.json"), "utf8"))
		.oneOf.map((v: any) => v.properties.method.enum[0])
		.sort();
	writeFileSync(join(out, "..", "methods.json"), `${JSON.stringify(methods, null, 1)}\n`);
	writeFileSync(join(out, "shape-hashes.json"), `${JSON.stringify(shapeHashes(src), null, 1)}\n`);
} else if (flag("--scrub")) {
	const raw = assertScratch(opt("--raw") ?? "");
	const out = opt("--out")!;
	const work = assertScratch(opt("--work") ?? "");
	const keep = new Set(args.includes("--keep") ? (opt("--keep") ?? "").split(",") : []);
	mkdirSync(out, { recursive: true });
	for (const f of readdirSync(raw).filter((n) => n.endsWith(".jsonl"))) {
		const rawName = f.replace(/\.jsonl$/, "");
		const FIXTURE_NAMES: Record<string, string> = {
			S4: "file-change-accept",
			S5: "file-change-update-accept",
			S7: "file-change-decline-cancel",
			S8: "command-cancel",
			S9: "permissions-empty-grant",
			S10: "user-input-empty-answers",
			S11: "tool-call-refusal",
			S11b: "elicitation-decline",
			S12: "error-32601",
			S13: "default-policy",
			S14: "rename-while-pending",
			S16: "argv-equals-shown",
		};
		const name = FIXTURE_NAMES[rawName] ?? rawName;
		if (["S1", "S2", "S3", "S3a", "S3b", "S19"].includes(rawName)) continue;
		if (keep.size && !keep.has(name)) continue;
		const ctx = { work, uuids: new Map<string, string>() };
		const lines = readFileSync(join(raw, f), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Frame);
		const KEEP_NOTIFICATIONS =
			/^(serverRequest\/resolved|item\/(started|completed)|item\/fileChange\/patchUpdated|turn\/(started|completed|diff\/updated)|thread\/(started|name\/updated))$/;
		const kept = lines
			.filter((l) => l.frame && !l.frame._marker && !l.frame._event)
			.filter((l) => {
				const f = l.frame;
				const m = f.method as string | undefined;
				if (m && "id" in f) return true; // client request, or a server request
				if (m) {
					if (!KEEP_NOTIFICATIONS.test(m)) return false;
					const t = f.params?.item?.type;
					return t !== "reasoning";
				}
				// A response: keep initialize's (user agent) and anything we answered with.
				return l.dir === "out" || f.result?.userAgent !== undefined;
			});
		const text = kept
			.map((l) => JSON.stringify(scrub({ dir: l.dir, frame: l.frame }, ctx)))
			.join("\n");
		writeFileSync(join(out, `${name}.jsonl`), `${text}\n`);
		console.log("wrote", name, kept.length);
	}
}
