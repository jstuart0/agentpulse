/**
 * Test helper: writes a `claude` stand-in (see `fake-claude-stream.ts`) into a directory and returns what a
 * test needs to run it and to count what it was sent. The binary is a one-line shell wrapper around Bun, so
 * it can be given to code that spawns an executable path.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeConfig } from "./fake-claude-stream.js";

const FAKE = join(import.meta.dir, "fake-claude-stream.ts");

export type FakeClaude = {
	path: string;
	dir: string;
	/** The environment to give the child so it finds its config. */
	env: Record<string, string>;
	logPath: string;
	pidFile: string;
	configure(next: FakeConfig): void;
	log(): Array<Record<string, any>>;
	/** User lines any child of this fake was sent. */
	userLines(): number;
	starts(): Array<{ pid: number; argv: string[] }>;
	controlSubtypes(): string[];
	/** Control responses the fake was sent that were not valid or answered nothing it had asked (a wrong or repeated id). */
	badResponses(): Array<Record<string, any>>;
	pid(): number | null;
};

export function makeFakeClaude(dir: string, config: FakeConfig = {}): FakeClaude {
	mkdirSync(dir, { recursive: true });
	const logPath = join(dir, "fake-claude.log.jsonl");
	const configPath = join(dir, "fake-claude.config.json");
	const pidFile = join(dir, "fake-claude.pid");
	const path = join(dir, "claude");
	writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
	chmodSync(path, 0o755);
	const write = (next: FakeConfig) =>
		writeFileSync(configPath, JSON.stringify({ log: logPath, ...next }));
	write(config);
	const log = () =>
		existsSync(logPath)
			? readFileSync(logPath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	return {
		path,
		dir,
		env: { FAKE_CLAUDE_CONFIG: configPath, FAKE_CLAUDE_PIDFILE: pidFile },
		logPath,
		pidFile,
		configure: write,
		log,
		userLines: () => log().filter((e) => e.ev === "user").length,
		starts: () => log().filter((e) => e.ev === "start") as any,
		badResponses: () =>
			log().filter((e) => e.ev === "control_response" && (e.valid === false || e.stray === true)),
		controlSubtypes: () =>
			log()
				.filter((e) => e.ev === "control_request")
				.map((e) => e.subtype),
		pid: () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null),
	};
}
