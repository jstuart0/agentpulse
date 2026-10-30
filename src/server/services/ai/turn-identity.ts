/**
 * What "a turn" is, for the watcher.
 *
 * The same turn can be reported by several signals (a hook's `Stop`, a managed
 * session's own `HeadlessPromptCompleted`, a `SessionEnd` that follows), and
 * Codex's detached hooks can arrive out of order. Everything that needs to say
 * "this is the same turn" or "that turn is over" asks here: the report store
 * (one report per turn), the Continue pass (one proposal per turn), the
 * dispatch (never send into a turn that has moved on) and the wake path (which
 * events wake a watcher at all).
 *
 * A leaf over the schema: it imports no AI-runtime, runner or channel code, so
 * every phase can use it.
 */
import { and, desc, eq, gt, inArray, lte, or } from "drizzle-orm";
import { events, controlActions, sessions } from "../../db/schema/index.js";
import { parseDbTimestamp } from "../util/db-time.js";

export type Boundary = "turn_end" | "session_end" | "turn_start";

/** A turn ends: the agent stopped (hook), or a managed session's own turn finished or failed. */
export const TURN_END_EVENT_TYPES: readonly string[] = [
	"Stop",
	"HeadlessTaskCompleted",
	"HeadlessTaskFailed",
	"HeadlessPromptCompleted",
	"HeadlessPromptFailed",
];
/** The session itself ended. */
export const SESSION_END_EVENT_TYPES: readonly string[] = ["SessionEnd", "ManagedSessionStopped"];
/** A turn begins: a person (or a sent prompt) started the next one. */
export const TURN_START_EVENT_TYPES: readonly string[] = [
	"UserPromptSubmit",
	"HeadlessPromptSubmitted",
	"InteractivePromptSubmitted",
];

const BOUNDARY_BY_TYPE = new Map<string, Boundary>([
	...TURN_END_EVENT_TYPES.map((t) => [t, "turn_end"] as const),
	...SESSION_END_EVENT_TYPES.map((t) => [t, "session_end"] as const),
	...TURN_START_EVENT_TYPES.map((t) => [t, "turn_start"] as const),
]);

/**
 * The boundary an event marks, or null. Every `ai_*` category is null whatever
 * its name: the watcher's own events must never wake the watcher.
 */
export function boundaryOf(event: {
	eventType: string;
	category: string | null;
}): Boundary | null {
	if (event.category?.startsWith("ai_")) return null;
	return BOUNDARY_BY_TYPE.get(event.eventType) ?? null;
}

const VALID_TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** A turn id is a short token. Anything else (spaces, 129+ characters, non-strings) is treated as absent. */
export function isValidTurnId(value: unknown): value is string {
	return typeof value === "string" && VALID_TURN_ID_RE.test(value);
}

/** What the turn key needs to know about a session. */
export interface TurnSession {
	sessionId: string;
	agentType: string;
}

/** An event by id; its payload is loaded when the caller didn't bring it. */
export interface TurnEventRef {
	id: number;
	rawPayload?: Record<string, unknown> | null;
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
type Db = any;

/** Only Codex hooks set `turn_id`; for every other agent type the field is ignored (an ingest key can plant one). */
function turnIdOf(session: TurnSession, payload: Record<string, unknown> | null | undefined) {
	if (session.agentType !== "codex_cli") return null;
	const candidate = payload?.turn_id;
	return isValidTurnId(candidate) ? candidate : null;
}

async function loadPayload(db: Db, eventId: number): Promise<Record<string, unknown>> {
	const [row] = await db
		.select({ rawPayload: events.rawPayload })
		.from(events)
		.where(eq(events.id, eventId))
		.limit(1);
	return (row?.rawPayload as Record<string, unknown> | undefined) ?? {};
}

async function newestPromptAtOrBefore(db: Db, sessionId: string, eventId: number) {
	const [row] = await db
		.select({ id: events.id, rawPayload: events.rawPayload })
		.from(events)
		.where(
			and(eq(events.sessionId, sessionId), eq(events.category, "prompt"), lte(events.id, eventId)),
		)
		.orderBy(desc(events.id))
		.limit(1);
	return row as { id: number; rawPayload: Record<string, unknown> } | undefined;
}

/**
 * The key of the turn this event belongs to.
 *  1. Codex only: the event's own valid `turn_id` (holds even when hooks are reordered).
 *  2. Otherwise the newest `prompt`-category event at or before it (a hook
 *     `UserPromptSubmit` or a managed `HeadlessPromptSubmitted` /
 *     `InteractivePromptSubmitted`): `t:<its turn_id>` if Codex set one, else `p:<its id>`.
 *  3. Otherwise `p:0`: a managed launch turn, whose start event isn't a prompt.
 */
export async function computeTurnKey(
	db: Db,
	session: TurnSession,
	triggerEvent: TurnEventRef,
): Promise<string> {
	const payload = triggerEvent.rawPayload ?? (await loadPayload(db, triggerEvent.id));
	const own = turnIdOf(session, payload);
	if (own) return `t:${own}`;
	const prompt = await newestPromptAtOrBefore(db, session.sessionId, triggerEvent.id);
	if (!prompt) return "p:0";
	const promptTurn = turnIdOf(session, prompt.rawPayload);
	return promptTurn ? `t:${promptTurn}` : `p:${prompt.id}`;
}

/**
 * Has the turn moved on? True when any of these holds:
 *  - the newest prompt in the session is a different turn from `turnKey` (a
 *    different `turn_id` when both have one, else a higher id);
 *  - a later boundary event belongs to a different turn (a `SessionEnd` that
 *    follows a reported `Stop` with no new prompt keys the same, so it doesn't);
 *  - anything after the trigger is a prompt, a permission event or a tool
 *    starting (the agent or the person is acting again);
 *  - the session is working again;
 *  - a prompt control action exists that was created after the trigger, in any
 *    status (a human follow-up on a session whose hooks have not reported yet).
 */
export async function isTurnStale(
	db: Db,
	session: TurnSession,
	turnKey: string,
	triggerEvent: { id: number },
	/** A prompt action to leave out of the "a prompt was sent after the trigger" check: the failed attempt a retry replaces. */
	options: { ignoreActionId?: string } = {},
): Promise<boolean> {
	const { sessionId } = session;

	const [trigger] = await db
		.select({ id: events.id, createdAt: events.createdAt })
		.from(events)
		.where(eq(events.id, triggerEvent.id))
		.limit(1);

	// The newest prompt is a different turn.
	const [newestPrompt] = await db
		.select({ id: events.id, rawPayload: events.rawPayload })
		.from(events)
		.where(and(eq(events.sessionId, sessionId), eq(events.category, "prompt")))
		.orderBy(desc(events.id))
		.limit(1);
	if (newestPrompt) {
		const promptTurn = turnIdOf(session, newestPrompt.rawPayload as Record<string, unknown>);
		if (turnKey.startsWith("t:")) {
			if (promptTurn ? `t:${promptTurn}` !== turnKey : newestPrompt.id > triggerEvent.id) {
				return true;
			}
		} else {
			const startedAt = Number(turnKey.slice(2));
			if (!Number.isFinite(startedAt) || newestPrompt.id > startedAt) return true;
		}
	}

	// The agent or the person is acting again.
	const [acting] = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.sessionId, sessionId),
				gt(events.id, triggerEvent.id),
				or(
					inArray(events.category, ["prompt", "permission_event"]),
					eq(events.eventType, "PreToolUse"),
				),
			),
		)
		.limit(1);
	if (acting) return true;

	// A later boundary that belongs to another turn.
	const [laterBoundary] = await db
		.select({ id: events.id, rawPayload: events.rawPayload })
		.from(events)
		.where(
			and(
				eq(events.sessionId, sessionId),
				gt(events.id, triggerEvent.id),
				inArray(events.eventType, [...TURN_END_EVENT_TYPES, ...SESSION_END_EVENT_TYPES]),
			),
		)
		.orderBy(desc(events.id))
		.limit(1);
	if (laterBoundary) {
		const laterKey = await computeTurnKey(db, session, {
			id: laterBoundary.id,
			rawPayload: laterBoundary.rawPayload as Record<string, unknown>,
		});
		if (laterKey !== turnKey) return true;
	}

	const [row] = await db
		.select({ isWorking: sessions.isWorking })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (row?.isWorking === true) return true;

	// A prompt control action created after the trigger, in any status.
	if (trigger) {
		const triggerMs = parseDbTimestamp(trigger.createdAt);
		if (triggerMs !== null) {
			const recent = await db
				.select({ id: controlActions.id, createdAt: controlActions.createdAt })
				.from(controlActions)
				.where(
					and(eq(controlActions.sessionId, sessionId), eq(controlActions.actionType, "prompt")),
				)
				.orderBy(desc(controlActions.createdAt))
				.limit(5);
			for (const action of recent as Array<{ id: string; createdAt: string }>) {
				if (action.id === options.ignoreActionId) continue;
				const ms = parseDbTimestamp(action.createdAt);
				if (ms !== null && ms > triggerMs) return true;
			}
		}
	}
	return false;
}

/**
 * Has anyone started a newer turn since `afterEventId`? One indexed lookup for a
 * prompt after it. The wake path asks it just before queueing a run, so a turn
 * that began while the debounce was running costs nothing.
 */
export async function hasPromptAfter(
	db: Db,
	sessionId: string,
	afterEventId: number,
): Promise<boolean> {
	const [row] = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.sessionId, sessionId),
				eq(events.category, "prompt"),
				gt(events.id, afterEventId),
			),
		)
		.limit(1);
	return row !== undefined;
}
