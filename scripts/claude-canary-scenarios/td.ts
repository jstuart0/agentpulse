/**
 * The integration scenario of Track TD: two forks alive on one host at once. Each takeover checks `agents --json`
 * for its own session id (and must find its own entry, never the other fork's), so the second takeover runs while
 * the first fork's process is listed. Then each fork gets its own prompt and answers with its own token, and
 * neither source session is touched.
 */
import type { ScenarioFn } from "./helpers.js";
import {
	insertObserved,
	listedFor,
	makeSource,
	promptAndWait,
	randomSentinel,
	sameExisting,
	sessionAssistantText,
	startHost,
	takeOver,
} from "./helpers.js";

export const TD_SCENARIO_IDS = ["two-forks"] as const;

export const TD_SCENARIOS: Record<(typeof TD_SCENARIO_IDS)[number], ScenarioFn> = {
	async "two-forks"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const host = await startHost(run, "two-forks", "login");
		try {
			const first = makeSource(run, host, rec.sentinel, "Reply with just: ready");
			if (!judge.instrument("source 1 was made under the throwaway config", first.id, first.why))
				return out;
			const second = makeSource(run, host, rec.sentinel, "Reply with just: ready");
			if (!judge.instrument("source 2 was made under the throwaway config", second.id, second.why))
				return out;
			if (!judge.pre("the two sources are different sessions", first.id !== second.id)) return out;
			await insertObserved(run, first, "canary S1");
			await insertObserved(run, second, "canary S2");

			const one = await takeOver(run, host, first.id as string);
			if (!judge.pre("the first takeover succeeded", one.action?.status === "succeeded", one.error))
				return out;
			// Positive control: the first fork really is listed, so the second takeover has another entry to ignore.
			if (
				!judge.pre(
					"the first fork is listed by agents --json",
					listedFor(run, host, first.cwd, one.fork as string),
				)
			)
				return out;
			const two = await takeOver(run, host, second.id as string);
			out.second = { status: two.action?.status, error: String(two.error ?? "").slice(0, 160) };
			judge.claim(
				"the second takeover succeeds while the first fork is alive",
				two.action?.status === "succeeded",
				out.second,
			);
			if (two.action?.status !== "succeeded") return out;
			const a = one.fork as string;
			const b = two.fork as string;
			judge.claim(
				"the two forks are different sessions, neither a source",
				new Set([a, b, first.id, second.id]).size === 4,
				{ a, b },
			);

			const tokenA = randomSentinel("TA");
			const tokenB = randomSentinel("TB");
			const gotA = await promptAndWait(run, rec, a, `Reply with just: ${tokenA}`);
			const gotB = await promptAndWait(run, rec, b, `Reply with just: ${tokenB}`);
			judge.instrument("both prompts were taken and their turns ended", gotA.done && gotB.done, {
				a: gotA.status,
				b: gotB.status,
			});
			const textA = await sessionAssistantText(run, a);
			const textB = await sessionAssistantText(run, b);
			judge.claim(
				"each fork answers its own prompt and not the other's",
				textA.includes(tokenA) &&
					!textA.includes(tokenB) &&
					textB.includes(tokenB) &&
					!textB.includes(tokenA),
				{ a: textA.slice(0, 80), b: textB.slice(0, 80) },
			);
			judge.claim(
				"neither source session was written",
				sameExisting(first) && sameExisting(second),
			);
		} finally {
			await host.dispose();
		}
		return out;
	},
};
