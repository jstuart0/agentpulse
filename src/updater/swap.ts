/**
 * The directory swap (step 13) and its undo, as journaled renames.
 *
 * Three-directory rotation: the previous `app.previous` is retired, `app` becomes `app.previous`, the staged
 * tree becomes `app`. Each rename is journaled as an intent first, then as done, so after a crash the
 * journal and the filesystem together say exactly which renames happened; `undoSwap` reverses them, last
 * first, checking the filesystem before each (so it can itself be interrupted and run again). Nothing is
 * deleted by the swap itself: the old trees stay until a commit or a later run removes them.
 *
 * The `.env*` files at the root of the old checkout are copied byte for byte, with their mode, into the new
 * one (contents are never read or logged): the services' environment files live there.
 */
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Journal, RenameOp } from "./journal.js";

const exists = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

export function planSwap(input: {
	app: string;
	previous: string;
	staging: string;
	retired: string;
}): RenameOp[] {
	const ops: RenameOp[] = [];
	if (exists(input.previous)) ops.push({ src: input.previous, dst: input.retired });
	ops.push({ src: input.app, dst: input.previous });
	ops.push({ src: input.staging, dst: input.app });
	return ops;
}

/** Runs the journaled renames. `save` writes the journal (and is where a test injects a crash). */
export function executeSwap(journal: Journal, save: (step: string) => void): void {
	for (let i = journal.done; i < journal.ops.length; i++) {
		const op = journal.ops[i] as RenameOp;
		journal.intent = i;
		save(`rename_intent_${i}`);
		renameSync(op.src, op.dst);
		journal.done = i + 1;
		journal.intent = -1;
		save(`rename_done_${i}`);
	}
}

/** How many ops are done, counting an intended one the filesystem shows was performed. */
export function effectiveDone(journal: Journal): number {
	if (journal.intent >= 0 && journal.intent === journal.done) {
		const op = journal.ops[journal.intent];
		if (op && !exists(op.src) && exists(op.dst)) return journal.done + 1;
	}
	return journal.done;
}

/** Reverses the done renames, last first. Idempotent: a rename already undone is skipped. */
export function undoSwap(journal: Journal, save: (step: string) => void): void {
	const count = effectiveDone(journal);
	for (let i = count - 1; i >= 0; i--) {
		const op = journal.ops[i] as RenameOp;
		if (exists(op.dst) && !exists(op.src)) {
			renameSync(op.dst, op.src);
		}
		journal.done = i;
		journal.intent = -1;
		save(`undo_${i}`);
	}
	journal.done = 0;
	journal.intent = -1;
}

/** `.env*` entries at the root of `dir` that aren't plain files (a link would copy what it points at, or nothing). */
export function irregularEnvEntries(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".env") && !lstatSync(join(dir, name)).isFile()) out.push(name);
	}
	return out;
}

/**
 * Copies every `.env*` regular file at the root of `from` into `to`, with its mode, except names the new tree
 * tracks (`.env.example` is part of the release: the old copy must not replace it, or the next update finds a
 * modified tracked file). Returns how many were copied.
 */
export function carryEnvFiles(
	from: string,
	to: string,
	trackedInNew: ReadonlySet<string> = new Set(),
): number {
	let count = 0;
	for (const name of readdirSync(from)) {
		if (!name.startsWith(".env") || trackedInNew.has(name)) continue;
		const source = join(from, name);
		const info = lstatSync(source);
		if (!info.isFile()) continue;
		const target = join(to, name);
		copyFileSync(source, target);
		chmodSync(target, info.mode & 0o777);
		count++;
	}
	return count;
}

/** Atomically points `updater/current` at `<version>` (a relative link, renamed over the old one). */
export function flipCurrent(updaterRoot: string, version: string): void {
	const temp = join(updaterRoot, `.current-${process.pid}`);
	rmSync(temp, { force: true });
	symlinkSync(version, temp);
	renameSync(temp, join(updaterRoot, "current"));
}

/** Installs a staged bundle directory as `updater/<version>` (replacing one already there). */
export function installBundle(updaterRoot: string, stagedDir: string, version: string): void {
	const target = join(updaterRoot, version);
	rmSync(target, { recursive: true, force: true });
	renameSync(stagedDir, target);
}

/** Directories named `<prefix>*` next to the checkout. */
export function listSiblings(parent: string, prefix: string): string[] {
	try {
		return readdirSync(parent)
			.filter((name) => name.startsWith(prefix))
			.map((name) => join(parent, name));
	} catch {
		return [];
	}
}

export function removeTree(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

export function isOlderThan(path: string, ms: number, now: number): boolean {
	try {
		return now - statSync(path).mtimeMs > ms;
	} catch {
		return false;
	}
}
