/**
 * AGEN-122: a fork's call rows carry the structured outcome. A Bash that exits 3 and one that succeeds, both
 * approved from the card: the first row is `failed` with `exit_code: 3`, the second `approved` with no code,
 * and the classifier counts the failed row and not the approved one. Hits the real routes, the real report
 * gate and the real stream runtime; the rows are read from the database the way the timeline reads them.
 */
import { classifySession } from "../../src/server/services/ai/classifier.js";
import type { ScenarioFn } from "./helpers.js";
import {
	answerNext,
	cardAnswered,
	insertObserved,
	makeSource,
	promptAndWait,
	sessionRow,
	sleep,
	startHost,
	takeOver,
} from "./helpers.js";
import { T122_EXPECTATIONS } from "./t122-mutations.js";

export const T122_SCENARIO_IDS = ["tool-outcomes"] as const;

type Row = { rawPayload?: Record<string, unknown>; eventType?: string; id: number };

export const T122_SCENARIOS: Record<(typeof T122_SCENARIO_IDS)[number], ScenarioFn> = {
	async "tool-outcomes"(run, rec, judge) {
		const host = await startHost(run, "tool-outcomes", "login");
		const out: Record<string, unknown> = {};
		try {
			const s = makeSource(run, host, rec.sentinel, "Reply with just: ready");
			if (!judge.instrument("S was made under the throwaway config", s.id, s.why)) return out;
			await insertObserved(run, s, "canary S");
			const taken = await takeOver(run, host, s.id as string);
			if (!judge.pre("the takeover succeeded", taken.action?.status === "succeeded", taken.error))
				return out;
			const n = taken.fork as string;
			const seen = new Set<string>();

			const ask = async (command: string) => {
				void promptAndWait(
					run,
					rec,
					n,
					`Use the Bash tool to run exactly this command, and nothing else, then reply with just: done. The command: ${command}`,
				);
				return answerNext(run, n, "accept", seen);
			};
			const failing = await ask("echo canary-out; exit 3");
			if (!judge.instrument("Claude asked for the failing Bash command", cardAnswered(failing)))
				return out;
			await sleep(6_000);
			const succeeding = await ask(`printf %s ${rec.sentinel} > ok.txt`);
			if (
				!judge.instrument("Claude asked for the succeeding Bash command", cardAnswered(succeeding))
			)
				return out;
			await sleep(8_000);

			const rows = (
				(await run
					.getDb()
					.select()
					.from(run.t.events)
					.where(run.orm.eq(run.t.events.sessionId, n))) as Row[]
			)
				.filter((e) => e.rawPayload?.kind === "call" && e.rawPayload?.claudeStreamRuntime === true)
				.sort((a, b) => a.id - b.id);
			out.callRows = rows.map((r) => ({
				tool: r.rawPayload?.tool,
				toolOutcome: r.rawPayload?.toolOutcome,
				is_error: r.rawPayload?.is_error,
				exit_code: r.rawPayload?.exit_code,
			}));
			judge.pre("two call rows were stored", rows.length === 2, rows.length);
			const [failed, approved] = rows;

			judge.claim(
				T122_EXPECTATIONS.failed,
				failed?.rawPayload?.toolOutcome === "failed" &&
					failed.rawPayload.exit_code === 3 &&
					failed.rawPayload.is_error === true &&
					failed.rawPayload.tool === "Bash",
				failed?.rawPayload,
			);
			judge.claim(
				T122_EXPECTATIONS.approved,
				approved?.rawPayload?.toolOutcome === "approved" &&
					!("exit_code" in (approved.rawPayload ?? {})) &&
					approved.rawPayload.is_error === false,
				approved?.rawPayload,
			);

			// The classifier: three copies of each stored row make "stuck" exactly when the row counts as a failure.
			const session = (await sessionRow(run, n)) as never;
			const verdictOf = (row: Row | undefined) =>
				classifySession({
					session,
					recentEvents: [row, row, row].map((r, i) => ({ ...r, id: i })) as never,
					now: new Date(),
				}).reasonCode;
			const counted = verdictOf(failed) === "repeated_tool_failure";
			const notCounted = verdictOf(approved) !== "repeated_tool_failure";
			judge.claim(T122_EXPECTATIONS.counted, counted && notCounted, { counted, notCounted });
		} finally {
			await host.dispose();
		}
		return out;
	},
};
