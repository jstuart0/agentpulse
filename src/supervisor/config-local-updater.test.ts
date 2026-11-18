import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_UPDATER } from "../shared/constants.js";
import { loadSupervisorConfig } from "./config.js";

let homeDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "ap-config-updater-"));
	originalHome = process.env.HOME;
	process.env.HOME = homeDir;
	mkdirSync(join(homeDir, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(homeDir, ".agentpulse"), 0o700);
	// Commands that never exist, so loading never spawns a real claude or codex.
	writeFileSync(
		join(homeDir, ".agentpulse", "supervisor.json"),
		JSON.stringify({
			claudeCommand: join(homeDir, "bin", "no-claude"),
			codexCommand: join(homeDir, "bin", "no-codex"),
		}),
		{ mode: 0o600 },
	);
});

afterEach(async () => {
	if (originalHome === undefined) {
		// biome-ignore lint/performance/noDelete: restoring an unset variable
		delete process.env.HOME;
	} else process.env.HOME = originalHome;
	await rm(homeDir, { recursive: true, force: true });
});

function writeRecord(over: Record<string, unknown> = {}, mode = 0o600) {
	const file = join(homeDir, ".agentpulse", "install.json");
	writeFileSync(
		file,
		JSON.stringify({
			schema: 1,
			kind: "local",
			components: ["server", "supervisor"],
			repoUrl: "https://example.invalid/agentpulse.git",
			track: "ref",
			ref: "main",
			installDir: join(homeDir, ".agentpulse", "app"),
			dataDir: join(homeDir, ".agentpulse", "data"),
			sqlitePath: join(homeDir, ".agentpulse", "data", "agentpulse.db"),
			dialect: "sqlite",
			service: "none",
			serverUrl: "http://localhost:3000",
			serverTransport: "loopback",
			bunBin: "/bun/bin/bun",
			...over,
		}),
		{ mode },
	);
	chmodSync(file, mode);
}

const features = async () => (await loadSupervisorConfig()).capabilities.features;

describe("the local_updater host feature", () => {
	test("is advertised when install.json says this host was installed by install-local.sh with a supervisor", async () => {
		writeRecord();
		expect(await features()).toContain(LOCAL_UPDATER);
		writeRecord({ components: ["supervisor"], dataDir: null, sqlitePath: null, dialect: null });
		expect(await features()).toContain(LOCAL_UPDATER);
	});

	test("is absent with no record (a hand-started or older install)", async () => {
		expect(await features()).not.toContain(LOCAL_UPDATER);
	});

	test("is absent when the install has no supervisor component", async () => {
		writeRecord({ components: ["server"] });
		expect(await features()).not.toContain(LOCAL_UPDATER);
	});

	test("is absent when the record isn't private to this account", async () => {
		writeRecord({}, 0o666);
		expect(await features()).not.toContain(LOCAL_UPDATER);
	});
});
