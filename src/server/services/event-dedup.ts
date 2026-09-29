import {
	EVENT_DUPLICATE_WINDOW_MS,
	getEventSourcePriority,
	normalizeComparableContent,
} from "../../shared/event-authority.js";
import { ORIGIN_CODEX_OBSERVER } from "../../shared/hook-headers.js";
import { type NormalizedEvent, OVERSIZE_STUB_MARKER } from "./event-normalizer.js";
import { parseDbTimestamp } from "./util/db-time.js";
import { sha256Hex } from "./util/hash.js";

export type DropReason = "deliveryRetry" | "toolUseRetry" | "contentWindow" | "authority";

/** Identity inputs for a hook delivery (Decision 2). `keyId` is the calling
 * API key's id (`authUser.id`; "anonymous" under DISABLE_AUTH). `deliveryId`
 * is the parsed `X-AgentPulse-Delivery-Id` header, or null when absent/
 * malformed. `origin` distinguishes the codex-observer's own posts from
 * everything else (native hooks, Claude Code, a pre-upgrade observer). */
export interface HookDeliveryContext {
	keyId: string;
	deliveryId: string | null;
	origin: "native" | "codex-observer";
}

export type DedupPolicy =
	| { kind: "content_window" }
	| { kind: "hook_delivery"; ctx: HookDeliveryContext; rawPayload: unknown };

/** A stored event as loaded for dedup: the session's most recent rows. */
export interface RecentEventRow {
	id: number;
	eventType: string;
	category: string | null;
	source: string;
	content: string | null;
	providerEventType: string | null;
	createdAt: string | null;
}

export interface PlannedRow extends NormalizedEvent {
	createdAt: string;
	/** Durable identity for the `dedup_key` column. Always null under content_window. */
	dedupKey: string | null;
	/** Stored rows this row supersedes by source authority, deleted only if it is stored. */
	deletesIfStored: number[];
}

export interface InsertPlan {
	retained: PlannedRow[];
	drops: Partial<Record<DropReason, number>>;
	/**
	 * hook_delivery only (Decision 2 / F48): the dedup key computed for the
	 * delivery's row 0 (the "primary" row — a hook's own event, never the
	 * assistant echo; see PR-inv), when it's keyed. persistEvents uses this
	 * to detect a whole-delivery replay even when a later row's own key
	 * happens to be free (e.g. an authority-superseded secondary that was
	 * since deleted) — see the whole-delivery-drop rule.
	 */
	primaryDedupKey?: string | null;
}

type AuthorityCandidate = {
	id: number | null;
	category: string | null;
	source: string;
	content: string | null;
	createdAt: string | null;
};

// The legacy in-memory window key. Content-derived and not unique per event,
// so it must never be persisted as a dedup_key. Exported (Phase 6) so
// persistEvents can match a RETURNING row back to the PlannedRow that
// produced it without assuming RETURNING order matches insert order (F35) —
// this is the exact composite planContentWindow's own `seen` Set already
// guarantees is unique within one incoming batch.
export function contentWindowKey(event: {
	eventType: string;
	category: string | null;
	source: string;
	content: string | null;
	providerEventType: string | null;
	rawPayload?: Record<string, unknown>;
}) {
	const transcriptId =
		typeof event.rawPayload?.transcript_uuid === "string"
			? event.rawPayload.transcript_uuid
			: typeof event.rawPayload?.transcript_timestamp === "string"
				? event.rawPayload.transcript_timestamp
				: "";
	return [
		event.eventType || "",
		event.category || "",
		event.source || "",
		event.content || "",
		event.providerEventType || "",
		transcriptId,
	].join("::");
}

function isNearInTime(left: string | null, right: string | null) {
	const leftMs = parseDbTimestamp(left);
	const rightMs = parseDbTimestamp(right);
	if (leftMs == null || rightMs == null) return false;
	return Math.abs(leftMs - rightMs) <= EVENT_DUPLICATE_WINDOW_MS;
}

// Same assistant text from two sources of different authority, close in time.
function isAuthorityDuplicate(existing: AuthorityCandidate, incoming: AuthorityCandidate) {
	if (existing.category !== "assistant_message" || incoming.category !== "assistant_message")
		return false;
	const existingContent = normalizeComparableContent(existing.content);
	if (!existingContent || existingContent !== normalizeComparableContent(incoming.content))
		return false;
	if (!isNearInTime(existing.createdAt, incoming.createdAt)) return false;
	return getEventSourcePriority(existing.source) !== getEventSourcePriority(incoming.source);
}

function outranks(left: AuthorityCandidate, right: AuthorityCandidate) {
	return getEventSourcePriority(left.source) > getEventSourcePriority(right.source);
}

function countDrop(drops: InsertPlan["drops"], reason: DropReason) {
	drops[reason] = (drops[reason] ?? 0) + 1;
}

function planContentWindow(
	recent: RecentEventRow[],
	incoming: NormalizedEvent[],
	nowIso: string,
): InsertPlan {
	// Stored rows are keyed without rawPayload (it isn't loaded), so the
	// transcript id only distinguishes rows within one batch.
	const seen = new Set(recent.map((row) => contentWindowKey(row)));
	const pool: AuthorityCandidate[] = recent.map((row) => ({
		id: row.id,
		category: row.category,
		source: row.source,
		content: row.content,
		createdAt: row.createdAt,
	}));
	const plan: InsertPlan = { retained: [], drops: {} };

	for (const event of incoming) {
		const key = contentWindowKey(event);
		if (seen.has(key)) {
			countDrop(plan.drops, "contentWindow");
			continue;
		}

		const candidate: AuthorityCandidate = {
			id: null,
			category: event.category,
			source: event.source,
			content: event.content,
			createdAt: nowIso,
		};
		const rivals = pool.filter((existing) => isAuthorityDuplicate(existing, candidate));
		if (rivals.some((existing) => outranks(existing, candidate))) {
			countDrop(plan.drops, "authority");
			continue;
		}

		const deletesIfStored: number[] = [];
		for (const rival of rivals) {
			if (rival.id) deletesIfStored.push(rival.id);
		}

		seen.add(key);
		plan.retained.push({ ...event, createdAt: nowIso, dedupKey: null, deletesIfStored });
		pool.push(candidate);
	}

	return plan;
}

// ── hook_delivery (Decision 1/2/22, Phase 7) ────────────────────────────────
//
// Hook deliveries are never content-deduped: a genuinely distinct tool call,
// turn or prompt is always stored. The only drops are exact-identity retries
// (the ON CONFLICT DO NOTHING race at persist time, counted post-insert by
// persistEvents) and the same hook-vs-transcript authority supersession
// content_window applies — gated identically (isAuthorityDuplicate only
// fires for assistant_message on both sides), so a hook's assistant echo
// still loses to a later transcript row.

export type DedupKeyArgs =
	| { kind: "t"; keyId: string; eventType: string; toolUseId: string }
	| { kind: "d"; keyId: string; deliveryId: string; bodyDigest: string; rowIndex: number }
	// F131b (D19): an oversize stub's own namespace. `identity` is the row's
	// tool_use_id, or ctx.deliveryId when there's no tool_use_id — never a
	// body digest, so a stub never collides with (or suppresses) a real `t:`
	// or `d:` row, only with a replay of itself.
	| { kind: "o"; keyId: string; eventType: string; identity: string };

function lengthPrefixed(fields: string[]): string {
	return fields.map((field) => `${field.length}:${field}`).join("");
}

/** The first 32 hex chars of a sha256 over the length-prefixed fields (D2). */
export function computeDedupKey(args: DedupKeyArgs): string {
	const fields =
		args.kind === "t"
			? [args.keyId, args.eventType, args.toolUseId]
			: args.kind === "d"
				? [args.keyId, args.deliveryId, args.bodyDigest, String(args.rowIndex)]
				: [args.keyId, args.eventType, args.identity];
	return `${args.kind}:${sha256Hex(lengthPrefixed(fields)).slice(0, 32)}`;
}

const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Validates the `X-AgentPulse-Delivery-Id` header. Malformed → null (D3). */
export function parseDeliveryId(header: string | null | undefined): string | null {
	if (!header) return null;
	return DELIVERY_ID_PATTERN.test(header) ? header : null;
}

/** Case-insensitive `X-AgentPulse-Origin` header parse. Anything else is "native". */
export function parseOrigin(header: string | null | undefined): "codex-observer" | "native" {
	return header?.toLowerCase() === ORIGIN_CODEX_OBSERVER.toLowerCase()
		? "codex-observer"
		: "native";
}

const TOOL_KEY_CATEGORIES = new Set(["tool_event", "permission_event"]);
const MAX_TOOL_USE_ID_LEN = 200;

function extractToolUseId(rawPayload: Record<string, unknown> | undefined): string | null {
	const value = rawPayload?.tool_use_id;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOOL_USE_ID_LEN) {
		return null;
	}
	return value;
}

function planHookDelivery(
	recent: RecentEventRow[],
	incoming: NormalizedEvent[],
	nowIso: string,
	ctx: HookDeliveryContext,
	rawPayload: unknown,
): InsertPlan {
	const pool: AuthorityCandidate[] = recent.map((row) => ({
		id: row.id,
		category: row.category,
		source: row.source,
		content: row.content,
		createdAt: row.createdAt,
	}));
	const plan: InsertPlan = { retained: [], drops: {} };
	let bodyDigest: string | null = null;
	let primaryDedupKey: string | null | undefined;
	const seenKeys = new Set<string>();

	incoming.forEach((event, rowIndex) => {
		let dedupKey: string | null = null;
		const isOversizeStub = event.rawPayload?.[OVERSIZE_STUB_MARKER] === true;

		if (isOversizeStub) {
			// F131b (D19): a stub never claims the real t:/d: key space — its
			// own o: namespace, keyed on tool_use_id when the delivery had one,
			// else the stamped delivery id. With neither, it stays unkeyed
			// (null), same fail-open direction as any other unkeyed row (D17):
			// a possible duplicate stub, never a suppressed real one.
			const toolUseId = extractToolUseId(event.rawPayload);
			const identity = toolUseId ?? ctx.deliveryId;
			if (identity) {
				dedupKey = computeDedupKey({
					kind: "o",
					keyId: ctx.keyId,
					eventType: event.eventType,
					identity,
				});
			}
		} else {
			if (TOOL_KEY_CATEGORIES.has(event.category)) {
				const toolUseId = extractToolUseId(event.rawPayload);
				if (toolUseId) {
					dedupKey = computeDedupKey({
						kind: "t",
						keyId: ctx.keyId,
						eventType: event.eventType,
						toolUseId,
					});
				}
			}

			if (dedupKey === null && ctx.deliveryId) {
				if (bodyDigest === null) bodyDigest = sha256Hex(JSON.stringify(rawPayload));
				dedupKey = computeDedupKey({
					kind: "d",
					keyId: ctx.keyId,
					deliveryId: ctx.deliveryId,
					bodyDigest,
					rowIndex,
				});
			}
		}

		if (rowIndex === 0) primaryDedupKey = dedupKey;

		// Intra-batch collapse (U2.5): two rows in the SAME delivery that
		// happen to compute the same key (e.g. a hand-built multi-row batch
		// in a test) keep only the first — the DB's UNIQUE constraint would
		// reject the second anyway, but catching it here avoids relying on
		// RETURNING's silent drop for a same-call duplicate.
		if (dedupKey !== null) {
			if (seenKeys.has(dedupKey)) {
				countDrop(plan.drops, dedupKey.startsWith("t:") ? "toolUseRetry" : "deliveryRetry");
				return;
			}
			seenKeys.add(dedupKey);
		}

		const candidate: AuthorityCandidate = {
			id: null,
			category: event.category,
			source: event.source,
			content: event.content,
			createdAt: nowIso,
		};
		const rivals = pool.filter((existing) => isAuthorityDuplicate(existing, candidate));
		if (rivals.some((existing) => outranks(existing, candidate))) {
			countDrop(plan.drops, "authority");
			return;
		}

		const deletesIfStored: number[] = [];
		for (const rival of rivals) {
			if (rival.id) deletesIfStored.push(rival.id);
		}

		plan.retained.push({ ...event, createdAt: nowIso, dedupKey, deletesIfStored });
		pool.push(candidate);
	});

	plan.primaryDedupKey = primaryDedupKey;
	return plan;
}

/**
 * Decides which incoming events to store and which stored rows each one
 * supersedes. Pure: reads only its arguments and never mutates them.
 * `recent` is the session's latest stored rows; `nowIso` stamps retained rows.
 */
export function planEventInsert(args: {
	policy: DedupPolicy;
	recent: RecentEventRow[];
	incoming: NormalizedEvent[];
	nowIso: string;
}): InsertPlan {
	switch (args.policy.kind) {
		case "content_window":
			return planContentWindow(args.recent, args.incoming, args.nowIso);
		case "hook_delivery":
			return planHookDelivery(
				args.recent,
				args.incoming,
				args.nowIso,
				args.policy.ctx,
				args.policy.rawPayload,
			);
	}
}

// ── Observability counters (Decision 6) ─────────────────────────────────────
//
// Process-local only — durable identity lives in the dedup_key column, not
// here, so these are observability only and reset on restart or via
// _resetEventDedupForTest(). Never consulted for correctness.

const dropCounts: Record<DropReason, number> = {
	deliveryRetry: 0,
	toolUseRetry: 0,
	contentWindow: 0,
	authority: 0,
};
let legacyObserverDeliveryCount = 0;
let warnedLegacyObserver = false;

/** Folds a plan's (or persist-time's) drop counts into the running totals. */
export function recordDrops(drops: Partial<Record<DropReason, number>>): void {
	for (const reason of Object.keys(dropCounts) as DropReason[]) {
		dropCounts[reason] += drops[reason] ?? 0;
	}
}

export function getEventsDeduplicatedCounts(): Record<DropReason, number> {
	return { ...dropCounts };
}

export function getLegacyObserverDeliveries(): number {
	return legacyObserverDeliveryCount;
}

/**
 * Counts one legacy-observer-shaped delivery (codex_cli, origin "native",
 * no transcript_path — mozart D14) and warns once per process so an
 * operator can see hosts that still need a supervisor upgrade. No
 * identifiers in the log line (D6) — counts only.
 */
export function recordLegacyObserverDelivery(): void {
	legacyObserverDeliveryCount++;
	if (!warnedLegacyObserver) {
		warnedLegacyObserver = true;
		console.warn(
			JSON.stringify({
				kind: "legacy_codex_observer",
				hint: "upgrade the supervisor on this host",
			}),
		);
	}
}

/** Reset for tests only: counters and the once-per-process warn flag. Durable
 * dedup_key rows in the DB are untouched — there is no other dedup state. */
export function _resetEventDedupForTest(): void {
	for (const reason of Object.keys(dropCounts) as DropReason[]) dropCounts[reason] = 0;
	legacyObserverDeliveryCount = 0;
	warnedLegacyObserver = false;
}
