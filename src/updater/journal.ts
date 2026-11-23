/**
 * `update-journal.json`: where an update has got to, written atomically before and after each step that
 * changes the machine, so a crash at any point leaves enough to put the install back.
 *
 * A rename is journaled as an intent first, then as done. Recovery needs no more than that: operations
 * before the last intent are done, the one at the intent is done only if the filesystem shows it, and the
 * rest never ran.
 */
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../shared/private-file.js";
import { readPrivateFileNoFollow } from "../shared/private-read.js";

export type JournalPhase =
	/** Before anything on the machine changed except staging and the drain request. */
	| "preparing"
	/** Services are being stopped or are stopped; the swap is in progress. */
	| "swapping"
	/** The new tree is in place and its health check passed: recovery finishes the commit, never rolls back. */
	| "verified"
	| "rolling_back"
	| "done"
	| "rolled_back";

export interface RenameOp {
	src: string;
	dst: string;
}

export interface Journal {
	schema: 1;
	phase: JournalPhase;
	/** The last step reached; for the output and the crash table. */
	step: string;
	from: string;
	to: string;
	/** The updater bundle that started this swap; recovery runs it, never the tree being renamed. */
	bundle: string | null;
	/** Units that were active before the run: the only ones started again. */
	units: string[];
	/** A `VACUUM INTO` copy taken for this update, or null. */
	snapshot: string | null;
	/** Renames, in order. */
	ops: RenameOp[];
	/** Number of ops known to be done. */
	done: number;
	/** Index of the op whose rename may have happened (written before it), or -1. */
	intent: number;
	/** The staged updater bundle directory to install as `updater/<to>`, and whether it was installed. */
	stagedBundle: string | null;
	bundleInstalled: boolean;
	/** Whether the staged tree's `.env*` were copied over. */
	envCopied: boolean;
	/** The fingerprint /health reported before the stop, to compare after the start. */
	fingerprint: string | null;
	app: string;
	startedAt: number;
}

const MAX_JOURNAL_BYTES = 64 * 1024;

function isString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && v.length < 4096;
}

export function parseJournal(text: string): Journal | null {
	try {
		const r = JSON.parse(text) as Record<string, unknown>;
		const phases = ["preparing", "swapping", "verified", "rolling_back", "done", "rolled_back"];
		if (
			r.schema !== 1 ||
			typeof r.phase !== "string" ||
			!phases.includes(r.phase) ||
			!isString(r.step) ||
			!isString(r.from) ||
			!isString(r.to) ||
			!isString(r.app) ||
			!Array.isArray(r.units) ||
			!r.units.every(isString) ||
			!Array.isArray(r.ops) ||
			!r.ops.every(
				(op) =>
					typeof op === "object" &&
					op !== null &&
					isString((op as RenameOp).src) &&
					isString((op as RenameOp).dst),
			) ||
			typeof r.done !== "number" ||
			typeof r.intent !== "number" ||
			typeof r.startedAt !== "number"
		) {
			return null;
		}
		return {
			schema: 1,
			phase: r.phase as JournalPhase,
			step: r.step,
			from: r.from,
			to: r.to,
			bundle: isString(r.bundle) ? r.bundle : null,
			units: r.units as string[],
			snapshot: isString(r.snapshot) ? r.snapshot : null,
			ops: (r.ops as RenameOp[]).map((op) => ({ src: op.src, dst: op.dst })),
			done: r.done,
			intent: r.intent,
			stagedBundle: isString(r.stagedBundle) ? r.stagedBundle : null,
			bundleInstalled: r.bundleInstalled === true,
			envCopied: r.envCopied === true,
			fingerprint: isString(r.fingerprint) ? r.fingerprint : null,
			app: r.app,
			startedAt: r.startedAt,
		};
	} catch {
		return null;
	}
}

export type JournalRead =
	| { kind: "absent" }
	| { kind: "unreadable" }
	| { kind: "ok"; journal: Journal };

export function readJournal(dir: string): JournalRead {
	const file = readPrivateFileNoFollow(join(dir, "update-journal.json"), MAX_JOURNAL_BYTES);
	if (file.kind === "absent") return { kind: "absent" };
	if (file.kind !== "ok") return { kind: "unreadable" };
	const journal = parseJournal(file.text);
	return journal ? { kind: "ok", journal } : { kind: "unreadable" };
}

export function writeJournal(dir: string, journal: Journal): void {
	writePrivateFileAtomicNoFollow(join(dir, "update-journal.json"), `${JSON.stringify(journal)}\n`);
}

/** A journal that needs recovery before anything else runs. */
export function needsRecovery(read: JournalRead): boolean {
	if (read.kind === "absent") return false;
	if (read.kind === "unreadable") return true;
	return read.journal.phase !== "done" && read.journal.phase !== "rolled_back";
}
