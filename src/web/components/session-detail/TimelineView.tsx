import { MarkdownContent } from "../MarkdownContent.js";
import { cn, formatTimeAgo } from "../../lib/utils.js";
import {
	EVENT_DUPLICATE_WINDOW_MS,
	EVENT_SOURCE_PRIORITY,
	PROMPT_MIRROR_WINDOW_MS,
	areNearInTime,
	isPromptMirrorSourcePair,
	normalizeComparableContent,
} from "../../../shared/event-authority.js";
import type { EventCategory, EventSource, SessionEvent } from "../../../shared/types.js";

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
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
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
	switch (category) {
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
		default:
			return "Event";
	}
}

function getBaseCategories(mode: TimelineMode): Set<EventCategory> {
	switch (mode) {
		case "prompts":
			return new Set(["prompt"]);
		case "conversation":
			return new Set(["prompt", "assistant_message"]);
		case "progress":
			return new Set([
				"prompt",
				"assistant_message",
				"progress_update",
				"plan_update",
				"status_update",
				"system_event",
			]);
		case "terminal":
			return new Set([
				"prompt",
				"assistant_message",
				"progress_update",
				"plan_update",
				"status_update",
				"tool_event",
				"system_event",
			]);
		case "debug":
			return new Set([
				"prompt",
				"assistant_message",
				"progress_update",
				"plan_update",
				"status_update",
				"tool_event",
				"system_event",
			]);
	}
}

export function getVisibleEvents(
	allEvents: SessionEvent[],
	mode: TimelineMode,
	showTools: boolean,
	showNoisyTools: boolean,
	showSystem: boolean,
) {
	const categories = getBaseCategories(mode);
	if (showTools) categories.add("tool_event");
	if (!showSystem) categories.delete("system_event");

	return allEvents.filter((event) => {
		if (!event.category || !categories.has(event.category)) return false;
		if (event.category === "tool_event" && !showTools && mode !== "debug" && mode !== "terminal") return false;
		if (event.category === "tool_event" && !showNoisyTools && event.isNoise) return false;
		if (!event.content && event.category !== "tool_event") return false;
		return true;
	});
}

export function eventKey(
	event: Pick<
		SessionEvent,
		"id" | "eventType" | "category" | "source" | "content" | "createdAt" | "providerEventType" | "rawPayload"
	>,
) {
	const transcriptId =
		(typeof event.rawPayload?.transcript_uuid === "string" && event.rawPayload.transcript_uuid) ||
		(typeof event.rawPayload?.transcript_timestamp === "string" && event.rawPayload.transcript_timestamp) ||
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

export function mergeSessionEvents(baseEvents: SessionEvent[], liveEvents: SessionEvent[]) {
	const merged = new Map<string, SessionEvent>();
	for (const event of [...baseEvents, ...liveEvents]) {
		merged.set(eventKey(event), event);
	}
	return collapseEquivalentEvents(
		Array.from(merged.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
	);
}
