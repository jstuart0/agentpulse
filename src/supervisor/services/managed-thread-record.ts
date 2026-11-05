/**
 * The supervisor's own record of the Codex threads it started: `launchRequestId -> threadId`, in
 * `~/.agentpulse/managed-threads.json` (AGEN-115, D11). It is recovery's proof. A resume asks the host to
 * start a process on a thread id the SERVER names, and any supervisor report can set a managed row's thread
 * id; this file is the one place that says which thread this supervisor really started for that launch.
 *
 * Private (0600, in a directory only this account can write), written atomically, at most 1,024 entries
 * newest first, and it carries a `createdAt` fixed when the file is first written (a thread older than that
 * may be one this supervisor started before the record existed). A file that is a symlink, not private, not
 * plain or not valid reads as empty and has no `createdAt`. A failed write never fails a launch: it logs, and
 * that session can't be resumed.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readPrivateFileNoFollow } from "./private-store.js";

export const MAX_THREAD_RECORD_ENTRIES = 1024;
const MAX_FILE_BYTES = 512 * 1024;

interface Entry {
	launchRequestId: string;
	threadId: string;
	at: string;
}

interface Stored {
	version: 1;
	createdAt: string;
	entries: Entry[];
}

export interface ManagedThreadRecord {
	/** The thread this supervisor started for the launch, or null (no file, no entry, an untrusted file). */
	lookup(launchRequestId: string): string | null;
	/** When the record was first written; null when there is no trustworthy file. */
	createdAt(): string | null;
	/** Records the thread for the launch, newest first. Never throws. */
	write(launchRequestId: string, threadId: string): void;
}

export function createManagedThreadRecord(options: {
	path: string;
	now?: () => number;
	log?: (line: string) => void;
}): ManagedThreadRecord {
	const now = options.now ?? Date.now;
	const log = options.log ?? ((line: string) => console.warn(line));

	function read(): Stored | null {
		const file = readPrivateFileNoFollow(options.path, MAX_FILE_BYTES);
		if (file.kind !== "ok") return null;
		try {
			const parsed = JSON.parse(file.text) as Partial<Stored>;
			if (
				parsed.version !== 1 ||
				typeof parsed.createdAt !== "string" ||
				!Array.isArray(parsed.entries) ||
				parsed.entries.length > MAX_THREAD_RECORD_ENTRIES
			) {
				return null;
			}
			const entries = parsed.entries.filter(
				(entry): entry is Entry =>
					typeof entry?.launchRequestId === "string" && typeof entry?.threadId === "string",
			);
			return { version: 1, createdAt: parsed.createdAt, entries };
		} catch {
			return null;
		}
	}

	return {
		lookup(launchRequestId) {
			return (
				read()?.entries.find((entry) => entry.launchRequestId === launchRequestId)?.threadId ?? null
			);
		},
		createdAt: () => read()?.createdAt ?? null,
		write(launchRequestId, threadId) {
			const temp = `${options.path}.${process.pid}.tmp`;
			try {
				mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
				const existing = read();
				const stamp = new Date(now()).toISOString();
				const entries = [
					{ launchRequestId, threadId, at: stamp },
					...(existing?.entries ?? []).filter((entry) => entry.launchRequestId !== launchRequestId),
				].slice(0, MAX_THREAD_RECORD_ENTRIES);
				const stored: Stored = { version: 1, createdAt: existing?.createdAt ?? stamp, entries };
				writeFileSync(temp, JSON.stringify(stored), { mode: 0o600 });
				chmodSync(temp, 0o600);
				renameSync(temp, options.path);
			} catch (error) {
				try {
					rmSync(temp, { force: true });
				} catch {}
				log(
					`[supervisor] couldn't record a managed thread (that session can't be resumed): ${
						error instanceof Error ? error.message.slice(0, 200) : "unknown"
					}`,
				);
			}
		},
	};
}
