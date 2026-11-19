/**
 * Who a pid is, read from the process table and never by a signal: the pair `{pid, start time}` names one
 * process for as long as it lives, so a lock holder or a recorded supervisor can be told apart from an
 * unrelated process that was handed the same pid later. Reading only: nothing here can end a process.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PS_TIMEOUT_MS = 3_000;

/** `ps -o lstart=` for `pid` (e.g. "Mon Nov 17 10:02:11 2026"), or null when no such process exists or ps can't say. */
export function processIdentity(pid: number): string | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			env: { ...process.env, LC_ALL: "C" },
			encoding: "utf-8",
			timeout: PS_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out === "" ? null : out;
	} catch {
		return null;
	}
}

/** When this machine last booted (ms since the epoch), or null when it can't be learned. */
export function bootTimeMs(): number | null {
	try {
		if (process.platform === "darwin") {
			const out = execFileSync("sysctl", ["-n", "kern.boottime"], {
				encoding: "utf-8",
				timeout: PS_TIMEOUT_MS,
				stdio: ["ignore", "pipe", "ignore"],
			});
			const sec = /sec\s*=\s*(\d+)/.exec(out)?.[1];
			return sec ? Number(sec) * 1000 : null;
		}
		if (process.platform === "linux") {
			const btime = /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf-8"))?.[1];
			return btime ? Number(btime) * 1000 : null;
		}
	} catch {
		// fall through: unknown
	}
	return null;
}
