#!/usr/bin/env bun
/**
 * A fake `codex app-server` for tests: JSONL on stdin and stdout, no socket. Copied to a temp file and
 * run as the "codex" executable, so the real spawn, framing and shutdown code is what's exercised.
 * Behaviour is chosen by environment variables; every received frame, signal and stdin end is appended to
 * FAKE_CODEX_LOG as one JSON line.
 *
 *   FAKE_CODEX_EARLY_EXIT=<n>          exit with code n at once
 *   FAKE_CODEX_SILENT=1                never answer anything
 *   FAKE_CODEX_STDERR_BYTES=<n>        write n bytes to stderr before the first answer
 *   FAKE_CODEX_STDERR_TEXT=<text>      write this text to stderr before the first answer
 *   FAKE_CODEX_IGNORE_STDIN_CLOSE=1    keep running when stdin ends
 *   FAKE_CODEX_IGNORE_TERM=1           keep running on SIGTERM
 *   FAKE_CODEX_GRANDCHILD=1            start a grandchild in this process group (its pid is logged)
 *   FAKE_CODEX_REQUESTS=<json array>   server requests to send after turn/start: [{method, params, id?}]
 *   FAKE_CODEX_IGNORE_INTERRUPT=1      never answer turn/interrupt
 *   FAKE_CODEX_FORCE_APPROVAL / FORCE_SANDBOX / SANDBOX_EXTRAS   as thread/start's answer
 *   FAKE_CODEX_REQUESTS_ON_TURN=<n>    which turn/start sends FAKE_CODEX_REQUESTS (default 1, the first)
 *   FAKE_CODEX_TURN_START_ERROR=<n>    the nth turn/start is answered with a JSON-RPC error
 *   FAKE_CODEX_TURN_START_SILENT=<n>   the nth turn/start is logged and never answered
 *   FAKE_CODEX_TURN_COMPLETE_BEFORE_REPLY=<n>   the nth turn/start writes turn/started and turn/completed
 *                                      for its own turn before its response
 * Turn ids count up: turn-1, turn-2, ...
 *
 * Resume (AGEN-115), shaped by answers recorded from Codex 0.163.0 (thread/read and thread/resume):
 *   FAKE_CODEX_THREAD_ID=<id>          the one thread this fake knows (default thr-1); another id is "thread not loaded" / "no rollout found"
 *   FAKE_CODEX_THREAD_CWD=<dir>        the thread's CURRENT directory, as thread/read and thread/resume answer it
 *   FAKE_CODEX_RESUME_CWD=<dir>        a different directory in thread/resume's answer than thread/read gave
 *   FAKE_CODEX_THREAD_ORIGINATOR=<n>   `thread.originator` (default codex_exec)
 *   FAKE_CODEX_READ_ERROR=<json>       {code,message}: thread/read fails like this
 *   FAKE_CODEX_RESUME_ERROR=<json>     {code,message}: thread/resume fails like this
 *   FAKE_CODEX_READ_SILENT=1 / FAKE_CODEX_RESUME_SILENT=1   never answered
 *   FAKE_CODEX_RESUME_FORCE_APPROVAL / FAKE_CODEX_RESUME_FORCE_SANDBOX   thread/resume's answer, whatever was asked
 *   FAKE_CODEX_SANDBOX_EXTRAS=<json>   merged into the answered sandbox (what a hostile project config produces)
 *   FAKE_CODEX_LOCK_FILE=<path>        the first thread/resume takes this "writer lock"; a second answers "already has an active writer"
 *   FAKE_CODEX_REQUESTS_ON_READ=<json> server requests [{method, params, id?}] sent just before thread/read's answer
 *   FAKE_CODEX_REQUESTS_ON_RESUME=<json>  the same, sent just after thread/resume's answer
 *   FAKE_CODEX_SANDBOX_OMIT=<key>      removes this key from the answered sandbox (a missing key)
 * With no override asked for, thread/resume answers the thread's recorded policy, which is deliberately a
 * third value: never + dangerFullAccess, so echoing the request or a default can't pass for the override.
 *
 * Behaviour recorded from a real Codex 0.163.0 (src/supervisor/providers/__fixtures__/codex-0.163), on when
 * FAKE_CODEX_REALISTIC=1: the first answer to a server request is final (a second is logged as
 * `ignoredAnswer` and does nothing), an `accept` runs the thing (a `ran` log entry), any answer is followed
 * by `serverRequest/resolved`, an unknown decision fails the item and runs nothing, and `turn/interrupt`
 * resolves every open request after its own answer. Any `accept*` decision runs the thing (`ran`), and a
 * `cancel` also interrupts the turn: every other open request is resolved after it (S8).
 *
 *   FAKE_CODEX_VERSION=<x.y.z>         `--version` and the `initialize` userAgent report this version
 *                                      (`app-server generate-json-schema` writes the 0.163 subset installed
 *                                      beside the fake as `fake-codex-schema`)
 *   FAKE_CODEX_NO_RESOLVE=1            never send `serverRequest/resolved`
 *   FAKE_CODEX_CONTROL=<file>          a file the test appends JSON lines to: {send: <frame>} writes a frame
 *                                      to stdout, {exit: <code>} exits, {replay: {file, index}} sends frame
 *                                      `index` of a recorded run (`dir: "in"`), preceded by the recorded
 *                                      `fileChange` item that the request names
 */
import { spawn } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const env = process.env;
const VERSION = env.FAKE_CODEX_VERSION || "0.0.0-fake";
if (process.argv.includes("--version")) {
	console.log(`codex-cli ${VERSION}`);
	process.exit(0);
}
if (process.argv.includes("generate-json-schema")) {
	// The committed 0.163 subset, laid out the way the real generator writes it.
	const out = process.argv[process.argv.indexOf("--out") + 1];
	// Installed next to the fake by installFakeCodex: the real generator is run with a scrubbed environment.
	const fixtureDir = join(dirname(process.argv[1] as string), "fake-codex-schema");
	mkdirSync(join(out, "v2"), { recursive: true });
	for (const name of [
		"CommandExecutionRequestApprovalParams.json",
		"CommandExecutionRequestApprovalResponse.json",
		"FileChangeRequestApprovalParams.json",
		"FileChangeRequestApprovalResponse.json",
		"v2/ServerRequestResolvedNotification.json",
		"v2/FileChangePatchUpdatedNotification.json",
	]) {
		cpSync(join(fixtureDir, name), join(out, name));
	}
	const item = JSON.parse(readFileSync(join(fixtureDir, "FileChangeThreadItem.json"), "utf8"));
	const { definitions, ...variant } = item;
	writeFileSync(
		join(out, "codex_app_server_protocol.v2.schemas.json"),
		JSON.stringify({ definitions: { ...definitions, ThreadItem: { oneOf: [variant] } } }),
	);
	process.exit(0);
}
const logFile = env.FAKE_CODEX_LOG;
const log = (entry: unknown) => {
	if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
log({ argv: process.argv.slice(2), pid: process.pid, cwd: process.cwd() });
log({ envNames: Object.keys(process.env) });

if (env.FAKE_CODEX_EARLY_EXIT) process.exit(Number(env.FAKE_CODEX_EARLY_EXIT));

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => {
		log({ signal });
		if (!(signal === "SIGTERM" && env.FAKE_CODEX_IGNORE_TERM)) process.exit(0);
	});
}

if (env.FAKE_CODEX_GRANDCHILD) {
	const grandchild = spawn("sleep", ["300"], { stdio: "ignore" });
	log({ grandchild: grandchild.pid });
}

const SANDBOX_TYPE: Record<string, string> = {
	"read-only": "readOnly",
	"workspace-write": "workspaceWrite",
	"danger-full-access": "dangerFullAccess",
};
const send = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let wroteStderr = false;
const beforeFirstAnswer = () => {
	if (wroteStderr || !(env.FAKE_CODEX_STDERR_BYTES || env.FAKE_CODEX_STDERR_TEXT)) return;
	wroteStderr = true;
	if (env.FAKE_CODEX_STDERR_TEXT) process.stderr.write(`${env.FAKE_CODEX_STDERR_TEXT}\n`);
	if (!env.FAKE_CODEX_STDERR_BYTES) return;
	const chunk = "e".repeat(64 * 1024);
	let left = Number(env.FAKE_CODEX_STDERR_BYTES);
	while (left > 0) {
		process.stderr.write(chunk.slice(0, Math.min(left, chunk.length)));
		left -= chunk.length;
	}
};

let turnStarts = 0;
const REALISTIC = env.FAKE_CODEX_REALISTIC === "1";
const sentRequests = new Map<string, { threadId: string }>();
const answeredRequests = new Set<string>();
const resolve = (id: string | number) => {
	const entry = sentRequests.get(JSON.stringify(id));
	if (!entry || env.FAKE_CODEX_NO_RESOLVE) return;
	send({ method: "serverRequest/resolved", params: { threadId: entry.threadId, requestId: id } });
};

const KNOWN_THREAD = env.FAKE_CODEX_THREAD_ID || "thr-1";
const threadCwd = () => env.FAKE_CODEX_THREAD_CWD || process.cwd();
// The key set of a real Codex 0.163.0 `thread` (thread/read and thread/resume), so a fake answer and a real
// one can be compared key for key (codex-resume.real.test.ts). Values are placeholders except the ones used.
const threadBody = (cwd: string, status: string, withEnvironments = true) => ({
	id: KNOWN_THREAD,
	// A real thread/read answers `environments: null`; thread/resume answers the list.
	environments: withEnvironments
		? [{ environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] }]
		: null,
	extra: null,
	sessionId: KNOWN_THREAD,
	forkedFromId: null,
	parentThreadId: null,
	preview: "",
	ephemeral: false,
	section: null,
	sectionEnteredAt: null,
	projectId: null,
	historyMode: "paginated",
	modelProvider: "openai",
	model: "fake-model",
	reasoningEffort: null,
	createdAt: 0,
	updatedAt: 0,
	recencyAt: 0,
	status: { type: status },
	path: `/fake/sessions/rollout-${KNOWN_THREAD}.jsonl`,
	cwd,
	cliVersion: VERSION,
	originator: env.FAKE_CODEX_THREAD_ORIGINATOR || "codex_exec",
	source: "exec",
	canAcceptDirectInput: null,
	threadSource: "user",
	agentNickname: null,
	agentRole: null,
	gitInfo: null,
	name: null,
	daybreakEnabled: null,
	turns: [],
});
let resumedHere = false;

function sendServerRequests(json: string | undefined) {
	const requests = JSON.parse(json || "[]") as Array<{
		method: string;
		params?: unknown;
		id?: number | string;
	}>;
	requests.forEach((entry, index) => {
		const id = entry.id ?? 100 + index;
		sentRequests.set(JSON.stringify(id), { threadId: KNOWN_THREAD });
		send({ id, method: entry.method, params: entry.params ?? {} });
	});
}

function handleThreadCall(m: any, reply: (result: unknown) => void) {
	const isRead = m.method === "thread/read";
	if (isRead ? env.FAKE_CODEX_READ_SILENT : env.FAKE_CODEX_RESUME_SILENT) return;
	const forced = isRead ? env.FAKE_CODEX_READ_ERROR : env.FAKE_CODEX_RESUME_ERROR;
	if (forced) {
		send({ id: m.id, error: JSON.parse(forced) });
		return;
	}
	if (m.params?.threadId !== KNOWN_THREAD) {
		send({
			id: m.id,
			error: {
				code: -32600,
				message: isRead
					? `thread not loaded: ${m.params?.threadId}`
					: `no rollout found for thread id ${m.params?.threadId}`,
			},
		});
		return;
	}
	if (isRead) {
		sendServerRequests(env.FAKE_CODEX_REQUESTS_ON_READ);
		reply({
			thread: threadBody(threadCwd(), "notLoaded", false),
			readState: { firstUnread: null, revision: "r" },
		});
		return;
	}
	const lock = env.FAKE_CODEX_LOCK_FILE;
	if (lock && !resumedHere) {
		if (existsSync(lock)) {
			send({
				id: m.id,
				error: { code: -32600, message: `thread ${KNOWN_THREAD} already has an active writer` },
			});
			return;
		}
		writeFileSync(lock, String(process.pid));
	}
	resumedHere = true;
	const approval = env.FAKE_CODEX_RESUME_FORCE_APPROVAL || m.params.approvalPolicy || "never";
	const sandbox = env.FAKE_CODEX_RESUME_FORCE_SANDBOX || m.params.sandbox || "danger-full-access";
	const cwd = env.FAKE_CODEX_RESUME_CWD || threadCwd();
	const sandboxAnswer: Record<string, unknown> = {
		type: SANDBOX_TYPE[sandbox],
		...(sandbox === "read-only" ? { networkAccess: false } : {}),
		...(sandbox === "workspace-write"
			? {
					writableRoots: [],
					networkAccess: false,
					excludeTmpdirEnvVar: false,
					excludeSlashTmp: false,
				}
			: {}),
		...JSON.parse(env.FAKE_CODEX_SANDBOX_EXTRAS || "{}"),
	};
	if (env.FAKE_CODEX_SANDBOX_OMIT) delete sandboxAnswer[env.FAKE_CODEX_SANDBOX_OMIT];
	reply({
		thread: threadBody(cwd, "idle"),
		model: "fake-model",
		modelProvider: "openai",
		serviceTier: null,
		disabledPluginIds: [],
		cwd,
		runtimeWorkspaceRoots: [cwd],
		instructionSources: [],
		approvalPolicy: approval,
		approvalsReviewer: "user",
		activePermissionProfile: null,
		reasoningEffort: null,
		collaborationMode: null,
		multiAgentMode: null,
		initialTurnsPage: null,
		turnsBackwardsCursor: null,
		itemsBackwardsCursor: null,
		sandbox: sandboxAnswer,
	});
	sendServerRequests(env.FAKE_CODEX_REQUESTS_ON_RESUME);
}

function handle(m: any) {
	if (typeof m.method !== "string") {
		// An answer to one of our server requests.
		const key = JSON.stringify(m.id);
		if (REALISTIC && answeredRequests.has(key)) {
			log({ ignoredAnswer: m });
			return;
		}
		answeredRequests.add(key);
		log({ answer: m });
		if (REALISTIC) {
			const decision = m.result?.decision;
			if (typeof decision === "string" && decision.startsWith("accept")) log({ ran: m.id });
			resolve(m.id);
			if (decision === "cancel") {
				// A cancel ends the turn: whatever else is open is resolved, unanswered.
				log({ interrupted: true });
				for (const key of sentRequests.keys()) {
					if (key !== JSON.stringify(m.id) && !answeredRequests.has(key)) resolve(JSON.parse(key));
				}
			}
		}
		return;
	}
	log({ method: m.method, params: m.params, id: m.id });
	if (env.FAKE_CODEX_SILENT) return;
	beforeFirstAnswer();
	const reply = (result: unknown) => send({ id: m.id, result });
	if (m.method === "initialize") {
		reply({
			protocolVersion: "fake",
			userAgent: `agentpulse-supervisor/${VERSION} (fake)`,
			codexHome: "/fake",
			platformFamily: "unix",
			platformOs: "macos",
		});
	} else if (m.method === "thread/start") {
		const approval = env.FAKE_CODEX_FORCE_APPROVAL || m.params.approvalPolicy || "on-request";
		const sandbox = env.FAKE_CODEX_FORCE_SANDBOX || m.params.sandbox || "read-only";
		reply({
			thread: { id: "thr-1", cwd: m.params.cwd, status: "idle", source: "fake" },
			approvalPolicy: approval,
			sandbox: {
				type: SANDBOX_TYPE[sandbox],
				...(sandbox === "read-only" ? { networkAccess: false } : {}),
				...(sandbox === "workspace-write" ? { writableRoots: [], networkAccess: false } : {}),
				...JSON.parse(env.FAKE_CODEX_SANDBOX_EXTRAS || "{}"),
			},
		});
	} else if (m.method === "thread/read" || m.method === "thread/resume") {
		handleThreadCall(m, reply);
	} else if (m.method === "thread/name/set") {
		reply({});
		send({
			method: "thread/name/updated",
			params: { threadId: m.params.threadId, threadName: m.params.name },
		});
	} else if (m.method === "turn/start") {
		turnStarts += 1;
		const nth = turnStarts;
		const turnId = `turn-${nth}`;
		if (Number(env.FAKE_CODEX_TURN_START_SILENT) === nth) return;
		if (Number(env.FAKE_CODEX_TURN_START_ERROR) === nth) {
			send({ id: m.id, error: { code: -32000, message: "turn refused" } });
			return;
		}
		if (Number(env.FAKE_CODEX_TURN_COMPLETE_BEFORE_REPLY) === nth) {
			send({ method: "turn/started", params: { threadId: "thr-1", turn: { id: turnId } } });
			send({
				method: "turn/completed",
				params: { threadId: "thr-1", turn: { id: turnId, status: "completed" } },
			});
		}
		reply({ turn: { id: turnId } });
		if (nth !== Number(env.FAKE_CODEX_REQUESTS_ON_TURN || 1)) return;
		const requests = JSON.parse(env.FAKE_CODEX_REQUESTS || "[]") as Array<{
			method: string;
			params?: unknown;
			id?: number | string;
		}>;
		requests.forEach((entry, index) => {
			const id = entry.id ?? index;
			sentRequests.set(JSON.stringify(id), { threadId: "thr-1" });
			send({ id, method: entry.method, params: entry.params ?? {} });
		});
	} else if (m.method === "turn/interrupt") {
		if (!env.FAKE_CODEX_IGNORE_INTERRUPT) {
			reply({});
			if (REALISTIC) {
				for (const key of sentRequests.keys()) {
					if (!answeredRequests.has(key)) resolve(JSON.parse(key));
				}
			}
		}
	} else {
		reply({});
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text: string) => {
	buffer += text;
	for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => {
	log({ stdinEnd: true });
	if (env.FAKE_CODEX_IGNORE_STDIN_CLOSE) setInterval(() => {}, 1_000);
	else process.exit(0);
});

// A file the test appends to, to make the fake say or do something at a moment of its choosing.
if (env.FAKE_CODEX_CONTROL) {
	let offset = 0;
	let partial = "";
	setInterval(() => {
		try {
			const size = statSync(env.FAKE_CODEX_CONTROL as string).size;
			if (size <= offset) return;
			const text = readFileSync(env.FAKE_CODEX_CONTROL as string, "utf8");
			partial += text.slice(offset);
			offset = text.length;
		} catch {
			return;
		}
		for (let nl = partial.indexOf("\n"); nl !== -1; nl = partial.indexOf("\n")) {
			const line = partial.slice(0, nl);
			partial = partial.slice(nl + 1);
			if (!line.trim()) continue;
			const command = JSON.parse(line);
			if (command.send) {
				const frame = command.send;
				if (typeof frame.method === "string" && frame.id !== undefined) {
					sentRequests.set(JSON.stringify(frame.id), { threadId: "thr-1" });
				}
				send(frame);
			}
			if (command.replay) {
				const recorded = readFileSync(command.replay.file, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
				const recordedAsk = recorded[command.replay.index].frame;
				for (const entry of recorded.slice(0, command.replay.index)) {
					const item = entry.dir === "in" ? entry.frame.params?.item : undefined;
					if (
						entry.frame.method === "item/started" &&
						item?.type === "fileChange" &&
						item.id === recordedAsk.params.itemId
					) {
						send(entry.frame);
					}
				}
				sentRequests.set(JSON.stringify(recordedAsk.id), { threadId: recordedAsk.params.threadId });
				send(recordedAsk);
			}
			if (command.exit !== undefined) process.exit(command.exit);
		}
	}, 15);
}
