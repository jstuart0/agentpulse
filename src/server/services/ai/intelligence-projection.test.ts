// R11b (AGEN-16 Phase 2, Decision 15): the classifier's bulk read path
// (loadRecentEventsBySession, projected columns) must classify identically
// to the single-session path (loadRecentEvents, full rows). A projected-away
// field the classifier actually reads would make this test fail without
// ever touching loadRecentEventsBySession's own column list directly.

import { beforeAll, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { getDb } = await import("../../db/client.js");
const { initializeDatabase } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema/index.js");
const { intelligenceForSession, intelligenceForSessions } = await import(
	"./intelligence-service.js"
);
const { completeProposalAsHitl, createPendingProposal } = await import("./proposals-service.js");

beforeAll(() => initializeDatabase());

function uid(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: "2026-04-20 00:25:00",
			...overrides,
		})
		.execute();
}

async function mkEvent(
	sessionId: string,
	overrides: Record<string, unknown> = {},
	createdAt = "2026-04-20 00:20:00",
) {
	await getDb()
		.insert(events)
		.values({
			sessionId,
			eventType: "Evt",
			category: "tool_event",
			source: "observed_hook",
			content: null,
			isNoise: false,
			rawPayload: {},
			createdAt,
			...overrides,
		})
		.execute();
}

describe("intelligenceForSessions projection parity (R11b)", () => {
	test("bulk classification deep-equals per-session classification across varied rows", async () => {
		const now = new Date("2026-04-20T00:30:00Z");

		// A: failures reported via a PostToolUseFailure row.
		const a = uid("proj-a");
		await mkSession(a);
		for (let k = 0; k < 4; k++) {
			await mkEvent(
				a,
				{
					eventType: "PostToolUseFailure",
					toolName: "Bash",
					toolResponse: "Command failed with exit 1",
				},
				`2026-04-20 00:1${k}:00`,
			);
		}

		// B: failures reported via toolResponse text on an ordinary PostToolUse.
		const b = uid("proj-b");
		await mkSession(b);
		for (let k = 0; k < 4; k++) {
			await mkEvent(
				b,
				{
					eventType: "PostToolUse",
					toolName: "Bash",
					toolResponse: "non-zero exit: 1",
				},
				`2026-04-20 00:1${k}:00`,
			);
		}

		// C: noise tool events — should not count toward failures/activity.
		const c = uid("proj-c");
		await mkSession(c);
		for (let k = 0; k < 3; k++) {
			await mkEvent(
				c,
				{
					eventType: "PostToolUse",
					toolName: "Read",
					isNoise: true,
					toolResponse: "ok",
				},
				`2026-04-20 00:0${k}:00`,
			);
		}
		await mkEvent(
			c,
			{ category: "assistant_message", content: "still working" },
			"2026-04-20 00:22:00",
		);

		// D: status rows, an open HITL, and a stale last activity.
		const d = uid("proj-d");
		await mkSession(d, { lastActivityAt: "2026-04-19 12:00:00" });
		await mkEvent(
			d,
			{ eventType: "StatusUpdate", category: "status", content: "waiting" },
			"2026-04-20 00:05:00",
		);
		const proposal = await createPendingProposal({ sessionId: d, providerId: "prov" });
		await completeProposalAsHitl({
			id: proposal.id,
			decision: "continue",
			nextPrompt: "go",
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
		});

		const ids = [a, b, c, d];
		const bulk = await intelligenceForSessions(ids, now);

		// Sanity first: every session actually resolved on both paths (neither
		// side silently skipped one), otherwise a trivial two-empty-maps
		// equality would pass without exercising the projection at all.
		expect(bulk.size).toBe(ids.length);
		for (const id of ids) expect(bulk.get(id)).not.toBeNull();

		const expected = new Map(
			await Promise.all(
				ids.map(async (id) => {
					const single = await intelligenceForSession(id, now);
					expect(single, id).not.toBeNull();
					return [id, single as NonNullable<typeof single>] as const;
				}),
			),
		);

		expect(bulk).toEqual(expected);
	});
});
