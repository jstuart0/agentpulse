/**
 * The live canary scenarios of AGEN-120 (subagents on a continued Claude session). Each takes S over with the
 * subagents option on and drives the real route, the real host and a real Claude (haiku) through the Agent call
 * and a helper's own tool calls, judging what the files on disk say.
 *
 *  - `subagent-approve`: the Agent call gets a card (approvable for the built-in type), a helper's `touch`
 *    gets its own card marked as a subagent's; a declined command leaves no file, an accepted one creates it
 *    inside the turn, and declining the Agent starts no helper.
 *  - `subagent-background`: a request for a background helper cannot outlive the turn (the env var); the fork
 *    stays managed.
 *  - `subagent-custom-type` (ask login): a user agent file's type is decline-only, its frontmatter hook never runs.
 *  - `subagent-stop-turn`: T119's interrupt during a helper stops the helper and the turn (runs after the
 *    rebase onto T119; before it the route is absent and the scenario is `instrumentInvalid`).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownClaudePids } from "../lib/claude-own-pids.js";
import {
	type Any,
	type Host,
	type Judge,
	type Recorder,
	type Run,
	type ScenarioFn,
	type Source,
	actionFor,
	answerNext,
	approvalRows,
	get,
	insertObserved,
	makeSource,
	managedRow,
	post,
	promptAndWait,
	resultCount,
	sawToolUse,
	sessionRow,
	sleep,
	sleepersOf,
	startHost,
	until,
} from "./helpers.js";

export const T120_SCENARIO_IDS = [
	"subagent-approve",
	"subagent-background",
	"subagent-custom-type",
	"subagent-stop-turn",
] as const;

/** A started host, S, and a finished takeover with the subagents option on: what each scenario begins with. */
async function preludeWithSubagents(
	run: Run,
	rec: Recorder,
	judge: Judge,
	name: string,
	setup?: (host: Host, s: Source) => void,
): Promise<{ host: Host; s: Source; n: string } | null> {
	const host = await startHost(run, name, "login");
	try {
		const s = makeSource(run, host, rec.sentinel, "Reply with just: ready");
		if (!judge.instrument("S was made under the throwaway config", s.id, s.why)) {
			await host.dispose();
			return null;
		}
		setup?.(host, s);
		await insertObserved(run, s, "canary S");
		const sent = await post(run, `/sessions/${s.id}/bind`, {
			targetSupervisorId: host.supervisorId,
			sameMachineConfirmed: true,
			forkOptions: { subagents: true },
		});
		const action = await until("the takeover to settle", 150_000, async () => {
			const row = await actionFor(run, s.id as string, "resume");
			return row && (row.status === "succeeded" || row.status === "failed") ? row : undefined;
		}).catch(() => actionFor(run, s.id as string, "resume"));
		const fork = (action?.metadata as Any)?.forkSessionId as string | undefined;
		if (
			!judge.pre(
				"the takeover succeeded",
				sent.status === 202 && action?.status === "succeeded" && Boolean(fork),
				action?.error ?? sent.body,
			)
		) {
			await host.dispose();
			return null;
		}
		const row = await sessionRow(run, fork as string);
		const applied = (row?.metadata as Any)?.forkOptions;
		if (!judge.pre("the host applied subagents", applied?.subagents === true, applied)) {
			await host.dispose();
			return null;
		}
		return { host, s, n: fork as string };
	} catch (error) {
		await host.dispose();
		throw error;
	}
}

const taskStarts = (rec: Recorder): Any[] =>
	rec.lines.filter((l) => l.type === "system" && l.subtype === "task_started");

const AGENT_TURN = (marker: string) =>
	`Use the Agent tool exactly once with subagent_type general-purpose, and give it this prompt: "Use the Bash tool to run exactly this command and nothing else: touch ${marker} - then reply with just: ok". After the helper returns, reply with just: finished.`;

/** Waits for the turn that started with `before` results to end. */
const turnEnded = (rec: Recorder, before: number, ms = 120_000) =>
	until("the turn to end", ms, () => resultCount(rec) > before).catch(() => false);

export const T120_SCENARIOS: Record<(typeof T120_SCENARIO_IDS)[number], ScenarioFn> = {
	async "subagent-approve"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const pre = await preludeWithSubagents(run, rec, judge, "subagent-approve");
		if (!pre) return out;
		const { host, s, n } = pre;
		try {
			const seen = new Set<string>();

			// 1. The Agent is approved, the helper's command is declined.
			const declined = join(s.cwd, "helper-declined.txt");
			let before = resultCount(rec);
			void promptAndWait(run, rec, n, AGENT_TURN("helper-declined.txt"));
			if (
				!judge.instrument(
					"Claude called Agent",
					await sawToolUse(rec, "Agent", "helper-declined"),
					rec.apiFailure,
				)
			)
				return out;
			const agentCard = await answerNext(run, n, "accept", seen);
			if (!judge.instrument("Claude's first request was answerable", agentCard)) return out;
			const agentPresentation = agentCard?.detail?.presentation ?? {};
			out.agentCard = {
				tool: agentPresentation.tool,
				type: agentPresentation.agent?.subagentType,
				builtIn: agentPresentation.agent?.builtIn,
				approvable: agentCard?.detail?.approvable ?? agentCard?.row?.approvable,
				fromSubagent: agentPresentation.fromSubagent,
			};
			judge.claim(
				"the first card is the Agent call, approvable for a built-in type",
				agentPresentation.tool === "Agent" &&
					agentPresentation.agent?.builtIn === true &&
					(agentCard?.detail?.approvable ?? agentCard?.row?.approvable) === true &&
					agentPresentation.fromSubagent === undefined,
				out.agentCard,
			);
			if (agentPresentation.tool !== "Agent") {
				// A helper started with no card for the Agent call: what was answered was the helper's own request.
				out.firstCardWas = agentPresentation.tool ?? agentCard?.row?.requestKind;
				await turnEnded(rec, before);
				return out;
			}
			const helperCard = await answerNext(run, n, "decline", seen);
			if (!judge.instrument("the helper asked for its command", helperCard)) return out;
			out.helperCard = {
				kind: helperCard?.row?.requestKind,
				fromSubagent: helperCard?.detail?.presentation?.fromSubagent,
			};
			judge.claim(
				"the helper's command card is marked as a subagent's",
				helperCard?.detail?.presentation?.fromSubagent === true &&
					String(helperCard?.detail?.presentation?.command ?? "").includes("helper-declined.txt"),
				out.helperCard,
			);
			judge.instrument("the turn ended", await turnEnded(rec, before), rec.apiFailure);
			judge.claim("the declined helper command left no file", !existsSync(declined));

			// 2. Both approved: the file is there when the turn ends.
			const made = join(s.cwd, "helper-made.txt");
			before = resultCount(rec);
			void promptAndWait(run, rec, n, AGENT_TURN("helper-made.txt"));
			if (
				!judge.instrument(
					"Claude called Agent again",
					await sawToolUse(rec, "Agent", "helper-made"),
				)
			)
				return out;
			const second = await answerNext(run, n, "accept", seen);
			const helper = await answerNext(run, n, "accept", seen);
			if (!judge.instrument("both cards were answered", second && helper)) return out;
			const ended = await turnEnded(rec, before);
			judge.instrument("the second turn ended", ended, rec.apiFailure);
			judge.claim("the accepted helper command created its file inside the turn", existsSync(made));

			// 3. A declined Agent call starts no helper.
			const never = join(s.cwd, "helper-never.txt");
			const startsBefore = taskStarts(rec).length;
			before = resultCount(rec);
			void promptAndWait(run, rec, n, AGENT_TURN("helper-never.txt"));
			if (
				!judge.instrument(
					"Claude called Agent a third time",
					await sawToolUse(rec, "Agent", "helper-never"),
				)
			)
				return out;
			const refused = await answerNext(run, n, "decline", seen);
			if (!judge.instrument("the third Agent call raised a card", refused)) return out;
			await turnEnded(rec, before);
			judge.claim(
				"declining the Agent starts no helper",
				taskStarts(rec).length === startsBefore && !existsSync(never),
				{ started: taskStarts(rec).length - startsBefore },
			);
			out.managed = (await managedRow(run, n))?.managedState;
		} finally {
			await host.dispose();
		}
		return out;
	},

	async "subagent-background"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const pre = await preludeWithSubagents(run, rec, judge, "subagent-background");
		if (!pre) return out;
		const { host, n } = pre;
		try {
			const seen = new Set<string>();
			const before = resultCount(rec);
			void promptAndWait(
				run,
				rec,
				n,
				"Call the Agent tool exactly once with subagent_type general-purpose and run_in_background set to true. The subagent's task: use Bash to run `sleep 12; touch bg-helper.txt`, then reply done. As soon as the Agent tool call returns, reply with just LAUNCHED and end your turn; do not wait for the subagent.",
			);
			judge.instrument(
				"Claude called Agent",
				await sawToolUse(rec, "Agent", "bg-helper"),
				rec.apiFailure,
			);
			// Answer whatever cards come (the Agent call, and the helper's command if it gets that far).
			const cards: Array<Record<string, unknown>> = [];
			for (let i = 0; i < 3; i++) {
				const answered = await answerNext(run, n, "accept", seen, i === 0 ? 60_000 : 20_000);
				if (answered)
					cards.push({
						tool: answered.detail?.presentation?.tool ?? answered.row?.requestKind,
						approvable: answered.row?.approvable,
						reason: answered.row?.notApprovableReason,
						status: answered.answer?.status,
					});
			}
			out.cards = cards;
			out.tasks = taskStarts(rec).map((t) => ({ type: t.subagent_type, bg: t.is_backgrounded }));
			out.agentResults = rec.lines
				.filter((l) => l.type === "user" && JSON.stringify(l.message ?? {}).includes("tool_result"))
				.map((l) => JSON.stringify(l.message).slice(0, 220));
			await turnEnded(rec, before, 90_000);
			// Past the time a background helper would have finished, spoken, and set off a turn of its own.
			await sleep(25_000);
			const row = await managedRow(run, n);
			out.state = row?.managedState;
			out.requestedBackground = rec.lines.some(
				(l) =>
					l.type === "assistant" &&
					Array.isArray(l.message?.content) &&
					l.message.content.some(
						(b: Any) =>
							b.type === "tool_use" && b.name === "Agent" && b.input?.run_in_background === true,
					),
			);
			out.backgroundStarted = taskStarts(rec).some((t) => t.is_backgrounded === true);
			judge.claim(
				"the fork stays managed through a request for a background helper",
				row?.managedState === "managed" && ownClaudePids(host.cfg).length > 0,
				out,
			);
		} finally {
			await host.dispose();
		}
		return out;
	},

	async "subagent-custom-type"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		if (run.login === "key") {
			// `--restricted` loads no user agent files: there is no custom type to meet.
			judge.instrument("this scenario needs the ask login (user agent files load there)", true);
			return { skipped: "restricted loads no user agent files" };
		}
		const pre = await preludeWithSubagents(run, rec, judge, "subagent-custom-type", (host) => {
			const marks = join(host.home, "marks");
			mkdirSync(marks, { recursive: true });
			mkdirSync(join(host.cfg, "agents"), { recursive: true });
			writeFileSync(
				join(host.cfg, "agents", "probeagent.md"),
				[
					"---",
					"name: probeagent",
					"description: Canary probe agent. Runs one Bash command.",
					"tools: Bash",
					"hooks:",
					"  PreToolUse:",
					"    - matcher: Bash",
					"      hooks:",
					"        - type: command",
					`          command: "touch ${join(marks, "hook-pretool.txt")}"`,
					"---",
					"You run exactly one Bash command and reply with DONE.",
					"",
				].join("\n"),
			);
		});
		if (!pre) return out;
		const { host, n } = pre;
		try {
			const marker = join(host.home, "marks", "hook-pretool.txt");
			const before = resultCount(rec);
			void promptAndWait(
				run,
				rec,
				n,
				'Use the Agent tool exactly once with subagent_type probeagent, description "probe", prompt "go". Then reply with just: finished.',
			);
			judge.instrument(
				"Claude called Agent for the custom type",
				await sawToolUse(rec, "Agent", "probeagent"),
				rec.apiFailure,
			);
			const row = (await until("the Agent card", 90_000, async () =>
				(await approvalRows(run, n)).find((r) => r.status === "pending"),
			).catch(() => null)) as Any;
			if (!judge.instrument("a card was raised for it", row)) return out;
			const detail = (await get(run, `/sessions/${n}/approvals/${row.id}`)).body as Any;
			out.card = {
				approvable: detail?.approvable ?? row.approvable,
				reason: detail?.notApprovableReason ?? row.notApprovableReason,
				type: detail?.presentation?.agent?.subagentType,
			};
			judge.claim(
				"the custom type's card is decline-only custom_agent",
				(detail?.approvable ?? row.approvable) === false &&
					(detail?.notApprovableReason ?? row.notApprovableReason) === "custom_agent",
				out.card,
			);
			const accepted = await post(run, `/sessions/${n}/approvals/${row.id}/decision`, {
				decision: "accept",
				presentationHash: detail?.presentationHash ?? row.presentationHash,
			});
			out.acceptStatus = accepted.status;
			judge.claim("an accept for it is refused", accepted.status === 409, accepted.body);
			await post(run, `/sessions/${n}/approvals/${row.id}/decision`, { decision: "decline" });
			await turnEnded(rec, before);
			await sleep(3_000);
			judge.claim(
				"no custom helper started and its frontmatter hook never ran",
				!existsSync(marker) && !taskStarts(rec).some((t) => t.subagent_type === "probeagent"),
				{ hook: existsSync(marker), started: taskStarts(rec).length },
			);
		} finally {
			await host.dispose();
		}
		return out;
	},

	async "subagent-stop-turn"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const pre = await preludeWithSubagents(run, rec, judge, "subagent-stop-turn");
		if (!pre) return out;
		const { host, s, n } = pre;
		try {
			const seen = new Set<string>();
			const started = join(s.cwd, "helper-started.txt");
			void promptAndWait(
				run,
				rec,
				n,
				'Use the Agent tool exactly once with subagent_type general-purpose, and give it this prompt: "Use the Bash tool to run exactly this command and nothing else: touch helper-started.txt && sleep 100". After the helper returns, reply with just: finished.',
			);
			judge.instrument(
				"Claude called Agent",
				await sawToolUse(rec, "Agent", "helper-started"),
				rec.apiFailure,
			);
			await answerNext(run, n, "accept", seen);
			const bash = await answerNext(run, n, "accept", seen);
			if (!judge.instrument("the helper asked for its command", bash)) return out;
			await until("the helper's command to start", 30_000, () => existsSync(started)).catch(
				() => {},
			);
			judge.pre("the helper's command started", existsSync(started));
			const sleepers = sleepersOf(ownClaudePids(host.cfg));
			judge.pre("a sleep descendant exists", sleepers.length > 0, sleepers.length);
			const resultsBefore = resultCount(rec);
			const interrupted = await post(run, `/sessions/${n}/interrupt`);
			out.interrupt = interrupted.status;
			// The route exists only once the Stop turn track (AGEN-119) is merged.
			if (
				!judge.instrument(
					"the interrupt route exists",
					interrupted.status !== 404,
					interrupted.body,
				)
			)
				return out;
			await until("the turn to end", 60_000, () => resultCount(rec) > resultsBefore).catch(
				() => {},
			);
			const result = rec.lines.filter((l) => l.type === "result").at(-1);
			out.terminalReason = result?.terminal_reason;
			judge.claim(
				"the interrupt ends the turn with the interrupted result",
				resultCount(rec) > resultsBefore && result?.terminal_reason === "aborted_tools",
				out.terminalReason,
			);
			await sleep(2_000);
			judge.claim(
				"the helper's command is gone and the fork is still managed",
				sleepersOf(ownClaudePids(host.cfg)).length === 0 &&
					(await managedRow(run, n))?.managedState === "managed",
				{ sleepers: sleepersOf(ownClaudePids(host.cfg)).length },
			);
		} finally {
			await host.dispose();
		}
		return out;
	},
};
