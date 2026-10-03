/**
 * A session hit says whose session it is, derived the way the session DTO
 * derives it (a user, a service key, or nobody; never the key's id), so the
 * Search page can show an owner. Runs against whichever backend the test run
 * uses.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../../db/__test_db.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import { seedKey, seedLocalUser } from "../../test-utils/team-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema/index.js");
const { getSearchBackend } = await import("./index.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
	await resetIdentityState();
});

async function insertSession(
	sessionId: string,
	displayName: string,
	owner: { ownerUserId?: string; ingestKeyId?: string },
) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: "claude_code",
			displayName,
			status: "active",
			isWorking: false,
			lastActivityAt: now,
			startedAt: now,
			...owner,
		})
		.execute();
}

describe("search hits for sessions carry the owner", () => {
	test("a user's session, a service key's session and an unowned one each say so, and never the key id", async () => {
		const user = await seedLocalUser("hit-owner");
		const key = await seedKey("hit-service", ["ingest"]);
		await insertSession("hit-user", "owlpine-user", { ownerUserId: user.id });
		await insertSession("hit-service", "owlpine-service", { ingestKeyId: key.id });
		await insertSession("hit-nobody", "owlpine-nobody", {});

		const { hits } = await getSearchBackend().search({ q: "owlpine", kinds: ["session"] });
		const bySession = new Map(hits.map((hit) => [hit.sessionId, hit]));

		expect(bySession.get("hit-user")).toMatchObject({ ownerUserId: user.id, ownerKind: "user" });
		expect(bySession.get("hit-service")).toMatchObject({ ownerUserId: null, ownerKind: "service" });
		expect(bySession.get("hit-nobody")).toMatchObject({
			ownerUserId: null,
			ownerKind: "unassigned",
		});
		expect(JSON.stringify(hits)).not.toContain(key.id);
	});
});
