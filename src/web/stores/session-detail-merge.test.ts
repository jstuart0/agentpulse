// ruby F95: the session detail page keeps its own `session` state (it
// carries detail-only fields), so live WebSocket updates that land in the
// session store are merged into it rather than waiting for the 10 s poll.
import { describe, expect, test } from "bun:test";
import type { Session } from "../../shared/types.js";
import { mergeSessionIntoDetail } from "./session-store.js";

const detail = {
	sessionId: "s1",
	displayName: "old-name",
	nameSource: "user",
	nativeName: "codex-title",
	claudeMdContent: "# detail-only",
} as unknown as Session;

describe("mergeSessionIntoDetail", () => {
	test("a store update for the same session wins on shared fields and keeps detail-only ones", () => {
		const incoming = {
			sessionId: "s1",
			displayName: "codex-title",
			nameSource: "native",
			nativeName: "codex-title",
		} as Session;
		const merged = mergeSessionIntoDetail(detail, incoming);
		expect(merged?.displayName).toBe("codex-title");
		expect(merged?.nameSource).toBe("native");
		expect((merged as unknown as { claudeMdContent: string }).claudeMdContent).toBe(
			"# detail-only",
		);
	});

	test("no store copy, or a different session → the detail state is unchanged", () => {
		expect(mergeSessionIntoDetail(detail, undefined)).toBe(detail);
		expect(mergeSessionIntoDetail(detail, { ...detail, sessionId: "s2" } as Session)).toBe(detail);
	});

	test("no detail yet → the store copy is used", () => {
		const incoming = { sessionId: "s1", displayName: "x" } as Session;
		expect(mergeSessionIntoDetail(null, incoming)).toBe(incoming);
	});
});
