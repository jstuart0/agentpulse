/**
 * A stand-in for a `claude` process that has started a tool process, for the stop ladder's tests. It is run
 * with `bun <this file>` and does nothing but stay alive.
 *
 *   FAKE_CLAUDE_LOG                where it records, one JSON line per fact: its own pid (`claude`), its
 *                                  child's pid (`child`), and `child-ready` once the child has installed its
 *                                  SIGTERM handling, so a test waits on that line, not on a sleep
 *   FAKE_CLAUDE_CHILD              "setsid" (the child leads its own session and group, as a Bash tool does),
 *                                  "group" (the child stays in this process's group) or "none"
 *   FAKE_CLAUDE_IGNORE_TERM        "1": ignores SIGTERM
 *   FAKE_CLAUDE_CHILD_IGNORE_TERM  "1": the child ignores SIGTERM too
 *   FAKE_CLAUDE_EXIT_FILE          exits 0 once this file exists (a turn that ends when the test says so)
 *
 * Nothing here reads a real Claude config or talks to a model.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const log = process.env.FAKE_CLAUDE_LOG;
const write = (entry: Record<string, unknown>) => {
	if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
};

if (process.env.FAKE_CLAUDE_IGNORE_TERM === "1") {
	process.on("SIGTERM", () => write({ signal: "SIGTERM", pid: process.pid }));
}

write({ role: "claude", pid: process.pid });

const childMode = process.env.FAKE_CLAUDE_CHILD ?? "none";
if (childMode !== "none") {
	const ignore = process.env.FAKE_CLAUDE_CHILD_IGNORE_TERM === "1";
	const ready =
		'require("node:fs").appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ role: "child-ready", pid: process.pid }) + "\\n");';
	const code = `${ignore ? 'process.on("SIGTERM", () => {});' : ""} ${log ? ready : ""} setInterval(() => {}, 1000);`;
	const child = spawn(process.execPath, ["-e", code], {
		detached: childMode === "setsid",
		stdio: "ignore",
	});
	child.unref();
	write({ role: "child", pid: child.pid, mode: childMode });
}

// Output stays open and quiet, like a running turn.
setInterval(() => {}, 1000);

const exitFile = process.env.FAKE_CLAUDE_EXIT_FILE;
if (exitFile) {
	setInterval(() => {
		if (existsSync(exitFile)) process.exit(0);
	}, 20);
}
