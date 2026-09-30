import { beforeAll, describe, expect, test } from "bun:test";
/**
 * Phase 2 (D3, F20): GET /health gains an additive `clients: {relay,
 * statusline}` field — each a computeChecksum(content, {trimEnd:true})
 * over the actual repo files, so a relay/statusline install can detect
 * drift against the running server. Lenient when the files are missing
 * (e.g. a container image that doesn't ship scripts/).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../services/ai/__test_db.js";
import { isPostgresTest } from "../test-utils/backend.js";

const { initializeDatabase } = await import("../db/client.js");
const { health, markDbReady, computeClientChecksums } = await import("./health.js");
const { computeChecksum } = await import("../util/checksum.js");
import { Hono } from "hono";

function buildApp() {
	const app = new Hono();
	app.route("/api/v1", health);
	return app;
}

beforeAll(async () => {
	await initializeDatabase();
	markDbReady();
});

describe("GET /health — clients checksums", () => {
	test("clients.relay equals an independently computed checksum of the real scripts/relay.ts, 16 hex chars", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/health");
		expect(res.status).toBe(200);
		const body = await res.json();

		const relayPath = join(import.meta.dir, "../../../scripts/relay.ts");
		const relayContent = readFileSync(relayPath, "utf-8");
		const expected = await computeChecksum(relayContent, { trimEnd: true });

		expect(body.clients.relay).toBe(expected);
		expect(body.clients.relay).toMatch(/^[0-9a-f]{16}$/);
	});

	test("clients.statusline equals an independently computed checksum of the real scripts/statusline.sh", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/health");
		const body = await res.json();

		const statuslinePath = join(import.meta.dir, "../../../scripts/statusline.sh");
		const statuslineContent = readFileSync(statuslinePath, "utf-8");
		const expected = await computeChecksum(statuslineContent, { trimEnd: true });

		expect(body.clients.statusline).toBe(expected);
	});

	test("the route's checksum and computeChecksum agree by construction (refactor-drift guard)", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/health");
		const body = await res.json();
		const relayPath = join(import.meta.dir, "../../../scripts/relay.ts");
		const relayContent = readFileSync(relayPath, "utf-8");
		expect(body.clients.relay).toBe(await computeChecksum(relayContent, { trimEnd: true }));
	});

	test("response still 200 and status ok regardless of the clients field", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	// F165: the checksums come from the installer sources embedded at build
	// time, the same strings /setup-relay.sh splices in, so there's no file to
	// be missing and the served relay can't drift from what /health reports.
	test("clients hash the embedded installer sources", async () => {
		const { INSTALLER_SOURCES } = await import("../installers.js");
		const clients = await computeClientChecksums();
		expect(clients).toEqual({
			relay: await computeChecksum(INSTALLER_SOURCES.relay, { trimEnd: true }),
			statusline: await computeChecksum(INSTALLER_SOURCES.statusline, { trimEnd: true }),
		});
	});

	// percy AGEN-27 review (TB17 item 3): searchIndexes surfaces Postgres
	// trigram search-index presence, checked once at boot.
	test("searchIndexes is null on SQLite, or { present, missing[] } on Postgres (checked at boot)", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/health");
		const body = await res.json();

		if (isPostgresTest) {
			expect(body.searchIndexes).toBeDefined();
			expect(typeof body.searchIndexes.present).toBe("boolean");
			expect(Array.isArray(body.searchIndexes.missing)).toBe(true);
			// This test's own beforeAll already ran initializeDatabase(), which
			// migration 0006 + refreshSearchIndexStatus() both go through — a
			// real (indexes present) install, so missing should be empty.
			expect(body.searchIndexes.present).toBe(true);
			expect(body.searchIndexes.missing).toEqual([]);
		} else {
			expect(body.searchIndexes).toBeNull();
		}
	});
});
