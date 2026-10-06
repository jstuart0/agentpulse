/** AGEN-69 review fix U-5: open/closed and Show-all state is held, and cleared as a whole. */
import { describe, expect, test } from "bun:test";
import { useSummaryViewStore } from "./summary-view-store.js";

describe("summary view store", () => {
	test("sections start open and unexpanded; choices stick; reset clears them", () => {
		const s = useSummaryViewStore.getState();
		expect(s.closed).toEqual({});
		s.setOpen("changes", false);
		s.setExpanded("accomplishments", true);
		expect(useSummaryViewStore.getState().closed.changes).toBe(true);
		expect(useSummaryViewStore.getState().expanded.accomplishments).toBe(true);
		s.setOpen("changes", true);
		expect(useSummaryViewStore.getState().closed.changes).toBe(false);
		s.reset();
		expect(useSummaryViewStore.getState().closed).toEqual({});
		expect(useSummaryViewStore.getState().expanded).toEqual({});
	});
});
