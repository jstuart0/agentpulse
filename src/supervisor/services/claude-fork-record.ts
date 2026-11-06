/**
 * The supervisor's own record of the Claude forks it started (AGEN-117 T5, T13, T16): `forkId -> { source,
 * mode, dir }`, in `~/.agentpulse/claude-forks.json`. It is the host's only proof that a session id is a fork
 * it made: an in-place resume builds `--resume <id>` only for an id listed here, and the one-prompt headless
 * path refuses any id listed here, whatever a prompt action's metadata says (so a rolled-back server can't
 * send a fork down the path that would start `claude --resume` on it).
 *
 * Same trust rules as the Codex thread record: a private file (0600) in a private directory, never a link,
 * written atomically, bounded, and one that can't be believed reads as empty. A failed write is reported to
 * the caller (a takeover refuses on it), unlike the Codex record, because nothing may resume a fork the
 * host can't later prove it made.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type ClaudeForkMode,
	isClaudeForkMode,
	isResumableSessionId,
} from "../../shared/session-resume.js";
import { readPrivateFileNoFollow } from "./private-store.js";

export const MAX_FORK_RECORD_ENTRIES = 1024;
const MAX_FILE_BYTES = 512 * 1024;
/** Forks this host is running are kept past the bound; at most as many as it can run at once, with room. */
const LIVE_HEADROOM = 64;

export interface ForkEntry {
	forkId: string;
	source: string;
	mode: ClaudeForkMode;
	/** The directory the fork was started in (the proved one); recovery uses it, not what a report says. */
	dir: string;
	at: string;
}

interface Stored {
	version: 1;
	entries: ForkEntry[];
}

/**
 * What the record can say about an id: `fork` (listed), `not_fork` (a record that can be read, or none at all,
 * does not list it) or `unknown` (a record is there and cannot be believed: not private, a link, damaged). A
 * caller that must not run a one-prompt process on a fork refuses on `unknown`.
 */
export type ForkStatus = "fork" | "not_fork" | "unknown";

export interface ClaudeForkRecord {
	/** The entry for a fork this host started, or null (no file, no entry, an untrusted file). */
	lookup(forkId: string): ForkEntry | null;
	/** True when the id is a fork this host recorded. */
	isFork(forkId: string): boolean;
	/** `isFork` that tells an unreadable record from no record. */
	status(forkId: string): ForkStatus;
	/** Records a fork, newest first. Returns false when it could not be written (or the existing record can't be believed). */
	write(entry: Omit<ForkEntry, "at">): boolean;
}

function validEntry(entry: Partial<ForkEntry> | null | undefined): entry is ForkEntry {
	return (
		!!entry &&
		typeof entry.forkId === "string" &&
		isResumableSessionId(entry.forkId) &&
		typeof entry.source === "string" &&
		isResumableSessionId(entry.source) &&
		entry.source !== entry.forkId &&
		isClaudeForkMode(entry.mode) &&
		typeof entry.dir === "string" &&
		entry.dir.length > 0
	);
}

export function createClaudeForkRecord(options: {
	path: string;
	/** A fork whose process this host holds: never dropped to make room, even past the cap. */
	isLive?: (forkId: string) => boolean;
	now?: () => number;
	log?: (line: string) => void;
}): ClaudeForkRecord {
	const now = options.now ?? Date.now;
	const log = options.log ?? ((line: string) => console.warn(line));

	function read(): Stored | null {
		const file = readPrivateFileNoFollow(options.path, MAX_FILE_BYTES);
		if (file.kind !== "ok") return null;
		try {
			const parsed = JSON.parse(file.text) as Partial<Stored>;
			if (
				parsed.version !== 1 ||
				!Array.isArray(parsed.entries) ||
				parsed.entries.length > MAX_FORK_RECORD_ENTRIES + LIVE_HEADROOM
			) {
				return null;
			}
			return { version: 1, entries: parsed.entries.filter(validEntry) };
		} catch {
			return null;
		}
	}

	return {
		lookup: (forkId) => read()?.entries.find((entry) => entry.forkId === forkId) ?? null,
		isFork: (forkId) => read()?.entries.some((entry) => entry.forkId === forkId) ?? false,
		status(forkId) {
			if (readPrivateFileNoFollow(options.path, MAX_FILE_BYTES).kind === "absent")
				return "not_fork";
			const stored = read();
			if (stored === null) return "unknown";
			return stored.entries.some((entry) => entry.forkId === forkId) ? "fork" : "not_fork";
		},
		write(entry) {
			const temp = `${options.path}.${process.pid}.tmp`;
			try {
				if (!validEntry({ ...entry, at: "" })) throw new Error("not a valid fork entry");
				mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
				const existing = read();
				// A record that is there but can't be believed is not overwritten: that would forget every fork it
				// held, and a one-prompt process could then be started on one of them. Repairing it is the person's.
				if (
					existing === null &&
					readPrivateFileNoFollow(options.path, MAX_FILE_BYTES).kind !== "absent"
				) {
					throw new Error("the existing record can't be trusted");
				}
				const all = [
					{ ...entry, at: new Date(now()).toISOString() },
					...(existing?.entries ?? []).filter((e) => e.forkId !== entry.forkId),
				];
				// Newest first, bounded; but a fork this host is running is kept past the bound.
				const kept = all.slice(0, MAX_FORK_RECORD_ENTRIES);
				const live = all
					.slice(MAX_FORK_RECORD_ENTRIES)
					.filter((e) => options.isLive?.(e.forkId) === true);
				const stored: Stored = { version: 1, entries: [...kept, ...live] };
				writeFileSync(temp, JSON.stringify(stored), { mode: 0o600 });
				chmodSync(temp, 0o600);
				renameSync(temp, options.path);
				return true;
			} catch (error) {
				try {
					rmSync(temp, { force: true });
				} catch {}
				log(
					`[supervisor] couldn't record a Claude fork (it won't be started): ${
						error instanceof Error ? error.message.slice(0, 200) : "unknown"
					}`,
				);
				return false;
			}
		},
	};
}
