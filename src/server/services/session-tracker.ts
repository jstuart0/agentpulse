import {
	type SQL,
	and,
	count,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import {
	AGENT_TYPES,
	SESSION_END_TIMEOUT_MS,
	SESSION_IDLE_TIMEOUT_MS,
} from "../../shared/constants.js";
import type { OwnerScope } from "../../shared/owner-scope.js";
import {
	type ActiveOperationalStatus,
	type OperationalStatusInput,
	type SessionListTab,
	getOperationalStatus,
	hasOutstandingPermissionWait,
	isAlreadyAcknowledged,
} from "../../shared/session-state.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type {
	AgentType,
	ManagedState,
	OwnerStatsGroup,
	OwnerStatsResponse,
	SessionStatus,
	SessionTabCounts,
} from "../../shared/types.js";
import type { Actor } from "../auth/actor.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { managedSessions, projects, sessions } from "../db/schema/index.js";
import {
	executeRows,
	isAppIsoTimestamp,
	jsonExtractJson,
	jsonExtractText,
	jsonReadable,
	likeContains,
} from "../db/sql-helpers.js";
import { withTransaction } from "../db/with-transaction.js";
import { createInFlight } from "../util/in-flight.js";
import { runInOwnTurn } from "../util/own-turn.js";
import { mayClearAttention } from "./authorization.js";
import { normalizeHookEvent } from "./event-normalizer.js";
import { insertNormalizedEvents } from "./event-processor.js";
import { getManagedSession, mapManagedSession } from "./managed-session-state.js";
import { sanitizeNativeName } from "./name-sanitizer.js";
import { notifySessionUpdated } from "./notifier.js";
import { mapSessionDto } from "./session-dto.js";
import { listLiveOwnedManagedSessionIds } from "./session-ownership.js";

/**
 * Rename a session atomically across `sessions` and (when present)
 * `managed_sessions`. Both writes happen in a single transaction so a
 * failure on the second statement rolls back the first.
 *
 * The caller is expected to have already validated `name` (non-empty,
 * trimmed). This function performs the trim once more defensively.
 *
 * `options.source` (F5 / Decision 6, contract revised per codex r2 Medium #1)
 * records who initiated the rename via `sessions.metadata.renameSource` —
 * the flag `applyNativeName` below checks to decide whether a native-name
 * pull is allowed to overwrite the display name. Only an **explicit**
 * `source: "user"` stamps the flag. Every other case — an omitted
 * `source`, or an explicit non-"user" value like `"sync"` — is
 * LEGACY-NEUTRAL: the rename happens, but `renameSource` is left
 * untouched. This is deliberate: an old (pre-campaign) relay sends
 * `{ name }` with no `source` field at all, and if omission defaulted to
 * `"user"` that mixed-version relay would misclassify every Codex
 * name-sync pull as a manual rename, permanently blocking future
 * native-name pulls for that session. Callers that need the manual-rename
 * guarantee (dashboard rename UI, the Ask "rename X to Y" command) must
 * pass `{ source: "user" }` explicitly. Metadata is read-modify-written so
 * unrelated keys (e.g. `permissionWait`, `nativeName`) survive.
 */
export async function renameSession(
	sessionId: string,
	name: string,
	options: { source?: string } = {},
): Promise<void> {
	const trimmed = name.trim();
	await withTransaction(async (tx) => {
		const [row] = await tx
			.select({ metadata: sessions.metadata })
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);

		const metadata = { ...(row?.metadata ?? {}) } as Record<string, unknown>;
		if (options.source === "user") {
			metadata.renameSource = "user";
		}

		await tx
			.update(sessions)
			.set({ displayName: trimmed, metadata })
			.where(eq(sessions.sessionId, sessionId));

		const managed = await tx
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId))
			.limit(1);

		if (managed.length > 0) {
			await tx
				.update(managedSessions)
				.set({
					desiredThreadTitle: trimmed,
					providerSyncState: "pending",
					providerSyncError: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(managedSessions.sessionId, sessionId));
		}
	});
}

/**
 * Pull-only sync (F5, Decision 5/6) of Claude Code's native `session_name`
 * into `displayName`. Net-new precedence logic (not mirrored from the
 * Codex relay's push/pull sync, which has no manual-rename guard on its
 * pull direction — see Decision 6): a native name overwrites the
 * AgentPulse auto-generated name, but a manual dashboard rename
 * (`metadata.renameSource === "user"`) always wins.
 *
 * `metadata.nativeName` records the most recently *seen* native name from
 * Claude, updated on every call regardless of outcome — this is what makes
 * repeat calls with the same name idempotent (a second call recognizes the
 * name was already seen and no-ops). `metadata.lastAppliedNativeName`
 * records the value actually *applied* to `displayName`; it is left
 * untouched when the write is refused, since nothing was applied.
 *
 * Returns `{ found: false }` for an unknown session so the route can 404 —
 * deliberately different from `renameSession`'s silent no-op-on-missing-row
 * behavior, because the statusline caller needs to distinguish "session not
 * yet ingested — retry next render" from a successful call.
 */
// F79 (librarian mid-build): sanitizeNativeName moved to name-sanitizer.ts
// so it's independently importable for the shared fixture-based test, and
// (F82, percy) so the pre-cap perf guard lives next to the function it
// protects.
export async function applyNativeName(
	sessionId: string,
	nativeName: string,
): Promise<{
	found: boolean;
	applied: boolean;
	reason?: "manual_rename" | "empty_after_sanitize";
}> {
	const sanitized = sanitizeNativeName(nativeName);
	if (sanitized.length === 0) {
		return { found: false, applied: false, reason: "empty_after_sanitize" };
	}
	return withTransaction(async (tx) => {
		const [row] = await tx
			.select({ displayName: sessions.displayName, metadata: sessions.metadata })
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (!row) return { found: false, applied: false };

		const metadata = { ...(row.metadata ?? {}) } as Record<string, unknown>;
		const alreadySeen = metadata.nativeName === sanitized;

		if (metadata.renameSource === "user") {
			// Manual rename wins. Record that we saw this native name (for
			// idempotency and so later state-diff logic isn't confused about
			// whether it was observed), but refuse to apply it.
			if (alreadySeen) return { found: true, applied: false, reason: "manual_rename" };
			metadata.nativeName = sanitized;
			await tx.update(sessions).set({ metadata }).where(eq(sessions.sessionId, sessionId));
			return { found: true, applied: false, reason: "manual_rename" };
		}

		if (alreadySeen && row.displayName === sanitized) {
			// No-op: already applied on a prior call, nothing changed.
			return { found: true, applied: true };
		}

		metadata.nativeName = sanitized;
		metadata.lastAppliedNativeName = sanitized;
		await tx
			.update(sessions)
			.set({ displayName: sanitized, metadata })
			.where(eq(sessions.sessionId, sessionId));
		return { found: true, applied: true };
	});
}

/**
 * D14: clear the manual-rename pin and, if an agent-reported native name
 * has ever been observed, apply it immediately (so the DTO's nameSource
 * reads "native" right away, without waiting for the next /native-name
 * pull). No-op on displayName when nativeName was never recorded — the
 * session just becomes eligible for the next native-name pull again.
 */
export async function resetNameSource(
	sessionId: string,
): Promise<{ found: boolean; nativeNameApplied: boolean }> {
	return withTransaction(async (tx) => {
		const [row] = await tx
			.select({ displayName: sessions.displayName, metadata: sessions.metadata })
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (!row) return { found: false, nativeNameApplied: false };

		const metadata = { ...(row.metadata ?? {}) } as Record<string, unknown>;
		// biome-ignore lint/performance/noDelete: clearing a JSON metadata key must remove it, not set it to undefined (which would still serialize)
		delete metadata.renameSource;

		const nativeName = metadata.nativeName;
		const updates: Record<string, unknown> = { metadata };
		let nativeNameApplied = false;
		if (typeof nativeName === "string" && nativeName.length > 0) {
			updates.displayName = nativeName;
			metadata.lastAppliedNativeName = nativeName;
			nativeNameApplied = true;
		}

		await tx.update(sessions).set(updates).where(eq(sessions.sessionId, sessionId));
		return { found: true, nativeNameApplied };
	});
}

// `changed` is internal-only (the route uses it to decide whether to
// broadcast; the JSON response never includes it) — true when this call
// actually wrote lastUserAcknowledgedAt, false for an idempotent no-op.
export type AcknowledgeSessionResult =
	| { found: false }
	| { found: true; acknowledged: true; changed: boolean }
	| { found: true; acknowledged: false; reason: "not_owner" | "permission_wait" };

export type UnacknowledgeSessionResult =
	| { found: false }
	| { found: true; unacknowledged: true; changed: boolean }
	| { found: true; unacknowledged: false; reason: "not_owner" };

const ACKNOWLEDGE_CANDIDATE_COLUMNS = {
	ownerUserId: sessions.ownerUserId,
	agentType: sessions.agentType,
	status: sessions.status,
	endedAt: sessions.endedAt,
	lastAgentTurnCompletedAt: sessions.lastAgentTurnCompletedAt,
	lastUserAcknowledgedAt: sessions.lastUserAcknowledgedAt,
	metadata: sessions.metadata,
};

function isOwnerAllowed(ownerUserId: string | null, actor: Actor): boolean {
	return mayClearAttention({
		sessionOwnerUserId: ownerUserId,
		callerUserId: actor.userId,
		authDisabled: config.disableAuth,
		// Team mode only: an admin may clear anyone's WAITING or ERROR.
		adminOverride: actor.mode === "team" && actor.role === "admin",
	});
}

/**
 * Dashboard "mark as seen" (AGEN): stamps lastUserAcknowledgedAt with server
 * time and nothing else — not lastActivityAt, not isWorking, not lifecycle
 * status/endedAt. Stores exactly one `user_ack` timeline event (source
 * "dashboard") through the same normalizer the synthetic hook event uses,
 * via the plain insert-only path (no hook-delivery dedup — this isn't a
 * hook delivery and can't be replayed by a retrying relay).
 *
 * Ownership: counts only when the caller is the session's owner, the
 * session has no owner, or auth is disabled — otherwise a no-op
 * (`acknowledged: false, reason: "not_owner"`) rather than an error, so
 * viewing someone else's session can never clear their WAITING state and
 * never surfaces as a failure in the UI.
 *
 * Permission wait (AGEN): an outstanding permission prompt overrides every
 * other signal in getOperationalStatus, so stamping lastUserAcknowledgedAt
 * here could never move the session out of WAITING. Checked before
 * isAlreadyAcknowledged on purpose — a session waiting ONLY on a prompt (no
 * finished turn at all) has nothing isAlreadyAcknowledged would call
 * "pending", so without this check first it reported a false
 * `{acknowledged: true}` success. A true no-op either way: no write, no
 * stored event, no broadcast from the caller.
 *
 * Idempotent: when isAlreadyAcknowledged says the call wouldn't change the
 * turn/failure signal, this performs no DB write, stores no event, and the
 * caller broadcasts nothing — calling it again (acknowledged or not) never
 * throws and never reanimates a session.
 *
 * `source` identifies what produced the acknowledgement for the timeline
 * label (e.g. "dashboard" for "Mark as seen", "dismiss-error" for the
 * explicit "Dismiss error" action on an ERROR session) — defaults to
 * "dashboard". Sanitized the same way every UserAcknowledge source is
 * (normalizeHookEvent / sanitizeUserAckSource): an unrecognized value
 * collapses to "unknown" rather than being stored verbatim.
 */
export async function acknowledgeSession(
	sessionId: string,
	actor: Actor,
	source = "dashboard",
): Promise<AcknowledgeSessionResult> {
	const [row] = await getDb()
		.select(ACKNOWLEDGE_CANDIDATE_COLUMNS)
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return { found: false };

	if (!isOwnerAllowed(row.ownerUserId, actor)) {
		return { found: true, acknowledged: false, reason: "not_owner" };
	}
	if (hasOutstandingPermissionWait(row)) {
		return { found: true, acknowledged: false, reason: "permission_wait" };
	}
	if (isAlreadyAcknowledged(row)) return { found: true, acknowledged: true, changed: false };

	const now = new Date().toISOString();
	await getDb()
		.update(sessions)
		.set({ lastUserAcknowledgedAt: now })
		.where(eq(sessions.sessionId, sessionId));

	await insertNormalizedEvents(
		sessionId,
		normalizeHookEvent(
			{ session_id: sessionId, hook_event_name: "UserAcknowledge", source },
			row.agentType as AgentType,
		),
	);

	return { found: true, acknowledged: true, changed: true };
}

/**
 * Dashboard "mark as unseen" (AGEN): the inverse of acknowledgeSession.
 * Clears lastUserAcknowledgedAt, which puts a session that had been idled
 * by acknowledgement back into WAITING, and a dismissed failure back into
 * ERROR — getOperationalStatus re-derives the answer from the same turn/
 * endedAt fields it always has. Same ownership rule as acknowledge.
 * Idempotent: a session with no acknowledgement to clear is a no-op —
 * no write, no stored event, no broadcast from the caller.
 */
export async function unacknowledgeSession(
	sessionId: string,
	actor: Actor,
	source = "dashboard",
): Promise<UnacknowledgeSessionResult> {
	const [row] = await getDb()
		.select(ACKNOWLEDGE_CANDIDATE_COLUMNS)
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return { found: false };

	if (!isOwnerAllowed(row.ownerUserId, actor)) {
		return { found: true, unacknowledged: false, reason: "not_owner" };
	}
	if (row.lastUserAcknowledgedAt == null) {
		return { found: true, unacknowledged: true, changed: false };
	}

	await getDb()
		.update(sessions)
		.set({ lastUserAcknowledgedAt: null })
		.where(eq(sessions.sessionId, sessionId));

	await insertNormalizedEvents(
		sessionId,
		normalizeHookEvent(
			{ session_id: sessionId, hook_event_name: "UserUnacknowledge", source },
			row.agentType as AgentType,
		),
	);

	return { found: true, unacknowledged: true, changed: true };
}

// Managed states that indicate an agent process is still running under a live
// supervisor. Sessions in these states must not be auto-completed by staleness
// checks — the supervisor will report terminal state when the process exits.
// Order is preserved from the original slice (interactive/headless/managed
// first, pending last) — the slice TYPE-2b promotion narrows the element type
// to ManagedState so adding a new live state requires picking it from the
// canonical union.
const LIVE_MANAGED_STATES = [
	"interactive_terminal",
	"headless",
	"managed",
	"pending",
] as const satisfies readonly ManagedState[];

type SessionListFilters = {
	status?: SessionStatus;
	agentType?: AgentType;
	projectId?: string;
	/** Filter by the computed operational state rather than the raw lifecycle status (AGEN). */
	operational?: ActiveOperationalStatus;
	/**
	 * Server-side text search (AGEN): matches the same fields the
	 * dashboard's own client-side search does (displayName, cwd,
	 * gitBranch), case-insensitive substring. Composes with `operational`
	 * and `status` — without this, searching inside a server-paged status
	 * filter only ever sees the page already loaded. Empty/whitespace-only
	 * is treated as "no search" (same as omitting the field).
	 */
	q?: string;
	/**
	 * Exclude sessions linked to a project tagged "scratch" (AGEN) — mirrors
	 * the dashboard's "Show scratch workspaces" toggle, applied server-side
	 * so a status-filtered list's rows, its total, and the status card's
	 * count all agree. Opt-in: omitted/false leaves every existing caller's
	 * query shape (and statement count) unchanged.
	 */
	excludeScratch?: boolean;
	/**
	 * Whose sessions (AGEN): one scope shared by the plain list, the
	 * operational candidate scan and every stats query, so rows, totals and
	 * counts describe the same set. Omitted = everyone.
	 */
	owner?: OwnerScope;
	/**
	 * One of the dashboard's three tabs: exactly the sessions the matching stats
	 * count describes (see tabCondition). Not combined with `status` or
	 * `operational`.
	 */
	tab?: SessionListTab;
	/** Working directory contains this text (Ask's "in <directory>"). */
	cwd?: string;
	/** Last activity at or after this ISO time. */
	since?: string;
	/** Last activity before this ISO time. */
	until?: string;
	limit?: number;
	offset?: number;
};

/**
 * The owner scope as a predicate. `user` matches the owner column;
 * `unassigned` and `service` are both ownerless and differ by whether a key is
 * on record (the same split the DTO's ownerKind uses).
 */
function ownerScopeCondition(owner: OwnerScope | undefined): SQL | undefined {
	if (!owner) return undefined;
	switch (owner.kind) {
		case "user":
			return eq(sessions.ownerUserId, owner.userId);
		case "unassigned":
			return and(isNull(sessions.ownerUserId), isNull(sessions.ingestKeyId));
		case "service":
			return and(isNull(sessions.ownerUserId), isNotNull(sessions.ingestKeyId));
	}
}

/**
 * "Not in a scratch workspace", or undefined when there is no scratch project to
 * exclude. `projectId IS NULL` must pass through: a session with no linked
 * project at all is never scratch, but plain `NOT IN (...)` against a NULL
 * column evaluates to NULL (neither true nor false) and would silently drop it.
 */
function notScratchCondition(scratchProjectIds: readonly string[]): SQL | undefined {
	if (scratchProjectIds.length === 0) return undefined;
	return or(
		isNull(sessions.projectId),
		notInArray(sessions.projectId, [...scratchProjectIds]),
	) as SQL;
}

/** WHERE clause over the given predicates, skipping the ones that are absent. */
function allOf(...conditions: Array<SQL | undefined>): SQL | undefined {
	const present = conditions.filter((c): c is SQL => c !== undefined);
	return present.length > 0 ? and(...present) : undefined;
}

/**
 * The predicates every session query shares, whichever builder runs it:
 * agent type, project, scratch exclusion, search, owner scope, directory, time
 * window and (when given) lifecycle status. The plain list and the operational candidate scan both
 * start from this so a filter can never apply to one and not the other.
 */
function sharedFilterConditions(
	filters: SessionListFilters | undefined,
	scratchProjectIds: readonly string[],
): SQL[] {
	const conditions: SQL[] = [];
	if (filters?.status) {
		// TODO: translate status=archived into the isArchived filter. The status
		// column no longer carries 'archived' for new rows, so
		// GET /sessions?status=archived returns nothing until this is wired up.
		conditions.push(eq(sessions.status, filters.status));
	}
	if (filters?.tab) conditions.push(tabConditions()[filters.tab]);
	if (filters?.agentType) conditions.push(eq(sessions.agentType, filters.agentType));
	if (filters?.projectId) conditions.push(eq(sessions.projectId, filters.projectId));
	const notScratch = filters?.excludeScratch ? notScratchCondition(scratchProjectIds) : undefined;
	if (notScratch) conditions.push(notScratch);
	const search = searchCondition(filters?.q);
	if (search) conditions.push(search);
	const owner = ownerScopeCondition(filters?.owner);
	if (owner) conditions.push(owner);
	if (filters?.cwd) conditions.push(likeContains(sessions.cwd, filters.cwd));
	if (filters?.since) conditions.push(sql`${sessions.lastActivityAt} >= ${filters.since}`);
	if (filters?.until) conditions.push(sql`${sessions.lastActivityAt} < ${filters.until}`);
	return conditions;
}

/**
 * Project ids tagged "scratch" (AGEN) — mirrors the dashboard's own
 * client-side rule (`(project.tags ?? []).includes("scratch")`) so the
 * server can apply the same exclusion to a status-filtered list and its
 * counts, rather than leaving it to a client-side re-filter that can't
 * agree with a server-computed total. `tags` lives on the small `projects`
 * table (not session-level JSON), so fetching `{id, tags}` once and
 * filtering in JS is simpler and dialect-free than a JSON-array-contains
 * SQL expression.
 */
async function getScratchProjectIds(): Promise<string[]> {
	const rows = await getDb().select({ id: projects.id, tags: projects.tags }).from(projects);
	return rows
		.filter((row) => Array.isArray(row.tags) && row.tags.includes("scratch"))
		.map((row) => row.id);
}

/**
 * Shared search predicate for both the operational-candidate scan and the
 * plain session list: case-insensitive substring match on displayName,
 * cwd, or gitBranch — the same three fields DashboardPage's client-side
 * search matches on. Returns undefined for an empty/whitespace-only query
 * so callers can push it conditionally without an extra branch.
 */
function searchCondition(q: string | undefined): SQL | undefined {
	const trimmed = q?.trim();
	if (!trimmed) return undefined;
	return or(
		likeContains(sessions.displayName, trimmed),
		likeContains(sessions.cwd, trimmed),
		likeContains(sessions.gitBranch, trimmed),
	);
}

/**
 * What the stats poll reads per candidate row: the classifier's inputs, the
 * recency timestamp and the owner. Not the whole row, and not the whole
 * metadata — only the one key the classifier reads, extracted in SQL, so the
 * database and the driver never materialise and decode every row's metadata
 * (this runs on a timer in every open tab).
 */
// Most rows carry no permission wait. A plain substring test is far cheaper
// than parsing every row's JSON, and is exact: no occurrence of the key's name
// anywhere in the text means the key isn't there. A row that does contain the
// text (the real key, or a decoy in a value) goes through the real extraction.
// A document the database cannot read by key (jsonReadable) reads as no wait,
// so one such row cannot fail the poll for every session.
const PERMISSION_WAIT_SQL = sql`CASE WHEN CAST(${sessions.metadata} AS text) LIKE '%permissionWait%' THEN CASE WHEN ${jsonReadable(sessions.metadata)} THEN ${jsonExtractJson(sessions.metadata, "$.permissionWait")} END END`;

const CANDIDATE_COLUMNS = {
	sessionId: sessions.sessionId,
	status: sessions.status,
	isWorking: sessions.isWorking,
	isArchived: sessions.isArchived,
	endedAt: sessions.endedAt,
	semanticStatus: sessions.semanticStatus,
	lastAgentTurnCompletedAt: sessions.lastAgentTurnCompletedAt,
	lastUserAcknowledgedAt: sessions.lastUserAcknowledgedAt,
	lastActivityAt: sessions.lastActivityAt,
	ownerUserId: sessions.ownerUserId,
	ingestKeyId: sessions.ingestKeyId,
	permissionWait: sql<string | null>`${PERMISSION_WAIT_SQL}`.as("permission_wait"),
};

/**
 * The same columns as plain SQL, for the hot candidate scan: the rows come back
 * as the driver's own objects, without the ORM decoding twelve columns of every
 * row on every poll (about half the cost of the scan on SQLite). Booleans arrive
 * as 0/1 on SQLite; the classifier only tests them for truthiness.
 */
const CANDIDATE_SELECT_LIST = sql`${sessions.sessionId} AS "sessionId", ${sessions.status} AS "status", ${sessions.isWorking} AS "isWorking", ${sessions.isArchived} AS "isArchived", ${sessions.endedAt} AS "endedAt", ${sessions.semanticStatus} AS "semanticStatus", ${sessions.lastAgentTurnCompletedAt} AS "lastAgentTurnCompletedAt", ${sessions.lastUserAcknowledgedAt} AS "lastUserAcknowledgedAt", ${sessions.lastActivityAt} AS "lastActivityAt", ${sessions.ownerUserId} AS "ownerUserId", ${sessions.ingestKeyId} AS "ingestKeyId", ${PERMISSION_WAIT_SQL} AS "permissionWait"`;

type CandidateRow = Pick<
	typeof sessions.$inferSelect,
	| "sessionId"
	| "status"
	| "isWorking"
	| "isArchived"
	| "endedAt"
	| "semanticStatus"
	| "lastAgentTurnCompletedAt"
	| "lastUserAcknowledgedAt"
	| "lastActivityAt"
	| "ownerUserId"
	| "ingestKeyId"
> & { permissionWait: string | null };

/** A candidate row carrying what the classifier reads: it expects the permission wait under `metadata`. */
type ClassifiableRow = CandidateRow & { metadata: OperationalStatusInput["metadata"] };

/** The row's metadata with the wait decoded, or no wait at all when the extracted text isn't JSON. */
function parsePermissionWait(raw: string): ClassifiableRow["metadata"] {
	try {
		return { permissionWait: JSON.parse(raw) };
	} catch {
		return null;
	}
}

/**
 * Makes a narrowed row classifiable. The classifier reads one metadata key, so
 * this rebuilds just that on the fetched row itself (no second object per row,
 * which is hot: this runs over every candidate on every poll): a wait that isn't
 * there (a missing key or a JSON null) is absent, anything else is decoded
 * exactly as decoding the whole metadata would have.
 */
function toClassifiable(row: CandidateRow): ClassifiableRow {
	const raw = row.permissionWait;
	const classifiable = row as ClassifiableRow;
	classifiable.metadata = raw == null || raw === "null" ? null : parsePermissionWait(raw);
	return classifiable;
}

/**
 * True when a failed row's failure has been dismissed, evaluated in SQL —
 * ONLY safe when both timestamp columns hold the exact ISO shape every
 * app-side write actually produces (isAppIsoTimestamp): a legacy SQLite
 * bare value or a Postgres offset value sorts against an ISO value by the
 * "T"/" " byte at the same position, not by actual time, and can disagree
 * with parseStoredTimestamp's answer (the same reasoning as
 * isFailureAcknowledged in shared/session-state.ts, duplicated here
 * because SQL can't call into the shared TS function). Shared by the
 * candidate-scan exclusion and the completed-count query below so the two
 * never drift from each other.
 */
function failedAndDismissedSql(): SQL {
	return and(
		eq(sessions.status, "failed"),
		sql`${sessions.lastUserAcknowledgedAt} IS NOT NULL`,
		isAppIsoTimestamp(sessions.lastUserAcknowledgedAt),
		isAppIsoTimestamp(sessions.endedAt),
		sql`${sessions.lastUserAcknowledgedAt} >= ${sessions.endedAt}`,
	) as SQL;
}

/**
 * The rows getOperationalStatus would classify "completed" once archiving is
 * set aside (AGEN) — written once, here, and used by every tab's predicate so
 * the Completed tab, its count and the Active tab (its complement) cannot
 * drift. Every "completed" branch of the classifier that doesn't need
 * isArchived is reproduced exactly: literal status completed/archived, any
 * non-failed row with endedAt set, or a failed row dismissed under the same
 * ISO-shape guard as the candidate-scan exclusion. The `ne(status, "failed")`
 * guard on the endedAt branch matters because every failed row also has
 * endedAt set (markSessionFailed always writes both together) — without it, an
 * undismissed failure would double-match and inflate the count.
 */
function finishedConditionsSql(): SQL {
	return or(
		eq(sessions.status, "completed"),
		eq(sessions.status, "archived"),
		and(ne(sessions.status, "failed"), sql`${sessions.endedAt} IS NOT NULL`),
		failedAndDismissedSql(),
	) as SQL;
}

/**
 * The dashboard's three tabs as predicates over the sessions table: mutually
 * exclusive and jointly exhaustive.
 *   archived  = the archive flag, whatever the status;
 *   completed = not archived and finished (finishedConditionsSql);
 *   active    = not archived and not finished — idle sessions waiting on a
 *               person and undismissed failures included.
 * `active` negates with IS NOT TRUE, so a row whose finished test is unknown
 * (NULL, from a missing timestamp) lands in Active rather than in no tab. One
 * limit: a failed row dismissed with timestamps that aren't in the shape the
 * app writes can't be proven dismissed here, so the SQL keeps it in Active
 * even where the classifier, which parses them, would call it completed.
 * The stats aggregate counts with these same predicates, so a tab's rows and
 * its badge are one definition.
 */
function tabConditions(): Record<SessionListTab, SQL> {
	const finished = finishedConditionsSql();
	const notArchived = eq(sessions.isArchived, false);
	return {
		archived: eq(sessions.isArchived, true),
		completed: and(notArchived, finished) as SQL,
		active: and(notArchived, sql`(${finished}) IS NOT TRUE`) as SQL,
	};
}

/**
 * Candidate predicate mirroring isActiveOperationalSession (AGEN): not
 * archived, and either not ended or still-unacknowledged-failed.
 * getOperationalStatus resolves a failed row to "completed" once
 * acknowledged at or after endedAt — excluding that same row here too is
 * safe (not a second implementation of the precedence rule) under the same
 * ISO-shape guard as failedAndDismissedSql. When either column isn't that
 * shape, the row stays a candidate and the classifier (which parses
 * properly) decides. Without the exclusion at all, a dismissed failure
 * stays a candidate forever (nothing ever changes its `status` back),
 * accumulating an unbounded dead backlog that every getStats/operational=
 * call has to rescan.
 */
function operationalCandidateConditions(
	filters?: SessionListFilters,
	scratchProjectIds: readonly string[] = [],
) {
	const failedAndDismissed = failedAndDismissedSql();
	return [
		eq(sessions.isArchived, false),
		sql`${sessions.status} != 'archived'`,
		sql`${sessions.status} != 'completed'`,
		or(
			isNull(sessions.endedAt),
			and(eq(sessions.status, "failed"), sql`NOT (${failedAndDismissed})`),
		),
		...sharedFilterConditions(filters, scratchProjectIds),
	];
}

// Generous bound on the operational candidate scan (AGEN) — large enough
// that no real deployment should hit it in practice, small enough that a
// runaway backlog can't turn getStats/operational= into an unbounded scan.
// Overridable in tests only, via _setOperationalCandidateCapForTest.
const DEFAULT_OPERATIONAL_CANDIDATE_CAP = 5000;
let operationalCandidateCapOverride: number | null = null;

/** Test-only: override the candidate cap (null restores the default). */
export function _setOperationalCandidateCapForTest(cap: number | null): void {
	operationalCandidateCapOverride = cap;
}

function operationalCandidateCap(): number {
	return operationalCandidateCapOverride ?? DEFAULT_OPERATIONAL_CANDIDATE_CAP;
}

function logOperationalCandidatesTruncated(cap: number, matched: number): void {
	console.log(
		JSON.stringify({
			type: "operational_candidates_truncated",
			ts: new Date().toISOString(),
			cap,
			matched,
		}),
	);
}

/**
 * SQL for "this row CAN need attention" (1) or "it can't" (0) — used only to
 * split the candidate scan into tiers before the cap truncates it, never to
 * decide a row's final status; getOperationalStatus still does that once rows
 * are in hand. The tier is a SUPERSET of everything the classifier calls
 * WAITING or ERROR, so a row outside it can only be WORKING or IDLE:
 *
 *   - status is "failed" (ERROR candidate, acknowledged or not — the
 *     dismissed-and-ISO-shaped case is already excluded by the WHERE clause);
 *   - the agent reported a wait (`semanticStatus` "waiting");
 *   - permission-wait metadata is present at all (a cheap key lookup, not a
 *     decode of ids/anon — the classifier decides whether the wait is still
 *     outstanding);
 *   - a turn has finished and it is not provably acknowledged: no
 *     acknowledgement, or one SQL can't rank against it. A plain text `>=` is
 *     only trusted when both sides are the exact ISO shape the app writes;
 *     anything else stays in the tier and the classifier (which parses
 *     properly) decides.
 *
 * Every arm yields a definite 1 or 0 (never NULL), so `= 0` is exactly the
 * complement and a row can't fall out of both tiers.
 */
function operationalAttentionTier(): SQL {
	// Nested, not AND: the extraction must not run on a row that isn't readable.
	const metadataHasPermissionWait = sql`CASE WHEN ${jsonReadable(sessions.metadata)} THEN ${jsonExtractText(sessions.metadata, "$.permissionWait")} IS NOT NULL ELSE (1 = 0) END`;
	return sql`CASE
		WHEN ${sessions.status} = 'failed' THEN 1
		WHEN ${sessions.semanticStatus} = 'waiting' THEN 1
		WHEN ${metadataHasPermissionWait} THEN 1
		WHEN ${sessions.lastAgentTurnCompletedAt} IS NOT NULL AND (
			${sessions.lastUserAcknowledgedAt} IS NULL
			OR NOT (
				${isAppIsoTimestamp(sessions.lastUserAcknowledgedAt)}
				AND ${isAppIsoTimestamp(sessions.lastAgentTurnCompletedAt)}
				AND ${sessions.lastUserAcknowledgedAt} >= ${sessions.lastAgentTurnCompletedAt}
			)
		) THEN 1
		ELSE 0
	END`;
}

/**
 * The bounded candidate scan shared by getStats and the operational=
 * filter, in two steps. The probe is one unordered statement: when every
 * matching row fits under the cap — the normal case — that is the whole scan,
 * since classification and recency paging don't depend on fetch order. Only
 * when the cap is hit does completeTruncatedCandidates follow up with the
 * attention tier (operationalAttentionTier: everything that can be WAITING or
 * ERROR, newest first, up to the cap) and then an unsorted fill of the rest of
 * the cap, so an old WAITING/ERROR row survives behind any burst of fresher
 * idle noise wherever the database happens to return rows from. Nothing is
 * ever sorted over the whole matching set. A truncated scan is logged, one line
 * per call — never silent, since it can under-report the WORKING and IDLE
 * counts.
 */
interface CandidateProbe {
	where: SQL;
	cap: number;
	rows: CandidateRow[];
	truncated: boolean;
}

async function probeCandidates(
	filters: SessionListFilters | undefined,
	scratchProjectIds: readonly string[],
): Promise<CandidateProbe> {
	const where = and(...operationalCandidateConditions(filters, scratchProjectIds)) as SQL;
	const cap = operationalCandidateCap();
	const rows = await queryCandidates(sql`WHERE ${where} LIMIT ${cap + 1}`);
	return { where, cap, rows, truncated: rows.length > cap };
}

async function completeTruncatedCandidates(
	probe: CandidateProbe,
	attentionCap: AttentionCap,
): Promise<CandidateRow[]> {
	const { where, cap } = probe;
	logOperationalCandidatesTruncated(cap, probe.rows.length);
	const inAttentionTier = and(where, sql`${operationalAttentionTier()} = 1`) as SQL;
	const attention =
		attentionCap === "per-owner"
			? await fetchAttentionTierPerOwner(inAttentionTier, cap)
			: await queryCandidates(
					sql`WHERE ${inAttentionTier} ORDER BY ${ATTENTION_ORDER} LIMIT ${cap}`,
				);
	// The poll's cap is one budget shared by both tiers; per owner, the attention
	// tier has its own budget per owner and the fill keeps a whole one, within a
	// global ceiling on everything read.
	const fillLimit =
		attentionCap === "per-owner"
			? Math.min(cap, perOwnerCeiling(cap) - attention.length)
			: cap - attention.length;
	const fill =
		fillLimit > 0
			? await queryCandidates(
					sql`WHERE ${and(where, sql`${operationalAttentionTier()} = 0`)} LIMIT ${fillLimit}`,
				)
			: [];
	return [...attention, ...fill];
}

/**
 * The attention tier's order when it alone exceeds the cap: failures first (an
 * error is the loudest state and the one nobody else can see coming), then the
 * newest.
 */
const ATTENTION_ORDER = sql`CASE WHEN ${sessions.status} = 'failed' THEN 0 ELSE 1 END, ${sessions.lastActivityAt} DESC`;

/**
 * The most rows a per-owner scan reads in total (attention and fill): a
 * multiple of the cap, however many owners there are. Each owner's rows rank
 * first-come across owners, so a team over the ceiling shares it fairly and the
 * response, already flagged truncated, is approximate.
 */
const PER_OWNER_CEILING_FACTOR = 4;
function perOwnerCeiling(cap: number): number {
	return PER_OWNER_CEILING_FACTOR * cap;
}

/**
 * Runs a heavy scan as its own turn of the event loop on SQLite, where
 * statements are synchronous and would otherwise hold back every request queued
 * behind several dashboards' polls (see runInOwnTurn). On Postgres the awaits
 * are real I/O and the loop is free throughout, so the scan just runs.
 */
function heavyScan<T>(work: () => Promise<T>): Promise<T> {
	return config.dialect === "sqlite" ? runInOwnTurn(work) : work();
}

/** The candidate columns for the rows a `WHERE ... [ORDER BY] LIMIT ...` tail selects. */
async function queryCandidates(tail: SQL): Promise<CandidateRow[]> {
	const rows = await executeRows<Record<string, unknown>>(
		getDb(),
		sql`SELECT ${CANDIDATE_SELECT_LIST} FROM ${sessions} ${tail}`,
	);
	return rows as unknown as CandidateRow[];
}

/**
 * How far the attention tier is bounded: `overall` keeps the newest `cap` rows
 * across everyone (the poll), `per-owner` keeps the newest `cap` of EACH owner
 * (the per-owner grouping), so one owner's flood can't push another owner's
 * waiting or failed rows out of the tier.
 */
type AttentionCap = "overall" | "per-owner";

/**
 * The attention tier ranked within each owner (a user, or the ownerless
 * sessions split by whether a key reported them — the same buckets the grouping
 * reports), failures first and then newest, keeping `cap` per owner and at most
 * perOwnerCeiling(cap) rows overall. One statement however many owners there are.
 */
async function fetchAttentionTierPerOwner(where: SQL, cap: number): Promise<CandidateRow[]> {
	const rows = await executeRows<Record<string, unknown>>(
		getDb(),
		sql`SELECT * FROM (
			SELECT ${CANDIDATE_SELECT_LIST}, ROW_NUMBER() OVER (
				PARTITION BY ${sessions.ownerUserId}, (${sessions.ingestKeyId} IS NULL)
				ORDER BY ${ATTENTION_ORDER}
			) AS "ownerRank"
			FROM ${sessions} WHERE ${where}
		) AS ranked WHERE "ownerRank" <= ${cap}
		ORDER BY "ownerRank" ASC, "lastActivityAt" DESC LIMIT ${perOwnerCeiling(cap)}`,
	);
	return rows as unknown as CandidateRow[];
}

/**
 * Everything in `filters` that decides which rows a query matches, as a key
 * for sharing an in-flight computation. It mirrors sharedFilterConditions, so
 * adding a predicate there means adding it here: two calls whose keys are equal
 * must produce the same rows.
 */
function filtersKey(filters: SessionListFilters | undefined): string {
	const owner = filters?.owner;
	return JSON.stringify([
		filters?.status ?? null,
		filters?.tab ?? null,
		filters?.agentType ?? null,
		filters?.projectId ?? null,
		filters?.q?.trim() || null,
		filters?.excludeScratch === true,
		owner ? [owner.kind, owner.kind === "user" ? owner.userId : null] : null,
		filters?.cwd || null,
		filters?.since ?? null,
		filters?.until ?? null,
	]);
}

/** A live candidate row with the dashboard state the shared classifier gave it. */
type ClassifiedCandidate = CandidateRow & { operational: ActiveOperationalStatus };

interface ClassifiedCandidates {
	rows: ClassifiedCandidate[];
	truncated: boolean;
}

/** What one shared scan hands every caller that joined it. */
interface ScanOutcome extends ClassifiedCandidates {
	/** The totals the scan was asked to take in the same turn, if anyone asked. */
	totals?: unknown;
}

interface SharedScan {
	outcome: Promise<ScanOutcome>;
	/** True once the scan's first turn has begun: too late for another caller to add totals to it. */
	started: boolean;
	totals: (() => Promise<unknown>) | null;
}

/** In-flight scans by scope and filters; an entry lives only while its scan does. */
const sharedScans = new Map<string, SharedScan>();

/**
 * The candidate scan, classified by the shared classifier (never a second
 * implementation of the precedence rule in SQL), with completed rows dropped.
 * Concurrent callers with the same filters share one scan and one pass of
 * classification: the poll and the operational list ask the same question.
 * Callers treat the rows as read-only.
 *
 * `totals` is the count query that must describe the same database state as the
 * candidates (the poll's card counts, the grouping's per-owner totals). On
 * SQLite it runs in the scan's own first turn, back to back with the probe, so
 * no write can land between the two and the numbers in one response always
 * agree. A caller that joins a scan that has not started yet adds its totals to
 * it; one that arrives after it started gets a scan of its own. On Postgres
 * statements are real I/O with no shared snapshot, so the totals are simply
 * taken alongside (and the scan is not delayed by them).
 *
 * Past the cap (the response is already flagged `truncated`) the attention and
 * fill queries are separate turns after the probe and may see later writes; the
 * counts in a truncated response are approximate by definition.
 */
function classifiedCandidates(
	filters: SessionListFilters | undefined,
	knownScratchProjectIds?: readonly string[],
	attentionCap: AttentionCap = "overall",
	totals: (() => Promise<unknown>) | null = null,
): Promise<ScanOutcome> {
	const key = `${attentionCap}:${filtersKey(filters)}`;
	const existing = sharedScans.get(key);
	if (existing) {
		if (totals === null || existing.totals !== null) return existing.outcome;
		if (!existing.started) {
			existing.totals = totals;
			return existing.outcome;
		}
	}
	const entry: SharedScan = { outcome: undefined as never, started: false, totals };
	entry.outcome = runScan(entry, filters, knownScratchProjectIds, attentionCap).finally(() => {
		if (sharedScans.get(key) === entry) sharedScans.delete(key);
	});
	sharedScans.set(key, entry);
	return entry.outcome;
}

async function runScan(
	entry: SharedScan,
	filters: SessionListFilters | undefined,
	knownScratchProjectIds: readonly string[] | undefined,
	attentionCap: AttentionCap,
): Promise<ScanOutcome> {
	const scratchProjectIds = knownScratchProjectIds ?? (await scratchProjectIdsFor(filters));
	const first = await heavyScan(async () => {
		entry.started = true;
		const totals = entry.totals ? await entry.totals() : undefined;
		return { totals, probe: await probeCandidates(filters, scratchProjectIds) };
	});
	const { probe } = first;
	const candidates = probe.truncated
		? await heavyScan(() => completeTruncatedCandidates(probe, attentionCap))
		: probe.rows;
	const rows: ClassifiedCandidate[] = [];
	for (const candidate of candidates) {
		const operational = getOperationalStatus(toClassifiable(candidate));
		if (operational === "completed") continue;
		const row = candidate as ClassifiedCandidate;
		row.operational = operational;
		rows.push(row);
	}
	return { rows, truncated: probe.truncated, totals: first.totals };
}

/**
 * A scan plus the count query that has to agree with it: one turn on SQLite
 * (see classifiedCandidates), taken alongside on Postgres.
 */
async function scanWithTotals<T>(
	filters: SessionListFilters,
	scratchProjectIds: readonly string[],
	attentionCap: AttentionCap,
	totals: () => Promise<T>,
): Promise<{ scan: ClassifiedCandidates; totals: T }> {
	if (config.dialect === "sqlite") {
		const scan = await classifiedCandidates(filters, scratchProjectIds, attentionCap, totals);
		return { scan, totals: scan.totals as T };
	}
	const [scan, counted] = await Promise.all([
		classifiedCandidates(filters, scratchProjectIds, attentionCap),
		totals(),
	]);
	return { scan, totals: counted };
}

/** Newest activity first, ties by session id (descending) so paging is stable. Timestamps are parsed here, for the rows a list actually pages, not for every candidate. */
function sortNewestFirst<T extends { lastActivityAt: string; sessionId: string }>(rows: T[]): T[] {
	const keyed = rows.map((row) => ({ row, at: parseStoredTimestamp(row.lastActivityAt) ?? 0 }));
	keyed.sort((a, b) => b.at - a.at || (a.row.sessionId < b.row.sessionId ? 1 : -1));
	return keyed.map((entry) => entry.row);
}

/**
 * Page the classified candidates matching `operational`, ordered by recency
 * (same ordering getSessions otherwise uses). Fetching candidates' minimal
 * columns, classifying, then paging is what keeps a count/filter correct
 * beyond the first page (and up to the cap).
 */
async function getOperationalFilteredIds(
	operational: ActiveOperationalStatus,
	filters: SessionListFilters | undefined,
	limit: number,
	offset: number,
): Promise<{ ids: string[]; total: number }> {
	// truncated is surfaced on getStats (the dashboard's always-on signal);
	// the filtered list shares the same bounded, logged scan regardless.
	const { rows } = await classifiedCandidates(filters);

	const matched = sortNewestFirst(rows.filter((row) => row.operational === operational));

	return {
		ids: matched.slice(offset, offset + limit).map((row) => row.sessionId),
		total: matched.length,
	};
}

/**
 * The scratch project ids a query needs, looked up only when it excludes
 * scratch: an unset flag skips the statement entirely, so every existing
 * caller's statement count is unchanged.
 */
async function scratchProjectIdsFor(filters: SessionListFilters | undefined): Promise<string[]> {
	return filters?.excludeScratch ? getScratchProjectIds() : [];
}

async function sessionListConditions(filters?: SessionListFilters): Promise<SQL[]> {
	return sharedFilterConditions(filters, await scratchProjectIdsFor(filters));
}

/**
 * F128: fields a `GET /sessions?fields=` projection may request. Narrow on
 * purpose: the relay's name sync pages this list every tick, and a full row
 * carries CLAUDE.md content, notes and metadata.
 */
export const SESSION_LIST_FIELDS = [
	"sessionId",
	"displayName",
	"nameSource",
	"nativeName",
	"agentType",
	"lastActivityAt",
] as const;
export type SessionListField = (typeof SESSION_LIST_FIELDS)[number];

export function isSessionListField(value: string): value is SessionListField {
	return (SESSION_LIST_FIELDS as readonly string[]).includes(value);
}

/**
 * F128: the projected list. Reads only the columns the allowlist needs
 * (metadata for nameSource/nativeName), and skips the count(*) and the
 * managed-session lookup the full list pays for.
 */
export async function getSessionSummaries(
	filters: SessionListFilters | undefined,
	fields: readonly SessionListField[],
): Promise<Array<Partial<Record<SessionListField, unknown>>>> {
	const conditions = await sessionListConditions(filters);
	let query = getDb()
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			agentType: sessions.agentType,
			lastActivityAt: sessions.lastActivityAt,
			metadata: sessions.metadata,
		})
		.from(sessions)
		.orderBy(desc(sessions.lastActivityAt), desc(sessions.id));
	if (conditions.length > 0) query = query.where(and(...conditions)) as typeof query;
	const rows = await query.limit(filters?.limit ?? 50).offset(filters?.offset ?? 0);
	return rows.map((row) => {
		const dto = mapSessionDto(row);
		const out: Partial<Record<SessionListField, unknown>> = {};
		for (const field of fields) out[field] = dto[field];
		return out;
	});
}

// Get all sessions with optional filters
export async function getSessions(filters?: SessionListFilters) {
	const limit = filters?.limit ?? 50;
	const offset = filters?.offset ?? 0;

	let rows: (typeof sessions.$inferSelect)[];
	let total: number;

	if (filters?.operational) {
		// Candidates' minimal columns, classified, THEN paged — see
		// getOperationalFilteredIds. The full rows for the page are fetched
		// separately below (same two-query shape as the non-operational path:
		// one query to decide the page, one to fetch it).
		const { ids, total: matchedTotal } = await getOperationalFilteredIds(
			filters.operational,
			filters,
			limit,
			offset,
		);
		total = matchedTotal;
		if (ids.length === 0) {
			rows = [];
		} else {
			const pageRows = await getDb()
				.select()
				.from(sessions)
				.where(inArray(sessions.sessionId, ids));
			const byId = new Map(pageRows.map((row) => [row.sessionId, row]));
			rows = ids
				.map((id) => byId.get(id))
				.filter((row): row is typeof sessions.$inferSelect => !!row);
		}
	} else {
		let query = getDb()
			.select()
			.from(sessions)
			.orderBy(desc(sessions.lastActivityAt), desc(sessions.id));

		const conditions = await sessionListConditions(filters);

		if (conditions.length > 0) {
			query = query.where(and(...conditions)) as typeof query;
		}

		rows = await query.limit(limit).offset(offset);

		const countQuery = getDb().select({ count: count() }).from(sessions);
		const [{ count: countResult }] =
			conditions.length > 0 ? await countQuery.where(and(...conditions)) : await countQuery;
		total = countResult;
	}

	// One batched membership query for the returned page — NOT a join (a
	// join would nest the row shape to {sessions:{...}, managed_sessions:
	// {...}} and break every flat-row consumer: useSessions.ts, relay.ts's
	// name-sync + CLAUDE.md-sync, and the MCP compactSessionRow mapper), and
	// NOT one getManagedSession() call per row (N+1 over up to 100 rows
	// polled every 30s). A single indexed IN-query regardless of page size,
	// merged onto the existing flat rows as a boolean.
	const pageSessionIds = rows.map((row) => row.sessionId);
	const managedRows =
		pageSessionIds.length > 0
			? await getDb()
					.select({ sessionId: managedSessions.sessionId })
					.from(managedSessions)
					.where(inArray(managedSessions.sessionId, pageSessionIds))
			: [];
	const managedIds = new Set(managedRows.map((row) => row.sessionId));
	const rowsWithManaged = rows.map((row) =>
		mapSessionDto(row, { managed: managedIds.has(row.sessionId) }),
	);

	return { sessions: rowsWithManaged, total };
}

// Get a single session by session_id
export async function getSession(sessionId: string) {
	const [session] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!session) return null;
	const managedSession = await getManagedSession(sessionId);
	return mapSessionDto(session, { managedSession });
}

// Get dashboard stats
export function getStats(options?: {
	excludeScratch?: boolean;
	owner?: OwnerScope;
}): Promise<StatsResult> {
	return statsInFlight(filtersKey(options), () => computeStats(options));
}

const statsInFlight = createInFlight<StatsResult>();

async function computeStats(options?: { excludeScratch?: boolean; owner?: OwnerScope }) {
	// The aggregate and the candidate scan are taken together (see
	// scanWithTotals), so every number below describes one database state, and a
	// concurrent caller asking only for the scan (the operational list) joins it.
	const filters: SessionListFilters = {
		excludeScratch: options?.excludeScratch,
		owner: options?.owner,
	};
	// Looked up once for both queries, so every number below is about the same set.
	const scratchProjectIds = await scratchProjectIdsFor(filters);
	const { scan, totals } = await scanWithTotals(filters, scratchProjectIds, "overall", () =>
		queryAggregateTotals(filters, scratchProjectIds),
	);
	const { rows: operationalRows, truncated } = scan;

	// AGEN: the four operational counts (WAITING/WORKING/IDLE/ERROR), correct
	// beyond whatever page size the dashboard happens to fetch — a single
	// bounded scan of the candidate rows (fetchOperationalCandidates),
	// classified by the same shared function getSessions's operational filter
	// uses, not a second SQL implementation of the precedence rule.
	const operational: Record<ActiveOperationalStatus, number> = {
		waiting: 0,
		working: 0,
		idle: 0,
		error: 0,
	};
	for (const row of operationalRows) operational[row.operational] += 1;

	return {
		total: totals.total,
		scratchHidden: totals.scratchHidden,
		activeSessions: totals.active,
		totalSessionsToday: totals.today,
		completedCount: totals.completed,
		archivedCount: totals.archived,
		tabCounts: totals.tabCounts,
		totalToolUsesToday: totals.toolUsesToday,
		byAgentType: totals.activeByAgentType,
		truncated,
		operational,
	};
}

interface StatsTotals {
	/** Every session in the scope, whatever its state. */
	total: number;
	/** Sessions in the owner scope that the scratch exclusion left out of every count here. */
	scratchHidden: number;
	active: number;
	today: number;
	toolUsesToday: number;
	completed: number;
	archived: number;
	/** The three tab counts: they partition `total`. */
	tabCounts: SessionTabCounts;
	/** Active sessions per agent type: every known type (zero-filled), plus any unrecognised one that has some. */
	activeByAgentType: Record<string, number>;
}

/**
 * The card counts, the tab badges and the by-type breakdown from one pass over
 * the table instead of one statement each (this runs on a timer in every open
 * tab). `completed` mirrors getOperationalStatus's own "completed" branch for
 * non-archived rows, so the Completed badge is correct beyond whatever page
 * the dashboard loaded; archived rows have their own badge.
 *
 * Deliberately not a GROUP BY agent type: that made the SQLite planner walk the
 * non-covering agent-type index with a table lookup for every row, about twice
 * the cost of one plain scan. The per-type active counts are conditional counts
 * in the same pass for the known types; an unrecognised historic type that has
 * active sessions is found by a second statement, which only runs when the
 * known types don't account for every active session.
 *
 * The scratch exclusion is applied to each count rather than to the WHERE, so
 * the same pass also counts what it left out (`scratchHidden`) without a
 * second statement. It is the same predicate the candidate scan, the per-owner
 * grouping and the list use (notScratchCondition).
 */
async function queryAggregateTotals(
	filters: SessionListFilters,
	scratchProjectIds: readonly string[],
): Promise<StatsTotals> {
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
	// The owner scope narrows every query, so the cards, the tab counts and the
	// four operational counts all describe the same set of sessions.
	const scope = allOf(...sharedFilterConditions({ owner: filters.owner }, []));
	const visible = filters.excludeScratch ? notScratchCondition(scratchProjectIds) : undefined;
	const counted = (condition: SQL | undefined): SQL =>
		(condition && visible ? and(condition, visible) : (condition ?? visible)) as SQL;
	const countWhere = (condition: SQL | undefined) => {
		const where = counted(condition);
		return (where ? sql<number>`count(*) FILTER (WHERE ${where})` : sql<number>`count(*)`).mapWith(
			Number,
		);
	};
	const startedToday = sql`${sessions.startedAt} >= ${todayStart}`;
	// The card and the by-type breakdown keep their own narrower meaning
	// (lifecycle status 'active'); the tab counts below use the tab predicates.
	const isActive = eq(sessions.status, "active");
	const tabs = tabConditions();
	const knownTypeColumns = Object.fromEntries(
		AGENT_TYPES.map((type, i) => [
			`type${i}`,
			countWhere(and(isActive, eq(sessions.agentType, type)) as SQL),
		]),
	);
	const [row] = await getDb()
		.select({
			total: countWhere(undefined),
			scratchHidden: visible
				? sql<number>`count(*) FILTER (WHERE NOT (${visible}))`.mapWith(Number)
				: sql<number>`0`.mapWith(Number),
			active: countWhere(isActive),
			today: countWhere(startedToday),
			toolUsesToday:
				sql<number>`COALESCE(SUM(${sessions.totalToolUses}) FILTER (WHERE ${counted(startedToday)}), 0)`.mapWith(
					Number,
				),
			tabActive: countWhere(tabs.active),
			completed: countWhere(tabs.completed),
			archived: countWhere(tabs.archived),
			...knownTypeColumns,
		})
		.from(sessions)
		.where(scope);
	const totals = row as Record<string, number>;

	// Zero-fill every known agent type so a consumer never has to
	// special-case "absent means 0".
	const activeByAgentType: Record<string, number> = {};
	let knownActive = 0;
	AGENT_TYPES.forEach((type, i) => {
		const active = totals[`type${i}`] ?? 0;
		activeByAgentType[type] = active;
		knownActive += active;
	});
	if ((totals.active ?? 0) > knownActive) {
		const unrecognised = await getDb()
			.select({ agentType: sessions.agentType, active: count() })
			.from(sessions)
			.where(allOf(scope, visible, isActive, notInArray(sessions.agentType, [...AGENT_TYPES])))
			.groupBy(sessions.agentType)
			.orderBy(sessions.agentType);
		for (const { agentType, active } of unrecognised) {
			if (active > 0) activeByAgentType[agentType] = active;
		}
	}
	return {
		total: totals.total ?? 0,
		scratchHidden: totals.scratchHidden ?? 0,
		active: totals.active ?? 0,
		today: totals.today ?? 0,
		toolUsesToday: totals.toolUsesToday ?? 0,
		completed: totals.completed ?? 0,
		archived: totals.archived ?? 0,
		tabCounts: {
			active: totals.tabActive ?? 0,
			completed: totals.completed ?? 0,
			archived: totals.archived ?? 0,
		},
		activeByAgentType,
	};
}

type StatsResult = Awaited<ReturnType<typeof computeStats>>;

/** The stats of a scope with no sessions at all, in exactly the shape getStats answers. */
export function emptyStats(): StatsResult {
	return {
		total: 0,
		scratchHidden: 0,
		activeSessions: 0,
		totalSessionsToday: 0,
		completedCount: 0,
		archivedCount: 0,
		tabCounts: { active: 0, completed: 0, archived: 0 },
		totalToolUsesToday: 0,
		byAgentType: Object.fromEntries(AGENT_TYPES.map((type) => [type, 0])),
		truncated: false,
		operational: { waiting: 0, working: 0, idle: 0, error: 0 },
	};
}

/** The per-owner grouping of a scope with no sessions at all. */
export function emptyStatsByOwner(): Omit<OwnerStatsResponse, "ownerScope"> {
	return { groups: [], truncated: false };
}

/** A session an Ask reply can name, with the dashboard state it is in. */
export interface ClassifiedSessionRow {
	sessionId: string;
	displayName: string | null;
	cwd: string | null;
	status: string;
	agentType: string;
	lastActivityAt: string;
	operational: ReturnType<typeof getOperationalStatus>;
}

const ASK_DISPLAY_COLUMNS = {
	sessionId: sessions.sessionId,
	displayName: sessions.displayName,
	cwd: sessions.cwd,
	status: sessions.status,
	agentType: sessions.agentType,
	lastActivityAt: sessions.lastActivityAt,
};

/**
 * The sessions the dashboard shows in any of `statuses`, newest first, for
 * Ask's "what's waiting": the same candidate scan the dashboard's counts use
 * (attention rows first when the cap is hit, classified by the shared
 * classifier), narrowed by a directory substring and a last-activity window.
 * `truncated` says the scan was capped, so the list may be incomplete.
 */
export async function findSessionsByOperational(
	statuses: readonly ActiveOperationalStatus[],
	options: { cwd?: string; since?: string; until?: string; limit: number },
): Promise<{ rows: ClassifiedSessionRow[]; truncated: boolean }> {
	const { rows: candidates, truncated } = await classifiedCandidates({
		cwd: options.cwd,
		since: options.since,
		until: options.until,
	});
	const wanted = sortNewestFirst(
		candidates.filter((row) => statuses.includes(row.operational)),
	).slice(0, options.limit);
	if (wanted.length === 0) return { rows: [], truncated };
	const operationalById = new Map(wanted.map((row) => [row.sessionId, row.operational]));
	const detail = await getDb()
		.select(ASK_DISPLAY_COLUMNS)
		.from(sessions)
		.where(
			inArray(
				sessions.sessionId,
				wanted.map((row) => row.sessionId),
			),
		);
	const byId = new Map(detail.map((row) => [row.sessionId, row]));
	const rows = wanted.flatMap((row) => {
		const found = byId.get(row.sessionId);
		const operational = operationalById.get(row.sessionId);
		return found && operational ? [{ ...found, operational }] : [];
	});
	return { rows, truncated };
}

/** The dashboard state of each named session (unknown ids are absent). */
export async function classifySessions(
	sessionIds: readonly string[],
): Promise<Map<string, ClassifiedSessionRow>> {
	if (sessionIds.length === 0) return new Map();
	const rows = await getDb()
		.select({
			...CANDIDATE_COLUMNS,
			displayName: sessions.displayName,
			cwd: sessions.cwd,
			agentType: sessions.agentType,
		})
		.from(sessions)
		.where(inArray(sessions.sessionId, [...sessionIds]));
	return new Map(
		rows.map((row) => [
			row.sessionId,
			{
				sessionId: row.sessionId,
				displayName: row.displayName,
				cwd: row.cwd,
				status: row.status,
				agentType: row.agentType,
				lastActivityAt: row.lastActivityAt,
				operational: getOperationalStatus(toClassifiable(row)),
			},
		]),
	);
}

function ownerGroupKey(owner: { ownerUserId: string | null; hasKey: boolean }): string {
	if (owner.ownerUserId) return owner.ownerUserId;
	return owner.hasKey ? "service" : "unassigned";
}

/**
 * Per-owner counts in one grouped pass (two statements however many owners
 * there are): a GROUP BY for each owner's total and completed rows, and the
 * bounded candidate scan getStats uses, classified and tallied per owner in
 * memory. Sums across groups equal the unscoped totals (`total`, `completed`)
 * and the operational counts getStats reports while nothing is capped.
 *
 * Past the cap the scan keeps each owner's attention rows (up to the cap PER
 * OWNER) instead of the newest overall, so one owner's flood never changes
 * another owner's waiting and error columns; the working and idle columns come
 * from an unsorted fill and are approximate. `truncated` says the scan was
 * capped and those columns may under-count.
 */
export function getStatsByOwner(options?: {
	excludeScratch?: boolean;
	owner?: OwnerScope;
}): Promise<Omit<OwnerStatsResponse, "ownerScope">> {
	return statsByOwnerInFlight(filtersKey(options), () => computeStatsByOwner(options));
}

const statsByOwnerInFlight = createInFlight<Omit<OwnerStatsResponse, "ownerScope">>();

async function computeStatsByOwner(options?: {
	excludeScratch?: boolean;
	owner?: OwnerScope;
}): Promise<Omit<OwnerStatsResponse, "ownerScope">> {
	const filters: SessionListFilters = {
		excludeScratch: options?.excludeScratch,
		owner: options?.owner,
	};
	const scratchProjectIds = await scratchProjectIdsFor(filters);
	const hasKey = sql<number>`CASE WHEN ${sessions.ingestKeyId} IS NULL THEN 0 ELSE 1 END`;
	const tabs = tabConditions();
	const tabSum = (condition: SQL) =>
		sql<number>`COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0)`.mapWith(Number);
	const totalsQuery = getDb()
		.select({
			ownerUserId: sessions.ownerUserId,
			hasKey: hasKey.mapWith(Number),
			total: count(),
			completed: tabSum(tabs.completed),
			tabActive: tabSum(tabs.active),
			tabArchived: tabSum(tabs.archived),
		})
		.from(sessions)
		.where(allOf(...sharedFilterConditions(filters, scratchProjectIds)))
		.groupBy(sessions.ownerUserId, hasKey);
	const {
		scan: { rows: candidates, truncated },
		totals,
	} = await scanWithTotals(filters, scratchProjectIds, "per-owner", async () => await totalsQuery);

	const groups = new Map<string, OwnerStatsGroup>();
	for (const row of totals) {
		const owner = { ownerUserId: row.ownerUserId, hasKey: row.hasKey === 1 };
		const key = ownerGroupKey(owner);
		const group = groups.get(key) ?? {
			ownerUserId: row.ownerUserId,
			ownerKind: row.ownerUserId ? "user" : owner.hasKey ? "service" : "unassigned",
			total: 0,
			active: 0,
			idle: 0,
			completed: 0,
			tabCounts: { active: 0, completed: 0, archived: 0 },
			working: 0,
			waiting: 0,
			error: 0,
		};
		group.total += row.total;
		group.completed += row.completed;
		group.tabCounts.active += row.tabActive;
		group.tabCounts.completed += row.completed;
		group.tabCounts.archived += row.tabArchived;
		groups.set(key, group);
	}
	for (const row of candidates) {
		const group = groups.get(
			ownerGroupKey({ ownerUserId: row.ownerUserId, hasKey: row.ingestKeyId !== null }),
		);
		if (!group) continue;
		group[row.operational] += 1;
		group.active += 1;
	}
	return {
		groups: [...groups.values()].sort((a, b) => b.total - a.total),
		truncated,
	};
}

// Recovery cutoff for sessions stuck with isWorking=true. If an agent
// crashed without sending Stop, the working flag can stay latched
// forever. After this many ms with no activity we clear the flag so
// the regular active → idle → completed flow can resume.
const STUCK_WORKING_RECOVERY_MS = 2 * SESSION_END_TIMEOUT_MS;

/**
 * Advance stale sessions through the lifecycle:
 *   active  → idle       when !isWorking and no activity for idle timeout
 *   idle    → completed  when no activity for end timeout
 *
 * Working sessions never transition automatically — the user rule is
 * that isWorking=true must block idle/completed until Stop arrives.
 * Sessions whose managed process is still running under a connected
 * owner-of-record supervisor are skipped entirely; those flip to
 * terminal state when the supervisor reports the process exited.
 *
 * Stuck-working recovery: if isWorking=true but there has been no
 * activity for 2× the end timeout, we assume the agent crashed and
 * clear the flag so the normal flow can run on the next tick.
 */
export async function updateStaleSessions(): Promise<number> {
	const now = Date.now();
	const idleCutoff = new Date(now - SESSION_IDLE_TIMEOUT_MS).toISOString();
	const endCutoff = new Date(now - SESSION_END_TIMEOUT_MS).toISOString();
	const stuckWorkingCutoff = new Date(now - STUCK_WORKING_RECOVERY_MS).toISOString();

	const liveSessionIds = await listLiveOwnedManagedSessionIds(LIVE_MANAGED_STATES);

	const excludeLive =
		liveSessionIds.length > 0 ? notInArray(sessions.sessionId, liveSessionIds) : undefined;

	// Stuck-working recovery: clear isWorking on sessions that have been
	// silent for far too long. Runs first so the idle transition below
	// can pick them up on the same tick.
	const cleared = await getDb()
		.update(sessions)
		.set({ isWorking: false })
		.where(
			and(
				eq(sessions.isWorking, true),
				lt(sessions.lastActivityAt, stuckWorkingCutoff),
				...(excludeLive ? [excludeLive] : []),
			),
		)
		.returning({ sessionId: sessions.sessionId });

	// active → idle: only when the session is NOT currently working.
	const idled = await getDb()
		.update(sessions)
		.set({ status: "idle" })
		.where(
			and(
				eq(sessions.status, "active"),
				eq(sessions.isWorking, false),
				lt(sessions.lastActivityAt, idleCutoff),
				...(excludeLive ? [excludeLive] : []),
			),
		)
		.returning({ sessionId: sessions.sessionId });

	// idle → completed: requires the session to have already moved to
	// idle, which by the rule above means it was not working when it
	// went idle. This enforces the user-visible progression
	//   working → not-working → idle → completed
	// rather than letting an active session skip straight to completed.
	const result = await getDb()
		.update(sessions)
		.set({
			status: "completed",
			endedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(sessions.status, "idle"),
				lt(sessions.lastActivityAt, endCutoff),
				...(excludeLive ? [excludeLive] : []),
			),
		)
		.returning({ sessionId: sessions.sessionId });

	await broadcastSweptSessions([...cleared, ...idled, ...result].map((row) => row.sessionId));

	return result.length;
}

const SWEEP_BROADCAST_BATCH = 500;

/**
 * Tell open dashboards about every session the sweep changed, in the same
 * shape as any other session update. Reads are batched (two statements per
 * 500 sessions, not two per session) and the loop yields to I/O between
 * batches so a large sweep doesn't hold the event loop.
 */
async function broadcastSweptSessions(changedIds: string[]): Promise<void> {
	const ids = [...new Set(changedIds)];
	for (let start = 0; start < ids.length; start += SWEEP_BROADCAST_BATCH) {
		if (start > 0) await new Promise<void>((resolve) => setImmediate(resolve));
		const batch = ids.slice(start, start + SWEEP_BROADCAST_BATCH);
		const rows = await getDb().select().from(sessions).where(inArray(sessions.sessionId, batch));
		const managedRows = await getDb()
			.select()
			.from(managedSessions)
			.where(inArray(managedSessions.sessionId, batch));
		const managedById = new Map(managedRows.map((row) => [row.sessionId, mapManagedSession(row)]));
		for (const row of rows) {
			notifySessionUpdated(
				mapSessionDto(row, { managedSession: managedById.get(row.sessionId) ?? null }),
			);
		}
	}
}
