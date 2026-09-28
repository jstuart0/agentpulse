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

	// F83 (tessa mid-build): the "missing file -> clients absent" branch,
	// disclosed as untested in the Phase 2 red commit. computeClientChecksums
	// takes an injectable reader, so this exercises the real omission logic
	// without mocking node:fs globally (which risked destabilizing unrelated
	// tests sharing this process).
	test("a missing file's key is omitted, and the function never rejects (so the route can never fail because of it)", async () => {
		const relayPath = join(import.meta.dir, "../../../scripts/relay.ts");
		const statuslinePath = join(import.meta.dir, "../../../scripts/statusline.sh");
		const fakeReader = async (path: string) => {
			if (path === relayPath) throw new Error("ENOENT: no such file");
			if (path === statuslinePath) return "#!/bin/sh\necho ok\n";
			throw new Error(`unexpected path: ${path}`);
		};

		const clients = await computeClientChecksums(fakeReader);

		expect("relay" in clients).toBe(false);
		expect(typeof clients.statusline).toBe("string");
		expect(clients.statusline).toMatch(/^[0-9a-f]{16}$/);
	});
});
