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
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const env = process.env;
if (process.argv.includes("--version")) {
	console.log("codex-cli 0.0.0-fake");
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

function handle(m: any) {
	if (typeof m.method !== "string") {
		// An answer to one of our server requests.
		log({ answer: m });
		return;
	}
	log({ method: m.method, params: m.params, id: m.id });
	if (env.FAKE_CODEX_SILENT) return;
	beforeFirstAnswer();
	const reply = (result: unknown) => send({ id: m.id, result });
	if (m.method === "initialize") {
		reply({
			protocolVersion: "fake",
			userAgent: "agentpulse-supervisor/0.0.0 (fake)",
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
		requests.forEach((entry, index) =>
			send({ id: entry.id ?? index, method: entry.method, params: entry.params ?? {} }),
		);
	} else if (m.method === "turn/interrupt") {
		if (!env.FAKE_CODEX_IGNORE_INTERRUPT) reply({});
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
