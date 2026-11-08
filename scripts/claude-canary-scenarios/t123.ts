/**
 * The live canary scenario of AGEN-123 (owner-only tool detail), `tool-detail`. A real fork runs an unasked
 * Read and a Bash `echo`; the signed-in person's `GET .../tool-calls` shows both, with the text; a manage key is
 * refused `human_required`; nothing of the file's contents is in any stored row. Then a rule is placed beneath
 * the fork's directory: a Read of a file under it reached through a symlink and a Bash command leave no detail.
 * The owner rule is covered by the route matrix, not here.
 *
 * Team mode was found feasible for this throwaway server (the mode is a stored setting the in-process server reads
 * per request, and the team fixtures seed a second member), but the scenario keeps the single person: the
 * matrix carries team mode, and a mode switch mid-scenario would only re-test what the matrix holds.
 */
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Any, ScenarioFn } from "./helpers.js";
import {
	answerNext,
	approvalRows,
	get,
	insertObserved,
	makeSource,
	post,
	randomSentinel,
	resultCount,
	sessionAssistantText,
	sleep,
	startHost,
	takeOver,
	until,
} from "./helpers.js";

export const T123_SCENARIO_IDS = ["tool-detail"] as const;

const DETAIL_LANDS_MS = 30_000;

export const T123_SCENARIOS: Record<(typeof T123_SCENARIO_IDS)[number], ScenarioFn> = {
	async "tool-detail"(run, rec, judge) {
		const host = await startHost(run, "tool-detail", "login");
		const out: Record<string, unknown> = {};
		try {
			const s = makeSource(run, host, rec.sentinel, "Reply with just: ready");
			if (!judge.instrument("S was made under the throwaway config", s.id, s.why)) return out;
			await insertObserved(run, s, "canary S");

			// The file Claude reads holds its own token: no prompt names it, so it can only reach a row if the
			// call's output does. (The detail-in-row mutation reads the token from the recorder.)
			const fileToken = randomSentinel("FT");
			const vaultToken = randomSentinel("VT");
			(rec as Any).leakToken = fileToken;
			writeFileSync(join(s.cwd, "read-me.txt"), `${fileToken}\n`);
			const vault = join(s.cwd, "vault");
			mkdirSync(vault, { recursive: true });
			writeFileSync(join(vault, "secret.txt"), `${vaultToken}\n`);
			// A mutation re-runs this scenario in the same directory; start the link afresh.
			rmSync(join(s.cwd, "link"), { force: true });
			symlinkSync(vault, join(s.cwd, "link"));

			const taken = await takeOver(run, host, s.id as string);
			if (!judge.pre("the takeover succeeded", taken.action?.status === "succeeded", taken.error))
				return out;
			const n = taken.fork as string;

			const seen = new Set<string>();
			/** Sends a prompt and answers whatever card it raises, until the turn's `result`. */
			const runTurn = async (text: string): Promise<boolean> => {
				const before = resultCount(rec);
				const sent = await post(run, `/sessions/${n}/prompt`, { prompt: text });
				if (sent.status >= 300) return false;
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					if (resultCount(rec) > before) return true;
					await answerNext(run, n, "accept", seen, 2_500);
				}
				return resultCount(rec) > before;
			};
			const index = async () =>
				(await get(run, `/sessions/${n}/tool-calls?view=index`)) as { status: number; body: Any };
			/**
			 * The tool-use ids Claude wrote from line `from` on, read from the wire. The timeline rows can't be
			 * the source: the server's content window drops a managed row identical to a recent one, so a second
			 * turn that does the same thing leaves none (found by this canary; not this ticket's to change).
			 */
			const toolUsesSince = (from: number): Array<{ id: string; name: string }> =>
				rec.lines
					.slice(from)
					.filter((line) => line.type === "assistant" && Array.isArray(line.message?.content))
					.flatMap((line) =>
						(line.message.content as Any[])
							.filter((block) => block?.type === "tool_use" && typeof block.id === "string")
							.map((block) => ({ id: block.id as string, name: String(block.name) })),
					);

			// ---- Turn A: no rules. An unasked Read, then a Bash echo.
			const wireBeforeA = rec.lines.length;
			const doneA = await runTurn(
				`Use the Read tool to read read-me.txt in the current directory, then use the Bash tool to run exactly this command: echo canary-${rec.sentinel}. Then reply with just: done`,
			);
			if (!judge.instrument("turn A ended", doneA)) return out;
			const usesA = toolUsesSince(wireBeforeA);
			const idsA = usesA.map((u) => u.id);
			judge.instrument(
				"Claude made a Read call and a Bash call",
				usesA.some((u) => u.name === "Read") && usesA.some((u) => u.name === "Bash"),
				usesA.map((u) => u.name),
			);
			const landed = await until("the detail of turn A", DETAIL_LANDS_MS, async () => {
				const listed = await index();
				const calls = (listed.body?.calls ?? []) as Any[];
				return calls.some((c) => c.tool === "Read") && calls.some((c) => c.tool === "Bash")
					? calls
					: undefined;
			}).catch(() => null);
			if (!judge.instrument("the host sent detail to a server that stores it", landed)) return out;
			const calls = landed as Any[];
			const readCall = calls.find((c) => c.tool === "Read");
			const bashCall = calls.find((c) => c.tool === "Bash");
			const readFull = (await get(run, `/sessions/${n}/tool-calls/${readCall.toolUseId}`)).body;
			const bashFull = (await get(run, `/sessions/${n}/tool-calls/${bashCall.toolUseId}`)).body;
			judge.claim(
				"the signed-in person reads both calls, with their text",
				String(readFull?.call?.output ?? "").includes(fileToken) &&
					String(bashFull?.call?.output ?? "").includes(`canary-${rec.sentinel}`),
				{ read: readFull?.call?.outcome, bash: bashFull?.call?.outcome },
			);
			const keyHeaders = { Authorization: `Bearer ${run.manage.key}` };
			const asKey = await Promise.all(
				[
					`/api/v1/sessions/${n}/tool-calls`,
					`/api/v1/sessions/${n}/tool-calls/${bashCall.toolUseId}`,
				].map(async (path) => {
					const res = await fetch(`${run.base}${path}`, { headers: keyHeaders });
					return {
						status: res.status,
						error: ((await res.json().catch(() => null)) as Any)?.error,
					};
				}),
			);
			judge.claim(
				"a manage key is refused human_required",
				asKey.every((r) => r.status === 403 && r.error === "human_required"),
				asKey,
			);

			// The file's contents are in no stored row (the prompt's own words are the one place the echoed text lives).
			const tables = async () => ({
				events: (
					(await run
						.getDb()
						.select()
						.from(run.t.events)
						.where(run.orm.eq(run.t.events.sessionId, n))) as Any[]
				).filter((row) => row.eventType !== "HeadlessPromptSubmitted"),
				approvals: await approvalRows(run, n),
				actions: (await run
					.getDb()
					.select()
					.from(run.t.controlActions)
					.where(run.orm.eq(run.t.controlActions.sessionId, n))) as Any[],
				session: (await run
					.getDb()
					.select()
					.from(run.t.sessions)
					.where(run.orm.eq(run.t.sessions.sessionId, n))) as Any[],
			});
			const assistant = await sessionAssistantText(run, n);
			judge.instrument(
				"Claude did not echo the file's contents in its own words",
				!assistant.includes(fileToken),
			);
			await sleep(1_500);
			const hits = Object.entries(await tables())
				.filter(([, rows]) => JSON.stringify(rows).includes(fileToken))
				.map(([name]) => name);
			judge.claim("the file's contents are in no stored row", hits.length === 0, hits);

			// ---- Turn B: a rule beneath the fork's directory.
			const exclude = join(host.home, ".agentpulse", "exclude");
			mkdirSync(join(host.home, ".agentpulse"), { recursive: true, mode: 0o700 });
			chmodSync(join(host.home, ".agentpulse"), 0o700);
			writeFileSync(exclude, `${vault}\n`, { mode: 0o600 });
			await sleep(1_500);
			const wireBeforeB = rec.lines.length;
			const doneB = await runTurn(
				`Use the Read tool to read link/secret.txt in the current directory, then use the Bash tool to run exactly this command: echo second-${rec.sentinel}. Then reply with just: done`,
			);
			if (!judge.instrument("turn B ended", doneB)) return out;
			const usesB = toolUsesSince(wireBeforeB);
			const idsB = usesB.map((u) => u.id);
			if (
				!judge.pre(
					"Claude made a Read call and a Bash call in turn B",
					usesB.some((u) => u.name === "Read") && usesB.some((u) => u.name === "Bash"),
					usesB.map((u) => u.name),
				)
			)
				return out;
			await sleep(6_000);
			const afterB = ((await index()).body?.calls ?? []) as Any[];
			const keptForB = afterB.filter((c) => idsB.includes(c.toolUseId)).map((c) => c.tool);
			judge.claim("no detail is kept for the excluded calls", keptForB.length === 0, keptForB);
			const hitsB = Object.entries(await tables())
				.filter(([, rows]) => JSON.stringify(rows).includes(vaultToken))
				.map(([name]) => name);
			judge.claim("the excluded file's contents are in no stored row", hitsB.length === 0, hitsB);
			out.callsA = idsA.length;
			out.callsB = idsB.length;
		} finally {
			await host.dispose();
		}
		return out;
	},
};
