/**
 * The live canary scenarios of AGEN-121 (MCP tools on a continued Claude session). Each runs against a real
 * Claude Code, a real supervisor wiring and the real server routes, with a throwaway MCP server of this
 * file's own and a throwaway fork MCP file inside the scenario's own home: the person's real
 * `~/.agentpulse/claude-fork-mcp.json` is never read (the host is told where to look with `configureForkMcp`).
 *
 *  - `mcp-approve`: the card shows the call; after accept the server's log holds exactly the shown input; the
 *    init names exactly the applied server, with a user-scope server sitting in the throwaway `.claude.json`
 *    (the strict flag keeps it out).
 *  - `mcp-decline`: a declined call never reaches the server; an accepted one does (the control).
 *  - `mcp-file-changed`: the file is edited between takeover and recovery, and Resume is refused
 *    `mcp_servers_changed` (an unedited file resumes: the control).
 *  - `mcp-end-session`: End leaves no process of the run, the MCP server included (the server was listed as a
 *    descendant of this run's Claude before).
 *
 * Nothing here signals a process except `killOwnClaudeProcesses`, which selects by this run's exact
 * CLAUDE_CONFIG_DIR. An MCP server's pid is only ever asked about (signal 0), and is found only as a
 * descendant of a pid this run started.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configureForkMcp } from "../../src/supervisor/providers/claude-fork-mcp.js";
import { killOwnClaudeProcesses, ownClaudePids } from "../lib/claude-own-pids.js";
import {
	type Any,
	type Host,
	type Judge,
	type Recorder,
	type Run,
	type ScenarioFn,
	actionFor,
	answerNext,
	approvalRows,
	cardAnswered,
	initLines,
	insertObserved,
	makeSource,
	managedRow,
	pidAlive,
	post,
	promptAndWait,
	resultCount,
	sawToolUse,
	sessionRow,
	sleep,
	startHost,
	until,
} from "./helpers.js";

export const T121_SCENARIO_IDS = [
	"mcp-approve",
	"mcp-decline",
	"mcp-file-changed",
	"mcp-end-session",
] as const;

// ── The throwaway MCP server ────────────────────────────────────────────────

/**
 * A stdio MCP server that writes one `started` line (its pid, its parent and the config directory it was
 * given) and one line per tool call to the log named by its first argument. Reading that log is how a scenario
 * knows what reached the server.
 */
const PROBE_SERVER = `const fs = require("node:fs");
const log = process.argv[2];
const note = (value) => fs.appendFileSync(log, JSON.stringify(value) + "\\n");
note({ started: true, pid: process.pid, ppid: process.ppid, configDir: process.env.CLAUDE_CONFIG_DIR ?? null });
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let at;
	while ((at = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, at);
		buffer = buffer.slice(at + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
});
function handle(m) {
	if (m.method === "initialize") {
		send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
	} else if (m.method === "tools/list") {
		send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo_note", description: "Writes the note to the server's log", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
	} else if (m.method === "tools/call") {
		note({ call: m.params.name, args: m.params.arguments });
		send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "note written" }] } });
	} else if (m.id !== undefined) {
		send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
	}
}
setInterval(() => {}, 1 << 30);
`;

interface ProbeFiles {
	script: string;
	log: string;
	userLog: string;
}

function probeFiles(host: Host): ProbeFiles {
	return {
		script: join(host.home, "bin", "mcp-probe.js"),
		log: join(host.home, "mcp-probe.log"),
		userLog: join(host.home, "mcp-user.log"),
	};
}

/** The person's fork MCP file: one server, `probe`, in the throwaway home. */
function writeForkFile(host: Host, files: ProbeFiles, extraEnv: Record<string, string> = {}): void {
	mkdirSync(join(host.home, "bin"), { recursive: true, mode: 0o700 });
	writeFileSync(files.script, PROBE_SERVER, { mode: 0o600 });
	const path = join(host.home, ".agentpulse", "claude-fork-mcp.json");
	writeFileSync(
		path,
		JSON.stringify({
			mcpServers: {
				probe: {
					command: process.execPath,
					args: [files.script, files.log],
					...(Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {}),
				},
			},
		}),
		{ mode: 0o600 },
	);
	chmodSync(path, 0o600);
}

/** A user-scope server in the throwaway `.claude.json`: what `--strict-mcp-config` must keep out. */
function plantUserServer(host: Host, files: ProbeFiles): void {
	const path = join(host.cfg, ".claude.json");
	const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	writeFileSync(
		path,
		JSON.stringify({
			...current,
			mcpServers: {
				...(current.mcpServers ?? {}),
				usersrv: { command: process.execPath, args: [files.script, files.userLog] },
			},
		}),
	);
}

const readLog = (path: string): Any[] => {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
};
const startedIn = (path: string): Any | null => readLog(path).find((e) => e.started) ?? null;
const callsIn = (path: string): Any[] => readLog(path).filter((e) => e.call);

/** Every descendant of `roots` (pids this run started), with its command line, by walking `ps`. */
function descendantsOf(roots: number[]): Array<{ pid: number; command: string }> {
	const listing = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
		encoding: "utf8",
		maxBuffer: 1 << 26,
	}).stdout;
	const children = new Map<number, number[]>();
	const commands = new Map<number, string>();
	for (const line of listing.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const pid = Number(m[1]);
		commands.set(pid, m[3] as string);
		children.set(Number(m[2]), [...(children.get(Number(m[2])) ?? []), pid]);
	}
	const found: Array<{ pid: number; command: string }> = [];
	const seen = new Set<number>();
	const walk = (pid: number) => {
		for (const child of children.get(pid) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			found.push({ pid: child, command: commands.get(child) ?? "" });
			walk(child);
		}
	};
	for (const root of roots) walk(root);
	return found;
}

// ── Mutations (see t121-mutations.ts) ───────────────────────────────────────

/** Rewrites the argv the fork is started with, for the mutations that break the host's own argv. */
export function mcpMutatedArgs(mutation: string | null, args: string[]): string[] {
	if (mutation === "mcp-no-strict") return args.filter((a) => a !== "--strict-mcp-config");
	if (mutation === "mcp-allow-rule") {
		// The host adds an allow rule for the tool beside its own ask rules, in the same inline settings.
		const out = [...args];
		const at = out.indexOf("--settings");
		if (at >= 0 && typeof out[at + 1] === "string") {
			const settings = JSON.parse(out[at + 1] as string);
			settings.permissions = {
				...settings.permissions,
				allow: ["mcp__probe__echo_note"],
			};
			out[at + 1] = JSON.stringify(settings);
		}
		return out;
	}
	return args;
}

let rewriteSentinel: string | null = null;
let skipInitMcpCheck = false;
let wirePatched = false;

/** Installs the two wire-level breaks once; they act only while a scenario has switched them on. */
async function patchOnce(): Promise<void> {
	if (wirePatched) return;
	wirePatched = true;
	const { ClaudeLink } = await import("../../src/supervisor/providers/claude-wire.js");
	const proto = ClaudeLink.prototype as Any;
	const originalWrite = proto.writeLine;
	proto.writeLine = function (line: string) {
		let sent = line;
		if (rewriteSentinel !== null) {
			try {
				const parsed = JSON.parse(line);
				const body = parsed?.response?.response;
				if (
					parsed?.type === "control_response" &&
					body?.behavior === "allow" &&
					typeof body.updatedInput?.text === "string"
				) {
					body.updatedInput.text = body.updatedInput.text.replaceAll(
						rewriteSentinel,
						`${rewriteSentinel}-REWRITTEN`,
					);
					sent = JSON.stringify(parsed);
				}
			} catch {}
		}
		return originalWrite.call(this, sent);
	};
	const { ClaudeStreamRuntime } = await import("../../src/supervisor/providers/claude-stream.js");
	const runtimeProto = ClaudeStreamRuntime.prototype as Any;
	const originalProblem = runtimeProto.firstPromptProblem;
	runtimeProto.firstPromptProblem = function (init: Any) {
		const problem = originalProblem.call(this, init);
		return skipInitMcpCheck && (problem === "tools" || problem === "mcp_servers") ? null : problem;
	};
}

async function armMutation(run: Run, rec: Recorder): Promise<() => void> {
	await patchOnce();
	if (run.mutation === "mcp-rewrite-input") rewriteSentinel = rec.sentinel;
	if (run.mutation === "mcp-no-strict") skipInitMcpCheck = true;
	return () => {
		rewriteSentinel = null;
		skipInitMcpCheck = false;
	};
}

// ── The shared setup ────────────────────────────────────────────────────────

async function bindWithMcp(run: Run, host: Host, sourceId: string) {
	const sent = await post(run, `/sessions/${sourceId}/bind`, {
		targetSupervisorId: host.supervisorId,
		sameMachineConfirmed: true,
		forkOptions: { mcp: true },
	});
	if (sent.status !== 202) {
		return {
			status: sent.status,
			action: null as Any,
			fork: null,
			error: JSON.stringify(sent.body),
		};
	}
	const action = await until("the takeover to settle", 150_000, async () => {
		const row = await actionFor(run, sourceId, "resume");
		return row && (row.status === "succeeded" || row.status === "failed") ? row : undefined;
	}).catch(() => actionFor(run, sourceId, "resume"));
	return {
		status: 202,
		action,
		fork: ((action?.metadata as Any)?.forkSessionId as string | undefined) ?? null,
		error: action?.error as string | undefined,
	};
}

interface McpWorld {
	host: Host;
	n: string;
	files: ProbeFiles;
	cfgPath: string;
	done: () => Promise<void>;
}

/** A host with the fork file, a source session, and the source taken over with the MCP option on. */
async function mcpPrelude(
	run: Run,
	rec: Recorder,
	judge: Judge,
	name: string,
	options: { userServer?: boolean } = {},
): Promise<McpWorld | null> {
	const disarm = await armMutation(run, rec);
	const host = await startHost(run, name, "login");
	const files = probeFiles(host);
	const done = async () => {
		disarm();
		configureForkMcp(null);
		await host.dispose();
	};
	try {
		writeForkFile(host, files);
		configureForkMcp({ agentpulseDir: join(host.home, ".agentpulse") });
		const s = makeSource(run, host, rec.sentinel, "Reply with just: ready");
		if (!judge.instrument("S was made under the throwaway config", s.id, s.why)) {
			await done();
			return null;
		}
		if (options.userServer) plantUserServer(host, files);
		await insertObserved(run, s, "canary S");
		const taken = await bindWithMcp(run, host, s.id as string);
		if (!judge.pre("the takeover succeeded", taken.action?.status === "succeeded", taken.error)) {
			await done();
			return null;
		}
		const n = taken.fork as string;
		const stored = ((await sessionRow(run, n))?.metadata as Any)?.forkOptions;
		if (
			!judge.pre(
				"the takeover applied exactly the fork file's server",
				Array.isArray(stored?.mcpServers) &&
					stored.mcpServers.length === 1 &&
					stored.mcpServers[0].name === "probe",
				stored,
			)
		) {
			await done();
			return null;
		}
		judge.pre("the server started and its log is readable", startedIn(files.log) !== null);
		return { host, n, files, cfgPath: host.cfg, done };
	} catch (error) {
		await done();
		throw error;
	}
}

const callPrompt = (sentinel: string, tag: string) =>
	`Call the MCP tool echo_note (its full name is mcp__probe__echo_note) exactly once with text "${sentinel}-${tag}". Do nothing else, then reply: done`;

const NAMES = {
	cardAppeared: "a card appeared for the MCP call",
	initExact: "the init names exactly the applied server",
	shownInput: "the card shows the call's input as Claude sent it",
	logExact: "the server's log holds exactly the shown input",
	neverReceived: "declined: the server never received the call",
	refused: "the changed file refuses the resume as mcp_servers_changed",
	noneLeft: "nothing of the run is left after End",
} as const;

// ── Scenarios ───────────────────────────────────────────────────────────────

export const T121_SCENARIOS: Record<(typeof T121_SCENARIO_IDS)[number], ScenarioFn> = {
	async "mcp-approve"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const world = await mcpPrelude(run, rec, judge, "mcp-approve", { userServer: true });
		if (!world) return out;
		try {
			void promptAndWait(run, rec, world.n, callPrompt(rec.sentinel, "a"));
			if (
				!judge.instrument(
					"Claude called the MCP tool",
					await sawToolUse(rec, "mcp__probe__echo_note", rec.sentinel),
					rec.apiFailure,
				)
			) {
				return out;
			}
			const init = initLines(rec).at(-1) as Any;
			const loaded: string[] = (init?.mcp_servers ?? []).map((s: Any) => s.name);
			out.mcpServers = loaded;
			judge.claim(NAMES.initExact, loaded.length === 1 && loaded[0] === "probe", loaded);

			const answered = await answerNext(run, world.n, "accept", new Set<string>(), 30_000);
			judge.claim(NAMES.cardAppeared, cardAnswered(answered));
			const presentation = answered?.detail?.presentation as Any;
			const sent = [...rec.inputs.values()].at(-1) as Any;
			let shown: Any = null;
			try {
				shown = JSON.parse(String(presentation?.target ?? ""));
			} catch {}
			judge.claim(
				"the card names the server, the tool and the raw name, by the server's own split",
				presentation?.mcp?.server === "probe" &&
					presentation?.mcp?.tool === "echo_note" &&
					presentation?.mcp?.rawToolName === "mcp__probe__echo_note",
				presentation?.mcp,
			);
			judge.claim(NAMES.shownInput, JSON.stringify(shown) === JSON.stringify(sent), {
				shown,
				sent,
			});
			await until("the turn to end", 90_000, () => resultCount(rec) >= 1).catch(() => {});
			const calls = callsIn(world.files.log);
			out.calls = calls.length;
			judge.claim(
				NAMES.logExact,
				calls.length === 1 && JSON.stringify(calls[0].args) === JSON.stringify(shown),
				calls,
			);
			judge.claim(
				"the user-scope server was never started",
				startedIn(world.files.userLog) === null,
				startedIn(world.files.userLog),
			);
		} finally {
			await world.done();
		}
		return out;
	},

	async "mcp-decline"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const world = await mcpPrelude(run, rec, judge, "mcp-decline");
		if (!world) return out;
		try {
			void promptAndWait(run, rec, world.n, callPrompt(rec.sentinel, "declined"));
			if (
				!judge.instrument(
					"Claude called the MCP tool",
					await sawToolUse(rec, "mcp__probe__echo_note", rec.sentinel),
					rec.apiFailure,
				)
			) {
				return out;
			}
			const seen = new Set<string>();
			const declined = await answerNext(run, world.n, "decline", seen, 30_000);
			judge.claim(NAMES.cardAppeared, cardAnswered(declined));
			await until("the turn to end", 90_000, () => resultCount(rec) >= 1).catch(() => {});
			judge.claim(
				NAMES.neverReceived,
				callsIn(world.files.log).length === 0,
				callsIn(world.files.log),
			);

			// The control: the same server, the same prompt shape, accepted, reaches the log.
			const before = resultCount(rec);
			void promptAndWait(run, rec, world.n, callPrompt(rec.sentinel, "accepted"));
			const accepted = await answerNext(run, world.n, "accept", seen, 60_000);
			await until("the turn to end", 90_000, () => resultCount(rec) > before).catch(() => {});
			const calls = callsIn(world.files.log);
			out.controlCalls = calls.length;
			judge.pre(
				"the control: an accepted call reaches the server's log",
				cardAnswered(accepted) && calls.length === 1,
				calls,
			);
		} finally {
			await world.done();
		}
		return out;
	},

	async "mcp-file-changed"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const world = await mcpPrelude(run, rec, judge, "mcp-file-changed");
		if (!world) return out;
		const { host, n, files } = world;
		const degrade = async () => {
			killOwnClaudeProcesses(host.cfg, "SIGTERM");
			return until("N to read degraded", 60_000, async () => {
				const row = await managedRow(run, n);
				return row?.managedState === "degraded" ? row : undefined;
			}).catch(() => null);
		};
		const resume = async () => {
			await post(run, `/sessions/${n}/resume`);
			return (await until("the resume to settle", 120_000, async () => {
				const a = await actionFor(run, n, "resume");
				return a && a.status !== "running" && a.status !== "queued" && a.id !== lastResume
					? a
					: undefined;
			}).catch(() => null)) as Any;
		};
		let lastResume = (await actionFor(run, n, "resume"))?.id;
		try {
			// The control: the unedited file resumes, so a refusal below is the edit's.
			judge.pre("N reads degraded after its process is gone", Boolean(await degrade()));
			await sleep(2_000);
			const first = await resume();
			lastResume = first?.id;
			out.control = first?.status;
			if (
				!judge.pre(
					"the control: the unedited file resumes",
					first?.status === "succeeded",
					first?.error,
				)
			) {
				return out;
			}
			judge.pre("the resumed fork holds a process", ownClaudePids(host.cfg).length > 0);

			// The person edits the file: the same server, one more variable.
			judge.pre("N reads degraded again", Boolean(await degrade()));
			writeForkFile(host, files, { EDITED: "yes" });
			await sleep(2_000);
			const second = await resume();
			out.refusal = { status: second?.status, error: String(second?.error ?? "").slice(0, 160) };
			judge.claim(
				NAMES.refused,
				second?.status === "failed" &&
					/MCP servers this session was started with have changed/.test(String(second?.error)),
				out.refusal,
			);
			judge.claim(
				"nothing was started by the refused resume",
				ownClaudePids(host.cfg).length === 0,
				ownClaudePids(host.cfg),
			);
		} finally {
			await world.done();
		}
		return out;
	},

	async "mcp-end-session"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const world = await mcpPrelude(run, rec, judge, "mcp-end-session");
		if (!world) return out;
		const { host, n, files } = world;
		try {
			const roots = ownClaudePids(host.cfg);
			judge.pre("the fork is running", roots.length > 0, roots.length);
			const started = startedIn(files.log);
			const server = descendantsOf(roots).filter((d) => d.command.includes(files.script));
			out.server = server.map((d) => d.pid);
			// The positive control: the server is a descendant of a pid this run started, and it logged its own pid.
			if (
				!judge.pre(
					"the MCP server is listed as a descendant of the run's Claude before End",
					server.length > 0 && server.some((d) => d.pid === started?.pid),
					{ listed: server.map((d) => d.pid), logged: started?.pid },
				)
			) {
				return out;
			}
			judge.pre(
				"the server's environment names the run's config directory",
				started?.configDir === host.cfg,
				started?.configDir,
			);
			const stopped = await post(run, `/sessions/${n}/stop`);
			out.stopStatus = stopped.status;
			await until(
				"no process of the run is left",
				40_000,
				() => ownClaudePids(host.cfg).length === 0 && server.every((d) => !pidAlive(d.pid)),
			).catch(() => {});
			judge.claim(
				NAMES.noneLeft,
				ownClaudePids(host.cfg).length === 0 && server.every((d) => !pidAlive(d.pid)),
				{
					claude: ownClaudePids(host.cfg),
					server: server.filter((d) => pidAlive(d.pid)).map((d) => d.pid),
				},
			);
			judge.claim(
				"no approval card is still pending",
				(await approvalRows(run, n)).every((r: Any) => r.status !== "pending"),
			);
			judge.claim(
				"the private --mcp-config copy is removed",
				!existsSync(join(host.home, ".agentpulse", "claude-fork-mcp")) ||
					readdirSafe(join(host.home, ".agentpulse", "claude-fork-mcp")).length === 0,
			);
		} finally {
			await world.done();
		}
		return out;
	},
};

function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

export { NAMES as T121_EXPECTATIONS };
