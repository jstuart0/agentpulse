import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { buildDefaultConfig, loadSupervisorConfig, saveSupervisorConfig } from "./config.js";

let homeDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "ap-config-version-"));
	originalHome = process.env.HOME;
	process.env.HOME = homeDir;
});

afterEach(async () => {
	if (originalHome === undefined) {
		// biome-ignore lint/performance/noDelete: restoring an unset variable
		delete process.env.HOME;
	} else process.env.HOME = originalHome;
	await rm(homeDir, { recursive: true, force: true });
});

const configPath = () => join(homeDir, ".agentpulse", "supervisor.json");

/** Commands that never exist, so loading never spawns a real claude or codex. */
const noExecutables = () => ({
	claudeCommand: join(homeDir, "bin", "no-claude"),
	codexCommand: join(homeDir, "bin", "no-codex"),
});

function writeConfig(extra: Record<string, unknown>) {
	mkdirSync(join(homeDir, ".agentpulse"), { recursive: true });
	writeFileSync(
		configPath(),
		JSON.stringify({
			serverUrl: "http://localhost:3000",
			claudeCommand: join(homeDir, "bin", "no-claude"),
			codexCommand: join(homeDir, "bin", "no-codex"),
			...extra,
		}),
		{ mode: 0o600 },
	);
}

describe("the supervisor's reported version", () => {
	test("the default config carries the package version, not a literal", () => {
		expect(buildDefaultConfig().version).toBe(pkg.version);
	});

	test("a persisted 0.1.0 no longer wins", async () => {
		writeConfig({ version: "0.1.0" });
		const loaded = await loadSupervisorConfig();
		expect(loaded.version).toBe(pkg.version);
	});

	test("a config file with no version reports the package version", async () => {
		writeConfig({});
		expect((await loadSupervisorConfig()).version).toBe(pkg.version);
	});

	test("a save omits the version, so the next upgrade is never held at an old value", async () => {
		writeConfig({ version: "0.1.0" });
		const loaded = await loadSupervisorConfig();
		await saveSupervisorConfig({ ...loaded, ...noExecutables() });
		const onDisk = JSON.parse(readFileSync(configPath(), "utf-8"));
		expect("version" in onDisk).toBe(false);
		expect(onDisk.serverUrl).toBe("http://localhost:3000");
	});
});
