/**
 * The updater's log: one line per event with a code, versions and a duration, and nothing else (rule 31).
 * No artifact content, no command output, no path of a secret, no URL from a response. The lines can reach
 * a terminal and `logs/updater.log`; the writer refuses to follow a link and keeps the file private.
 */
import { appendFileSync, chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SAFE = /[^0-9A-Za-z._:+\- ]/g;

/** A value fit for a log line: short, printable and with no way to start a second line. */
export function logText(value: unknown): string {
	return String(value).replace(SAFE, "?").slice(0, 120);
}

export interface UpdaterLog {
	line(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
}

export function createFileLog(path: string, now: () => number): UpdaterLog {
	return {
		line(event, fields = {}) {
			const parts = [new Date(now()).toISOString(), logText(event)];
			for (const [key, value] of Object.entries(fields)) {
				if (value === undefined || value === null) continue;
				parts.push(`${logText(key)}=${logText(value)}`);
			}
			const text = `${parts.join(" ")}\n`;
			try {
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				try {
					if (lstatSync(path).isSymbolicLink()) return;
				} catch {
					// no file yet
				}
				appendFileSync(path, text, { mode: 0o600 });
				chmodSync(path, 0o600);
			} catch {
				// the log is best effort; a failure here never changes an update
			}
		},
	};
}
