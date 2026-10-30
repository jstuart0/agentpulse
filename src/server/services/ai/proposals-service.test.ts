import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
	hasProposalForTurn,
	listProposalsForSession,
	ProposalAlreadyExistsError,
	proposalActivity,
	recordSuggestion,
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

	test("the prompt is stored trimmed, and the hash and approvable flag a client reads are the request's own", async () => {
		const withPrompt = await createPendingProposal({ sessionId: "s1", providerId: "prov" });
		await completeProposalAsHitl({
			id: withPrompt.id,
			decision: "continue",
			nextPrompt: "  go on  \n",
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
			promptSha256: hashPrompt("go on"),
			approvable: true,
		});
		const stored = await getProposal(withPrompt.id);
		expect(stored?.nextPrompt).toBe("go on");
		expect(stored?.approvable).toBe(true);
		expect(stored?.promptSha256).toBe(hashPrompt("go on"));
		expect(stored?.promptHash).toBe(stored?.promptSha256 ?? null);

		const without = await createPendingProposal({ sessionId: "s2", providerId: "prov" });
		await completeProposalAsHitl({
			id: without.id,
			decision: "ask",
			nextPrompt: "   ",
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
			promptSha256: hashPrompt(""),
			approvable: false,
		});
		const empty = await getProposal(without.id);
		expect(empty?.nextPrompt).toBeNull();
		expect(empty?.approvable).toBe(false);
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

describe("one proposal per turn", () => {
	test("a second proposal for the same (session, turn) throws; another turn or another session doesn't", async () => {
		await createPendingProposal({ sessionId: "s1", providerId: "p", turnKey: "p:1" });
		await expect(
			createPendingProposal({ sessionId: "s1", providerId: "p", turnKey: "p:1" }),
		).rejects.toBeInstanceOf(ProposalAlreadyExistsError);
		await createPendingProposal({ sessionId: "s1", providerId: "p", turnKey: "p:2" });
		await createPendingProposal({ sessionId: "s2", providerId: "p", turnKey: "p:1" });
		expect(await hasProposalForTurn("s1", "p:1")).toBe(true);
		expect(await hasProposalForTurn("s1", "p:3")).toBe(false);
	});

	test("proposals without a turn key are not limited", async () => {
		await createPendingProposal({ sessionId: "s1", providerId: "p" });
		await createPendingProposal({ sessionId: "s1", providerId: "p" });
		expect(await listProposalsForSession("s1")).toHaveLength(2);
	});

	test("the count and newest time for the flood limits come from the table", async () => {
		const now = Date.now();
		const iso = (ms: number) => new Date(now - ms).toISOString();
		for (const [i, age] of [30_000, 20 * 60_000, 90 * 60_000].entries()) {
			await getDb()
				.insert(watcherProposals)
				.values({
					sessionId: "s1",
					providerId: "p",
					state: "complete",
					turnKey: `p:age-${i}`,
					createdAt: iso(age),
					updatedAt: iso(age),
				});
		}
		const activity = await proposalActivity("s1", iso(60 * 60_000));
		expect(activity.inWindow).toBe(2);
		expect(activity.newestAt).toBeGreaterThan(now - 31_000);
		expect(activity.newestAt).toBeLessThan(now - 29_000);
		expect(await proposalActivity("s2", iso(60 * 60_000))).toEqual({ inWindow: 0, newestAt: null });
	});
});

describe("recordSuggestion", () => {
	test("the first text wins and a second call leaves it, with its kind", async () => {
		const p = await createPendingProposal({ sessionId: "s1", providerId: "p", turnKey: "p:9" });
		expect(
			await recordSuggestion({
				id: p.id,
				suggestedPrompt: "Run the tests",
				continueKind: "run_tests",
			}),
		).toBe(true);
		expect(
			await recordSuggestion({
				id: p.id,
				suggestedPrompt: "Delete everything",
				continueKind: "proceed",
			}),
		).toBe(false);
		expect(await getProposal(p.id)).toMatchObject({
			suggestedPrompt: "Run the tests",
			continueKind: "run_tests",
		});
	});

	test("completing a proposal records the suggestion through it, once", async () => {
		const p = await createPendingProposal({ sessionId: "s1", providerId: "p", turnKey: "p:10" });
		await completeProposalAsHitl({
			id: p.id,
			decision: "continue",
			nextPrompt: null,
			suggestedPrompt: "Run the tests",
			continueKind: "run_tests",
			tokensIn: 0,
			tokensOut: 0,
			costCents: 0,
		});
		await completeProposalAsHitl({
			id: p.id,
			decision: "continue",
			nextPrompt: null,
			suggestedPrompt: "Something else",
			tokensIn: 0,
			tokensOut: 0,
			costCents: 0,
		});
		expect((await getProposal(p.id))?.suggestedPrompt).toBe("Run the tests");
	});
});

describe("drift guard: suggested_prompt has one writer", () => {
	const SERVER = join(import.meta.dir, "../..");

	function sourceFiles(dir: string, out: string[] = []): string[] {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name === "test-utils" || name === "node_modules") continue;
				sourceFiles(full, out);
			} else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
				out.push(full);
			}
		}
		return out;
	}

	/** A `.set({ ... suggestedPrompt ... })` or `.values({ ... suggestedPrompt ... })` write. */
	const WRITE_RE = /\.(?:set|values)\(\s*\{[^}]*\bsuggestedPrompt\b/s;

	test("exactly one non-test file writes it, and it is this service", () => {
		const files = sourceFiles(SERVER);
		expect(files.length).toBeGreaterThan(100);
		const writers = files
			.filter((f) => WRITE_RE.test(readFileSync(f, "utf8")))
			.map((f) => f.slice(SERVER.length + 1));
		expect(writers).toEqual(["services/ai/proposals-service.ts"]);
	});

	test("planted negative: the pattern does catch another writer", () => {
		expect(WRITE_RE.test("db.update(t).set({ suggestedPrompt: x, updatedAt: y })")).toBe(true);
		expect(WRITE_RE.test("const a = row.suggestedPrompt;")).toBe(false);
	});
});
