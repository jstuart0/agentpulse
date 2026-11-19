import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_KEY_LIST, envelopeFor } from "../../src/shared/__fixtures__/release-test-signer.ts";
import {
	buildBashExcludeScriptForInstaller,
	materializeExcludeScript,
} from "../../src/shared/hook-command.ts";
import { clientDigests } from "../../src/shared/relay-installer-parts.ts";
import { MAX_ENVELOPE_BYTES, verifyManifest } from "../../src/shared/release-manifest.ts";
import { NoPinnedReleasesError, buildManifest } from "./build-manifest.ts";
import { type FixtureRepo, createFixtureRepo } from "./fixture-repo.ts";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const cleanup: string[] = [];
afterAll(async () => {
	const { rmSync } = await import("node:fs");
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const SETUP_RELAY = (excludeForm: string) =>
	`#!/usr/bin/env bash\n# @@AGENTPULSE_RELAY_TS@@\nap_load_exclude_script() {\n\tIFS= read -r -d '' ap_exclude_script_text <<'AP_EXCLUDE_SCRIPT_EOF' || true\n${excludeForm}AP_EXCLUDE_SCRIPT_EOF\n}\n`;

const journal = (...tags: string[]) =>
	JSON.stringify({
		version: "7",
		dialect: "x",
		entries: tags.map((tag, idx) => ({ idx, version: "6", when: idx, tag, breakpoints: true })),
	});

/** The files every release commit carries. `marker` makes the relay differ per release. */
const releaseFiles = (version: string, marker = version) => ({
	"package.json": `{\n\t"name": "agentpulse",\n\t"version": "${version}"\n}\n`,
	"scripts/relay.ts": `export const RELAY_VERSION = "${marker}";\nconsole.log("relay");\n`,
	"scripts/statusline.sh": `#!/bin/sh\nAGENTPULSE_STATUSLINE_VERSION="${marker}"\n`,
	"scripts/setup-relay.sh": SETUP_RELAY(buildBashExcludeScriptForInstaller()),
	"drizzle/sqlite/meta/_journal.json": journal("0001_a", "0022_sqlite_last"),
	"drizzle/postgres/meta/_journal.json": journal("0001_a", "0023_postgres_last"),
});

interface Pin {
	version: string;
	commit: string;
	severity?: "normal" | "security";
	pulled?: boolean;
	reason?: string;
}

function dataFile(pins: Pin[], over: Record<string, unknown> = {}) {
	return `${JSON.stringify(
		{
			schema: 1,
			firstSignedVersion: "0.12.0",
			minSupported: "0.11.0",
			revokedKeyIds: ["k-000000000001"],
			releases: pins,
			...over,
		},
		null,
		"\t",
	)}\n`;
}

const releases =
	(tags: string[], draft: string[] = []) =>
	(tag: string) =>
		tags.includes(tag) ? { draft: false } : draft.includes(tag) ? { draft: true } : null;

function build(
	repo: FixtureRepo,
	lookup: (tag: string) => { draft: boolean } | null,
	over: object = {},
) {
	return buildManifest({ repoDir: repo.dir, now: NOW, releaseLookup: lookup, ...over });
}

/** The big scenario: one tag of every kind the builder must include or refuse. */
function scenario() {
	const repo = createFixtureRepo();
	cleanup.push(repo.dir);
	repo.commit(releaseFiles("0.11.0"), "base");
	const a = repo.commit(releaseFiles("0.12.0"), "release 0.12.0");
	const b = repo.commit(releaseFiles("0.12.1", "0.12.1-new"), "release 0.12.1");
	const lightweight = repo.commit(releaseFiles("0.12.2"));
	const mismatch = repo.commit(releaseFiles("0.12.9"), "package says 0.12.9");
	const noRelease = repo.commit(releaseFiles("0.12.5"));
	const pre = repo.commit(releaseFiles("0.13.0-rc.1"));
	const unlisted = repo.commit(releaseFiles("0.12.6"));
	const draft = repo.commit(releaseFiles("0.12.8"));
	const old = repo.commit(releaseFiles("0.11.5"));
	repo.pushMain();
	repo.git("checkout", "-q", "-b", "side");
	const offMain = repo.commit(releaseFiles("0.12.3"), "never on main");
	repo.git("checkout", "-q", "main");

	repo.tag("v0.12.0", a);
	repo.tag("v0.12.1", b);
	repo.tag("v0.12.2", lightweight, "lightweight");
	repo.tag("v0.12.3", offMain);
	repo.tag("v0.12.4", mismatch);
	repo.tag("v0.12.5", noRelease);
	repo.tag("v0.13.0-rc.1", pre);
	repo.tag("v0.12.6", unlisted);
	repo.tag("v0.12.7", a); // listed below with a different commit
	repo.tag("v0.12.8", draft);
	repo.tag("v0.11.5", old);

	const pins: Pin[] = [
		{ version: "0.12.0", commit: a },
		{ version: "0.12.1", commit: b, severity: "security" },
		{ version: "0.12.2", commit: lightweight },
		{ version: "0.12.3", commit: offMain },
		{ version: "0.12.4", commit: mismatch },
		{ version: "0.12.5", commit: noRelease },
		{ version: "0.13.0-rc.1", commit: pre },
		{ version: "0.12.7", commit: b },
		{ version: "0.12.8", commit: draft },
		{ version: "0.11.5", commit: old },
	];
	const head = repo.commit({ "releases/release-data.json": dataFile(pins) }, "pin releases");
	repo.pushMain();
	const withRelease = [
		"v0.12.0",
		"v0.12.1",
		"v0.12.2",
		"v0.12.3",
		"v0.12.4",
		"v0.13.0-rc.1",
		"v0.12.6",
		"v0.12.7",
		"v0.11.5",
	];
	return { repo, a, b, head, pins, lookup: releases(withRelease, ["v0.12.8"]) };
}

/** Built once: these tests only read git objects. The pull test builds its own. */
let shared: ReturnType<typeof scenario> | undefined;
const readOnly = () => {
	shared ??= scenario();
	return shared;
};

describe("buildManifest: which versions get in", () => {
	test("only a listed, annotated, on-main, version-matching, released tag at its pinned commit is included", async () => {
		const { repo, a, b, head, lookup } = readOnly();
		const m = await build(repo, lookup);
		expect(m.releases.map((r) => r.version)).toEqual(["0.13.0-rc.1", "0.12.1", "0.12.0"]);
		expect(m.releases.find((r) => r.version === "0.12.0")?.commit).toBe(a);
		expect(m.releases.find((r) => r.version === "0.12.1")?.commit).toBe(b);
		expect(m.latest).toBe("0.12.1");
		expect(m.sourceCommit).toBe(head);
		expect(m.seq).toBe(Number(repo.git("rev-list", "--count", head)));
		expect(m.minSupported).toBe("0.11.0");
		expect(m.revokedKeyIds).toEqual(["k-000000000001"]);
		expect(m.schema).toBe(1);
	});

	test("severity, pulled and the reason come from the data file; a pulled release is never latest", async () => {
		const { repo, a, b, lookup } = scenario();
		repo.commit(
			{
				"releases/release-data.json": dataFile(
					[
						{ version: "0.12.0", commit: a },
						{
							version: "0.12.1",
							commit: b,
							severity: "security",
							pulled: true,
							reason: "data_loss",
						},
					],
					{ minSupported: "0.11.0" },
				),
			},
			"pull 0.12.1",
		);
		repo.pushMain();
		const m = await build(repo, lookup);
		const pulled = m.releases.find((r) => r.version === "0.12.1");
		expect(pulled).toMatchObject({ severity: "security", pulled: true, pulledReason: "data_loss" });
		expect(m.latest).toBe("0.12.0");
		const normal = m.releases.find((r) => r.version === "0.12.0");
		expect(normal).toMatchObject({ severity: "normal", pulled: false });
		expect(normal?.pulledReason).toBeUndefined();
	});

	test("migrations are the last journal tag per dialect at the tag", async () => {
		const { repo, lookup } = readOnly();
		const m = await build(repo, lookup);
		expect(m.releases[1]?.migrations).toEqual({
			sqlite: "0022_sqlite_last",
			postgres: "0023_postgres_last",
		});
	});

	test("client digests are full sha256 of the files at that tag, exclude-check from the materialized heredoc", async () => {
		const { repo, lookup } = readOnly();
		const m = await build(repo, lookup);
		const files = releaseFiles("0.12.1", "0.12.1-new");
		const expected = await clientDigests({
			relay: files["scripts/relay.ts"],
			statusline: files["scripts/statusline.sh"],
			excludeCheck: materializeExcludeScript(buildBashExcludeScriptForInstaller()),
		});
		expect(m.releases[1]?.clients).toEqual(expected);
		expect(m.releases[1]?.clients.relay).toMatch(/^[0-9a-f]{64}$/);
		expect(m.releases[1]?.clients.relay).not.toBe(m.releases[2]?.clients.relay);
	});
});

describe("buildManifest: determinism and shape", () => {
	test("a dirty worktree changes nothing: output reads git objects only", async () => {
		const { repo, lookup } = readOnly();
		const before = JSON.stringify(await build(repo, lookup));
		writeFileSync(join(repo.dir, "scripts/relay.ts"), "tampered");
		writeFileSync(join(repo.dir, "releases/release-data.json"), "{}");
		writeFileSync(join(repo.dir, "untracked.txt"), "x");
		expect(JSON.stringify(await build(repo, lookup))).toBe(before);
	});

	test("expiresAt is issuedAt plus 10 days, from the injected clock", async () => {
		const { repo, lookup } = readOnly();
		const m = await build(repo, lookup);
		expect(m.issuedAt).toBe(new Date(NOW).toISOString());
		expect(Date.parse(m.expiresAt) - Date.parse(m.issuedAt)).toBe(10 * 86_400_000);
	});

	test("the output verifies through the real verifier once signed", async () => {
		const { repo, lookup } = readOnly();
		const m = await build(repo, lookup);
		const r = await verifyManifest(envelopeFor(m), {
			keys: TEST_KEY_LIST,
			revoked: new Set(),
			now: NOW,
			last: null,
		});
		expect(r.ok).toBe(true);
	});

	test("an unlisted-everything repo is refused: no release means no manifest", async () => {
		const repo = createFixtureRepo();
		cleanup.push(repo.dir);
		repo.commit({ ...releaseFiles("0.11.0"), "releases/release-data.json": dataFile([]) });
		repo.pushMain();
		await expect(build(repo, () => null)).rejects.toThrow(/no release/i);
		await expect(build(repo, () => null)).rejects.toBeInstanceOf(NoPinnedReleasesError);
	});

	test("40 tags trim to the newest 30 and the signed envelope stays under 32 KiB", async () => {
		const repo = createFixtureRepo();
		cleanup.push(repo.dir);
		repo.commit(releaseFiles("0.11.0"), "base");
		const pins: Pin[] = [];
		const tags: string[] = [];
		for (let i = 0; i < 40; i++) {
			const version = `0.12.${i}`;
			const sha = repo.commit(releaseFiles(version, `${version}-m`), version);
			repo.tag(`v${version}`, sha);
			pins.push({ version, commit: sha });
			tags.push(`v${version}`);
		}
		repo.commit({ "releases/release-data.json": dataFile(pins) });
		repo.pushMain();
		const m = await build(repo, releases(tags));
		expect(m.releases).toHaveLength(30);
		expect(m.releases[0]?.version).toBe("0.12.39");
		expect(m.releases.at(-1)?.version).toBe("0.12.10");
		expect(m.latest).toBe("0.12.39");
		expect(envelopeFor(m).length).toBeLessThan(MAX_ENVELOPE_BYTES);
	}, 60_000);
});
