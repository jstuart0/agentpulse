// Phase 3 (AGEN-16): mergeSessionEvents gets a hybrid dedup key —
// `id:N` when id > 0, else the existing content-based eventKey — and
// iterates live events first, then base, so the polled DB row wins on any
// collision (Map.set() with the same key: the later call wins).
//
// No DOM harness here — mergeSessionEvents is tested as a pure function.
// eventKey (React key / DOM id, ActivityTimeline.tsx:63) is untouched: it
// stays purely content-based. F86 guard: this file never touches
// areNearInTime/parseEventTime/collapseEquivalentEvents semantics in
// ../../../shared/event-authority.js — those stay live in the web client.
//
// tool_event fixtures are used for every id-collision case so that
// collapseEquivalentEvents (which only ever merges assistant_message /
// prompt rows) can't quietly absorb a merge bug and mask a false pass.

import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../shared/types.js";
import { mergeSessionEvents } from "./TimelineView.js";

function toolEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
	return {
		id: 0,
		sessionId: "sess-1",
		eventType: "PostToolUse",
		category: "tool_event",
		source: "observed_hook",
		content: "Running Bash",
		isNoise: false,
		providerEventType: null,
		toolName: "Bash",
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		createdAt: "2026-09-29T12:00:00.000Z",
		...overrides,
	};
}

function assistantEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
	return {
		id: 0,
		sessionId: "sess-1",
		eventType: "AssistantMessage",
		category: "assistant_message",
		source: "observed_hook",
		content: "All done here.",
		isNoise: false,
		providerEventType: "Stop",
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		createdAt: "2026-09-29T12:00:00.000Z",
		...overrides,
	};
}

describe("mergeSessionEvents (P5.1-P5.7)", () => {
	// P5.1: the duplicate-live boundary. The same stored row arrives twice —
	// once from the WS broadcast (live, real id, ISO createdAt as the socket
	// sent it) and once from the next REST poll (base, same id, bare SQLite
	// createdAt as the DB stores it). The old content-based eventKey
	// (which folds in createdAt verbatim) treats these as two different
	// events because the createdAt strings differ in format, even though
	// they share the same real id. RED@P3-start: 2 rows. Fixed: 1 row, and
	// it's the polled (base) row's shape that wins.
	test("P5.1 a live broadcast and its later poll of the same id collapse to one row, base wins", () => {
		const live = toolEvent({
			id: 42,
			content: "Running Bash",
			createdAt: "2026-09-29T12:00:00.123Z",
		});
		const base = toolEvent({
			id: 42,
			content: "Running Bash",
			createdAt: "2026-09-29 12:00:00",
		});

		const merged = mergeSessionEvents([base], [live]);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.createdAt).toBe(base.createdAt);
	});

	// P5.2 (tessa's overlap case): 5 base rows, one of which a live entry
	// also reports (by id) with a slightly different shape (as if the
	// optimistic live copy and the polled row diverged in some field before
	// the DB write settled). The old key treats the overlapping live row as
	// a 6th distinct event (base: 5 + live-only-by-old-key: 1 = 6). The
	// fixed key unifies it back down to 5, because it shares id=3 with an
	// existing base row.
	test("P5.2 an overlapping live row collapses into its base counterpart: 6 at base, 5 after the fix", () => {
		const base = [1, 2, 3, 4, 5].map((id) =>
			toolEvent({
				id,
				content: `tool call ${id}`,
				createdAt: `2026-09-29 12:00:0${id}`,
			}),
		);
		// Live copy of base row id=3, with a divergent (optimistic) shape —
		// different content and createdAt format — but the same real id.
		const overlappingLive = toolEvent({
			id: 3,
			content: "tool call 3 (optimistic)",
			createdAt: "2026-09-29T12:00:03.500Z",
		});

		const merged = mergeSessionEvents(base, [overlappingLive]);

		expect(merged).toHaveLength(5);
		expect(merged.find((e) => e.id === 3)?.content).toBe("tool call 3");
	});

	// P5.3: the polled row must win even when the live row is processed
	// after it structurally — mergeSessionEvents controls this via
	// iteration order (live first, then base), not caller order. Passing
	// live and base in the "wrong" array order must not change the winner.
	test("P5.3 the polled row wins regardless of which array argument order the caller uses in content", () => {
		const live = toolEvent({ id: 7, content: "optimistic", toolResponse: null });
		const base = toolEvent({ id: 7, content: "finalized", toolResponse: "ok" });

		const merged = mergeSessionEvents([base], [live]);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.content).toBe("finalized");
		expect(merged[0]?.toolResponse).toBe("ok");
	});

	// P5.4 (GUARD): two genuinely live-only events (id=0, the pre-Phase-6/7
	// broadcast shape, or any not-yet-persisted event) with distinct content
	// both survive on the eventKey fallback path.
	test("P5.4 two distinct live-only (id=0) events both survive", () => {
		const liveA = toolEvent({ id: 0, content: "call A", createdAt: "2026-09-29T12:00:01.000Z" });
		const liveB = toolEvent({ id: 0, content: "call B", createdAt: "2026-09-29T12:00:02.000Z" });

		const merged = mergeSessionEvents([], [liveA, liveB]);

		expect(merged).toHaveLength(2);
		expect(merged.map((e) => e.content).sort()).toEqual(["call A", "call B"]);
	});

	// P5.5 (GUARD): distinct base (already-persisted) events with different
	// ids are untouched by merging in an empty live array.
	test("P5.5 distinct base events pass through unchanged with no live events", () => {
		const base = [1, 2, 3].map((id) => toolEvent({ id, content: `call ${id}` }));

		const merged = mergeSessionEvents(base, []);

		expect(merged).toHaveLength(3);
		expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
	});

	// P5.6 (GUARD): output is sorted by createdAt regardless of input order
	// or which array (base/live) an event came from. Uses one consistent
	// timestamp format throughout — mixing bare SQLite and ISO strings hits
	// a separate, pre-existing, out-of-scope sort bug (a bare string always
	// sorts before an ISO string for the same wall time, since ' ' < 'T'
	// lexicographically), which is not what this case is testing.
	test("P5.6 merged output is sorted by createdAt", () => {
		const base = toolEvent({ id: 1, content: "first", createdAt: "2026-09-29 12:00:00" });
		const live = toolEvent({ id: 2, content: "second", createdAt: "2026-09-29 12:00:05" });
		const base2 = toolEvent({ id: 3, content: "third", createdAt: "2026-09-29 12:00:10" });

		const merged = mergeSessionEvents([base2, base], [live]);

		expect(merged.map((e) => e.content)).toEqual(["first", "second", "third"]);
	});

	// P5.7 (GUARD): collapseEquivalentEvents still runs after the id-based
	// merge — an assistant-authority duplicate (same content, near in time,
	// different source) still collapses to one row. Deliberately uses
	// assistant_message (not tool_event) since that's the only category
	// collapseEquivalentEvents touches.
	test("P5.7 assistant-authority collapse still applies after merging", () => {
		const hook = assistantEvent({
			id: 10,
			source: "observed_hook",
			content: "All done here.",
			createdAt: "2026-09-29 12:00:00",
		});
		const transcript = assistantEvent({
			id: 11,
			source: "observed_transcript",
			content: "All done here.",
			createdAt: "2026-09-29T12:00:02.000Z",
		});

		const merged = mergeSessionEvents([hook], [transcript]);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.source).toBe("observed_transcript");
	});
});
