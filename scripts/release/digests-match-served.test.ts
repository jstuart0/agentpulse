/**
 * The manifest's client digests must be the digests of the bytes a server really serves. The builder
 * reads a tag's git objects; a relay compares what its server's GET /setup-relay.sh hands it. If those
 * two ever disagree, every relay refuses every update, so they are held equal here: a manifest built
 * from a tag cut from the current tree against the in-process server's served installer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { materializeExcludeScript } from "../../src/shared/hook-command.ts";
import {
	clientDigests,
	extractRelayInstallerParts,
} from "../../src/shared/relay-installer-parts.ts";
import "../../src/server/db/__test_db.js";
import { buildManifest } from "./build-manifest.ts";
import { createFixtureRepo } from "./fixture-repo.ts";

const { setup } = await import("../../src/server/routes/setup.js");
const { config } = await import("../../src/server/config.js");
const { computeClientChecksums } = await import("../../src/server/routes/health.js");

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");
const saved = { url: config.publicUrl, explicit: config.publicUrlExplicit };
const repo = createFixtureRepo();
afterAll(() => {
	config.publicUrl = saved.url;
	config.publicUrlExplicit = saved.explicit;
	rmSync(repo.dir, { recursive: true, force: true });
});

describe("digests in the manifest equal the digests of the served bytes", () => {
	test("relay, statusline and exclude-check, and the migration tails, for a tag cut from this tree", async () => {
		const files = {
			"package.json": `{"name":"agentpulse","version":"0.12.0"}\n`,
			"scripts/relay.ts": read("scripts/relay.ts"),
			"scripts/statusline.sh": read("scripts/statusline.sh"),
			"scripts/setup-relay.sh": read("scripts/setup-relay.sh"),
			"drizzle/sqlite/meta/_journal.json": read("drizzle/sqlite/meta/_journal.json"),
			"drizzle/postgres/meta/_journal.json": read("drizzle/postgres/meta/_journal.json"),
		};
		const release = repo.commit(files, "cut 0.12.0 from the current tree");
		repo.tag("v0.12.0", release);
		repo.commit({
			"releases/release-data.json": JSON.stringify({
				schema: 1,
				firstSignedVersion: "0.12.0",
				minSupported: "0.11.0",
				revokedKeyIds: [],
				releases: [{ version: "0.12.0", commit: release }],
			}),
		});
		repo.pushMain();
		const manifest = await buildManifest({
			repoDir: repo.dir,
			now: Date.parse("2026-11-19T12:00:00.000Z"),
			releaseLookup: () => ({ draft: false }),
		});

		config.publicUrl = "https://agentpulse.example.test";
		config.publicUrlExplicit = true;
		const res = await new Hono().route("/", setup).request("/setup-relay.sh");
		expect(res.status).toBe(200);
		const extracted = extractRelayInstallerParts(await res.text());
		expect(extracted.ok).toBe(true);
		if (!extracted.ok) return;
		const served = await clientDigests({
			relay: extracted.parts.relay,
			statusline: extracted.parts.statusline,
			excludeCheck: materializeExcludeScript(extracted.parts.excludeHeredoc),
		});
		expect(manifest.releases[0]?.clients).toEqual(served);

		const sqliteTail = JSON.parse(files["drizzle/sqlite/meta/_journal.json"]).entries.at(-1).tag;
		const postgresTail = JSON.parse(files["drizzle/postgres/meta/_journal.json"]).entries.at(
			-1,
		).tag;
		expect(manifest.releases[0]?.migrations).toEqual({
			sqlite: sqliteTail,
			postgres: postgresTail,
		});
	});

	test("the relay and statusline digests are /health's clients digests, widened", async () => {
		const health = await computeClientChecksums();
		const manifestForm = await clientDigests({
			relay: read("scripts/relay.ts"),
			statusline: read("scripts/statusline.sh"),
			excludeCheck: "",
		});
		expect(manifestForm.relay.startsWith(health.relay as string)).toBe(true);
		expect(manifestForm.statusline.startsWith(health.statusline as string)).toBe(true);
	});
});
