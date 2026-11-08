import { type ReactNode, type RefObject, forwardRef } from "react";
import { TURN_UNASKED_PREFIX } from "../../../shared/claude-fork-copy.js";
import type { ForkToolCallDto } from "../../../shared/fork-tool-calls.js";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { useForkToolCalls } from "../../hooks/useForkToolCalls.js";
import { useOwnershipUi } from "../../hooks/useOwnershipUi.js";
import {
	eventDisplayTime,
	lateArrival,
	lateDetail,
	lateRunStarts,
	lateSuffix,
} from "../../lib/event-time.js";
import { isFork } from "../../lib/fork-session.js";
import { ownerLabel } from "../../lib/owner-label.js";
import { toolDetailAccess } from "../../lib/session-action-access.js";
import { useUserStore } from "../../stores/user-store.js";
import { useUsersStore } from "../../stores/users-store.js";
import { CallDetails, type DetailContext, TurnDetails } from "./ForkRowDetails.js";
import {
	AssistantBubble,
	PromptBubble,
	TimelineCard,
	type TimelineMode,
	eventKey,
	eventLabel,
	eventRowIsPlainText,
	eventRowLabel,
	eventRowTone,
} from "./TimelineView.js";
import { ToolCallBlock } from "./ToolCallBlock.js";
import { callRowToolUseId, turnCallIds, turnEndedAtMs } from "./fork-detail-availability.js";

interface ActivityTimelineProps {
	visibleEvents: SessionEvent[];
	mode: TimelineMode;
	onScroll: () => void;
	endRef: RefObject<HTMLDivElement | null>;
	loadingContext?: boolean;
	/**
	 * A continued Claude session and every event of it (the visible ones are a subset): lets a viewer allowed
	 * to read tool detail open what a call ran. Absent, no row has a Details control.
	 */
	session?: Session | null;
	allEvents?: readonly SessionEvent[];
}

/** What the rows below this need to add a Details control, or null when this viewer gets none. */
function useForkDetail(
	session: Session | null | undefined,
	allEvents: readonly SessionEvent[],
): ForkDetail | null {
	const ui = useOwnershipUi();
	const userId = useUserStore((s) => s.userId);
	const effectiveRole = useUserStore((s) => s.effectiveRole);
	const directory = useUsersStore((s) => s.byId);
	const access = session ? toolDetailAccess(ui, session, { userId, effectiveRole }) : "denied";
	const enabled =
		!!session && session.agentType === "claude_code" && isFork(session) && access !== "denied";
	const stored = useForkToolCalls(
		session?.sessionId ?? null,
		enabled,
		session?.isWorking === true,
		allEvents.at(-1)?.id ?? 0,
	);
	if (!enabled || !session || stored.unavailable) return null;
	const owner = session.ownerUserId ?? null;
	const context: DetailContext = {
		sessionId: session.sessionId,
		access,
		ownerName: owner === null ? null : ownerLabel(directory[owner], owner, { selfId: userId }),
	};
	return { context, calls: stored.calls, allEvents, working: session.isWorking === true };
}

export interface ForkDetail {
	context: DetailContext;
	calls: ReadonlyMap<string, ForkToolCallDto>;
	allEvents: readonly SessionEvent[];
	working: boolean;
}

/**
 * Activity timeline renderer. Two output shapes based on `mode`:
 *   - terminal: raw-ish transcript, monospace, no bubbles
 *   - otherwise: the regular prompt/assistant bubble + tool-block mix
 * Scroll container state + the bottom sentinel are handled here; the
 * parent only supplies the event list and the scroll handler.
 */
export const ActivityTimeline = forwardRef<HTMLDivElement, ActivityTimelineProps>(
	({ visibleEvents, mode, onScroll, endRef, loadingContext, session, allEvents }, containerRef) => {
		const forkDetail = useForkDetail(session, allEvents ?? visibleEvents);
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
						renderBubbles(visibleEvents, mode, forkDetail)
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
function renderBubbles(
	visibleEvents: SessionEvent[],
	mode: TimelineMode,
	forkDetail: ForkDetail | null,
) {
	const starts = lateRunStarts(visibleEvents);
	const positions = forkDetail ? new Map(forkDetail.allEvents.map((e, i) => [e.id, i])) : null;
	return visibleEvents.map((event, index) => {
		const minutes = lateArrival(event);
		const detail = lateDetail(event) ?? undefined;
		const note = minutes !== null && starts.has(index) ? lateSuffix(minutes) : undefined;
		const row = renderBubbleEvent(event, mode, note, detail, minutes !== null);
		const extra = row && forkDetail && positions ? rowDetails(event, forkDetail, positions) : null;
		return stampedItem(
			event,
			extra ? (
				<>
					{row}
					{extra}
				</>
			) : (
				row
			),
		);
	});
}

/** The Details control under a call's row, or "Show what ran" under a turn's unasked line; null for any other row. */
export function rowDetails(
	event: SessionEvent,
	detail: ForkDetail,
	positions: ReadonlyMap<number, number>,
) {
	const index = positions.get(event.id);
	if (index === undefined) return null;
	const toolUseId = callRowToolUseId(event);
	if (toolUseId !== null) {
		const record = detail.calls.get(toolUseId);
		if (!record) return null;
		const endedAt = turnEndedAtMs(detail.allEvents, index, detail.working);
		return <CallDetails context={detail.context} record={record} turnEndedAt={endedAt} />;
	}
	if (event.eventType === "HeadlessStatus" && event.content?.startsWith(TURN_UNASKED_PREFIX)) {
		const records = turnCallIds(detail.allEvents, index)
			.map((id) => detail.calls.get(id))
			.filter((record) => record !== undefined && record.outcome === "unasked");
		if (records.length === 0) return null;
		const endedAt = turnEndedAtMs(detail.allEvents, index, detail.working);
		return (
			<TurnDetails
				context={detail.context}
				records={records as NonNullable<(typeof records)[number]>[]}
				turnEndedAt={endedAt}
			/>
		);
	}
	return null;
}

function renderBubbleEvent(
	event: SessionEvent,
	mode: TimelineMode,
	lateNote?: string,
	lateDetail?: string,
	late?: boolean,
) {
	// Judged by the event type before the host-supplied category: a host that labels a plain-text row
	// "assistant_message" or "prompt" must not get it parsed as Markdown.
	const plainText = eventRowIsPlainText(event);
	if (!plainText && event.category === "prompt" && event.content) {
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
	if (!plainText && event.category === "assistant_message" && event.content) {
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
			plainText={plainText}
		/>
	);
}
