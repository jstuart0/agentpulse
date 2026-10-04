/**
 * AGEN-69: reads the events a session summary is built from, within hard
 * bounds, and nothing else. Every read is session-scoped, carries
 * `id BETWEEN`, selects named expressions only (never `raw_payload`, never a
 * whole `tool_input`), and runs as its own `runInOwnTurn` job so a long
 * session cannot hold the event loop.
 *
 * Reads, in order:
 *   1 bounds: min(id), max(id), count(*) for the session;
 *   2 chunks, newest first, at most MAX_CHUNKS of CHUNK_SIZE ids each. A chunk
 *     is a two-step statement: the ids first (index-only on
 *     `idx_events_session_id_id`), then a join back for the rows that pass the
 *     class filters. It always reports the chunk's lowest id and row count, so
 *     the cursor advances even when no row passes;
 *   3 first prompts, one statement over the session's oldest CHUNK_SIZE ids.
 *
 * The pure statement builders are exported (contract C-10) so a test can read
 * the SQL text; `loadEvidence` is the only function that touches the database.
 */
import { type SQL, sql } from "drizzle-orm";
import { config } from "../../../config.js";
import { getDb } from "../../../db/client.js";
import { executeRows, jsonExtractText, jsonReadable, textTail } from "../../../db/sql-helpers.js";
import { runInOwnTurn } from "../../../util/own-turn.js";
import { COARSE_VALIDATION_TERMS } from "./command-class.js";
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
	PROMPT_CAP,
	READ_CLASS_TOOLS,
	SPINE_ROW_CAP,
	SQL_REDACTION_MARGIN,
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

const SPINE_CATEGORIES = [
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
function effectiveCategory(alias: string): SQL {
	const a = sql.raw(alias);
	return sql`COALESCE(${a}.category, CASE ${a}.event_type
		WHEN 'UserPromptSubmit' THEN 'prompt'
		WHEN 'PostToolUse' THEN 'tool_event'
		WHEN 'PostToolUseFailure' THEN 'tool_event'
		WHEN 'AssistantMessage' THEN 'assistant_message'
		ELSE NULL END)`;
}

/** 'spine' (narrative), 'action' (a finished tool call that is not read-class), or NULL (not evidence). */
function classExpression(alias: string): SQL {
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

/**
 * One `tool_input` key as text, cut in SQL. A row whose document holds a
 * `\\u0000` or surrogate escape yields NULL for every key (Postgres json
 * stores such a document but fails reading ANY key of it, even with `->`), so
 * one such row cannot fail the statement for the rest.
 *
 * Postgres takes the four keys of a row as json fragments (`->` returns NULL
 * for an array or scalar document) once per row in a fenced lateral behind a
 * single guard: a guard or `->>` per key re-parses the whole document each time
 * (618 ms for 350 fat rows measured, against about 250 ms here). SQLite parses
 * once for `json_valid` and `json_extract` together.
 */
function toolInputField(key: string): SQL {
	if (config.dialect === "postgres") {
		return cut(sql`CAST(${sql.raw(`r.${key}`)} #>> '{}' AS text)`, TOOL_INPUT_FIELD_SQL_CAP);
	}
	const extracted = jsonExtractText(sql.raw("e.tool_input"), `$.${key}`);
	return sql`CASE WHEN p.cls = 'action' AND ${jsonReadable(sql.raw("e.tool_input"))}
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

/** SQL that is true when a command's text might be a validation: a superset of the classifier's allowlist. */
function looksLikeValidation(commandText: SQL): SQL {
	const likes = COARSE_VALIDATION_TERMS.map(
		(term) => sql`lower(${commandText}) LIKE ${`%${term}%`}`,
	);
	return sql.join(likes, sql` OR `);
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
 */
export function buildChunkStatement(params: ChunkParams): SQL {
	const wantSpine = params.spineLimit > 0;
	const wantAction = params.actionLimit > 0;
	const content = wantSpine
		? sql`CASE WHEN p.cls = 'spine' THEN ${contentExpression(params)} END`
		: sql`NULL`;
	const filePath = wantAction
		? sql`COALESCE(${toolInputField("file_path")}, ${toolInputField("path")})`
		: sql`NULL`;
	const command = wantAction ? toolInputField("command") : sql`NULL`;
	const description = wantAction ? toolInputField("description") : sql`NULL`;
	const fullResponse = wantAction
		? sql`CASE WHEN p.cls = 'action' THEN e.tool_response END`
		: sql`NULL`;
	const responseTail = wantAction
		? sql`CASE WHEN p.cls = 'action' AND e.event_type = 'PostToolUseFailure'
			THEN ${textTail(sql`e.tool_response`, TOOL_INPUT_FIELD_SQL_CAP)} END`
		: sql`NULL`;

	// Postgres: the four keys as json fragments, once per action row (OFFSET 0 keeps the planner
	// from inlining the lateral and evaluating each `->` again for every use).
	const postgresKeys = wantAction
		? sql`LEFT JOIN LATERAL (
		SELECT (e.tool_input::json) -> ${"file_path"} AS file_path, (e.tool_input::json) -> ${"path"} AS path,
			(e.tool_input::json) -> ${"command"} AS command, (e.tool_input::json) -> ${"description"} AS description
		WHERE p.cls = 'action' AND ${postgresReadable(sql.raw("e.tool_input"))} OFFSET 0
	) r ON true`
		: sql``;
	const rowCtes = sql`ex AS (
	SELECT p.id AS id, p.cls AS cls, e.created_at AS created_at, e.event_type AS event_type,
		e.category AS category, e.tool_name AS tool_name,
		${content} AS content, ${filePath} AS file_path, ${command} AS command_text,
		${description} AS description_text, ${fullResponse} AS full_response, ${responseTail} AS response_tail
	FROM picked p ${JOIN} events e ON e.id = p.id
	${config.dialect === "postgres" ? postgresKeys : sql``}
)`;

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
picked AS (
	SELECT id, cls FROM ranked
	WHERE (cls = 'spine' AND rn <= ${params.spineLimit}) OR (cls = 'action' AND rn <= ${params.actionLimit})
),
${rowCtes}
SELECT meta.chunk_lo, meta.chunk_rows, meta.spine_total, meta.action_total,
	(SELECT created_at FROM events WHERE id = meta.chunk_lo) AS chunk_lo_at,
	ex.id, ex.cls, ex.created_at, ex.event_type, ex.category, ex.tool_name, ex.content,
	ex.file_path, ex.command_text, ex.description_text,
	CASE WHEN ${looksLikeValidation(sql`COALESCE(ex.command_text, '')`)} THEN ex.full_response END AS response_text,
	ex.response_tail
FROM meta LEFT JOIN ex ON 1 = 1
ORDER BY ex.id DESC`;
}

export function buildBoundsStatement(sessionId: string): SQL {
	return sql`SELECT min(id) AS min_id, max(id) AS max_id, count(*) AS total
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

export interface EvidenceBundle {
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
	return runInOwnTurn(async () => {
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
}

export async function loadEvidence(sessionId: string): Promise<EvidenceBundle> {
	const diagnostics: EvidenceBundle["diagnostics"] = { jobs: 0, chunks: 0, statements: [] };
	const [bounds] = await runStatement("bounds", buildBoundsStatement(sessionId), diagnostics);
	const total = Number(bounds?.total ?? 0);
	const minId =
		bounds?.min_id === null || bounds?.min_id === undefined ? null : Number(bounds.min_id);
	const maxId =
		bounds?.max_id === null || bounds?.max_id === undefined ? null : Number(bounds.max_id);
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
		const result = await runStatement(
			"chunk",
			buildChunkStatement({
				sessionId,
				lo: minId,
				cursor,
				spineLimit: spineLeft,
				actionLimit: Math.min(actionLeft, ACTION_ROWS_PER_CHUNK),
				newestChunk: diagnostics.chunks === 0,
			}),
			diagnostics,
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
	return { throughEventId: maxId, firstEventId: minId, rows, firstPromptRows, scan, diagnostics };
}
