/**
 * percy AGEN-27 review (TB22, High): GET /api/v1/health's `searchIndexes`
 * must not count an INVALID index as present — Postgres will never
 * actually use one (e.g. a CONCURRENTLY build that failed partway
 * through, or a build this migration's own `IF NOT EXISTS` skips fixing).
 *
 * Gated by AGENTPULSE_TEST_BACKEND=postgres — needs a real Postgres
 * connection.
 */

import { afterAll, expect, test } from "bun:test";
import postgres from "postgres";
import { config } from "../../config.js";
import { describePostgresOnly } from "../../test-utils/backend.js";

describePostgresOnly("refreshSearchIndexStatus — INVALID indexes (percy TB22 High)", () => {
	const cleanupConnections: Array<{ end: () => Promise<void> }> = [];
	afterAll(async () => {
		for (const conn of cleanupConnections) await conn.end();
	});

	test("an INVALID index does not count as present", async () => {
		// A dedicated scratch DATABASE — this test needs to make a real
		// trigram-index-named index INVALID, which would be destructive if
		// done against the shared agentpulse_test database's real indexes.
		const admin = postgres(config.databaseUrl, { max: 1 });
		cleanupConnections.push(admin);
		const scratchDbName = `agen27_scratch_${Math.random().toString(36).slice(2, 10)}`;
		await admin.unsafe(`CREATE DATABASE "${scratchDbName}"`);

		const scratchUrl = new URL(config.databaseUrl);
		scratchUrl.pathname = `/${scratchDbName}`;
		const scratchClient = postgres(scratchUrl.toString(), { max: 1 });
		cleanupConnections.push(scratchClient);

		try {
			await scratchClient.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
			await scratchClient.unsafe(
				"CREATE TABLE sessions (session_id text primary key, display_name text)",
			);
			await scratchClient.unsafe(
				"CREATE INDEX idx_sessions_display_name_trgm ON sessions USING gin (display_name gin_trgm_ops)",
			);

			// Simulate the real-world failure mode (a CONCURRENTLY build that
			// died partway through) by directly marking the index invalid,
			// rather than actually racing a CONCURRENTLY build against
			// pg_terminate_backend — same end state (indisvalid = false),
			// deterministic, and fast.
			await scratchClient.unsafe(
				"UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_sessions_display_name_trgm'::regclass",
			);

			const stillListedInPgIndexes = await scratchClient.unsafe(
				"SELECT 1 FROM pg_indexes WHERE indexname = 'idx_sessions_display_name_trgm'",
			);
			expect(stillListedInPgIndexes.length).toBe(1);

			const { drizzle } = await import("drizzle-orm/postgres-js");
			const schema = await import("../../db/schema/index.js");
			const { refreshSearchIndexStatus } = await import("./search-index-status.js");
			const scratchDb = drizzle(scratchClient, { schema });

			const status = await refreshSearchIndexStatus(
				scratchDb as unknown as import("../../db/client.js").Db,
			);

			expect(status.present).toBe(false);
			expect(status.missing).toContain("idx_sessions_display_name_trgm");
		} finally {
			await scratchClient.end();
			cleanupConnections.splice(cleanupConnections.indexOf(scratchClient), 1);
			await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
		}
	});

	test("a VALID index of the same name counts as present (control)", async () => {
		const admin = postgres(config.databaseUrl, { max: 1 });
		cleanupConnections.push(admin);
		const scratchDbName = `agen27_scratch_${Math.random().toString(36).slice(2, 10)}`;
		await admin.unsafe(`CREATE DATABASE "${scratchDbName}"`);

		const scratchUrl = new URL(config.databaseUrl);
		scratchUrl.pathname = `/${scratchDbName}`;
		const scratchClient = postgres(scratchUrl.toString(), { max: 1 });
		cleanupConnections.push(scratchClient);

		try {
			await scratchClient.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
			await scratchClient.unsafe(
				"CREATE TABLE sessions (session_id text primary key, display_name text)",
			);
			await scratchClient.unsafe(
				"CREATE INDEX idx_sessions_display_name_trgm ON sessions USING gin (display_name gin_trgm_ops)",
			);

			const { drizzle } = await import("drizzle-orm/postgres-js");
			const schema = await import("../../db/schema/index.js");
			const { refreshSearchIndexStatus } = await import("./search-index-status.js");
			const scratchDb = drizzle(scratchClient, { schema });

			const status = await refreshSearchIndexStatus(
				scratchDb as unknown as import("../../db/client.js").Db,
			);

			expect(status.missing).not.toContain("idx_sessions_display_name_trgm");
		} finally {
			await scratchClient.end();
			cleanupConnections.splice(cleanupConnections.indexOf(scratchClient), 1);
			await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
		}
	});
});
