import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../shared/private-file.js";
import { CANONICAL_REPO_URL, MANIFEST_URL } from "../shared/release-feed.js";
import { RELEASE_KEYS } from "../shared/release-keys.js";
import { buildRealDeps } from "./real-deps.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ap-realdeps-"));
	mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function record(service: "launchd" | "systemd" | "none") {
	writePrivateFileAtomicNoFollow(
		join(home, ".agentpulse", "install.json"),
		`${JSON.stringify({
			schema: 1,
			kind: "local",
			components: ["server"],
			repoUrl: CANONICAL_REPO_URL,
			track: "release",
			ref: "v0.12.0",
			installDir: join(home, ".agentpulse", "app"),
			dataDir: join(home, ".agentpulse", "data"),
			sqlitePath: join(home, ".agentpulse", "data", "agentpulse.db"),
			dialect: "sqlite",
			service,
			serverUrl: "http://localhost:3000",
			port: 3000,
			bunBin: "/bun/bin/bun",
		})}\n`,
	);
}

describe("the real dependencies", () => {
	test("the repository, the trust keys and the feed are constants, whatever the environment says", () => {
		record("none");
		const deps = buildRealDeps({
			HOME: home,
			AGENTPULSE_REPO_URL: "https://evil.invalid/x.git",
			AGENTPULSE_RELEASE_KEYS: "[]",
			AGENTPULSE_MANIFEST_URL: "https://evil.invalid/manifest.json",
			AGENTPULSE_UPDATE_URL: "https://evil.invalid",
		});
		expect(deps.canonicalRepoUrl).toBe(CANONICAL_REPO_URL);
		expect(deps.keys).toBe(RELEASE_KEYS);
		expect(deps.manifestUrl).toBe(MANIFEST_URL);
		expect(deps.home).toBe(home);
	});

	test("a launchd or systemd install can't reach its service manager without AGENTPULSE_UPDATER_REAL_SERVICES=1", () => {
		for (const service of ["launchd", "systemd"] as const) {
			record(service);
			expect(() => buildRealDeps({ HOME: home })).toThrow("AGENTPULSE_UPDATER_REAL_SERVICES");
			expect(() => buildRealDeps({ HOME: home, AGENTPULSE_UPDATER_REAL_SERVICES: "0" })).toThrow();
		}
	});

	test("with no install record there is no service manager to reach", async () => {
		const deps = buildRealDeps({ HOME: home });
		expect(deps.serviceManager.kind).toBe("none");
		expect(await deps.serviceManager.preflight()).toBe("no_service_manager");
	});
});
