import { MarkdownContent } from "../MarkdownContent.js";
import { cn, formatTimeAgo } from "../../lib/utils.js";
import type { EventCategory, SessionEvent } from "../../../shared/types.js";

export type TimelineMode = "prompts" | "conversation" | "progress" | "debug";

export function PromptBubble({ text, time }: { text: string; time: string }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[80%]">
				<div className="rounded-2xl rounded-br-sm bg-primary/15 border border-primary/20 px-4 py-3">
					<MarkdownContent content={text} compact />
				</div>
				<p className="text-[10px] text-muted-foreground mt-1 text-right">
					{formatTimeAgo(time)}
				</p>
			</div>
		</div>
	);
}

export function AssistantBubble({ text, time }: { text: string; time: string }) {
	return (
		<div className="flex justify-start">
			<div className="max-w-[80%]">
				<div className="rounded-2xl rounded-bl-sm bg-sky-500/10 border border-sky-500/20 px-4 py-3">
					<MarkdownContent content={text} compact />
				</div>
				<p className="text-[10px] text-muted-foreground mt-1">
					{formatTimeAgo(time)}
				</p>
			</div>
		</div>
	);
}

export function TimelineCard({
	text,
	time,
	label,
	tone = "default",
}: {
	text: string;
	time: string;
	label: string;
	tone?: "default" | "emerald" | "amber" | "muted";
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
				<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
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
		if (event.category === "tool_event" && !showTools && mode !== "debug") return false;
		if (event.category === "tool_event" && !showNoisyTools && event.isNoise) return false;
		if (!event.content && event.category !== "tool_event") return false;
		return true;
	});
}

export function eventKey(
	event: Pick<
		SessionEvent,
		"id" | "eventType" | "category" | "content" | "createdAt" | "providerEventType" | "rawPayload"
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
	return Array.from(merged.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

