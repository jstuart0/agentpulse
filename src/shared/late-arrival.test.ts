import { expect, test } from "bun:test";
import { LATE_ARRIVAL_MS } from "./late-arrival.js";

test("a report is late after exactly one minute", () => {
	expect(LATE_ARRIVAL_MS).toBe(60_000);
});
