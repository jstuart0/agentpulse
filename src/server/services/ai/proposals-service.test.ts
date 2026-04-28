import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { aiHitlRequests, sessions, watcherProposals } = await import("../../db/schema.js");
const {
	cancelOpenHitl,
	completeProposalAsHitl,
	createPendingProposal,
	getOpenHitlProposal,
	getProposal,
	listProposalsForSession,
	resolveProposalHitl,
} = await import("./proposals-service.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(aiHitlRequests).execute();
	await db.delete(watcherProposals).execute();
	await db.delete(sessions).execute();
	// Slice DB-1: cascade FKs require parent sessions for every child row.
	for (const id of ["s1", "s2"]) {
		await db
			.insert(sessions)
			.values({ sessionId: id, agentType: "claude_code" })
			.onConflictDoNothing();
	}
});

describe("proposals-service HITL overlay", () => {
	test("completeProposalAsHitl stores proposal.state=complete but overlays as hitl_waiting", async () => {
		const p = await createPendingProposal({
			sessionId: "s1",
			providerId: "prov",
		});
		await completeProposalAsHitl({
			id: p.id,
			decision: "continue",
			nextPrompt: "go",
			tokensIn: 10,
			tokensOut: 5,
			costCents: 1,
		});
		// Derived state exposes hitl_waiting via overlay even though the
		// physical watcher_proposals.state is "complete" after Phase 1.
		const row = await getProposal(p.id);
		expect(row?.state).toBe("hitl_waiting");

		const open = await getOpenHitlProposal("s1");
		expect(open?.id).toBe(p.id);
	});

	test("resolveProposalHitl marks applied and flips derived state", async () => {
		const p = await createPendingProposal({
			sessionId: "s1",
			providerId: "prov",
		});
		await completeProposalAsHitl({
			id: p.id,
			decision: "ask",
			nextPrompt: null,
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
		});
		const resolved = await resolveProposalHitl({
			proposalId: p.id,
			action: "approve",
			replyText: "ok",
		});
		expect(resolved?.state).toBe("hitl_applied");
	});

	test("cancelOpenHitl supersedes active hitl rows", async () => {
		const p = await createPendingProposal({
			sessionId: "s1",
			providerId: "prov",
		});
		await completeProposalAsHitl({
			id: p.id,
			decision: "continue",
			nextPrompt: "go",
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
		});
		const count = await cancelOpenHitl("s1", "manual");
		expect(count).toBe(1);
		const open = await getOpenHitlProposal("s1");
		expect(open).toBeNull();
	});

	test("listProposalsForSession overlays derived state", async () => {
		const p1 = await createPendingProposal({
			sessionId: "s2",
			providerId: "prov",
		});
		await completeProposalAsHitl({
			id: p1.id,
			decision: "continue",
			nextPrompt: "next",
			tokensIn: 0,
			tokensOut: 0,
			costCents: 0,
		});
		const p2 = await createPendingProposal({
			sessionId: "s2",
			providerId: "prov",
		});
		await completeProposalAsHitl({
			id: p2.id,
			decision: "ask",
			nextPrompt: null,
			tokensIn: 0,
			tokensOut: 0,
			costCents: 0,
		});
		await resolveProposalHitl({ proposalId: p2.id, action: "decline" });

		const list = await listProposalsForSession("s2");
		const byId = new Map(list.map((l) => [l.id, l.state]));
		// p1 superseded by p2 opening → still "complete" physically, but
		// overlay follows the (superseded) hitl row's status which does not
		// flip it.
		expect(byId.get(p1.id)).toBe("complete");
		expect(byId.get(p2.id)).toBe("hitl_declined");
	});
});
