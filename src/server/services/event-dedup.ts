import {
	EVENT_DUPLICATE_WINDOW_MS,
	getEventSourcePriority,
	normalizeComparableContent,
} from "../../shared/event-authority.js";
import type { NormalizedEvent } from "./event-normalizer.js";
import { parseDbTimestamp } from "./util/db-time.js";

export type DedupPolicy = { kind: "content_window" };

export type DropReason = "deliveryRetry" | "toolUseRetry" | "contentWindow" | "authority";

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
	}
}
