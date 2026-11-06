/**
 * Where an observed Claude session started, proved from the host's own files (AGEN-117 T7). The server's
 * `candidateCwd` follows hooks (and so a `cd`), so it is only a guess; the directory a fork is spawned in is
 * the one the conversation's transcript itself says, found as follows:
 *
 *  - exactly one `<config dir>/projects/*\/<S>.jsonl` (none is `missing`, more than one is `rejected`);
 *  - its head is read as lines of JSON (at most 4 MiB, a line at most 1 MiB), and the FIRST top-level string
 *    `cwd` is taken: where the session started. A value inside another key never counts, so a `"cwd":"/evil"`
 *    in a prompt or tool result changes nothing;
 *  - the project directory's name must equal Claude's own encoding of that value (measured, P0 `s_head`), else
 *    `rejected`: a name the function can't reproduce is a transcript this code doesn't understand;
 *  - the server's candidate must be that directory or inside it.
 *
 * Files only: nothing here starts a process, and no content beyond that one field is kept.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isResumableSessionId } from "../../shared/session-resume.js";

export const HEAD_READ_BYTES = 4 * 1024 * 1024;
export const HEAD_LINE_BYTES = 1024 * 1024;
/** Paths this long or shorter are encoded in full; longer ones are cut and given a hash (measured). */
const FULL_ENCODING_LIMIT = 200;

/** The 32-bit string hash Java and Claude Code use, over UTF-16 units. */
function javaHash(text: string): number {
	let hash = 0;
	for (let i = 0; i < text.length; i++) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
	return hash;
}

/** Claude Code's project directory name for a working directory (measured on 2.1.318, P0 `s_head`). */
export function encodeProjectDirName(cwd: string): string {
	const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
	if (encoded.length <= FULL_ENCODING_LIMIT) return encoded;
	// abs() of the SIGNED value: a negative hash matched only in that form.
	return `${encoded.slice(0, FULL_ENCODING_LIMIT)}-${Math.abs(javaHash(cwd)).toString(36)}`;
}

/** The whole transcript is scanned for the directories it worked in, up to this much; a longer one is refused. */
export const SCAN_MAX_BYTES = 64 * 1024 * 1024;
/** A line longer than this can't be judged, so the transcript is refused. */
export const SCAN_LINE_BYTES = 8 * 1024 * 1024;
/** More distinct directories than this is not a session this code understands. */
export const SCAN_MAX_CWDS = 256;

export type SourceDirectory =
	| { ok: true; dir: string; transcript: string; cwds: string[] }
	| { ok: false; kind: "missing" | "rejected" };

/** The first top-level string `cwd` of a transcript head, or null. Parsed JSON only, never a text search. */
export function firstTopLevelCwd(head: Buffer): string | null {
	let start = 0;
	let consumed = 0;
	while (start < head.length) {
		let end = head.indexOf(0x0a, start);
		const complete = end !== -1;
		if (!complete) end = head.length;
		if (end - start > HEAD_LINE_BYTES) return null;
		// A cut final line is not a line.
		if (!complete && head.length >= HEAD_READ_BYTES) return null;
		const text = head.subarray(start, end).toString("utf8").trim();
		start = end + 1;
		consumed += 1;
		if (text === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const cwd = (parsed as Record<string, unknown>).cwd;
			if (typeof cwd === "string" && cwd !== "") return cwd;
		}
		if (consumed > 10_000) return null;
	}
	return null;
}

/**
 * Every distinct top-level string `cwd` in the transcript, in the order first seen (AGEN-117 P5-X1): a `cd`
 * into an excluded directory would otherwise carry that directory's content into the fork. Null when the
 * transcript can't be fully judged: longer than `SCAN_MAX_BYTES`, a line over `SCAN_LINE_BYTES`, or more
 * than `SCAN_MAX_CWDS` distinct values. Parsed JSON only, like the first-cwd rule.
 */
export function scanAllCwds(path: string): string[] | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		if (fstatSync(fd).size > SCAN_MAX_BYTES) return null;
		const seen = new Set<string>();
		const block = Buffer.alloc(1024 * 1024);
		let carry: Buffer = Buffer.alloc(0);
		let position = 0;
		const take = (line: Buffer): boolean => {
			if (line.length === 0) return true;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line.toString("utf8"));
			} catch {
				return true;
			}
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const cwd = (parsed as Record<string, unknown>).cwd;
				if (typeof cwd === "string" && cwd !== "") {
					seen.add(cwd);
					if (seen.size > SCAN_MAX_CWDS) return false;
				}
			}
			return true;
		};
		while (true) {
			const read = readSync(fd, block, 0, block.length, position);
			if (read === 0) break;
			position += read;
			let data = Buffer.concat([carry, block.subarray(0, read)]);
			let start = 0;
			while (true) {
				const end = data.indexOf(0x0a, start);
				if (end === -1) break;
				if (!take(data.subarray(start, end))) return null;
				start = end + 1;
			}
			data = data.subarray(start);
			if (data.length > SCAN_LINE_BYTES) return null;
			carry = data;
		}
		if (!take(carry)) return null;
		return [...seen];
	} finally {
		closeSync(fd);
	}
}

function readHead(path: string): Buffer | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, HEAD_READ_BYTES);
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, 0);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

const insideOrEqual = (inner: string, outer: string): boolean => {
	const base = outer.endsWith("/") ? outer.slice(0, -1) : outer;
	return inner === outer || inner === base || inner.startsWith(`${base}/`);
};

/**
 * The directory the conversation S started in, and its transcript, for a host whose Claude keeps its
 * projects under `configDir`. `candidate` is the server's guess and must be that directory or inside it.
 */
export function findSourceDirectory(input: {
	configDir: string | null;
	sessionId: string;
	candidate: string;
}): SourceDirectory {
	if (!input.configDir || !isResumableSessionId(input.sessionId)) {
		return { ok: false, kind: "rejected" };
	}
	const projects = join(input.configDir, "projects");
	let names: string[];
	try {
		names = readdirSync(projects);
	} catch {
		return { ok: false, kind: "missing" };
	}
	const matches: Array<{ project: string; file: string }> = [];
	for (const name of names) {
		const file = join(projects, name, `${input.sessionId}.jsonl`);
		try {
			if (lstatSync(file).isFile()) matches.push({ project: name, file });
		} catch {
			// not in this project
		}
	}
	if (matches.length === 0) return { ok: false, kind: "missing" };
	if (matches.length > 1) return { ok: false, kind: "rejected" };
	const match = matches[0] as { project: string; file: string };
	const head = readHead(match.file);
	if (head === null) return { ok: false, kind: "missing" };
	const cwd = firstTopLevelCwd(head);
	if (cwd === null) return { ok: false, kind: "missing" };
	if (!cwd.startsWith("/")) return { ok: false, kind: "rejected" };
	if (encodeProjectDirName(cwd) !== match.project) return { ok: false, kind: "rejected" };
	if (!insideOrEqual(input.candidate, cwd)) return { ok: false, kind: "rejected" };
	const cwds = scanAllCwds(match.file);
	if (cwds === null) return { ok: false, kind: "rejected" };
	return { ok: true, dir: cwd, transcript: match.file, cwds };
}
