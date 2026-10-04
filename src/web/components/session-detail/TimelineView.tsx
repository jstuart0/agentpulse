import {
	EVENT_DUPLICATE_WINDOW_MS,
	EVENT_SOURCE_PRIORITY,
	PROMPT_MIRROR_WINDOW_MS,
	areNearInTime,
	isPromptMirrorSourcePair,
	normalizeComparableContent,
} from "../../../shared/event-authority.js";
import type { EventCategory, EventSource, SessionEvent } from "../../../shared/types.js";
import { cn, formatTimeAgo } from "../../lib/utils.js";
import { MarkdownContent } from "../MarkdownContent.js";

export type TimelineMode = "prompts" | "conversation" | "progress" | "terminal" | "debug";

function chooseHigherAuthorityEvent(left: SessionEvent, right: SessionEvent) {
	const leftPriority = EVENT_SOURCE_PRIORITY[left.source] ?? 0;
	const rightPriority = EVENT_SOURCE_PRIORITY[right.source] ?? 0;
	if (leftPriority !== rightPriority) return leftPriority > rightPriority ? left : right;
	return left.createdAt >= right.createdAt ? left : right;
}

function isAssistantAuthorityDuplicate(left: SessionEvent, right: SessionEvent) {
	if (left.category !== "assistant_message" || right.category !== "assistant_message") return false;
	const leftContent = normalizeComparableContent(left.content);
	const rightContent = normalizeComparableContent(right.content);
	if (!leftContent || leftContent !== rightContent) return false;
	return areNearInTime(left.createdAt, right.createdAt, EVENT_DUPLICATE_WINDOW_MS);
}

function isPromptMirrorDuplicate(left: SessionEvent, right: SessionEvent) {
	if (left.category !== "prompt" || right.category !== "prompt") return false;
	const leftContent = normalizeComparableContent(left.content);
	const rightContent = normalizeComparableContent(right.content);
	if (!leftContent || leftContent !== rightContent) return false;
	if (!isPromptMirrorSourcePair(left.source, right.source)) return false;
	return areNearInTime(left.createdAt, right.createdAt, PROMPT_MIRROR_WINDOW_MS);
}

function collapseEquivalentEvents(events: SessionEvent[]) {
	const collapsed: SessionEvent[] = [];

	for (const event of events) {
		const last = collapsed.at(-1);
		if (!last) {
			collapsed.push(event);
			continue;
		}

		if (isAssistantAuthorityDuplicate(last, event)) {
			collapsed[collapsed.length - 1] = chooseHigherAuthorityEvent(last, event);
			continue;
		}

		if (isPromptMirrorDuplicate(last, event)) {
			collapsed[collapsed.length - 1] = chooseHigherAuthorityEvent(last, event);
			continue;
		}

		collapsed.push(event);
	}

	return collapsed;
}

export function sourceLabel(source: EventSource) {
	switch (source) {
		case "observed_hook":
			return "Hook";
		case "observed_status":
			return "Status";
		case "observed_transcript":
			return "Transcript";
		case "managed_control":
			return "Control";
		case "launch_system":
			return "Launch";
	}
}

function SourceBadge({ source }: { source: EventSource }) {
	return (
		<span className="rounded-full border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
			{sourceLabel(source)}
		</span>
	);
}

export function PromptBubble({
	text,
	time,
	source,
}: {
	text: string;
	time: string;
	source?: EventSource;
}) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[80%]">
				<div className="rounded-2xl rounded-br-sm bg-primary/15 border border-primary/20 px-4 py-3">
					<MarkdownContent content={text} compact />
				</div>
				<div className="mt-1 flex items-center justify-end gap-2">
					{source ? <SourceBadge source={source} /> : null}
					<p className="text-[10px] text-muted-foreground text-right">{formatTimeAgo(time)}</p>
				</div>
			</div>
		</div>
	);
}

export function AssistantBubble({
	text,
	time,
	source,
}: {
	text: string;
	time: string;
	source?: EventSource;
}) {
	return (
		<div className="flex justify-start">
			<div className="max-w-[80%]">
				<div className="rounded-2xl rounded-bl-sm bg-sky-500/10 border border-sky-500/20 px-4 py-3">
					<MarkdownContent content={text} compact />
				</div>
				<div className="mt-1 flex items-center gap-2">
					<p className="text-[10px] text-muted-foreground">{formatTimeAgo(time)}</p>
					{source ? <SourceBadge source={source} /> : null}
				</div>
			</div>
		</div>
	);
}

export function TimelineCard({
	text,
	time,
	label,
	tone = "default",
	source,
}: {
	text: string;
	time: string;
	label: string;
	tone?: "default" | "emerald" | "amber" | "muted";
	source?: EventSource;
}) {
	const toneClasses = {
		default: "border-border bg-card/60",
		emerald: "border-emerald-500/20 bg-emerald-500/10",
		amber: "border-amber-500/20 bg-amber-500/10",
		muted: "border-border/70 bg-muted/30",
	};

	return (
		<div className={cn("rounded-xl border px-3 py-2.5", toneClasses[tone])}>
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{label}
					</span>
					{source ? <SourceBadge source={source} /> : null}
				</div>
				<span className="text-[10px] text-muted-foreground">{formatTimeAgo(time)}</span>
			</div>
			<div className="mt-1.5">
				<MarkdownContent content={text} compact />
			</div>
		</div>
	);
}

export function eventLabel(category: EventCategory | null): string {
	if (category === null) return "Event";
	switch (category) {
		case "prompt":
			return "Prompt";
		case "assistant_message":
			return "Response";
		case "progress_update":
			return "Progress";
		case "plan_update":
			return "Plan";
		case "status_update":
			return "Status";
		case "tool_event":
			return "Tool";
		case "system_event":
			return "System";
		case "permission_event":
			return "Permission";
		case "user_ack":
			return "Acknowledged";
		case "ai_proposal_pending":
			return "AI Proposal Pending";
		case "ai_proposal":
			return "AI Proposal";
		case "ai_report":
			return "AI Report";
		case "ai_hitl_request":
			return "AI HITL";
		case "ai_hitl_response":
			return "AI HITL Reply";
		case "ai_continue_sent":
			return "AI Continue";
		case "ai_continue_blocked":
			return "AI Continue Blocked";
		case "ai_error":
			return "AI Error";
		default: {
			const _exhaustive: never = category;
			void _exhaustive;
			return "Event";
		}
	}
}

/**
 * Which TimelineMode(s) each EventCategory shows in by default (before
 * showTools/showSystem overrides). A `Record<EventCategory, ...>` — not a
 * switch over TimelineMode — so adding a member to the EventCategory union
 * without deciding where it shows is a TypeScript error here, the same way
 * eventLabel's switch above is exhaustive over category.
 *
 * "user_ack" (AGEN) shows in Debug only: acknowledge/unacknowledge/dismiss
 * events are real signal for someone debugging the operational-status
 * model, but noise for every other view. The ai_* categories show nowhere
 * via this component today (AiPanel/the AI tab owns their display) —
 * explicit empty arrays, not an omission.
 */
const CATEGORY_MODES: Record<EventCategory, readonly TimelineMode[]> = {
	prompt: ["prompts", "conversation", "progress", "terminal", "debug"],
	assistant_message: ["conversation", "progress", "terminal", "debug"],
	progress_update: ["progress", "terminal", "debug"],
	plan_update: ["progress", "terminal", "debug"],
	status_update: ["progress", "terminal", "debug"],
	tool_event: ["terminal", "debug"],
	system_event: ["progress", "terminal", "debug"],
	permission_event: ["progress", "terminal", "debug"],
	user_ack: ["debug"],
	ai_proposal_pending: [],
	ai_proposal: [],
	ai_report: [],
	ai_hitl_request: [],
	ai_hitl_response: [],
	ai_continue_sent: [],
	ai_continue_blocked: [],
	ai_error: [],
};

function getBaseCategories(mode: TimelineMode): Set<EventCategory> {
	const categories = new Set<EventCategory>();
	for (const key of Object.keys(CATEGORY_MODES) as EventCategory[]) {
		if (CATEGORY_MODES[key].includes(mode)) categories.add(key);
	}
	return categories;
}

export function getVisibleEvents<E extends Pick<SessionEvent, "category" | "isNoise" | "content">>(
	allEvents: E[],
	mode: TimelineMode,
	showTools: boolean,
	showNoisyTools: boolean,
	showSystem: boolean,
): E[] {
	const categories = getBaseCategories(mode);
	if (showTools) categories.add("tool_event");
	if (!showSystem) categories.delete("system_event");

	return allEvents.filter((event) => {
		if (!event.category || !categories.has(event.category)) return false;
		if (event.category === "tool_event" && !showTools && mode !== "debug" && mode !== "terminal")
			return false;
		if (event.category === "tool_event" && !showNoisyTools && event.isNoise) return false;
		if (!event.content && event.category !== "tool_event") return false;
		return true;
	});
}

export function eventKey(
	event: Pick<
		SessionEvent,
		| "id"
		| "eventType"
		| "category"
		| "source"
		| "content"
		| "createdAt"
		| "providerEventType"
		| "rawPayload"
	>,
) {
	const transcriptId =
		(typeof event.rawPayload?.transcript_uuid === "string" && event.rawPayload.transcript_uuid) ||
		(typeof event.rawPayload?.transcript_timestamp === "string" &&
			event.rawPayload.transcript_timestamp) ||
		"";
	return [
		event.id || 0,
		event.eventType,
		event.category || "",
		event.source,
		event.content || "",
		event.createdAt,
		event.providerEventType || "",
		transcriptId,
	].join("::");
}

// Phase 3 (AGEN-16): a merge-only key, distinct from eventKey (which stays
// purely content-based for React key / DOM id use, ActivityTimeline.tsx:63).
// Once an event has a real persisted id, that id alone identifies it — a
// live broadcast and its later REST poll of the same row can otherwise
// differ in shape (createdAt in particular: ISO from the WS payload vs
// bare "YYYY-MM-DD HH:MM:SS" from the DB), which the old content-based key
// treated as two distinct events. id=0 (not yet persisted, e.g. a
// pre-Phase-6/7 broadcast) falls back to the content-based key.
function mergeKey(event: SessionEvent): string {
	return event.id > 0 ? `id:${event.id}` : eventKey(event);
}

// F102: `id` is a global auto-increment across every session, not scoped to
// one — mergeKey's `id:${event.id}` branch trusts it as a merge key without
// any sessionId cross-check. That's safe only because every call site
// (SessionDetailPage) already scopes both `baseEvents` (a REST poll of this
// session) and `liveEvents` (WS events filtered to this session's id) to
// the same session before calling this function. Before Phase 6, hook
// broadcasts always carried id:0 and fell back to the content-based key, so
// a same-id collision across two different sessions' events was never
// actually reachable here — now that hook broadcasts carry real ids
// (Phase 6), a caller that ever passes unscoped arrays would silently
// merge another session's row in. If this function ever needs to be
// called with un-prescoped inputs, filter by sessionId first (or add an
// explicit assert here) — don't rely on id uniqueness alone.
export function mergeSessionEvents(baseEvents: SessionEvent[], liveEvents: SessionEvent[]) {
	const merged = new Map<string, SessionEvent>();
	// Live first, then base: Map.set() on a collision keeps the later call's
	// value, so the polled (base) row's shape always wins over the
	// optimistic live copy.
	for (const event of [...liveEvents, ...baseEvents]) {
		merged.set(mergeKey(event), event);
	}
	return collapseEquivalentEvents(
		Array.from(merged.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
	);
}
