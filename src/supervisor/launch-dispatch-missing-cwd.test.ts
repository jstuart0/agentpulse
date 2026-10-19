/**
 * Whether a launch's directory exists is judged here, on the supervisor's own disk, right
 * before spawn (spawn-cwd.ts canonicalSpawnCwd): the server never checks it, since its disk
 * is the wrong machine. A directory that is missing fails the launch with a message that says
 * so, and nothing is spawned.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest } from "../shared/types.js";
import { type LaunchProviders, createLaunchDispatcher } from "./launch-dispatch.js";
import { createReportGate } from "./services/report-gate.js";

const SUPERVISOR_ID = "sup-1";
const STATUS_PATH = `/supervisors/${SUPERVISOR_ID}/launches/launch-1/status`;

let home: string;
let work: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-dispatch-missing-cwd-")));
	work = join(home, "trusted", "project");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness() {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const ran: string[] = [];
	const launched: LaunchRequest[] = [];
	const gate = createReportGate({
		request: async (path: string, options?: RequestInit) => {
			calls.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
			return { session: { displayName: "x" }, managedSession: {}, events: [] };
		},
		supervisorId: SUPERVISOR_ID,
		home,
		now: () => 0,
		log: () => {},
	});
	const providers = {
		launchManagedCodex: async (l: LaunchRequest) => {
			launched.push(l);
			ran.push("codex");
			return { pid: 1, metadata: {}, runtime: {} };
		},
		launchClaudeHeadless: async (l: LaunchRequest) => {
			launched.push(l);
			ran.push("headless");
			return { pid: 2, metadata: {}, monitor: Promise.resolve() };
		},
		launchClaudeInteractive: async (l: LaunchRequest) => {
			launched.push(l);
			ran.push("interactive");
			return { pid: 3, metadata: {} };
		},
	} as unknown as LaunchProviders;
	const dispatch = createLaunchDispatcher({
		gate,
		trustedRoots: [join(home, "trusted")],
		providers,
		executePrelaunchActions: (async () => {
			ran.push("prelaunch");
		}) as never,
		log: () => {},
		warn: () => {},
	});
	return { calls, ran, launched, dispatch };
}

function launch(over: Record<string, unknown>): LaunchRequest {
	return {
		id: "launch-1",
		launchCorrelationId: "corr-1",
		agentType: "claude_code",
		requestedLaunchMode: "headless",
		cwd: work,
		model: "m",
		env: {},
		launchSpec: { prelaunchActions: [{ kind: "scaffold_workarea", path: work }] },
		...over,
	} as unknown as LaunchRequest;
}

const MODES = [
	{ agentType: "claude_code", mode: "headless" },
	{ agentType: "claude_code", mode: "interactive_terminal" },
	{ agentType: "codex_cli", mode: "managed_codex" },
] as const;

describe("a launch whose directory is missing on this host", () => {
	for (const m of MODES) {
		test(`${m.agentType}/${m.mode}: failed with a message that says the directory doesn't exist on this host; no provider runs`, async () => {
			const h = harness();
			const missing = join(work, "not-created-anywhere");
			await h.dispatch(
				launch({
					agentType: m.agentType,
					requestedLaunchMode: m.mode,
					cwd: missing,
					launchSpec: {},
				}),
			);
			expect(h.launched).toEqual([]);
			const failed = h.calls.filter((c) => c.body.status === "failed");
			expect(failed).toHaveLength(1);
			expect(failed[0]?.path).toBe(STATUS_PATH);
			expect(String(failed[0]?.body.error)).toBe(
				"Launch not started: Working directory doesn't exist on this host.",
			);
		});
	}

	test("the same launch with the directory present reaches its provider (the check is about the directory, nothing else)", async () => {
		const h = harness();
		await h.dispatch(launch({ launchSpec: {} }));
		expect(h.ran).toEqual(["headless"]);
		expect(h.calls.some((c) => c.body.status === "failed")).toBe(false);
	});
});
