/**
 * What a supervisor says about the exclude file on its host: "none" (no rules),
 * "ok" (rules in use) or "invalid" (the file has an error, so that supervisor is
 * sending no session data). It rides on the heartbeat as one optional field.
 *
 * A current supervisor sends a body only when the state is "invalid" and nothing at
 * all otherwise (the older "none" / "ok" words are still accepted, and clear the flag).
 *
 * Only "invalid" is kept, because it is the only state somebody has to act on:
 * "none" and "ok" are accepted and stored as null, so the server never records
 * which hosts use exclusion (and any team member who can list hosts cannot learn
 * it). The flag lives in one nullable column, supervisors.exclude_rules_state
 * (null = nothing to act on, or a supervisor from before the field existed), and
 * is cleared when the supervisor registers and when a heartbeat arrives with no
 * body or an empty one (an older supervisor after a downgrade must not leave a
 * stale warning behind).
 *
 * A heartbeat is never rejected because of this field (a failing heartbeat makes
 * the supervisor exit): the body is read tolerantly and bounded, anything that is
 * not a valid state leaves the column alone, and a failure to write it is logged
 * and swallowed. The column is written with plain SQL and read from the row
 * through a narrow cast, so this module does not depend on the schema file that
 * declares the column.
 */
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "../db/client.js";
import { executeRows } from "../db/sql-helpers.js";

/** The states a supervisor may report on the wire. */
const REPORTABLE_STATES = ["none", "ok", "invalid"] as const;
/** The one state the server keeps and returns. */
export type ExcludeRulesState = "invalid";
type ReportedState = (typeof REPORTABLE_STATES)[number];

/** The field is one short word; anything past this is not a heartbeat this server wants to read. */
const MAX_HEARTBEAT_BODY_BYTES = 1024;

function parseReportedState(value: unknown): ReportedState | null {
	return typeof value === "string" && (REPORTABLE_STATES as readonly string[]).includes(value)
		? (value as ReportedState)
		: null;
}

/** The flag on a supervisors row: "invalid", or null for anything else (a value an earlier version stored, no value, or no column). */
export function excludeRulesStateOf(row: object): ExcludeRulesState | null {
	return (row as { excludeRulesState?: unknown }).excludeRulesState === "invalid"
		? "invalid"
		: null;
}

/** The request body as text, or null when it is longer than the limit (then it is not read further) or cannot be read. */
async function readBoundedBody(c: Context, limit: number): Promise<string | null> {
	const declared = Number(c.req.header("content-length"));
	if (Number.isFinite(declared) && declared > limit) return null;
	const stream = c.req.raw.body;
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * A heartbeat's body, read once and bounded: nothing (an older supervisor, or a current one with nothing to
 * say), a JSON object, or something that could not be read (too long, a stream failure, not JSON, not an
 * object). Every field of the heartbeat is judged from this one read.
 */
export type HeartbeatBody =
	| { kind: "empty" }
	| { kind: "object"; value: Record<string, unknown> }
	| { kind: "unreadable" };

export async function readHeartbeatBody(c: Context): Promise<HeartbeatBody> {
	const text = await readBoundedBody(c, MAX_HEARTBEAT_BODY_BYTES);
	if (text === null) return { kind: "unreadable" };
	if (text.trim() === "") return { kind: "empty" };
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { kind: "object", value: parsed as Record<string, unknown> };
		}
	} catch {
		// falls through
	}
	return { kind: "unreadable" };
}

/** What a heartbeat's body says to do with the flag. */
type Reported = "set" | "clear" | "leave";

function reportedState(body: HeartbeatBody): Reported {
	// No body at all, or an empty one: an older supervisor, which cannot be saying "invalid".
	if (body.kind === "empty") return "clear";
	if (body.kind === "unreadable") return "leave";
	if (!Object.hasOwn(body.value, "excludeRulesState")) return "leave";
	const state = parseReportedState(body.value.excludeRulesState);
	if (state === null) return "leave";
	return state === "invalid" ? "set" : "clear";
}

let warned = false;

function warnOnce(error: unknown) {
	if (warned) return;
	warned = true;
	console.warn(
		JSON.stringify({
			kind: "heartbeat_exclude_state_failed",
			level: "warn",
			error: error instanceof Error ? error.message : String(error),
		}),
	);
}

/** How the flag is written; replaceable so a test can make the write fail without touching the schema. */
type FlagWriter = (supervisorId: string, state: ExcludeRulesState | null) => Promise<void>;

async function writeFlag(supervisorId: string, state: ExcludeRulesState | null) {
	await executeRows(
		getDb(),
		// Clearing a flag that is already clear writes nothing: a healthy host's
		// heartbeat (which sends no body) costs no more than it did before the flag.
		state === null
			? sql`UPDATE supervisors SET exclude_rules_state = NULL WHERE id = ${supervisorId} AND exclude_rules_state IS NOT NULL`
			: sql`UPDATE supervisors SET exclude_rules_state = ${state} WHERE id = ${supervisorId}`,
	);
}

/**
 * Applies what a heartbeat's body says about the flag. Called once from the heartbeat
 * handler, before the supervisor row is read back for the response. Never throws.
 */
export async function recordHeartbeatExcludeState(
	supervisorId: string,
	body: HeartbeatBody,
	write: FlagWriter = writeFlag,
): Promise<void> {
	try {
		const reported = reportedState(body);
		if (reported === "leave") return;
		await write(supervisorId, reported === "set" ? "invalid" : null);
	} catch (error) {
		warnOnce(error);
	}
}
