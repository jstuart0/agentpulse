import { type ReactNode, type RefObject, forwardRef } from "react";
import type { SessionEvent } from "../../../shared/types.js";
import {
	AssistantBubble,
	PromptBubble,
	TimelineCard,
	type TimelineMode,
	eventKey,
	eventLabel,
} from "./TimelineView.js";
import { ToolCallBlock } from "./ToolCallBlock.js";

interface ActivityTimelineProps {
	visibleEvents: SessionEvent[];
	mode: TimelineMode;
	onScroll: () => void;
	endRef: RefObject<HTMLDivElement | null>;
	loadingContext?: boolean;
}

/**
 * Activity timeline renderer. Two output shapes based on `mode`:
 *   - terminal: raw-ish transcript, monospace, no bubbles
 *   - otherwise: the regular prompt/assistant bubble + tool-block mix
 * Scroll container state + the bottom sentinel are handled here; the
 * parent only supplies the event list and the scroll handler.
 */
export const ActivityTimeline = forwardRef<HTMLDivElement, ActivityTimelineProps>(
	({ visibleEvents, mode, onScroll, endRef, loadingContext }, containerRef) => {
		return (
			<div ref={containerRef} onScroll={onScroll} className="h-full overflow-auto p-3 md:p-6">
				{loadingContext ? (
					<p className="text-xs text-muted-foreground text-center pb-2">Loading older context…</p>
				) : null}
				<div className={mode === "terminal" ? "space-y-4" : "space-y-3"}>
					{visibleEvents.length === 0 ? (
						<p className="text-sm text-muted-foreground text-center py-8">
							No events match this view yet.
						</p>
					) : mode === "terminal" ? (
						visibleEvents.map((event) => stampedItem(event, renderTerminalEvent(event)))
					) : (
						visibleEvents.map((event) => stampedItem(event, renderBubbleEvent(event, mode)))
					)}
					<div ref={endRef} />
				</div>
			</div>
		);
	},
);

ActivityTimeline.displayName = "ActivityTimeline";

/**
 * Wraps a rendered timeline item in a thin container that carries the DOM id
 * used by the scroll/flash effect. Persisted DB rows (id > 0) get
 * `id="event-{id}"`. WebSocket-only events (no persisted id) get a
 * `data-event-key` attribute instead — search hits always reference persisted
 * rows so they will always find the id-stamped element.
 */
function stampedItem(event: SessionEvent, child: ReactNode) {
	if (child === null) return null;
	const key = eventKey(event);
	if (event.id) {
		return (
			<div key={key} id={`event-${event.id}`}>
				{child}
			</div>
		);
	}
	return (
		<div key={key} data-event-key={key}>
			{child}
		</div>
	);
}

function renderTerminalEvent(event: SessionEvent) {
	if (event.category === "prompt" && event.content) {
		return (
			<div className="font-mono text-[13px] leading-6">
				<span className="text-primary select-none mr-1">&gt;</span>
				<span className="whitespace-pre-wrap break-words text-foreground">{event.content}</span>
			</div>
		);
	}
	if (event.category === "assistant_message" && event.content) {
		return (
			<div className="text-sm leading-6 whitespace-pre-wrap break-words text-foreground/90">
				{event.content}
			</div>
		);
	}
	if (event.category === "tool_event") {
		return <ToolCallBlock event={event} />;
	}
	if (!event.content) return null;
	return (
		<div className="font-mono text-[12px] leading-5 text-muted-foreground whitespace-pre-wrap break-words">
			<span className="uppercase tracking-wider mr-2 text-[10px]">
				{eventLabel(event.category)}
			</span>
			{event.content}
		</div>
	);
}

function renderBubbleEvent(event: SessionEvent, mode: TimelineMode) {
	if (event.category === "prompt" && event.content) {
		return (
			<PromptBubble
				text={event.content}
				time={event.createdAt}
				source={mode === "debug" ? event.source : undefined}
			/>
		);
	}
	if (event.category === "assistant_message" && event.content) {
		return (
			<AssistantBubble
				text={event.content}
				time={event.createdAt}
				source={mode === "debug" ? event.source : undefined}
			/>
		);
	}
	if (event.category === "tool_event") {
		const detail = event.content || event.toolName || event.eventType;
		return (
			<TimelineCard
				label={eventLabel(event.category)}
				text={detail}
				time={event.createdAt}
				tone={event.isNoise ? "muted" : "amber"}
				source={mode === "debug" ? event.source : undefined}
			/>
		);
	}
	if (!event.content) return null;
	return (
		<TimelineCard
			label={eventLabel(event.category)}
			text={event.content}
			time={event.createdAt}
			tone={event.category === "status_update" ? "emerald" : "default"}
			source={mode === "debug" ? event.source : undefined}
		/>
	);
}
