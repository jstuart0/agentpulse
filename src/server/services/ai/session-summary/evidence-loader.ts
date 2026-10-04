/**
 * AGEN-69: reads the events a session summary is built from, within hard
 * bounds, and nothing else. Every read is session-scoped, carries
 * `id BETWEEN`, selects named expressions only (never a whole `raw_payload`,
 * never a whole `tool_input`), and runs as its own `runInOwnTurn` job so a long
 * session cannot hold the event loop.
 *
 * `raw_payload` is read in exactly two places, both for named keys: the
 * `tool_use_id` of a Post row that has no input (to find the Pre row of the
 * same call, the Codex observer posts input on Pre only), and the `error` /
 * `error_message` of a failed shell row that has no response (a Claude
 * PostToolUseFailure carries its text under `error`).
 *
 * Reads, in order:
 *   1 bounds: min(id), max(id), count(*) for the session, and its agent type;
 *   2 chunks, newest first, at most MAX_CHUNKS of CHUNK_SIZE ids each. A chunk
 *     is a two-step statement: the ids first (index-only on
 *     `idx_events_session_id_id`), then a join back for the rows that pass the
 *     class filters. It always reports the chunk's lowest id and row count, so
 *     the cursor advances even when no row passes;
 *   3 first prompts, one statement over the session's oldest CHUNK_SIZE ids.
 * The pairing is part of the chunk statement, not another statement: the job
 * and statement counts do not change (3 for a small session, 11 for 41,000
 * events).
 *
 * `loadEvidence` must never be called from inside a `runInOwnTurn` job: each of
 * its reads is an own-turn job, and a job that waits on another deadlocks the
 * queue. When the queue is full it rejects with `OwnTurnBusyError`, unchanged,
 * and the caller maps that to its busy answer. Any other read failure rejects
 * with `EvidenceReadError`, which carries a code and never SQL text.
 *
 * The pure statement builders are exported (contract C-10) so a test can read
 * the SQL text; `loadEvidence` is the only function that touches the database.
 */
import { type SQL, sql } from "drizzle-orm";
import { config } from "../../../config.js";
import { getDb } from "../../../db/client.js";
import { executeRows, jsonExtractText, jsonReadable, textTail } from "../../../db/sql-helpers.js";
import { OwnTurnBusyError, runInOwnTurn } from "../../../util/own-turn.js";
import type { EvidenceRow, ScanSummary } from "./ledger.js";
import {
	ACTION_ROWS_PER_CHUNK,
	ACTION_ROW_CAP,
	AGENT_MESSAGE_CAP,
	CHUNK_SIZE,
	FIRST_PROMPT_CAP,
	FIRST_PROMPT_COUNT,
	FIRST_PROMPT_WINDOW,
	LAST_AGENT_MESSAGE_CAP,
	MAX_CHUNKS,
	ONE_LINER_CAP,
	PAIRING_AGENTS,
	PAIR_RAW_PAYLOAD_MAX_BYTES,
	PAIR_WINDOW_IDS,
	PROMPT_CAP,
	READ_CLASS_TOOLS,
	RESPONSE_SQL_CAP,
	SHELL_TOOLS,
	SPINE_ROW_CAP,
	SQL_REDACTION_MARGIN,
	TOOL_INPUT_BYTE_BUDGET,
	TOOL_INPUT_FIELD_SQL_CAP,
} from "./limits.js";

// ── statement pieces ─────────────────────────────────────────────────────────

/** Event ids are 32-bit on Postgres; the bounds read uses this as its upper `id BETWEEN` edge. */
const ID_RANGE_MIN = 1;
const ID_RANGE_MAX = 2_147_483_647;

/** Literal SQL list of constants this file owns (never user input); checked at load. */
function literalList(values: readonly string[]): SQL {
	for (const v of values) {
		if (!/^[A-Za-z_]+$/.test(v)) throw new Error(`literalList: unsafe constant ${v}`);
	}
	return sql.raw(values.map((v) => `'${v}'`).join(", "));
}

/**
 * SQLite plans a plain JOIN from either side; it chose to walk every event
 * through `idx_events_created_at_id` and probe the ids. CROSS JOIN fixes the
 * order (ids first, then the primary key). Postgres plans the join well on its
 * own, and CROSS JOIN is not a hint there, so it keeps the plain keyword.
 */
const JOIN = sql.raw(config.dialect === "sqlite" ? "CROSS JOIN" : "JOIN");

/** A constant of this file's own as a SQL integer literal, so a plan sees the real LIMIT. */
function literalInt(value: number): SQL {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`literalInt: ${value}`);
	return sql.raw(String(value));
}

/** The categories that are narrative (spine) evidence. Exported with `classExpression` for phase 5's too-little-activity probe. */
export const SPINE_CATEGORIES = [
	"prompt",
	"assistant_message",
	"permission_event",
	"plan_update",
	"status_update",
	"progress_update",
	"ai_proposal_pending",
	"ai_proposal",
	"ai_report",
	"ai_hitl_request",
	"ai_hitl_response",
	"ai_continue_sent",
	"ai_continue_blocked",
	"ai_error",
] as const;

/**
 * The category a row counts as. A NULL category (a row whose writer set none)
 * falls back to its event type, so it is never silently excluded.
 */
export function effectiveCategory(alias: string): SQL {
	const a = sql.raw(alias);
	return sql`COALESCE(${a}.category, CASE ${a}.event_type
		WHEN 'UserPromptSubmit' THEN 'prompt'
		WHEN 'PostToolUse' THEN 'tool_event'
		WHEN 'PostToolUseFailure' THEN 'tool_event'
		WHEN 'AssistantMessage' THEN 'assistant_message'
		ELSE NULL END)`;
}

/** 'spine' (narrative), 'action' (a finished tool call that is not read-class), or NULL (not evidence). */
export function classExpression(alias: string): SQL {
	const a = sql.raw(alias);
	return sql`CASE
		WHEN ${effectiveCategory(alias)} IN (${literalList(SPINE_CATEGORIES)}) THEN 'spine'
		WHEN ${effectiveCategory(alias)} = 'tool_event'
			AND ${a}.event_type IN ('PostToolUse', 'PostToolUseFailure')
			AND (${a}.tool_name IS NULL OR lower(${a}.tool_name) NOT IN (${literalList(READ_CLASS_TOOLS)}))
		THEN 'action'
		ELSE NULL END`;
}

function cut(expression: SQL, characters: number): SQL {
	return sql`substr(${expression}, 1, ${characters})`;
}

/** The tools whose response SQL reads: a shell call's response holds its exit code and its output. */
const SHELL_RESPONSE_TOOLS = [...SHELL_TOOLS, "unknown_tool"] as const;

function shellToolTest(alias: string): SQL {
	return sql`lower(${sql.raw(alias)}.tool_name) IN (${literalList(SHELL_RESPONSE_TOOLS)})`;
}

/**
 * Every key the loader reads out of a row's `raw_payload` (an untrusted document
 * that can hold anything): the call id for pairing, and the failure text of a row
 * with no response. A key is read only through `rawKey`, so this list is the whole set.
 */
export const RAW_PAYLOAD_KEYS = ["tool_use_id", "error", "error_message"] as const;
type RawPayloadKey = (typeof RAW_PAYLOAD_KEYS)[number];

function rawKey(alias: string, key: RawPayloadKey): SQL {
	return jsonExtractText(sql.raw(`${alias}.raw_payload`), `$.${key}`);
}

/** The call id a row's `raw_payload` carries, NULL for a document that cannot be read by key. */
function callIdOf(alias: string): SQL {
	const raw = sql.raw(`${alias}.raw_payload`);
	const readable = config.dialect === "postgres" ? postgresReadable(raw) : jsonReadable(raw);
	const bytes = storedBytes(raw);
	// Nested: the size test must run before the document is parsed (an AND is not ordered).
	return sql`CASE WHEN ${bytes} <= ${literalInt(PAIR_RAW_PAYLOAD_MAX_BYTES)} THEN
		CASE WHEN ${readable} THEN ${rawKey(alias, "tool_use_id")} END END`;
}

/** The `error` text of a failed row, NULL when its `raw_payload` cannot be read by key. */
function errorTextOf(alias: string): SQL {
	const raw = sql.raw(`${alias}.raw_payload`);
	const readable = config.dialect === "postgres" ? postgresReadable(raw) : jsonReadable(raw);
	return sql`CASE WHEN ${readable} THEN COALESCE(${rawKey(alias, "error")}, ${rawKey(alias, "error_message")}) END`;
}

/** The stored size of a column in bytes, without detoasting it on Postgres. */
function storedBytes(col: SQL): SQL {
	return config.dialect === "postgres"
		? sql`COALESCE(pg_column_size(${col}), 0)`
		: sql`COALESCE(length(CAST(${col} AS BLOB)), 0)`;
}

/** The size of a row's `tool_input` in bytes. */
function inputBytes(alias: string): SQL {
	return storedBytes(sql.raw(`${alias}.tool_input`));
}

const INPUT_KEYS = ["file_path", "path", "command", "cmd", "description"] as const;
type InputKey = (typeof INPUT_KEYS)[number];

/**
 * The text of one `tool_input` key, cut in SQL. A row whose document holds a
 * `\\u0000` or surrogate escape yields NULL for every key (Postgres json
 * stores such a document but fails reading ANY key of it, even with `->`), so
 * one such row cannot fail the statement for the rest. A row past the byte
 * budget yields NULL for every key.
 *
 * Postgres takes the keys of a row as json fragments (`->` returns NULL for an
 * array or scalar document) once per row in a fenced lateral behind a single
 * guard: a guard or `->>` per key re-parses the whole document each time (618 ms
 * for 350 fat rows measured, against about 250 ms here). SQLite parses once for
 * `json_valid` and `json_extract` together.
 */
function ownField(key: InputKey): SQL {
	if (config.dialect === "postgres") {
		return cut(sql`CAST(${sql.raw(`r.${key}`)} #>> '{}' AS text)`, TOOL_INPUT_FIELD_SQL_CAP);
	}
	const extracted = jsonExtractText(sql.raw("e.tool_input"), `$.${key}`);
	return sql`CASE WHEN p.cls = 'action' AND p.run_bytes <= ${literalInt(TOOL_INPUT_BYTE_BUDGET)} AND ${jsonReadable(sql.raw("e.tool_input"))}
		THEN ${cut(sql`CAST(${extracted} AS text)`, TOOL_INPUT_FIELD_SQL_CAP)} END`;
}

/** The same key of the paired Pre row (alias `pre`; Postgres through the lateral `pr`). */
function preField(key: InputKey): SQL {
	if (config.dialect === "postgres") {
		return cut(sql`CAST(${sql.raw(`pr.${key}`)} #>> '{}' AS text)`, TOOL_INPUT_FIELD_SQL_CAP);
	}
	const extracted = jsonExtractText(sql.raw("pre.tool_input"), `$.${key}`);
	return sql`CASE WHEN pre.id IS NOT NULL AND ${jsonReadable(sql.raw("pre.tool_input"))}
		THEN ${cut(sql`CAST(${extracted} AS text)`, TOOL_INPUT_FIELD_SQL_CAP)} END`;
}

/**
 * The exact readability test is a regex over the whole document, so a plain
 * substring test for a backslash-u escape runs first: almost no document has
 * one, and only those pay for the regex.
 */
function postgresReadable(column: SQL): SQL {
	return sql`(strpos(CAST(${column} AS text), ${"\\u"}) = 0 OR ${jsonReadable(column)})`;
}

function postgresKeyLateral(alias: string, guard: SQL): SQL {
	const col = sql.raw(`${alias}.tool_input`);
	const keys = INPUT_KEYS.map((k) => sql`(${col}::json) -> ${k} AS ${sql.raw(k)}`);
	return sql`LEFT JOIN LATERAL (
		SELECT ${sql.join(keys, sql`, `)}
		WHERE ${guard} AND ${postgresReadable(col)} OFFSET 0
	) ${sql.raw(alias === "e" ? "r" : "pr")} ON true`;
}

export interface ChunkParams {
	sessionId: string;
	/** The chunk's id window: `lo` is the session's first id, `cursor` the highest id of this chunk. */
	lo: number;
	cursor: number;
	/** Narrative rows still wanted; 0 asks for tool rows only. */
	spineLimit: number;
	/** Tool rows still wanted in this chunk (at most ACTION_ROWS_PER_CHUNK); 0 asks for narrative rows only. */
	actionLimit: number;
	/** The newest chunk may hold the session's last agent message, which is read at a larger cap. */
	newestChunk: boolean;
	/** The session's agent type; only a Codex session (or an `unknown_tool` row) probes for a Pre row. */
	agentType?: string | null;
	/** Retry mode: tool rows are returned with no input fields, no pairing and no raw_payload read. */
	withoutInputs?: boolean;
}

/** The text caps (characters) SQL reads, per category, each with the redaction margin. */
function contentExpression(params: ChunkParams): SQL {
	const message =
		(params.newestChunk ? LAST_AGENT_MESSAGE_CAP : AGENT_MESSAGE_CAP) + SQL_REDACTION_MARGIN;
	return sql`CASE ${effectiveCategory("e")}
		WHEN 'prompt' THEN ${cut(sql`e.content`, PROMPT_CAP + SQL_REDACTION_MARGIN)}
		WHEN 'assistant_message' THEN ${cut(sql`e.content`, message)}
		ELSE ${cut(sql`e.content`, ONE_LINER_CAP + SQL_REDACTION_MARGIN)} END`;
}

/**
 * One chunk, two steps in one statement: the chunk's ids (a bounded index
 * range, newest first) and then the rows among them that are evidence. The
 * first result row always carries the chunk's lowest id and size; row columns
 * are NULL when nothing was selected.
 *
 * For the tool rows: `picked` keeps a running byte total of their `tool_input`
 * (newest first), and fields are read only while it is under
 * TOOL_INPUT_BYTE_BUDGET; a Post row with no input looks up the Pre row of the
 * same call within PAIR_WINDOW_IDS ids before it (the probe rides
 * `idx_events_session_id_id`, nearest first, and stops at the first match).
 */
export function buildChunkStatement(params: ChunkParams): SQL {
	const wantSpine = params.spineLimit > 0;
	const wantAction = params.actionLimit > 0;
	const inputs = wantAction && !params.withoutInputs;
	const pg = config.dialect === "postgres";
	const budget = literalInt(TOOL_INPUT_BYTE_BUDGET);
	const content = wantSpine
		? sql`CASE WHEN p.cls = 'spine' THEN ${contentExpression(params)} END`
		: sql`NULL`;
	const orNull = (value: SQL) => (inputs ? value : sql`NULL`);
	const filePath = orNull(sql`COALESCE(${ownField("file_path")}, ${ownField("path")})`);
	const command = orNull(sql`COALESCE(${ownField("command")}, ${ownField("cmd")})`);
	const description = orNull(ownField("description"));
	const mayPair = PAIRING_AGENTS.includes(params.agentType ?? "")
		? sql`1 = 1`
		: sql`lower(e.tool_name) = 'unknown_tool'`;
	const callId = orNull(
		sql`CASE WHEN p.cls = 'action' AND e.tool_input IS NULL AND ${mayPair} THEN ${callIdOf("e")} END`,
	);
	const shell = shellToolTest("e");
	const response = wantAction
		? sql`CASE WHEN p.cls = 'action' AND ${shell} THEN ${cut(sql`e.tool_response`, RESPONSE_SQL_CAP)} END`
		: sql`NULL`;
	const failureText = inputs
		? sql`COALESCE(${textTail(sql`e.tool_response`, RESPONSE_SQL_CAP)}, ${cut(errorTextOf("e"), RESPONSE_SQL_CAP)})`
		: textTail(sql`e.tool_response`, RESPONSE_SQL_CAP);
	const responseTail = wantAction
		? sql`CASE WHEN p.cls = 'action' AND e.event_type = 'PostToolUseFailure' AND ${shell} THEN ${failureText} END`
		: sql`NULL`;
	const inputGuard = sql`p.cls = 'action' AND p.run_bytes <= ${budget}`;

	const picked = inputs
		? sql`picked AS (
	SELECT x.id AS id, x.cls AS cls,
		SUM(CASE WHEN x.cls = 'action' THEN x.in_bytes ELSE 0 END) OVER (ORDER BY x.id DESC) AS run_bytes
	FROM (SELECT p0.id AS id, p0.cls AS cls, ${inputBytes("e")} AS in_bytes
		FROM picked0 p0 ${JOIN} events e ON e.id = p0.id) x
)`
		: sql`picked AS (SELECT id, cls, 0 AS run_bytes FROM picked0)`;

	const ex = sql`ex AS (
	SELECT p.id AS id, p.cls AS cls, e.created_at AS created_at, e.event_type AS event_type,
		e.category AS category, e.tool_name AS tool_name,
		${content} AS content, ${filePath} AS file_path, ${command} AS command_text,
		${description} AS description_text, ${response} AS response_text, ${responseTail} AS response_tail,
		${callId} AS call_id
	FROM picked p ${JOIN} events e ON e.id = p.id
	${pg && inputs ? postgresKeyLateral("e", inputGuard) : sql``}
)`;

	const pairing = inputs
		? sql`,
pair AS MATERIALIZED (
	SELECT ex.id AS id, (
		SELECT pre2.id FROM events pre2
		WHERE pre2.session_id = ${params.sessionId}
			AND pre2.id BETWEEN ex.id - ${literalInt(PAIR_WINDOW_IDS)} AND ex.id
			AND pre2.event_type = 'PreToolUse'
			AND ${callIdOf("pre2")} = ex.call_id
		ORDER BY pre2.id DESC LIMIT 1
	) AS pre_id
	FROM ex WHERE ex.call_id IS NOT NULL
),
paired AS (
	SELECT ex.id AS id, ex.cls AS cls, ex.created_at AS created_at, ex.event_type AS event_type,
		ex.category AS category,
		CASE WHEN lower(ex.tool_name) = 'unknown_tool' AND pre.tool_name IS NOT NULL
			THEN pre.tool_name ELSE ex.tool_name END AS tool_name,
		ex.content AS content,
		COALESCE(ex.file_path, ${cut(sql`COALESCE(${preField("file_path")}, ${preField("path")})`, TOOL_INPUT_FIELD_SQL_CAP)}) AS file_path,
		COALESCE(ex.command_text, ${preField("command")}, ${preField("cmd")}) AS command_text,
		ex.description_text AS description_text, ex.response_text AS response_text,
		ex.response_tail AS response_tail
	FROM ex
	LEFT JOIN pair ON pair.id = ex.id
	LEFT JOIN events pre ON pre.id = pair.pre_id
	${pg ? postgresKeyLateral("pre", sql`pre.id IS NOT NULL`) : sql``}
)`
		: sql``;
	const source = inputs ? sql`paired` : sql`ex`;

	return sql`
WITH ids AS MATERIALIZED (
	SELECT id FROM events
	WHERE session_id = ${params.sessionId} AND id BETWEEN ${params.lo} AND ${params.cursor}
	ORDER BY id DESC LIMIT ${literalInt(CHUNK_SIZE)}
),
cand AS MATERIALIZED (
	SELECT e.id AS id, ${classExpression("e")} AS cls
	FROM ids ${JOIN} events e ON e.id = ids.id
),
meta AS (
	SELECT min(id) AS chunk_lo, count(*) AS chunk_rows,
		CAST(COALESCE(SUM(CASE WHEN cls = 'spine' THEN 1 ELSE 0 END), 0) AS integer) AS spine_total,
		CAST(COALESCE(SUM(CASE WHEN cls = 'action' THEN 1 ELSE 0 END), 0) AS integer) AS action_total
	FROM cand
),
ranked AS (
	SELECT id, cls, ROW_NUMBER() OVER (PARTITION BY cls ORDER BY id DESC) AS rn
	FROM cand WHERE cls IS NOT NULL
),
picked0 AS (
	SELECT id, cls FROM ranked
	WHERE (cls = 'spine' AND rn <= ${params.spineLimit}) OR (cls = 'action' AND rn <= ${params.actionLimit})
),
${picked},
${ex}${pairing}
SELECT meta.chunk_lo, meta.chunk_rows, meta.spine_total, meta.action_total,
	(SELECT created_at FROM events WHERE id = meta.chunk_lo) AS chunk_lo_at,
	${source}.id, ${source}.cls, ${source}.created_at, ${source}.event_type, ${source}.category,
	${source}.tool_name, ${source}.content, ${source}.file_path, ${source}.command_text,
	${source}.description_text, ${source}.response_text, ${source}.response_tail
FROM meta LEFT JOIN ${source} ON 1 = 1
ORDER BY ${source}.id DESC`;
}

/** The bounds, and the session's agent type (a scalar read of one column through the unique `session_id`). */
export function buildBoundsStatement(sessionId: string): SQL {
	return sql`SELECT min(id) AS min_id, max(id) AS max_id, count(*) AS total,
		(SELECT agent_type FROM sessions WHERE session_id = ${sessionId}) AS agent_type
		FROM events WHERE session_id = ${sessionId} AND id BETWEEN ${ID_RANGE_MIN} AND ${ID_RANGE_MAX}`;
}

/** The first prompts: the earliest prompts among the session's oldest FIRST_PROMPT_WINDOW ids. */
export function buildFirstPromptsStatement(sessionId: string, lo: number, hi: number): SQL {
	return sql`
WITH ids AS MATERIALIZED (
	SELECT id FROM events
	WHERE session_id = ${sessionId} AND id BETWEEN ${lo} AND ${hi}
	ORDER BY id ASC LIMIT ${literalInt(FIRST_PROMPT_WINDOW)}
)
SELECT e.id AS id, e.created_at AS created_at, e.event_type AS event_type, e.category AS category,
	${cut(sql`e.content`, FIRST_PROMPT_CAP + SQL_REDACTION_MARGIN)} AS content
FROM ids ${JOIN} events e ON e.id = ids.id
WHERE ${effectiveCategory("e")} = 'prompt'
ORDER BY e.id ASC LIMIT ${literalInt(FIRST_PROMPT_COUNT)}`;
}

// ── running ──────────────────────────────────────────────────────────────────

export interface StatementDiagnostic {
	kind: "bounds" | "chunk" | "first_prompts";
	rows: number;
	/** Characters of text the statement returned into JS. */
	chars: number;
	elapsedMs: number;
}

/** A read failed and could not be retried. Carries a code only: never SQL text, never the driver's error. */
export class EvidenceReadError extends Error {
	readonly code = "evidence_read_failed";
	constructor(readonly statement: StatementDiagnostic["kind"]) {
		super(`evidence read failed (${statement})`);
		this.name = "EvidenceReadError";
	}
}

export interface EvidenceBundle {
	/** The session's agent type, read with the bounds; null when the session row is gone. */
	agentType: string | null;
	/** `max(id)` read before the evidence; null for a session with no events. */
	throughEventId: number | null;
	/** `min(id)` read before the evidence. */
	firstEventId: number | null;
	rows: EvidenceRow[];
	firstPromptRows: EvidenceRow[];
	scan: ScanSummary;
	diagnostics: { jobs: number; chunks: number; statements: StatementDiagnostic[] };
}

type RawRow = Record<string, unknown>;

function text(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function toEvidenceRow(raw: RawRow): EvidenceRow {
	return {
		id: Number(raw.id),
		createdAt: String(raw.created_at ?? ""),
		eventType: String(raw.event_type ?? ""),
		category: text(raw.category),
		toolName: text(raw.tool_name),
		content: text(raw.content),
		filePath: text(raw.file_path),
		command: text(raw.command_text),
		description: text(raw.description_text),
		response: text(raw.response_text),
		responseTail: text(raw.response_tail),
	};
}

function sizeOf(raw: RawRow): number {
	let n = 0;
	for (const value of Object.values(raw)) if (typeof value === "string") n += value.length;
	return n;
}

async function runStatement(
	kind: StatementDiagnostic["kind"],
	query: SQL,
	diagnostics: EvidenceBundle["diagnostics"],
): Promise<RawRow[]> {
	try {
		return await runInOwnTurn(async () => {
			diagnostics.jobs++;
			const started = performance.now();
			const rows = await executeRows<RawRow>(getDb(), query);
			diagnostics.statements.push({
				kind,
				rows: rows.length,
				chars: rows.reduce((n, r) => n + sizeOf(r), 0),
				elapsedMs: performance.now() - started,
			});
			return rows;
		});
	} catch (error) {
		if (error instanceof OwnTurnBusyError) throw error;
		throw new EvidenceReadError(kind);
	}
}

export async function loadEvidence(sessionId: string): Promise<EvidenceBundle> {
	const diagnostics: EvidenceBundle["diagnostics"] = { jobs: 0, chunks: 0, statements: [] };
	const [bounds] = await runStatement("bounds", buildBoundsStatement(sessionId), diagnostics);
	const total = Number(bounds?.total ?? 0);
	const minId =
		bounds?.min_id === null || bounds?.min_id === undefined ? null : Number(bounds.min_id);
	const maxId =
		bounds?.max_id === null || bounds?.max_id === undefined ? null : Number(bounds.max_id);
	const agentType = text(bounds?.agent_type);
	const scan: ScanSummary = {
		eventsTotal: total,
		eventsRead: 0,
		eligibleRead: 0,
		droppedByCap: 0,
		reachedFirstEvent: true,
		oldestReadAt: null,
	};
	if (minId === null || maxId === null || total === 0) {
		return {
			agentType,
			throughEventId: null,
			firstEventId: null,
			rows: [],
			firstPromptRows: [],
			scan,
			diagnostics,
		};
	}

	const rows: EvidenceRow[] = [];
	let cursor = maxId;
	let spineLeft = SPINE_ROW_CAP;
	let actionLeft = ACTION_ROW_CAP;
	let lowestRead = maxId + 1;
	while (diagnostics.chunks < MAX_CHUNKS && cursor >= minId && (spineLeft > 0 || actionLeft > 0)) {
		const chunkParams: ChunkParams = {
			sessionId,
			lo: minId,
			cursor,
			spineLimit: spineLeft,
			actionLimit: Math.min(actionLeft, ACTION_ROWS_PER_CHUNK),
			newestChunk: diagnostics.chunks === 0,
			agentType,
		};
		// A chunk that fails is retried once without reading any tool input: its tool rows come
		// back as `[not shown]` entries, so one unreadable row cannot make the session unsummarisable.
		const result = await runStatement("chunk", buildChunkStatement(chunkParams), diagnostics).catch(
			(error: unknown) => {
				if (error instanceof OwnTurnBusyError) throw error;
				return runStatement(
					"chunk",
					buildChunkStatement({ ...chunkParams, withoutInputs: true }),
					diagnostics,
				);
			},
		);
		diagnostics.chunks++;
		const meta = result[0];
		const chunkLo =
			meta?.chunk_lo === null || meta?.chunk_lo === undefined ? null : Number(meta.chunk_lo);
		if (!meta || chunkLo === null) break;
		scan.eventsRead += Number(meta.chunk_rows);
		scan.eligibleRead += Number(meta.spine_total) + Number(meta.action_total);
		let spineGot = 0;
		let actionGot = 0;
		for (const raw of result) {
			if (raw.id === null || raw.id === undefined) continue;
			rows.push(toEvidenceRow(raw));
			if (raw.cls === "spine") spineGot++;
			else actionGot++;
		}
		scan.droppedByCap +=
			Number(meta.spine_total) - spineGot + (Number(meta.action_total) - actionGot);
		spineLeft -= spineGot;
		actionLeft -= actionGot;
		lowestRead = chunkLo;
		scan.oldestReadAt = text(meta.chunk_lo_at);
		cursor = chunkLo - 1;
	}
	scan.reachedFirstEvent = cursor < minId;

	const firstPromptRows = (
		await runStatement(
			"first_prompts",
			buildFirstPromptsStatement(sessionId, minId, maxId),
			diagnostics,
		)
	).map(toEvidenceRow);
	const seen = new Set(rows.map((r) => r.id));
	for (const row of firstPromptRows) {
		if (seen.has(row.id)) continue;
		if (row.id >= lowestRead) {
			// Inside the scanned window but left out by the narrative cap: now represented.
			scan.droppedByCap -= 1;
		} else {
			scan.eventsRead += 1;
			scan.eligibleRead += 1;
		}
	}
	return {
		agentType,
		throughEventId: maxId,
		firstEventId: minId,
		rows,
		firstPromptRows,
		scan,
		diagnostics,
	};
}
