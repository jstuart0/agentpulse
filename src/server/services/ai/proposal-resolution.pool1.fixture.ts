/**
 * Child-process fixture for proposal-resolution.pool1.test.ts. The Postgres
 * pool size is fixed when the db client module loads, so the check runs in its
 * own process with AGENTPULSE_PG_POOL_MAX=1.
 *
 * With a pool of one, a statement issued through the pool while a transaction
 * holds the only connection waits forever. This runs the send paths (a person's
 * approve, an automatic dispatch, a refusal, the two human queue functions) and
 * prints one "RESULT {json}" line naming what completed. A path that hangs keeps
 * the process alive, and the test's deadline kills it and fails.
 */
import { sha256 } from "../../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { config } = await import("../../config.js");
const watcher = await import("../../test-utils/watcher-fixtures.js");
const schema = await import("../../db/schema/index.js");
const feature = await import("./feature.js");
const { AI_ACTOR, dispatchPrompt, resolveProposal } = await import("./proposal-resolution.js");
const { queuePromptAction, queueStopAction } = await import("../control-actions.js");

await initializeDatabase();
(config as Record<string, unknown>).disableAuth = true;
await watcher.enableAiRuntime();
await watcher.setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
const providerId = await watcher.seedProvider();
const PROMPT = "Run the failing test and fix it";
const USER = { userId: null, label: "user" } as const;

let n = 0;
async function world(managed = true) {
	n += 1;
	const sessionId = `p1-${n}-${crypto.randomUUID().slice(0, 6)}`;
	if (managed) await watcher.seedLiveManagedSession(sessionId);
	else await watcher.seedSession(sessionId);
	const turn = await watcher.seedFinishedTurn(sessionId);
	const ids = await watcher.seedProposalWithHitl({
		sessionId,
		providerId,
		prompt: PROMPT,
		turnKey: turn.turnKey,
		triggerEventId: turn.stopId,
	});
	return { sessionId, ...turn, ...ids };
}

const result: Record<string, unknown> = {};

const approve = await world();
result.humanApprove = (
	await resolveProposal({
		hitlId: approve.hitlId,
		action: "approve",
		promptSha256: sha256(PROMPT),
		actor: USER,
		actorKind: "user",
	})
).ok;

const auto = await world();
await watcher.seedAutoConfig({ sessionId: auto.sessionId, providerId });
result.autoDispatch = (
	await dispatchPrompt(auto.sessionId, { kind: "auto", continueKind: "run_tests" }, AI_ACTOR, {
		actorKind: "auto",
		proposalId: auto.proposalId,
		triggerEventId: auto.stopId,
		turnKey: auto.turnKey,
	})
).ok;

const observed = await world(false);
const refused = await resolveProposal({
	hitlId: observed.hitlId,
	action: "approve",
	promptSha256: sha256(PROMPT),
	actor: USER,
	actorKind: "user",
});
result.refusalCommits = !refused.ok && refused.code === "prompt_not_deliverable";

const queued = await world();
await queuePromptAction(queued.sessionId, "Look at the failing test", USER);
const stopped = await world();
await queueStopAction(stopped.sessionId, USER);
result.humanQueue = true;

result.poolMax = process.env.AGENTPULSE_PG_POOL_MAX;
console.log(`RESULT ${JSON.stringify(result)}`);

for (const table of [
	schema.aiHitlRequests,
	schema.watcherProposals,
	schema.watcherConfigs,
	schema.controlActions,
	schema.managedSessions,
	schema.launchRequests,
	schema.events,
	schema.sessions,
	schema.supervisors,
]) {
	await getDb().delete(table);
}
process.exit(0);
