/**
 * The real claim loops driven by a fake claim source and a fake gate, with a real `update-drain.json` in a
 * throwaway home: while the drain is fresh a claimed launch and prompt are refused with the fixed sentence and a
 * stop is handed to its handler; with no drain everything is handled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_UPDATING_MESSAGE } from "../../shared/managed-messages.js";
import type { ControlAction, LaunchRequest } from "../../shared/types.js";
import { UPDATE_DRAIN_FILE } from "../../shared/update-files.js";
import { createClaimLoops } from "./claim-loops.js";
import { createUpdateDrain } from "./update-drain.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ap-claim-"));
	mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const startDrain = () =>
	writeFileSync(
		join(home, ".agentpulse", UPDATE_DRAIN_FILE),
		JSON.stringify({ schema: 1, requestedAt: Date.now(), expiresAt: Date.now() + 120_000 }),
		{ mode: 0o600 },
	);

function harness(
	claims: { launch?: LaunchRequest | null; action?: ControlAction | null },
	rules: "none" | "ok" = "none",
) {
	const events: string[] = [];
	const drain = createUpdateDrain({
		home,
		version: "0.12.0",
		counts: async () => ({ codex: 0, headless: 0, bridges: 0, approvals: 0 }),
	});
	const loops = createClaimLoops({
		claimLaunchRequest: async () => ({ launchRequest: claims.launch ?? null }),
		claimActionRequest: async () => ({ action: claims.action ?? null }),
		drain,
		gate: {
			rulesState: () => rules,
			refuseLaunch: async (id: string) => void events.push(`refuseLaunch:${id}`),
			reportLaunchStatus: async (id: string, body: { status: string; error?: string | null }) =>
				void events.push(`launchStatus:${id}:${body.status}:${body.error}`),
			reportControlStatus: async (
				id: string,
				_s: string | null,
				body: { status: string; error?: string | null },
			) => {
				events.push(`controlStatus:${id}:${body.status}:${body.error}`);
				return { outcome: "sent" as const, action: null };
			},
		},
		dispatchLaunch: async (l) => void events.push(`dispatchLaunch:${l.id}`),
		handleControlAction: async (a) => void events.push(`handle:${a.actionType}:${a.id}`),
		log: () => {},
	});
	return { loops, events };
}

const launch = { id: "L1" } as unknown as LaunchRequest;
const action = (actionType: string, id: string) =>
	({ id, actionType, sessionId: "s1" }) as unknown as ControlAction;

describe("the claim loops under a fresh drain", () => {
	test("a claimed launch is failed with the fixed sentence and never dispatched", async () => {
		startDrain();
		const { loops, events } = harness({ launch });
		await loops.claimLaunch();
		expect(events).toEqual([`launchStatus:L1:failed:${HOST_UPDATING_MESSAGE}`]);
	});
	test("while exclude rules exist the refusal is the generic one", async () => {
		startDrain();
		const { loops, events } = harness({ launch }, "ok");
		await loops.claimLaunch();
		expect(events).toEqual(["refuseLaunch:L1"]);
	});
	test("a prompt, resume, retry or fork is failed with the sentence; stop and interrupt are handled", async () => {
		startDrain();
		for (const type of ["prompt", "resume", "retry", "fork"]) {
			const { loops, events } = harness({ action: action(type, `A-${type}`) });
			await loops.claimControlAction();
			expect(events, type).toEqual([`controlStatus:A-${type}:failed:${HOST_UPDATING_MESSAGE}`]);
		}
		for (const type of ["stop", "interrupt"]) {
			const { loops, events } = harness({ action: action(type, `A-${type}`) });
			await loops.claimControlAction();
			expect(events, type).toEqual([`handle:${type}:A-${type}`]);
		}
	});
	test("with no drain, or a stale one, everything is handled", async () => {
		const none = harness({ launch, action: action("prompt", "A1") });
		await none.loops.claimLaunch();
		await none.loops.claimControlAction();
		expect(none.events).toEqual(["dispatchLaunch:L1", "handle:prompt:A1"]);
		writeFileSync(
			join(home, ".agentpulse", UPDATE_DRAIN_FILE),
			JSON.stringify({
				schema: 1,
				requestedAt: Date.now() - 3_600_000,
				expiresAt: Date.now() + 60_000,
			}),
			{ mode: 0o600 },
		);
		const stale = harness({ launch });
		await stale.loops.claimLaunch();
		expect(stale.events).toEqual(["dispatchLaunch:L1"]);
	});
	test("a failing claim request is logged, not thrown", async () => {
		const logged: string[] = [];
		const loops = createClaimLoops({
			claimLaunchRequest: async () => {
				throw new Error("down");
			},
			claimActionRequest: async () => {
				throw new Error("down");
			},
			drain: createUpdateDrain({
				home,
				version: "0",
				counts: async () => ({ codex: 0, headless: 0, bridges: 0, approvals: 0 }),
			}),
			gate: {} as never,
			dispatchLaunch: async () => {},
			handleControlAction: async () => {},
			log: (l) => void logged.push(l),
		});
		await loops.claimLaunch();
		await loops.claimControlAction();
		expect(logged).toHaveLength(2);
	});
});
