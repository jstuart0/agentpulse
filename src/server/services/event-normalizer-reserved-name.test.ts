import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { normalizeHookEvent } from "./event-normalizer.js";

describe("reserved event names are refused without scanning the name (AGEN-146)", () => {
	let warn: ReturnType<typeof spyOn> | undefined;
	afterEach(() => warn?.mockRestore());

	test("a 16 MiB Ai… name is refused quickly and logs no part of it", () => {
		warn = spyOn(console, "warn").mockImplementation(() => {});
		const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
		const name = `Ai${secret}${"x".repeat(16 * 1024 * 1024)}`;
		const started = performance.now();
		const out = normalizeHookEvent(
			{ session_id: "s-1", hook_event_name: name } as never,
			"claude_code",
		);
		const ms = performance.now() - started;
		expect(out).toEqual([]);
		expect(ms).toBeLessThan(100);
		const line = String(warn.mock.calls[0]?.[0] ?? "");
		expect(line).toContain('"family":"server_only"');
		expect(line).not.toContain("ghp_");
		expect(line).not.toContain("namePrefix");
	});

	test("a Headless… name logs the supervisor-only family", () => {
		warn = spyOn(console, "warn").mockImplementation(() => {});
		expect(
			normalizeHookEvent(
				{ session_id: "s-2", hook_event_name: "HeadlessPromptFailed" } as never,
				"claude_code",
			),
		).toEqual([]);
		expect(String(warn.mock.calls[0]?.[0])).toContain('"family":"supervisor_only"');
	});
});
