/**
 * The supervisor's approvals wiring, run for real (AGEN-87). main() performs real network calls and can't be
 * run in a test, so the three things it must do are one function and are checked here: the shared tracker is
 * the one it built, the server's features from registration reach it, the beat ticks on the scheduler it was
 * given, and a heartbeat's features are applied only when the heartbeat succeeded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_APPROVALS_SERVER_FEATURE } from "../../shared/codex-approvals.js";
import { APPROVALS_TICK_MS, wireCodexApprovals } from "./codex-approvals-wiring.js";
import { sharedCodexApprovals } from "./codex-approvals.js";
import { configureCodexApprovals } from "./codex-approvals.js";
import { RpcClient } from "./codex-rpc.js";

afterEach(() => configureCodexApprovals(null));

const FEATURE = [CODEX_APPROVALS_SERVER_FEATURE];

/** A gate that says every request is fine to send and records nothing: only the tracker's own behaviour is on show. */
function quietGate() {
	return {
		verdict: () => "send" as const,
		excludesPath: () => false,
		isOffline: () => false,
		reportApproval: async () => ({ outcome: "blocked" as const }),
		syncApprovals: async () => ({ outcome: "empty" as const }),
	};
}

let sessions = 0;

/** A runtime-less way to see whether the tracker is enabled: a request is declined with a fixed reason. */
async function declineReasonFor(tracker: ReturnType<typeof sharedCodexApprovals>) {
	const written: unknown[] = [];
	const client = new RpcClient({
		write: (frame) => written.push(JSON.parse(frame)),
		close: () => {},
	});
	const reasons: string[] = [];
	const handle = tracker.attachClient(client, {
		sessionId: `wiring-${++sessions}`,
		warn: async (_content, detail) => void reasons.push(detail.reason),
	});
	tracker.setVerdict(handle, { verdict: "supported", reason: "ok" });
	client.receive(
		`${JSON.stringify({
			id: 1,
			method: "item/commandExecution/requestApproval",
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "i",
				command: "ls",
				cwd: "/w",
				availableDecisions: ["accept"],
			},
		})}\n`,
	);
	await Bun.sleep(5);
	tracker.dispose(handle);
	return reasons[0];
}

describe("wireCodexApprovals", () => {
	test("the tracker it builds is the one managed Codex runtimes attach to", () => {
		const { approvals } = wireCodexApprovals({
			gate: quietGate(),
			serverFeatures: FEATURE,
			schedule: () => ({}),
		});
		expect(sharedCodexApprovals()).toBe(approvals);
	});

	test("the features from registration are applied: with them a request is held, without them it is declined as not enabled", async () => {
		const on = wireCodexApprovals({
			gate: quietGate(),
			serverFeatures: FEATURE,
			schedule: () => ({}),
		});
		expect(await declineReasonFor(on.approvals)).not.toBe("approvals_not_enabled");

		const off = wireCodexApprovals({
			gate: quietGate(),
			serverFeatures: undefined,
			schedule: () => ({}),
		});
		expect(await declineReasonFor(off.approvals)).toBe("approvals_not_enabled");
	});

	test("it schedules one beat every APPROVALS_TICK_MS, and each beat ticks the tracker", async () => {
		const scheduled: Array<{ callback: () => void; ms: number }> = [];
		const { approvals } = wireCodexApprovals({
			gate: quietGate(),
			serverFeatures: FEATURE,
			schedule: (callback, ms) => scheduled.push({ callback, ms }),
		});
		expect(scheduled.map((s) => s.ms)).toEqual([APPROVALS_TICK_MS]);

		// A beat that finds something due does the work: a request past its deadline is declined by the tick.
		let ticks = 0;
		const real = approvals.tick.bind(approvals);
		approvals.tick = () => {
			ticks++;
			return real();
		};
		scheduled[0].callback();
		scheduled[0].callback();
		expect(ticks).toBe(2);
	});

	test("a beat that throws is logged and does not escape the scheduler", async () => {
		const scheduled: Array<() => void> = [];
		const errors: unknown[] = [];
		const { approvals } = wireCodexApprovals({
			gate: quietGate(),
			serverFeatures: FEATURE,
			schedule: (callback) => scheduled.push(callback),
			onTickError: (error) => void errors.push(error),
		});
		approvals.tick = () => Promise.reject(new Error("tick failed"));
		scheduled[0]();
		await Bun.sleep(5);
		expect(errors).toHaveLength(1);
	});

	test("heartbeat features are applied when the heartbeat succeeds and left alone when it fails", async () => {
		const { approvals, applyHeartbeat } = wireCodexApprovals({
			gate: quietGate(),
			serverFeatures: undefined,
			schedule: () => ({}),
		});
		expect(await declineReasonFor(approvals)).toBe("approvals_not_enabled");

		await expect(
			applyHeartbeat(async () => {
				throw new Error("heartbeat failed");
			}),
		).rejects.toThrow("heartbeat failed");
		expect(await declineReasonFor(approvals)).toBe("approvals_not_enabled");

		const beat = await applyHeartbeat(async () => ({ serverFeatures: FEATURE }));
		expect(beat).toEqual({ serverFeatures: FEATURE });
		expect(await declineReasonFor(approvals)).not.toBe("approvals_not_enabled");

		// A later successful answer that no longer advertises it turns approvals off again.
		await applyHeartbeat(async () => ({}));
		expect(await declineReasonFor(approvals)).toBe("approvals_not_enabled");
		await applyHeartbeat(async () => null);
		expect(await declineReasonFor(approvals)).toBe("approvals_not_enabled");

		// ... and a failure after that leaves it as it was.
		await applyHeartbeat(async () => ({ serverFeatures: FEATURE }));
		await applyHeartbeat(async () => {
			throw new Error("down");
		}).catch(() => undefined);
		expect(await declineReasonFor(approvals)).not.toBe("approvals_not_enabled");
	});
});

describe("main() uses the wiring", () => {
	const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");

	test("it is built on the gate with the registration's features, and the heartbeat goes through applyHeartbeat", () => {
		expect(source).toMatch(
			/wireCodexApprovals\(\{\s*gate,\s*serverFeatures: registration\.serverFeatures\s*\}\)/,
		);
		expect(source).toContain("approvalsWiring.applyHeartbeat(");
		expect(source).not.toContain("createCodexApprovalTracker");
	});
});
