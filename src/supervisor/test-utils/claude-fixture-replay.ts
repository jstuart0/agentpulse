/**
 * Replays a recorded Claude Code stream through the fork runtime, turn by turn, against the fake `claude`
 * (AGEN-119..123 Track 0). One scripted turn per user line the recording was sent; request frames are not
 * replayed (the runtime then has no approval port to answer them), so a replay shows what the lines alone
 * produce: the reports, the outcome, the states. No real Claude is started.
 */
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import {
	CLAUDE_FIXTURE_DIR,
	type RecordedLine,
	readClaudeFixture,
} from "../providers/__fixtures__/claude-frames.js";
import type { FakeConfig } from "../providers/__fixtures__/fake-claude-stream.js";
import type { ClaudeStreamOptions } from "../providers/claude-stream.js";
import { type Harness, INIT } from "./claude-stream-harness.js";

type Step = NonNullable<FakeConfig["turns"]>[number][number];

const NOT_REPLAYED = new Set([
	"control_response",
	"control_request",
	"control_cancel_request",
	"command_lifecycle",
]);

/** One scripted turn per user line of the recording. Empty when the recording was never sent a prompt. */
export function turnsOf(lines: readonly RecordedLine[]): Step[][] {
	const turns: Step[][] = [];
	for (const line of lines) {
		if (line.dir === "in" && line.frame.type === "user") turns.push([]);
		else if (line.dir === "out" && turns.length > 0) {
			const type = line.frame.type as string;
			if (NOT_REPLAYED.has(type)) continue;
			turns.at(-1)?.push(
				type === "system" && line.frame.subtype === "init"
					? INIT
					: {
							say: JSON.parse(
								JSON.stringify(line.frame).replaceAll(
									/"session_id":"[0-9a-f-]{36}"/g,
									'"session_id":"$SESSION"',
								),
							),
						},
			);
		}
	}
	return turns;
}

export type ReplayResult = {
	turns: number;
	outcomes: Array<Record<string, unknown>>;
	events: ManagedSessionEventInput[];
	states: ManagedSessionStateInput[];
};

/** A turn that never ends (a recording cut short) is recorded as `hung` and the replay stops there. */
const TURN_WAIT_MS = 2_500;

export async function replayFixture(
	name: string,
	makeHarness: (config: FakeConfig) => Harness,
	options: {
		dir?: string;
		extra?: Partial<ClaudeStreamOptions>;
	} = {},
): Promise<ReplayResult | null> {
	const turns = turnsOf(readClaudeFixture(name, options.dir ?? CLAUDE_FIXTURE_DIR));
	if (turns.length === 0) return null;
	const h = makeHarness({ turns });
	const rt = await h.start(options.extra);
	const outcomes: ReplayResult["outcomes"] = [];
	for (let i = 0; i < turns.length; i++) {
		if (i === 0) {
			rt.beginSettle();
			rt.settled();
		}
		let sent: Awaited<ReturnType<typeof rt.sendPrompt>>;
		try {
			sent = await rt.sendPrompt("go", `a${i}`);
		} catch (error) {
			outcomes.push({ refused: (error as { kind?: string }).kind ?? "error" });
			break;
		}
		const outcome = await Promise.race([
			sent.done,
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), TURN_WAIT_MS)),
		]);
		if (outcome === "hung") {
			outcomes.push({ hung: true });
			break;
		}
		outcomes.push({ ...outcome });
		if (!outcome.ok && outcome.code === "fatal") break;
	}
	// Rows reported without being awaited (a call's row) have landed by now.
	await Bun.sleep(40);
	await rt.dispose({ interruptMs: 0, stdinCloseMs: 300, termMs: 300, killMs: 300 });
	return { turns: turns.length, outcomes, events: h.events, states: h.states };
}
