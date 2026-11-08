/**
 * The live canary scenarios of Stop turn (AGEN-119): a person ends what a continued Claude session is doing and
 * the session stays open. Real Claude, real server, real host and supervisor code in one process (see
 * `claude-takeover-canary.ts`); the scenarios import what they need from `./helpers.js`.
 *
 *   stop-turn              an approved Bash `sleep` is stopped: the same process, the command gone, IDLE, a second prompt answers
 *   stop-turn-pending      a card is open when the turn is stopped: it closes `turn_stopped` and a later accept is refused
 *   stop-turn-before-send  the stop lands before the prompt is sent: nothing reaches Claude (the pre-send checks are slowed on purpose so it does)
 *   stop-turn-race         a stop racing a short command: a stop is only ever reported for an abort
 *
 * The call row's `toolOutcome: "stopped"` and the classifier's zero failures belong to AGEN-122 (T122): they are
 * judged here only once rows carry a `toolOutcome` at all, and `needsT122` says when they were not.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getOperationalStatus } from "../../src/shared/session-state.js";
import {
	INTERRUPTED_BEFORE_SEND_CODE,
	INTERRUPTED_TERMINAL_REASONS,
	STOPPED_BEFORE_SEND,
	TURN_STOPPED_BY_PERSON,
} from "../../src/shared/stop-turn.js";
import { ownClaudePids } from "../lib/claude-own-pids.js";
import {
	type Any,
	type Run,
	type ScenarioFn,
	actionFor,
	answerNext,
	approvalRows,
	forkLines,
	initLines,
	pidAlive,
	post,
	prelude,
	promptAndWait,
	sessionAssistantText,
	sessionRow,
	sleep,
	sleepersOf,
	until,
	userLinesOut,
} from "./helpers.js";

export const T119_SCENARIO_IDS = [
	"stop-turn",
	"stop-turn-pending",
	"stop-turn-before-send",
	"stop-turn-race",
] as const;

type StreamProto = Record<string, (...args: Any[]) => Any>;

/** Patches the fork runtime's prototype for one scenario and gives it back; nothing here signals a process. */
async function patchRuntime(patch: (proto: StreamProto) => void): Promise<() => void> {
	const { ClaudeStreamRuntime } = await import("../../src/supervisor/providers/claude-stream.js");
	const proto = ClaudeStreamRuntime.prototype as unknown as StreamProto;
	// Class methods are non-enumerable, so a spread copies none of them and a restore built on it puts nothing back
	// (found by this canary: a patched interruptTurn leaked into the next mutation's scenario, which then read as
	// instrumentInvalid). The descriptors are what to save.
	const originals = Object.getOwnPropertyDescriptors(proto);
	patch(proto);
	return () => {
		for (const key of Object.getOwnPropertyNames(proto)) {
			if (!(key in originals)) delete proto[key];
		}
		Object.defineProperties(proto, originals);
	};
}

const callRows = async (run: Run, sessionId: string) =>
	(
		(await run
			.getDb()
			.select()
			.from(run.t.events)
			.where(run.orm.eq(run.t.events.sessionId, sessionId))) as Any[]
	).filter((row) => (row.rawPayload as Any)?.kind === "call");

const turnEnds = async (run: Run, sessionId: string) =>
	(
		(await run
			.getDb()
			.select()
			.from(run.t.events)
			.where(run.orm.eq(run.t.events.sessionId, sessionId))) as Any[]
	).filter(
		(row) =>
			row.eventType === "HeadlessPromptFailed" || row.eventType === "HeadlessPromptCompleted",
	);

const settled = (status: unknown) => status === "succeeded" || status === "failed";

/** Waits for the newest action of a type to leave queued and running. */
const settledAction = (run: Run, sessionId: string, type: string, ms = 30_000) =>
	until(`the ${type} to settle`, ms, async () => {
		const action = await actionFor(run, sessionId, type);
		return action && settled(action.status) ? action : undefined;
	}).catch(() => actionFor(run, sessionId, type)) as Promise<Any>;

const lastResult = (rec: Parameters<ScenarioFn>[1]) => forkLines(rec, "result").at(-1);

export const T119_SCENARIOS: Record<(typeof T119_SCENARIO_IDS)[number], ScenarioFn> = {
	/** Main path: an approved long Bash command is stopped and the session carries on. */
	async "stop-turn"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const pre = await prelude(run, rec, judge, "stop-turn");
		if (!pre) return out;
		const { host, s, n } = pre;
		const restore =
			run.mutation === "interrupt-as-stop"
				? await patchRuntime((proto) => {
						// The mutation: Stop turn is the End session ladder.
						proto.interruptTurn = async function (this: Any) {
							await this.stop();
							return { status: "interrupted" };
						};
					})
				: () => {};
		try {
			const started = join(s.cwd, `st-started-${rec.sentinel}.txt`);
			const done = join(s.cwd, `st-done-${rec.sentinel}.txt`);
			void promptAndWait(
				run,
				rec,
				n,
				`Use the Bash tool to run exactly this command, with no timeout and no background option, and nothing else: touch st-started-${rec.sentinel}.txt; sleep 100; touch st-done-${rec.sentinel}.txt`,
			);
			const answered = await answerNext(run, n, "accept", new Set<string>());
			if (!judge.instrument("Claude asked for the Bash command", answered)) return out;
			await until("the command to start", 30_000, () => existsSync(started)).catch(() => {});
			judge.pre("the command started", existsSync(started));
			const pidsBefore = ownClaudePids(host.cfg);
			judge.pre("the fork is running", pidsBefore.length > 0, pidsBefore.length);
			const sleepers = sleepersOf(pidsBefore);
			judge.pre("a sleep descendant exists", sleepers.length > 0, sleepers.length);
			const promptAction = await actionFor(run, n, "prompt");
			judge.pre("the prompt holds the turn (running)", promptAction?.status === "running");

			const interrupted = await post(run, `/sessions/${n}/interrupt`);
			out.interruptStatus = interrupted.status;
			judge.pre("the server accepted the interrupt", interrupted.status === 202, interrupted.body);
			const interrupt = await settledAction(run, n, "interrupt");
			out.interrupt = {
				status: interrupt?.status,
				error: interrupt?.error,
				metadata: interrupt?.metadata,
			};
			judge.claim(
				"the interrupt succeeded and says it interrupted",
				interrupt?.status === "succeeded" && interrupt?.metadata?.interrupted === true,
				out.interrupt,
			);
			const prompt = await until("the prompt to settle", 30_000, async () => {
				const row = await actionFor(run, n, "prompt");
				return row && settled(row.status) ? row : undefined;
			}).catch(() => null);
			out.prompt = { status: prompt?.status, error: prompt?.error };
			judge.claim(
				"the prompt action failed with 'Turn stopped by a person.'",
				prompt?.status === "failed" && prompt?.error === TURN_STOPPED_BY_PERSON,
				out.prompt,
			);
			await sleep(1_500);
			const pidsAfter = ownClaudePids(host.cfg);
			judge.claim(
				"the fork's process is the same one and still alive",
				pidsBefore.length > 0 &&
					pidsBefore.every((pid) => pidsAfter.includes(pid) && pidAlive(pid)),
				{ before: pidsBefore, after: pidsAfter },
			);
			await until("the sleep to end", 15_000, () => sleepers.every((pid) => !pidAlive(pid))).catch(
				() => {},
			);
			judge.claim(
				"the Bash descendant is gone",
				sleepers.every((pid) => !pidAlive(pid)),
				sleepers.filter(pidAlive),
			);
			judge.claim(
				"the command started and did not finish",
				existsSync(started) && !existsSync(done),
			);
			const row = await sessionRow(run, n);
			out.operational = getOperationalStatus(row);
			judge.claim(
				"the session reads IDLE, not WAITING",
				out.operational === "idle",
				out.operational,
			);
			judge.claim(
				"no approval card is still pending",
				(await approvalRows(run, n)).every((r) => r.status !== "pending"),
			);
			const rows = await callRows(run, n);
			const withOutcome = rows.filter((r) => (r.rawPayload as Any)?.toolOutcome !== undefined);
			out.callRows = rows.length;
			if (withOutcome.length > 0) {
				judge.claim(
					"the call cut short is recorded as stopped, never failed",
					withOutcome.every((r) => (r.rawPayload as Any).toolOutcome === "stopped"),
					withOutcome.map((r) => (r.rawPayload as Any).toolOutcome),
				);
			} else {
				out.needsT122 =
					"no call row carries toolOutcome yet: the stopped-outcome and classifier checks wait for T122";
			}
			const second = await promptAndWait(run, rec, n, "Reply with just: second");
			judge.claim(
				"a second prompt answers",
				second.done && (await sessionAssistantText(run, n)).includes("second"),
				{ status: second.status, done: second.done },
			);
		} finally {
			restore();
			await host.dispose();
		}
		return out;
	},

	/** A card is open when the turn is stopped: it closes `turn_stopped`, and an accept after the interrupt committed is refused. */
	async "stop-turn-pending"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const pre = await prelude(run, rec, judge, "stop-turn-pending");
		if (!pre) return out;
		const { host, s, n } = pre;
		try {
			const file = join(s.cwd, `pend-${rec.sentinel}.txt`);
			void promptAndWait(
				run,
				rec,
				n,
				`Use the Bash tool to run exactly this command, and nothing else: touch pend-${rec.sentinel}.txt`,
			);
			const row = (await until("a pending approval", 90_000, async () =>
				(await approvalRows(run, n)).find((r) => r.status === "pending"),
			).catch(() => null)) as Any;
			if (!judge.instrument("Claude asked for the command", row)) return out;
			const hash = row.presentationHash as string;

			if (run.mutation === "no-turn-fence") {
				// The mutation: the interrupt is a bare row (no fence at enqueue) that names no target (no predicate).
				const id = crypto.randomUUID();
				const managed = (
					await run
						.getDb()
						.select()
						.from(run.t.managedSessions)
						.where(run.orm.eq(run.t.managedSessions.sessionId, n))
				)[0] as Any;
				await run
					.getDb()
					.insert(run.t.controlActions)
					.values({
						id,
						sessionId: n,
						launchRequestId: managed.launchRequestId,
						actionType: "interrupt",
						status: "queued",
						requestedBy: "user",
						metadata: { runtime: "claude_stream" },
					});
				judge.pre(
					"the (unfenced) interrupt row exists",
					Boolean(await actionFor(run, n, "interrupt")),
				);
			} else {
				const interrupted = await post(run, `/sessions/${n}/interrupt`);
				judge.pre(
					"the server accepted the interrupt",
					interrupted.status === 202,
					interrupted.body,
				);
			}
			const interruptRow = await actionFor(run, n, "interrupt");
			judge.pre(
				"the accept is posted before the host has claimed the interrupt",
				interruptRow?.status === "queued",
				interruptRow?.status,
			);
			const accept = await post(run, `/sessions/${n}/approvals/${row.id}/decision`, {
				decision: "accept",
				presentationHash: hash,
			});
			out.accept = { status: accept.status, body: accept.body };
			judge.claim(
				"the accept after the interrupt is refused turn_interrupted",
				accept.status === 409 && accept.body?.error === "turn_interrupted",
				out.accept,
			);
			await settledAction(run, n, "interrupt");
			await sleep(5_000);
			const after = (await approvalRows(run, n)).find((r) => r.id === row.id) as Any;
			out.row = {
				status: after?.status,
				closedReason: after?.closedReason,
				delivered: after?.firstDeliveredAt,
			};
			judge.claim(
				"the card closed turn_stopped and was never delivered",
				after?.status === "closed" &&
					after?.closedReason === "turn_stopped" &&
					after?.firstDeliveredAt == null,
				out.row,
			);
			judge.claim("the command did not run", !existsSync(file));
			const pids = ownClaudePids(host.cfg);
			judge.claim("the fork is still alive", pids.length > 0 && pids.every(pidAlive), pids);
		} finally {
			await host.dispose();
		}
		return out;
	},

	/**
	 * The stop lands before the prompt is sent. The host's pre-send check is slowed (and the control loop made
	 * concurrent, as the production supervisor's is) so the interrupt is claimed inside that window; otherwise this
	 * branch is a race the live host almost never loses. Each branch is judged on its own (B2-N4).
	 */
	async "stop-turn-before-send"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const pre = await prelude(run, rec, judge, "stop-turn-before-send");
		if (!pre) return out;
		const { host, n } = pre;
		const restore = await patchRuntime((proto) => {
			const checks = proto.assertNotOpenElsewhere as (this: Any) => Promise<void>;
			proto.assertNotOpenElsewhere = async function (this: Any) {
				await sleep(6_000);
				return checks.call(this);
			};
			if (run.mutation === "no-before-send-check") {
				// The mutation: the interrupt says it cancelled the send but never sets what sendPrompt checks.
				proto.cancelUnsentTurn = async () => ({ status: "interrupted", beforeSend: true });
			}
		});
		host.pump.concurrent = true;
		try {
			const initsBefore = initLines(rec).length;
			const userLinesBefore = userLinesOut(rec).length;
			const sent = await post(run, `/sessions/${n}/prompt`, { prompt: "Reply with just: never" });
			judge.pre("the prompt was queued", sent.status === 202, sent.body);
			const running = await until("the host to take the prompt", 30_000, async () => {
				const row = await actionFor(run, n, "prompt");
				return row?.status === "running" ? row : undefined;
			}).catch(() => null);
			if (!judge.instrument("the host took the prompt on", running)) return out;
			const interrupted = await post(run, `/sessions/${n}/interrupt`);
			judge.pre("the server accepted the interrupt", interrupted.status === 202, interrupted.body);
			const interrupt = await settledAction(run, n, "interrupt", 45_000);
			const beforeSend = interrupt?.metadata?.beforeSend === true;
			out.interrupt = {
				status: interrupt?.status,
				error: interrupt?.error,
				metadata: interrupt?.metadata,
			};
			if (
				!judge.instrument(
					"the interrupt landed before the prompt was sent",
					beforeSend,
					out.interrupt,
				)
			) {
				// (ii): it landed after the user line. Judged as a normal interrupt, which needs a result that says abort.
				await sleep(8_000);
				const result = lastResult(rec);
				judge.claim(
					"a stop that landed after the prompt ended as an abort, never a natural result",
					interrupt?.metadata?.interrupted === true &&
						result?.is_error === true &&
						INTERRUPTED_TERMINAL_REASONS.includes(result?.terminal_reason),
					{ interrupt: out.interrupt, terminal: result?.terminal_reason },
				);
				return out;
			}
			// (i): cancelled before it was sent.
			judge.claim("the interrupt succeeded", interrupt?.status === "succeeded", out.interrupt);
			// Past the slowed pre-send checks, to the prompt's own end: a send that was not cancelled has happened by now.
			await until("the prompt to settle", 60_000, async () => {
				const row = await actionFor(run, n, "prompt");
				return row && settled(row.status) ? row : undefined;
			}).catch(() => {});
			const prompt = await actionFor(run, n, "prompt");
			out.prompt = { status: prompt?.status, error: prompt?.error };
			judge.claim(
				"the prompt failed 'Stopped before Claude got the prompt'",
				prompt?.status === "failed" && prompt?.error === STOPPED_BEFORE_SEND,
				out.prompt,
			);
			judge.claim(
				"nothing reached Claude for the cancelled prompt",
				initLines(rec).length === initsBefore && userLinesOut(rec).length === userLinesBefore,
				{
					inits: initLines(rec).length - initsBefore,
					userLines: userLinesOut(rec).length - userLinesBefore,
				},
			);
			judge.claim("no tool row was written", (await callRows(run, n)).length === 0);
			const ends = (await turnEnds(run, n)).filter((e) => e.eventType === "HeadlessPromptFailed");
			judge.claim(
				"exactly one interrupted end event, with the before-send code",
				ends.length === 1 &&
					(ends[0].rawPayload as Any)?.status === "interrupted" &&
					(ends[0].rawPayload as Any)?.code === INTERRUPTED_BEFORE_SEND_CODE,
				ends.map((e) => e.rawPayload),
			);
			judge.claim(
				"the session reads IDLE",
				getOperationalStatus(await sessionRow(run, n)) === "idle",
			);
			host.pump.concurrent = false;
			restore();
			const next = await promptAndWait(run, rec, n, "Reply with just: after");
			judge.claim(
				"the session carries on: the next prompt answers",
				next.done && (await sessionAssistantText(run, n)).includes("after"),
			);
		} finally {
			host.pump.concurrent = false;
			restore();
			await host.dispose();
		}
		return out;
	},

	/** A stop racing a short command. Whatever the race, a stop is only reported for an abort. */
	async "stop-turn-race"(run, rec, judge) {
		const out: Record<string, unknown> = {};
		const pre = await prelude(run, rec, judge, "stop-turn-race");
		if (!pre) return out;
		const { host, n } = pre;
		const seen: Array<{ isError: unknown; terminal: unknown }> = [];
		const restore = await patchRuntime((proto) => {
			const onResult = proto.onResult as (this: Any, turn: Any, result: Any) => void;
			proto.onResult = function (this: Any, turn: Any, result: Any) {
				if (run.mutation === "flag-decides" && turn.interruptRequested) {
					// The mutation. A live Claude aborts when interrupted, so the natural-race case is manufactured:
					// the runtime is given a natural result, and a runtime that lets the flag alone decide is
					// shown an abort in its place, which is what "the flag decides" means.
					seen.push({ isError: false, terminal: "completed" });
					return onResult.call(this, turn, {
						...result,
						is_error: true,
						terminal_reason: INTERRUPTED_TERMINAL_REASONS[0],
					});
				}
				seen.push({ isError: result.is_error, terminal: result.terminal_reason });
				return onResult.call(this, turn, result);
			};
		});
		try {
			void promptAndWait(
				run,
				rec,
				n,
				`Use the Bash tool to run exactly this command, with no timeout and no background option, and nothing else: touch race-${rec.sentinel}.txt; sleep 8`,
			);
			// Answered and stopped back to back: the answer is not waited out (answerNext waits for the command to end).
			const card = (await until("a pending approval", 90_000, async () =>
				(await approvalRows(run, n)).find((r) => r.status === "pending"),
			).catch(() => null)) as Any;
			if (!judge.instrument("Claude asked for the Bash command", card)) return out;
			await post(run, `/sessions/${n}/approvals/${card.id}/decision`, {
				decision: "accept",
				presentationHash: card.presentationHash,
			});
			const interrupted = await post(run, `/sessions/${n}/interrupt`);
			out.interruptStatus = interrupted.status;
			if (
				!judge.instrument("the interrupt was queued", interrupted.status === 202, interrupted.body)
			) {
				return out;
			}
			const interrupt = await settledAction(run, n, "interrupt", 45_000);
			const prompt = await until("the prompt to settle", 60_000, async () => {
				const row = await actionFor(run, n, "prompt");
				return row && settled(row.status) ? row : undefined;
			}).catch(() => null);
			await sleep(1_000);
			out.interrupt = {
				status: interrupt?.status,
				error: interrupt?.error,
				metadata: interrupt?.metadata,
			};
			out.prompt = { status: prompt?.status, error: prompt?.error };
			out.resultsSeen = seen;
			const ends = await turnEnds(run, n);
			out.ends = ends.map((e) => [e.eventType, (e.rawPayload as Any)?.status]);
			if (run.mutation === "flag-decides") {
				judge.pre(
					"a natural result reached the runtime after the flag was set",
					seen.some((r) => r.isError === false),
					seen,
				);
			}
			const stopped = prompt?.error === TURN_STOPPED_BY_PERSON;
			const aborts = seen.every(
				(r) => r.isError === true && INTERRUPTED_TERMINAL_REASONS.includes(String(r.terminal)),
			);
			judge.claim(
				"a result that was not an abort is never reported as a stop",
				!stopped || aborts,
				{ prompt: out.prompt, seen },
			);
			// Which branch the race took is recorded, and each is a legal ending.
			const branch = stopped
				? "interrupted"
				: interrupt?.status === "failed"
					? "target already ended at the claim"
					: interrupt?.metadata?.interrupted === false
						? "natural result"
						: "other";
			out.branch = branch;
			judge.claim(
				"the race ended in a legal branch",
				branch !== "other" &&
					(await approvalRows(run, n)).every((r) => r.status !== "pending") &&
					ownClaudePids(host.cfg).length > 0,
				{ branch },
			);
		} finally {
			restore();
			await host.dispose();
		}
		return out;
	},
};
