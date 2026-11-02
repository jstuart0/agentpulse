/**
 * What an interactive launch writes for its terminal bridge: a config with no credential and no server address,
 * only what the bridge needs plus a nonce, private on disk, and the drain told which directory to follow. Runs the
 * real launch in dry-run mode (no terminal is opened).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LaunchRequest } from "../../shared/types.js";

let home: string;
let previousHome: string | undefined;
let previousDryRun: string | undefined;

beforeEach(() => {
	home = mkdtempSync("/tmp/apc-");
	previousHome = process.env.HOME;
	previousDryRun = process.env.AGENTPULSE_SUPERVISOR_DRY_RUN;
	process.env.HOME = home;
	process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "true";
});
afterEach(() => {
	process.env.HOME = previousHome;
	if (previousDryRun === undefined) process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = undefined;
	else process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = previousDryRun;
	rmSync(home, { recursive: true, force: true });
});

const launch = (id: string) =>
	({
		id: "launch-1",
		launchCorrelationId: id,
		agentType: "claude_code",
		requestedLaunchMode: "interactive_terminal",
		cwd: home,
		env: {},
		taskPrompt: "do the thing",
		baseInstructions: "",
		launchSpec: {},
	}) as unknown as LaunchRequest;

test("bridge.json holds no credential, no server address and no supervisor id, carries a fresh nonce, and is 0600", async () => {
	const { launchClaudeInteractiveRequest } = await import("./claude-interactive.js");
	const admitted: string[] = [];
	await launchClaudeInteractiveRequest(launch("cfg-1"), {
		reportState: async () => ({}) as never,
		reportEvents: async () => undefined,
		admitBridgeSpool: (id) => void admitted.push(id),
	});
	const file = join(home, ".agentpulse", "interactive", "cfg-1", "bridge.json");
	const text = readFileSync(file, "utf-8");
	const config = JSON.parse(text);
	expect(Object.keys(config).sort()).toEqual(
		["command", "cwd", "env", "launchNonce", "session_id", "socket_path"].sort(),
	);
	for (const gone of ["server_url", "supervisor_id", "supervisor_token", "api_key"]) {
		expect(text).not.toContain(gone);
	}
	expect(config.launchNonce).toMatch(/^[0-9a-f]{32}$/);
	expect(config.session_id).toBe("cfg-1");
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(admitted).toEqual(["cfg-1"]);

	await launchClaudeInteractiveRequest(launch("cfg-2"), {
		reportState: async () => ({}) as never,
		reportEvents: async () => undefined,
	});
	const second = JSON.parse(
		readFileSync(join(home, ".agentpulse", "interactive", "cfg-2", "bridge.json"), "utf-8"),
	);
	expect(second.launchNonce).not.toBe(config.launchNonce);
});

test("a launch id that can't be a directory name is refused before anything is written", async () => {
	const { launchClaudeInteractiveRequest } = await import("./claude-interactive.js");
	await expect(launchClaudeInteractiveRequest(launch("../escape"))).rejects.toThrow();
});
