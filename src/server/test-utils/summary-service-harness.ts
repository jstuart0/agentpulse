/**
 * Shared fixtures for the phase 5 session-summary service tests (AGEN-69).
 *
 * Real database, real registry and adapters, real HTTP to the stub provider:
 * nothing inside the repo is mocked. Import this module AFTER the test's own
 * `import "../ai/__test_db.js"` (config freezes on first import).
 */
import { setSystemTime, spyOn } from "bun:test";
import type { SQL } from "drizzle-orm";
import { eq, inArray, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { STORED } from "../../shared/__fixtures__/session-summary-view/index.js";
import type { StoredSessionSummary } from "../../shared/session-summary.js";
import { ANONYMOUS_ACTOR } from "../auth/actor.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import {
	events,
	aiDailySpend,
	aiSessionSummaries,
	llmProviders,
	sessions,
	settings,
} from "../db/schema/index.js";
import { _resetDrainStateForTest } from "../drain-state.js";
import { invalidateAiFlagsCache } from "../services/ai/feature.js";
import type { ProviderKind } from "../services/ai/llm/types.js";
import { createProvider } from "../services/ai/providers-service.js";
import { setLabsFlag } from "../services/labs-service.js";
import {
	type SummaryRequestCaller,
	type SummaryRequestResult,
	_resetSummaryGenerationsForTest,
	_setSummaryHooksForTest,
	_summaryGenerationCountForTest,
	requestSummaryGeneration,
} from "../services/session-summary-service.js";
import { toDbTimestamp } from "../services/util/db-time.js";
import { type LlmStubServer, type RecordedRequest, startLlmStubServer } from "./llm-stub-server.js";

export const KEY = "sk-test-harness-key-0123456789";

/** Local server date as spend-service.today() computes it. */
export function localDate(d: Date = new Date()): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Awaits `promise` but fails the test after `ms`: never a sleep. */
export async function withDeadline<T>(
	promise: Promise<T>,
	ms = 15_000,
	label = "deadline",
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}: not settled in ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Polls `check` until it is true, with a deadline. */
export async function until(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("until: condition not met in time");
		await new Promise((r) => setTimeout(r, 5));
	}
}

export async function seedSession(
	sessionId: string,
	over: Partial<typeof sessions.$inferInsert> = {},
): Promise<void> {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: "claude_code",
			displayName: `name of ${sessionId}`,
			cwd: "/work/project",
			status: "active",
			...over,
		});
}

export interface SeedEvent {
	eventType: string;
	category?: string | null;
	toolName?: string | null;
	content?: string | null;
	toolInput?: Record<string, unknown> | null;
	toolResponse?: string | null;
	createdAt?: string;
}

/** Inserts events in order, in chunks, and returns their ids (ascending). */
export async function seedEvents(sessionId: string, rows: SeedEvent[]): Promise<number[]> {
	const ids: number[] = [];
	const at = toDbTimestamp(new Date());
	for (let i = 0; i < rows.length; i += 400) {
		const chunk = rows.slice(i, i + 400);
		const inserted = await getDb()
			.insert(events)
			.values(
				chunk.map((r) => ({
					sessionId,
					eventType: r.eventType,
					category: r.category === undefined ? null : r.category,
					toolName: r.toolName ?? null,
					content: r.content ?? null,
					toolInput: r.toolInput ?? null,
					toolResponse: r.toolResponse ?? null,
					rawPayload: {},
					createdAt: r.createdAt ?? at,
				})),
			)
			.returning({ id: events.id });
		ids.push(...inserted.map((r) => r.id));
	}
	return ids;
}

export const prompt = (content: string, createdAt?: string): SeedEvent => ({
	eventType: "UserPromptSubmit",
	category: "prompt",
	content,
	createdAt,
});
export const edit = (file: string, createdAt?: string): SeedEvent => ({
	eventType: "PostToolUse",
	category: "tool_event",
	toolName: "Edit",
	toolInput: { file_path: file },
	createdAt,
});
export const ack = (createdAt?: string): SeedEvent => ({
	eventType: "UserAcknowledge",
	category: "user_ack",
	createdAt,
});

/** A session with one prompt and one edit: enough activity to summarise. */
export async function seedActiveSession(
	sessionId: string,
	over: Partial<typeof sessions.$inferInsert> = {},
): Promise<{ promptId: number; editId: number }> {
	await seedSession(sessionId, over);
	const [promptId, editId] = await seedEvents(sessionId, [
		prompt("Add retry to the uploader."),
		edit("src/uploader.ts"),
	]);
	return { promptId, editId };
}

export async function enableAi(opts: { labsFlag?: boolean } = {}): Promise<void> {
	const now = new Date().toISOString();
	for (const [key, value] of [
		["ai.enabled", true],
		["ai.killSwitch", false],
	] as const) {
		await getDb()
			.insert(settings)
			.values({ key, value, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
	}
	invalidateAiFlagsCache();
	await setLabsFlag("sessionSummary", opts.labsFlag ?? true);
}

export async function setAiSetting(key: string, value: unknown): Promise<void> {
	const now = new Date().toISOString();
	await getDb()
		.insert(settings)
		.values({ key, value, updatedAt: now })
		.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
	invalidateAiFlagsCache();
}

/** A priced default provider whose base URL is the stub (openai is priced; openai_compatible is free). */
export async function seedProvider(
	stub: LlmStubServer,
	over: { kind?: ProviderKind; model?: string; apiKey?: string } = {},
): Promise<void> {
	const kind = over.kind ?? "openai";
	await createProvider({
		name: "Stub provider (never shown)",
		kind,
		model: over.model ?? "gpt-5-mini",
		baseUrl: stub.baseUrl(
			kind === "anthropic" ? "anthropic" : kind === "cohere" ? "cohere" : "openai",
		),
		apiKey: over.apiKey ?? KEY,
		isDefault: true,
	});
}

/** A valid model answer (one JSON object) citing the given event ids. */
export function answer(cite: number[] = [], over: Record<string, unknown> = {}): string {
	const evidence = cite.map((id) => `E${id}`);
	return JSON.stringify({
		overview: "Added retry to the uploader.",
		outcome: { status: "mostly_completed", explanation: "The edit landed." },
		accomplishments: [{ text: "Edited the uploader", evidence }],
		changes: [],
		decisions: [],
		validation: [],
		problems: [],
		unfinished: [],
		nextActions: [],
		handoff: "The uploader now retries.",
		...over,
	});
}

export const STUB_USAGE: { input: number; output: number } = { input: 10_000, output: 1_000 };

// ── rows and spend ───────────────────────────────────────────────────────────

export async function readSummaryRow(sessionId: string) {
	const [row] = await getDb()
		.select()
		.from(aiSessionSummaries)
		.where(eq(aiSessionSummaries.sessionId, sessionId));
	return row;
}

export async function seedSummaryRow(
	sessionId: string,
	over: Partial<typeof aiSessionSummaries.$inferInsert> = {},
): Promise<void> {
	await getDb()
		.insert(aiSessionSummaries)
		.values({ sessionId, ...over });
}

/** A stored summary whose provenance names these event ids. */
export function storedSummary(over: {
	firstEventId?: number | null;
	throughAt?: string | null;
}): StoredSessionSummary {
	return {
		summary: STORED.summary,
		provenance: {
			...STORED.provenance,
			firstEventId: over.firstEventId === undefined ? 1 : over.firstEventId,
			throughAt: over.throughAt === undefined ? "2026-10-04T10:07:00.000Z" : over.throughAt,
		},
	};
}

export async function seedReadySummary(
	sessionId: string,
	opts: { throughEventId: number; firstEventId: number; generatedAt?: string; startedAt?: string },
): Promise<void> {
	const stored = storedSummary({ firstEventId: opts.firstEventId });
	await seedSummaryRow(sessionId, {
		generatedAt: opts.generatedAt ?? toDbTimestamp(new Date()),
		attemptStatus: "idle",
		throughEventId: opts.throughEventId,
		attemptStartedAt: opts.startedAt ?? null,
		summary: stored.summary,
		provenance: stored.provenance,
	});
}

export async function daySpend(): Promise<number> {
	const [row] = await getDb().select().from(aiDailySpend).where(eq(aiDailySpend.date, localDate()));
	return row?.spendCents ?? 0;
}
export async function setDaySpend(cents: number, date = localDate()): Promise<void> {
	await getDb().delete(aiDailySpend).where(eq(aiDailySpend.date, date));
	await getDb()
		.insert(aiDailySpend)
		.values({ userId: "local", date, spendCents: cents, updatedAt: new Date().toISOString() });
}
export async function sessionSpend(sessionId: string): Promise<number> {
	const [row] = await getDb()
		.select({ c: sessions.aiSpendCents })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId));
	return row?.c ?? 0;
}

export interface SpendSnapshot {
	day: number;
	sessions: Record<string, number>;
}
export async function snapshotSpend(...sessionIds: string[]): Promise<SpendSnapshot> {
	const per: Record<string, number> = {};
	for (const id of sessionIds) per[id] = await sessionSpend(id);
	return { day: await daySpend(), sessions: per };
}
/** C-9: asserts the day row moved by `dayDelta` and each listed session by its delta. */
export async function spendDelta(
	before: SpendSnapshot,
	sessionIds: string[] = Object.keys(before.sessions),
): Promise<{ day: number; sessions: Record<string, number> }> {
	const now = await snapshotSpend(...sessionIds);
	return {
		day: now.day - before.day,
		sessions: Object.fromEntries(
			sessionIds.map((id) => [id, now.sessions[id] - (before.sessions[id] ?? 0)]),
		),
	};
}

// ── logs ─────────────────────────────────────────────────────────────────────

/** Captures every console channel; `lines` holds each call's arguments joined. */
export function captureLogs(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
		spyOn(console, m).mockImplementation((...args: unknown[]) => {
			lines.push(
				args
					.map((a) =>
						typeof a === "string"
							? a
							: a instanceof Error
								? `${a.name}:${a.message}:${String(a.cause)}`
								: JSON.stringify(a),
					)
					.join(" "),
			);
		}),
	);
	return {
		lines,
		restore: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
}

export interface CapturedStatement {
	text: string;
	params: unknown[];
}

/** Runs `fn`, recording the text of every raw statement (`all` on SQLite, `execute` on Postgres) the real handle sends. */
export async function captureStatements<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; statements: CapturedStatement[] }> {
	const statements: CapturedStatement[] = [];
	const isPg = config.dialect === "postgres";
	const db = getDb() as unknown as Record<string, (...a: unknown[]) => unknown>;
	const method = isPg ? "execute" : "all";
	const original = (db[method] as (...a: unknown[]) => unknown).bind(db);
	const dialect = isPg ? new PgDialect() : new SQLiteSyncDialect();
	const spy = spyOn(db, method).mockImplementation((query: unknown, ...rest: unknown[]) => {
		const out = dialect.sqlToQuery(query as SQL);
		statements.push({ text: out.sql, params: out.params });
		return original(query, ...rest);
	});
	try {
		return { result: await fn(), statements };
	} finally {
		spy.mockRestore();
	}
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export function startStub(): LlmStubServer {
	return startLlmStubServer();
}

/** C-5: everything a test could leave behind. */
export async function resetWorld(stub: LlmStubServer | null): Promise<void> {
	setSystemTime();
	_resetDrainStateForTest();
	_setSummaryHooksForTest(null);
	_resetSummaryGenerationsForTest();
	const db = getDb();
	await db.delete(aiSessionSummaries);
	await db.delete(events);
	await db.delete(sessions);
	await db.delete(aiDailySpend);
	await db.delete(llmProviders);
	await db.delete(settings);
	invalidateAiFlagsCache();
	stub?.reset();
}

/**
 * The `afterEach` of every summary test (P5-28): reports what the test left behind, then resets.
 * A generation still running, or a request the stub had no script for, is a failure of the
 * test that caused it, named here instead of surfacing as flakiness in the next one. A test
 * that leaves either on purpose clears it itself first (`_resetSummaryGenerationsForTest`,
 * `stub.reset()`).
 */
export async function afterEachGuard(stub: LlmStubServer | null): Promise<void> {
	const running = _summaryGenerationCountForTest();
	const unscripted = stub?.unscripted.map((r) => `${r.shape} ${r.path}`) ?? [];
	stub?.releaseGates();
	await resetWorld(stub);
	const problems: string[] = [];
	if (running > 0) problems.push(`${running} generation(s) still running`);
	if (unscripted.length > 0)
		problems.push(`unscripted provider request(s): ${unscripted.join(", ")}`);
	if (problems.length > 0) throw new Error(`test left behind: ${problems.join("; ")}`);
}

export async function deleteSession(sessionId: string): Promise<void> {
	await getDb().delete(events).where(eq(events.sessionId, sessionId));
	await getDb().delete(aiSessionSummaries).where(eq(aiSessionSummaries.sessionId, sessionId));
	await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));
}

export async function countSummaryRows(ids: string[]): Promise<number> {
	const rows = await getDb()
		.select({ id: aiSessionSummaries.sessionId })
		.from(aiSessionSummaries)
		.where(inArray(aiSessionSummaries.sessionId, ids));
	return rows.length;
}

export { sql };

// ── requests ─────────────────────────────────────────────────────────────────

export const SOLO: SummaryRequestCaller = {
	subject: "solo-subject",
	teamMode: false,
	actor: ANONYMOUS_ACTOR,
};
export const asTeamMember = (subject: string): SummaryRequestCaller => ({
	subject,
	teamMode: true,
	actor: { userId: subject, label: "user", role: "member", mode: "team" },
});

export function request(
	sessionId: string,
	caller: SummaryRequestCaller = SOLO,
): Promise<SummaryRequestResult> {
	return requestSummaryGeneration(sessionId, caller);
}

/** Requests a generation, requires it to have started, and returns its `done` (wrapped: a bare promise would be flattened by `await`). */
export async function startGeneration(
	sessionId: string,
	caller: SummaryRequestCaller = SOLO,
): Promise<{ done: Promise<void> }> {
	const result = await request(sessionId, caller);
	if (result.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(result)}`);
	return { done: result.done };
}

/** Requests a generation and waits for it to end (every test settles what it starts, C-5). */
export async function runGeneration(
	sessionId: string,
	caller: SummaryRequestCaller = SOLO,
): Promise<void> {
	await withDeadline(
		(await startGeneration(sessionId, caller)).done,
		20_000,
		`generation of ${sessionId}`,
	);
}

export function refusalOf(result: SummaryRequestResult): string | null {
	return result.kind === "refused" ? result.refusal.error : null;
}

/** A default provider at an arbitrary base URL (a dead port, a server that answers badly). */
export async function seedProviderAt(
	baseUrl: string,
	over: { kind?: ProviderKind; model?: string } = {},
): Promise<void> {
	await createProvider({
		name: "Stub provider (never shown)",
		kind: over.kind ?? "openai",
		model: over.model ?? "gpt-5-mini",
		baseUrl,
		apiKey: KEY,
		isDefault: true,
	});
}

/** The system and user text of a recorded request, whatever the wire shape. */
export function promptsOf(req: RecordedRequest): { system: string; user: string } {
	const body = JSON.parse(req.body) as Record<string, unknown>;
	if (req.shape === "openai") {
		const messages = body.messages as Array<{ role: string; content: string }>;
		return { system: messages[0].content, user: messages[1].content };
	}
	if (req.shape === "anthropic") {
		const system = body.system as Array<{ text: string }>;
		const messages = body.messages as Array<{ content: string }>;
		return { system: system[0].text, user: messages[0].content };
	}
	return { system: String(body.preamble ?? ""), user: String(body.message ?? "") };
}
