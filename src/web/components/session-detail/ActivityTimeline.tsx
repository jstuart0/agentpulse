import { type ReactNode, type RefObject, forwardRef } from "react";
import type { SessionEvent } from "../../../shared/types.js";
import {
	eventDisplayTime,
	lateArrival,
	lateDetail,
	lateRunStarts,
	lateSuffix,
} from "../../lib/event-time.js";
import {
	APPROVAL_RESOLVED_EVENT,
	AssistantBubble,
	PromptBubble,
	TimelineCard,
	type TimelineMode,
	eventKey,
	eventLabel,
	eventRowLabel,
	eventRowTone,
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
						renderBubbles(visibleEvents, mode)
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
			<span className="uppercase tracking-wider mr-2 text-[10px]">{eventRowLabel(event)}</span>
			{event.content}
		</div>
	);
}

/**
 * Every late row carries a quiet marker and the two times in words; the "arrived … late" note goes on the
 * first row of each late run, judged over the rows on screen.
 */
function renderBubbles(visibleEvents: SessionEvent[], mode: TimelineMode) {
	const starts = lateRunStarts(visibleEvents);
	return visibleEvents.map((event, index) => {
		const minutes = lateArrival(event);
		const detail = lateDetail(event) ?? undefined;
		const note = minutes !== null && starts.has(index) ? lateSuffix(minutes) : undefined;
		return stampedItem(event, renderBubbleEvent(event, mode, note, detail, minutes !== null));
	});
}

function renderBubbleEvent(
	event: SessionEvent,
	mode: TimelineMode,
	lateNote?: string,
	lateDetail?: string,
	late?: boolean,
) {
	if (event.category === "prompt" && event.content) {
		return (
			<PromptBubble
				text={event.content}
				time={eventDisplayTime(event)}
				lateNote={lateNote}
				lateDetail={lateDetail}
				late={late}
				source={mode === "debug" ? event.source : undefined}
			/>
		);
	}
	if (event.category === "assistant_message" && event.content) {
		return (
			<AssistantBubble
				text={event.content}
				time={eventDisplayTime(event)}
				lateNote={lateNote}
				lateDetail={lateDetail}
				late={late}
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
				time={eventDisplayTime(event)}
				lateNote={lateNote}
				lateDetail={lateDetail}
				late={late}
				tone={event.isNoise ? "muted" : "amber"}
				source={mode === "debug" ? event.source : undefined}
			/>
		);
	}
	if (!event.content) return null;
	return (
		<TimelineCard
			label={eventRowLabel(event)}
			text={event.content}
			time={eventDisplayTime(event)}
			lateNote={lateNote}
			lateDetail={lateDetail}
			late={late}
			tone={eventRowTone(event)}
			source={mode === "debug" ? event.source : undefined}
			plainText={
				event.eventType === "ManagedEventsLost" || event.eventType === APPROVAL_RESOLVED_EVENT
			}
		/>
	);
}
