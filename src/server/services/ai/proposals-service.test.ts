import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { aiHitlRequests, sessions, watcherProposals } = await import("../../db/schema/index.js");
const {
	cancelOpenHitl,
	completeProposalAsHitl,
	createPendingProposal,
	getOpenHitlProposal,
	getProposal,
	listProposalsForSession,
} = await import("./proposals-service.js");
const { hashPrompt } = await import("./prompt-hash.js");

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(aiHitlRequests).execute();
	await getDb().delete(watcherProposals).execute();
	await getDb().delete(sessions).execute();
	// Slice DB-1: cascade FKs require parent sessions for every child row.
	for (const id of ["s1", "s2"]) {
		await getDb()
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

	test("a proposal's hash and approvable flag follow its trimmed prompt", async () => {
		const withPrompt = await createPendingProposal({ sessionId: "s1", providerId: "prov" });
		await completeProposalAsHitl({
			id: withPrompt.id,
			decision: "continue",
			nextPrompt: "  go on  \n",
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
		});
		const stored = await getProposal(withPrompt.id);
		expect(stored?.nextPrompt).toBe("go on");
		expect(stored?.approvable).toBe(true);
		expect(stored?.promptHash).toBe(hashPrompt("go on"));

		const without = await createPendingProposal({ sessionId: "s2", providerId: "prov" });
		await completeProposalAsHitl({
			id: without.id,
			decision: "ask",
			nextPrompt: "   ",
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
		});
		const empty = await getProposal(without.id);
		expect(empty?.nextPrompt).toBeNull();
		expect(empty?.approvable).toBe(false);
		expect(empty?.promptHash).toBeNull();
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
		await getDb()
			.update(aiHitlRequests)
			.set({ status: "declined" })
			.where(eq(aiHitlRequests.proposalId, p2.id));

		const list = await listProposalsForSession("s2");
		const byId = new Map(list.map((l) => [l.id, l.state]));
		// p1 superseded by p2 opening → still "complete" physically, but
		// overlay follows the (superseded) hitl row's status which does not
		// flip it.
		expect(byId.get(p1.id)).toBe("complete");
		expect(byId.get(p2.id)).toBe("hitl_declined");
	});
});
