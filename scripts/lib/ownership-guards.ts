/**
 * Pattern-parity guards for the ownership work. Three populations that must not
 * grow without someone deciding they should:
 *  - the files that write a session's owner column;
 *  - the files that delete session rows, which must go through the
 *    authorization module (or be a named cascade);
 *  - the bodies of withAdminLock, which must issue every statement on the
 *    transaction handle they are given, never on an ordinary one.
 *
 * The scans read code with comments and string bodies blanked, so a comment or
 * a quoted example never counts. They are line- and bracket-based, not a
 * parser: the tests pin what they do and don't see.
 */
import { type SeamFile, blankCommentsAndStrings } from "./test-seam-utils.js";

export interface OwnershipGuardReport {
	violations: string[];
	ownerWriters: string[];
	sessionDeleters: string[];
	adminLockBodies: number;
}

/** Files allowed to write sessions.owner_user_id, and why. */
export const OWNER_WRITERS_ALLOWED: Readonly<Record<string, string>> = {
	"src/server/services/event-processor.ts":
		"creates a session with the posting key's attribution (first write wins; never changes a non-null owner)",
	"src/server/services/managed-session-state.ts":
		"creates a session a supervisor reports, owned by the host's owner",
	"src/server/services/launch-dispatch.ts":
		"fills an empty owner when a launch is associated with the session it started",
	"src/server/services/session-owner-admin.ts":
		"the admin operations that claim unassigned sessions or change one session's owner",
	"src/server/services/service-keys.ts":
		"hands a key's earlier sessions to its new owner, under the admin lock",
};

/** Files allowed to delete session rows without importing the authorization module, and why. */
export const SESSION_DELETE_ALLOWED: Readonly<Record<string, string>> = {
	"src/server/services/control-actions.ts":
		"the cascade that removes a managed session's rows together, reached only after the caller was authorized",
};

type Region = { start: number; end: number };

const OPENERS = new Set(["(", "{", "["]);
const CLOSERS = new Set([")", "}", "]"]);

/** The text between the bracket at `open` and its match (exclusive), as offsets; null if unbalanced. */
function balanced(blanked: string, open: number): Region | null {
	let depth = 0;
	for (let i = open; i < blanked.length; i++) {
		const ch = blanked[i] as string;
		if (OPENERS.has(ch)) depth++;
		else if (CLOSERS.has(ch)) {
			depth--;
			if (depth === 0) return { start: open + 1, end: i };
		}
	}
	return null;
}

/** Where a statement that starts at `from` ends: a `;` at depth 0, or the bracket that closes its parent. */
function statementEnd(blanked: string, from: number): number {
	let depth = 0;
	for (let i = from; i < blanked.length; i++) {
		const ch = blanked[i] as string;
		if (OPENERS.has(ch)) depth++;
		else if (CLOSERS.has(ch)) {
			depth--;
			if (depth < 0) return i;
		} else if (ch === ";" && depth === 0) return i;
	}
	return blanked.length;
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) if (text[i] === "\n") line++;
	return line;
}

/** Lines of `content` outside comments that match `pattern`: raw SQL lives in strings, which the blanked text hides. */
function rawSqlLines(content: string, pattern: RegExp): number[] {
	const hits: number[] = [];
	content.split("\n").forEach((line, index) => {
		const code = line.trim();
		if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
		if (pattern.test(line)) hits.push(index + 1);
	});
	return hits;
}

const OWNER_KEY = /\bownerUserId\b\s*(?::|,|\}|$)/;

/** 1-based lines where the session owner column is written: `update(sessions).set({ ownerUserId })`, `insert(sessions).values({ ownerUserId })`, or raw SQL. */
export function findSessionOwnerWrites(content: string): number[] {
	const blanked = blankCommentsAndStrings(content);
	const lines = new Set<number>();
	for (const match of blanked.matchAll(/\b(?:update|insert)\(\s*sessions\s*\)/g)) {
		const from = match.index ?? 0;
		const end = statementEnd(blanked, from);
		for (const call of blanked.slice(from, end).matchAll(/\.(?:set|values)\(/g)) {
			const open = from + (call.index ?? 0) + call[0].length - 1;
			const args = balanced(blanked, open);
			if (args && OWNER_KEY.test(blanked.slice(args.start, args.end))) {
				lines.add(lineOf(blanked, from));
			}
		}
	}
	for (const line of rawSqlLines(
		content,
		/(?:UPDATE\s+sessions\b[^`]*\bowner_user_id\b|INSERT\s+INTO\s+sessions\b[^`]*\bowner_user_id\b)/i,
	)) {
		lines.add(line);
	}
	return [...lines].sort((a, b) => a - b);
}

/** 1-based lines that delete session rows. */
export function findSessionDeletes(content: string): number[] {
	const blanked = blankCommentsAndStrings(content);
	const lines = new Set<number>();
	for (const match of blanked.matchAll(/\bdelete\(\s*sessions\s*\)/g)) {
		lines.add(lineOf(blanked, match.index ?? 0));
	}
	for (const line of rawSqlLines(content, /\bDELETE\s+FROM\s+sessions\b/i)) lines.add(line);
	return [...lines].sort((a, b) => a - b);
}

/** How many withAdminLock bodies there are, and the lines in them that use an ordinary handle (`getDb(`). */
export function findHandleUseInAdminLockBodies(content: string): {
	bodies: number;
	lines: number[];
} {
	const blanked = blankCommentsAndStrings(content);
	let bodies = 0;
	const lines: number[] = [];
	for (const match of blanked.matchAll(/\bwithAdminLock\(/g)) {
		const open = (match.index ?? 0) + match[0].length - 1;
		const body = balanced(blanked, open);
		if (!body) continue;
		bodies++;
		for (const use of blanked.slice(body.start, body.end).matchAll(/\bgetDb\(/g)) {
			lines.push(lineOf(blanked, body.start + (use.index ?? 0)));
		}
	}
	return { bodies, lines };
}

const IMPORTS_AUTHORIZATION = /from\s+["'][^"']*\/authorization\.js["']/;

export function checkOwnershipGuards(files: SeamFile[]): OwnershipGuardReport {
	const report: OwnershipGuardReport = {
		violations: [],
		ownerWriters: [],
		sessionDeleters: [],
		adminLockBodies: 0,
	};
	for (const { rel, content } of files) {
		const ownerWrites = findSessionOwnerWrites(content);
		if (ownerWrites.length > 0) {
			report.ownerWriters.push(rel);
			if (!(rel in OWNER_WRITERS_ALLOWED)) {
				report.violations.push(
					`${rel}:${ownerWrites[0]}: writes the session owner column but is not in OWNER_WRITERS_ALLOWED (scripts/lib/ownership-guards.ts). Ingest never changes a non-null owner; add the file there only with the reason.`,
				);
			}
		}
		const deletes = findSessionDeletes(content);
		if (deletes.length > 0) {
			report.sessionDeleters.push(rel);
			if (!IMPORTS_AUTHORIZATION.test(content) && !(rel in SESSION_DELETE_ALLOWED)) {
				report.violations.push(
					`${rel}:${deletes[0]}: deletes session rows without going through services/authorization.js (or being a named cascade in SESSION_DELETE_ALLOWED).`,
				);
			}
		}
		const locked = findHandleUseInAdminLockBodies(content);
		report.adminLockBodies += locked.bodies;
		for (const line of locked.lines) {
			report.violations.push(
				`${rel}:${line}: getDb() inside a withAdminLock body. Issue the statement on the body's tx: an ordinary handle is a second connection on Postgres and escapes the lock's rollback.`,
			);
		}
	}
	return report;
}
