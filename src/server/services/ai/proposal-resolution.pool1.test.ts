/**
 * With a pool of exactly one connection, a statement issued through `getDb()`
 * inside a transaction waits for a second connection and never gets it. Every
 * send path must therefore keep all of its statements on the transaction's own
 * handle. The Postgres pool size is fixed when the db client loads, so the check
 * runs in a child process with AGENTPULSE_PG_POOL_MAX=1 (the fixture), under a
 * deadline: a path that hangs fails here instead of stalling the run.
 */
import { describe, expect, test } from "bun:test";
import "./__test_db.js";
import { isPostgresTest } from "../../test-utils/backend.js";

const FIXTURE_PATH = new URL("./proposal-resolution.pool1.fixture.ts", import.meta.url).pathname;
const DEADLINE_MS = 20_000;

describe("the send paths on a pool of one connection", () => {
	test.skipIf(!isPostgresTest)(
		"a person's approve, an automatic dispatch, a refusal and the human queue each complete",
		async () => {
			const child = Bun.spawn([process.execPath, "run", FIXTURE_PATH], {
				env: { ...process.env, AGENTPULSE_PG_POOL_MAX: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const finished = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(DEADLINE_MS).then(() => false),
			]);
			if (!finished) child.kill();
			expect(finished, "a send path hung on the single connection").toBe(true);

			const stdout = await new Response(child.stdout).text();
			const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
			expect(JSON.parse(line?.slice("RESULT ".length) ?? "{}")).toEqual({
				humanApprove: true,
				autoDispatch: true,
				refusalCommits: true,
				humanQueue: true,
				// The pool really was one connection in the child.
				poolMax: 1,
			});
		},
		DEADLINE_MS + 7_000,
	);
});
