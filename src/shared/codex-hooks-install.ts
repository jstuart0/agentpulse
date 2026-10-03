import { constants, accessSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { MERGE_REASON_NOT_JSON, mergeCodexHooksFile } from "./hook-command.js";
import { writeConfigFileAtomicNoFollow } from "./private-file.js";

export type CodexHooksInstallResult =
	| { status: "unchanged" }
	| { status: "written"; hadFile: boolean; backupPath?: string }
	/** The file was left exactly as it was; `message` says why and what to do. Setup carries on. */
	| { status: "skipped"; message: string }
	/** hooks.json is a symlink and a write would be needed: never written through. */
	| { status: "refused-symlink" };

type Writer = (path: string, content: string) => void;

function backupName(path: string, now: Date): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	return `${path}.agentpulse-bak.${stamp}`;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The CLI's Codex hooks.json step: read what is there, merge AgentPulse's
 * hooks into it (mergeCodexHooksFile), keep a timestamped backup of a file it
 * is about to change, and write the result atomically (temp file and rename,
 * never through a symlink). Nothing here prints or exits. A file that cannot be
 * read, is not usable JSON, is read-only, or cannot be written is reported as
 * "skipped", with the file and its directory as they were (a backup made for a
 * write that then failed is removed again). `write` is the test seam.
 */
export function installCodexHooksFile(
	path: string,
	ours: string,
	write: Writer = writeConfigFileAtomicNoFollow,
	now: () => Date = () => new Date(),
): CodexHooksInstallResult {
	const skipped = (reason: string, tail = "It was left untouched."): CodexHooksInstallResult => ({
		status: "skipped",
		message: `Codex hooks not updated: ${path} ${reason}. ${tail} To add the AgentPulse hooks, fix or move that file and run agentpulse setup again.`,
	});

	let isLink = false;
	let existing: string | null = null;
	let unreadable = false;
	let notUtf8 = false;
	try {
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (st) {
			isLink = st.isSymbolicLink();
			try {
				existing = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					readFileSync(path),
				);
			} catch (err) {
				if (err instanceof TypeError) notUtf8 = true;
				else unreadable = true;
			}
		}
	} catch {
		unreadable = true;
	}

	const merge = notUtf8
		? ({ status: "unusable", reason: MERGE_REASON_NOT_JSON } as const)
		: unreadable
			? null
			: mergeCodexHooksFile(existing, ours);
	if (merge?.status === "unchanged") return { status: "unchanged" };
	if (isLink) return { status: "refused-symlink" };
	if (merge === null) return skipped("could not be read");
	if (merge.status === "unusable") return skipped(merge.reason);

	const hadFile = existing !== null;
	if (hadFile) {
		try {
			accessSync(path, constants.W_OK);
		} catch {
			return skipped("is not writable", "It was left untouched (it is read-only).");
		}
	}
	let backupPath: string | undefined;
	if (hadFile) {
		backupPath = backupName(path, now());
		try {
			write(backupPath, existing as string);
		} catch (err) {
			return skipped(`could not be backed up (${describe(err)})`);
		}
	}
	try {
		write(path, merge.text);
	} catch (err) {
		if (backupPath) {
			try {
				unlinkSync(backupPath);
			} catch {
				// best-effort: the backup is a copy of the untouched file
			}
		}
		return skipped(`could not be written (${describe(err)})`);
	}
	return { status: "written", hadFile, ...(backupPath ? { backupPath } : {}) };
}
