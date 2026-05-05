// P8 — A-M6: applySessionUpdateToList reducer shared by WS delta events and
// the polling add/patch path.
//
// M2 (patch-2) clarification: the bulk polling response in useSessions.ts
// deliberately uses setSessions (full array replace), NOT applySessionUpdateToList.
// That is intentional: polling is the authoritative source for the full session
// list, so stale local sessions that no longer appear server-side should be
// evicted. applySessionUpdateToList is used by the WS path (session_created /
// session_updated events) and is available for any future polling code that
// needs upsert semantics on individual sessions without losing others.
// The test below verifies the reducer contract, not end-to-end path unification.
import { describe, expect, test } from "bun:test";
import type { Session } from "../../shared/types.js";
import { applySessionUpdateToList } from "./session-store.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: "s-1",
		sessionId: "sess-1",
		displayName: "brave-falcon",
		agentType: "claude_code",
		status: "active",
		cwd: "/tmp",
		transcriptPath: null,
		model: "claude-sonnet-4-6",
		startedAt: new Date().toISOString(),
		lastActivityAt: new Date().toISOString(),
		endedAt: null,
		semanticStatus: null,
		currentTask: null,
		planSummary: [],
		totalToolUses: 0,
		isWorking: false,
		isPinned: false,
		gitBranch: null,
		claudeMdContent: null,
		claudeMdPath: null,
		claudeMdUpdatedAt: null,
		notes: null,
		metadata: {},
		projectId: null,
		isArchived: false,
		...overrides,
	};
}

describe("A-M6 — applySessionUpdateToList reducer", () => {
	test("prepends a new session when not found", () => {
		const existing = makeSession({ sessionId: "a", id: "a" });
		const incoming = makeSession({ sessionId: "b", id: "b" });
		const result = applySessionUpdateToList([existing], incoming);
		expect(result[0].sessionId).toBe("b");
		expect(result[1].sessionId).toBe("a");
	});

	test("replaces an existing session in-place", () => {
		const v1 = makeSession({ sessionId: "x", displayName: "old" });
		const v2 = makeSession({ sessionId: "x", displayName: "new" });
		const result = applySessionUpdateToList([v1], v2);
		expect(result.length).toBe(1);
		expect(result[0].displayName).toBe("new");
	});

	test("preserves ordering when replacing", () => {
		const a = makeSession({ sessionId: "a", id: "a" });
		const b = makeSession({ sessionId: "b", id: "b" });
		const c = makeSession({ sessionId: "c", id: "c" });
		const bUpdated = makeSession({ sessionId: "b", id: "b", displayName: "updated" });
		const result = applySessionUpdateToList([a, b, c], bUpdated);
		expect(result.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
		expect(result[1].displayName).toBe("updated");
	});

	test("empty list — adds the session", () => {
		const s = makeSession();
		const result = applySessionUpdateToList([], s);
		expect(result.length).toBe(1);
		expect(result[0].sessionId).toBe("sess-1");
	});

	test("WS delta path uses applySessionUpdateToList for add-or-replace semantics", () => {
		// The WS path (session_created / session_updated) calls applySessionUpdateToList
		// so that new sessions are prepended and existing ones are patched in-place.
		// This differs from the polling path, which calls setSessions (full replace)
		// to ensure stale local sessions that disappeared server-side are evicted.
		const initial: Session[] = [];
		const incoming = makeSession({ sessionId: "ws-1", displayName: "ws-session" });

		// WS path: add
		const afterAdd = applySessionUpdateToList(initial, incoming);
		expect(afterAdd).toHaveLength(1);
		expect(afterAdd[0].sessionId).toBe("ws-1");

		// WS path: patch in-place
		const updated = makeSession({ sessionId: "ws-1", displayName: "updated" });
		const afterPatch = applySessionUpdateToList(afterAdd, updated);
		expect(afterPatch).toHaveLength(1);
		expect(afterPatch[0].displayName).toBe("updated");
	});
});
