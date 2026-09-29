import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";
import { itSqliteOnly } from "../../test-utils/backend.js";

const { getDb } = await import("../../db/client.js");
const { initializeDatabase } = await import("../../db/client.js");
const { aiHitlRequests, events, managedSessions, sessions, supervisors, watcherProposals } =
	await import("../../db/schema/index.js");
const { intelligenceForSession, intelligenceForSessions } = await import(
	"./intelligence-service.js"
);
const { completeProposalAsHitl, createPendingProposal } = await import("./proposals-service.js");

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(aiHitlRequests).execute();
	await getDb().delete(watcherProposals).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(supervisors).execute();
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: `n-${sessionId}`,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: "2026-04-20 00:00:00",
			...overrides,
		})
		.execute();
}

async function mkEvent(
	sessionId: string,
	overrides: Record<string, unknown> = {},
	createdAt = "2026-04-20 00:00:00",
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

async function mkSupervisor(id: string, status: "connected" | "disconnected") {
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `h-${id}`,
			platform: "darwin",
			arch: "arm64",
			version: "0.0.0-test",
			status,
		})
		.execute();
}

async function mkManaged(sessionId: string, supervisorId: string) {
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: `lr-${sessionId}`,
			supervisorId,
			managedState: "managed",
		})
		.execute();
}

describe("intelligence-service.intelligenceForSessions", () => {
	test("bulk results match per-session results across mixed scenarios", async () => {
		// Build a 50-session corpus mixing healthy / stuck / blocked / managed.
		const ids: string[] = [];
		for (let i = 0; i < 50; i++) {
			const id = `s-${i}`;
			ids.push(id);
			const isWorking = i % 7 === 0;
			await mkSession(id, {
				isWorking,
				planSummary: i % 5 === 0 ? "draft plan" : null,
				lastActivityAt: "2026-04-20 00:25:00",
			});

			// Sprinkle tool failures into ~1/3 of sessions to trigger "stuck".
			if (i % 3 === 0) {
				for (let k = 0; k < 4; k++) {
					await mkEvent(
						id,
						{
							toolName: "Bash",
							toolResponse: "non-zero exit: error",
							category: "tool_event",
						},
						`2026-04-20 00:1${k}:00`,
					);
				}
			} else {
				// A few benign events; ensure ordering / categories sane.
				for (let k = 0; k < 3; k++) {
					await mkEvent(
						id,
						{
							category: "assistant_message",
							content: `progress ${k}`,
						},
						`2026-04-20 00:0${k}:00`,
					);
				}
			}
		}

		// Connected supervisor on s-1, disconnected on s-2 → blocked.
		await mkSupervisor("sup-on", "connected");
		await mkSupervisor("sup-off", "disconnected");
		await mkManaged("s-1", "sup-on");
		await mkManaged("s-2", "sup-off");

		// Open HITL on s-3 (a "blocked" candidate if old enough).
		const proposal = await createPendingProposal({
			sessionId: "s-3",
			providerId: "prov",
		});
		await completeProposalAsHitl({
			id: proposal.id,
			decision: "continue",
			nextPrompt: "go",
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
		});

		const now = new Date("2026-04-20T00:30:00Z");
		const bulk = await intelligenceForSessions(ids, now);

		// Compare against per-session for parity.
		for (const id of ids) {
			const single = await intelligenceForSession(id, now);
			const fromBulk = bulk.get(id);
			expect(fromBulk).toBeDefined();
			expect(single).not.toBeNull();
			expect(fromBulk).toEqual(single as NonNullable<typeof single>);
		}
		expect(bulk.size).toBe(50);
	});

	// Decision 15 (F53/F75): Postgres runs the events fetch as one LATERAL
	// query (still O(1) queries regardless of input size); SQLite runs a
	// projected per-session loop instead (synchronous, no pool to starve —
	// O(1) queries would otherwise need the ROW_NUMBER window-function query
	// this replaced, which is what the old assertion here pinned).
	itSqliteOnly(
		"SQLite bulk path issues one projected select per session for events (D15)",
		async () => {
			const ids: string[] = [];
			for (let i = 0; i < 200; i++) {
				const id = `bulk-${i}`;
				ids.push(id);
				await mkSession(id, { lastActivityAt: "2026-04-20 00:25:00" });
				await mkEvent(id, { category: "assistant_message", content: "hello" });
			}

			const dbInstance = getDb();
			const origDbSelect = dbInstance.select.bind(dbInstance) as typeof dbInstance.select;
			let dbSelectCalls = 0;
			(dbInstance as unknown as { select: typeof dbInstance.select }).select = ((
				...args: unknown[]
			) => {
				dbSelectCalls++;
				// biome-ignore lint/suspicious/noExplicitAny: spy passthrough
				return (origDbSelect as any)(...args);
			}) as typeof dbInstance.select;

			try {
				const bulk = await intelligenceForSessions(ids, new Date("2026-04-20T00:30:00Z"));
				expect(bulk.size).toBe(200);
				// sessions inArray + managedSessions left-join + listOpenHitlForSessions
				// (3), plus one projected select per session for events (200).
				expect(dbSelectCalls).toBeGreaterThanOrEqual(200);
			} finally {
				(dbInstance as unknown as { select: typeof dbInstance.select }).select = origDbSelect;
			}
		},
	);

	test("returns empty map for empty input without touching the db", async () => {
		const out = await intelligenceForSessions([], new Date());
		expect(out.size).toBe(0);
	});

	test("skips ids that don't resolve to a session row", async () => {
		await mkSession("real");
		const out = await intelligenceForSessions(["real", "ghost"]);
		expect(out.has("real")).toBe(true);
		expect(out.has("ghost")).toBe(false);
	});
});
