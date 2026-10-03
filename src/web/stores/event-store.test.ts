import { beforeEach, describe, expect, test } from "bun:test";
import type { LiveSessionEvent } from "../../shared/types.js";
import { MAX_LIVE_EVENTS_PER_SESSION, useEventStore } from "./event-store.js";

function event(sessionId: string, id: number): LiveSessionEvent {
	return { sessionId, id } as unknown as LiveSessionEvent;
}

beforeEach(() => useEventStore.setState({ liveEvents: new Map() }));

describe("live events are capped per session", () => {
	test("the cap is 500", () => {
		expect(MAX_LIVE_EVENTS_PER_SESSION).toBe(500);
	});

	test("only the newest events of a session are kept", () => {
		const { addLiveEvent } = useEventStore.getState();
		for (let i = 1; i <= 520; i += 1) addLiveEvent(event("s1", i));
		const kept = useEventStore.getState().liveEvents.get("s1") ?? [];
		expect(kept.length).toBe(500);
		expect((kept[0] as unknown as { id: number }).id).toBe(21);
		expect((kept[499] as unknown as { id: number }).id).toBe(520);
	});

	test("one busy session doesn't cost another its events", () => {
		const { addLiveEvent } = useEventStore.getState();
		for (let i = 1; i <= 600; i += 1) addLiveEvent(event("busy", i));
		addLiveEvent(event("quiet", 1));
		expect(useEventStore.getState().liveEvents.get("quiet")?.length).toBe(1);
	});
});
