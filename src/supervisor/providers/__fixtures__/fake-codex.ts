import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = join(import.meta.dir, "fake-codex-app-server.ts");

/** Copies the fake `codex app-server` into `dir` as an executable and returns its path. */
export function installFakeCodex(dir: string, name = "fake-codex"): string {
	const path = join(dir, name);
	copyFileSync(SOURCE, path);
	chmodSync(path, 0o755);
	return path;
}

/** The fake's log: one parsed entry per line. */
export function readFakeLog(path: string): Array<Record<string, any>> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
