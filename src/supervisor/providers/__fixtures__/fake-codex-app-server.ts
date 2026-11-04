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
 *   FAKE_CODEX_IGNORE_STDIN_CLOSE=1    keep running when stdin ends
 *   FAKE_CODEX_IGNORE_TERM=1           keep running on SIGTERM
 *   FAKE_CODEX_GRANDCHILD=1            start a grandchild in this process group (its pid is logged)
 *   FAKE_CODEX_REQUESTS=<json array>   server requests to send after turn/start: [{method, params, id?}]
 *   FAKE_CODEX_IGNORE_INTERRUPT=1      never answer turn/interrupt
 *   FAKE_CODEX_FORCE_APPROVAL / FORCE_SANDBOX / SANDBOX_EXTRAS   as thread/start's answer
 *
 * Behaviour recorded from a real Codex 0.163.0 (src/supervisor/providers/__fixtures__/codex-0.163), on when
 * FAKE_CODEX_REALISTIC=1: the first answer to a server request is final (a second is logged as
 * `ignoredAnswer` and does nothing), an `accept` runs the thing (a `ran` log entry), any answer is followed
 * by `serverRequest/resolved`, an unknown decision fails the item and runs nothing, and `turn/interrupt`
 * resolves every open request after its own answer.
 *
 *   FAKE_CODEX_VERSION=<x.y.z>         `--version` and the `initialize` userAgent report this version
 *                                      (`app-server generate-json-schema` writes the 0.163 subset installed
 *                                      beside the fake as `fake-codex-schema`)
 *   FAKE_CODEX_NO_RESOLVE=1            never send `serverRequest/resolved`
 *   FAKE_CODEX_CONTROL=<file>          a file the test appends JSON lines to: {send: <frame>} writes a frame
 *                                      to stdout, {exit: <code>} exits
 */
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
log({ argv: process.argv.slice(2), pid: process.pid });

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
	if (wroteStderr || !env.FAKE_CODEX_STDERR_BYTES) return;
	wroteStderr = true;
	const chunk = "e".repeat(64 * 1024);
	let left = Number(env.FAKE_CODEX_STDERR_BYTES);
	while (left > 0) {
		process.stderr.write(chunk.slice(0, Math.min(left, chunk.length)));
		left -= chunk.length;
	}
};

const REALISTIC = env.FAKE_CODEX_REALISTIC === "1";
const sentRequests = new Map<string, { threadId: string }>();
const answeredRequests = new Set<string>();
const resolve = (id: string | number) => {
	const entry = sentRequests.get(JSON.stringify(id));
	if (!entry || env.FAKE_CODEX_NO_RESOLVE) return;
	send({ method: "serverRequest/resolved", params: { threadId: entry.threadId, requestId: id } });
};

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
			if (m.result?.decision === "accept") log({ ran: m.id });
			resolve(m.id);
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
	} else if (m.method === "thread/name/set") {
		reply({});
		send({
			method: "thread/name/updated",
			params: { threadId: m.params.threadId, threadName: m.params.name },
		});
	} else if (m.method === "turn/start") {
		reply({ turn: { id: "turn-1" } });
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
			if (command.exit !== undefined) process.exit(command.exit);
		}
	}, 15);
}
