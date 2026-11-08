/**
 * Runs one claimed control action (stop, prompt, workarea cleanup) and reports
 * its result.
 *
 * Before anything is executed the action is checked with the report gate. A session
 * is judged by the directory this supervisor started it in; the directory the
 * action itself names is only compared with it (a different one is refused, a
 * covered one excludes), never believed in its place. While rules exist an action
 * for a session this supervisor did not start is refused, and one that is not
 * about a session is judged by the directory it names. A refused action is not
 * executed and the only thing reported is the gate's generic failure. While the
 * exclude file is invalid nothing is executed and nothing is reported. Every
 * report an action makes, including one that arrives after it finished running,
 * goes through the gate.
 *
 * While rules exist every way a workarea cleanup can be refused answers with the one
 * generic body, so whether a path is covered, outside the trusted roots or missing is not
 * learnable from the answer; the specifics go to the host's own log. The difference
 * between a cleanup that ran and one that was refused stays visible for a path under a
 * trusted root, which is inherent to reporting a result at all. With no rules file the
 * bodies are what they always were.
 */
import { CLAUDE_TURN_CONTROL, CLAUDE_TURN_RENEWAL_MS } from "../shared/constants.js";
import {
	CLAUDE_FORK_NOT_HEADLESS_ERROR,
	CLAUDE_FORK_RECORD_UNREADABLE_ERROR,
	CLAUDE_STREAM_HELD_ERROR,
	NOTHING_RUNNING_STOP_NOTE,
	STOPPED_BY_PERSON_ERROR,
	STOPPED_UNCHECKED_NOTE,
	STOP_FAILED_ERROR,
} from "../shared/managed-messages.js";
import { STOP_RUNTIMES } from "../shared/stop-runtime.js";
import { TURN_DIDNT_STOP, TURN_STOP_NOT_SENT } from "../shared/stop-turn.js";
import type { ControlAction, ManagedState } from "../shared/types.js";
import { MANAGED_STATES } from "../shared/types.js";
import type { LaunchCallbacks } from "./providers/claude-shared.js";
import { ClaudePromptRefusal, ClaudePromptWithheld } from "./providers/claude-stream.js";
import type {
	hasClaudeStreamRuntime,
	hasHeadlessRuntime,
	interruptClaudeStreamSession,
	promptClaudeHeadlessSession,
	promptClaudeInteractiveSession,
	promptClaudeStreamSession,
	stopClaudeStreamSession,
	stopHeadlessClaude,
} from "./providers/claude.js";
import type {
	hasManagedCodexRuntime,
	promptManagedCodexSession,
	stopManagedCodexSession,
} from "./providers/codex-managed.js";
import { CodexPromptWithheld } from "./providers/codex-shared.js";
import { CleanupError, type executeCleanupWorkArea } from "./services/cleanup-workarea.js";
import { type FinalReporter, sendOnce } from "./services/final-report.js";
import { type ReportGate, controlRefusalBody } from "./services/report-gate.js";
import { canonicalSpawnCwd } from "./services/spawn-cwd.js";

export type ControlProviders = {
	stopManagedCodexSession: typeof stopManagedCodexSession;
	promptManagedCodexSession: typeof promptManagedCodexSession;
	hasManagedCodexRuntime: typeof hasManagedCodexRuntime;
	promptClaudeHeadlessSession: typeof promptClaudeHeadlessSession;
	promptClaudeInteractiveSession: typeof promptClaudeInteractiveSession;
	stopHeadlessClaude: typeof stopHeadlessClaude;
	/** A takeover fork's long-lived process (AGEN-117 T16). */
	promptClaudeStreamSession: typeof promptClaudeStreamSession;
	stopClaudeStreamSession: typeof stopClaudeStreamSession;
	/** Stop turn: ends what a fork's Claude is doing and keeps the process (AGEN-119). */
	interruptClaudeStreamSession: typeof interruptClaudeStreamSession;
	hasClaudeStreamRuntime: typeof hasClaudeStreamRuntime;
	hasHeadlessRuntime: typeof hasHeadlessRuntime;
};

export interface ControlActionDeps {
	gate: ReportGate;
	trustedRoots: string[];
	providers: ControlProviders;
	executeCleanupWorkArea: typeof executeCleanupWorkArea;
	/** Runs a `resume` action (see services/session-resume.ts). Absent: this build can't, and says so. */
	resumeSession?: (action: ControlAction, sessionId: string) => Promise<void>;
	/**
	 * What this host's own record says about the id: a fork it started, not one, or unknown (the record is there
	 * and can't be believed). The one-prompt path refuses a fork whatever a prompt action's metadata says, so a
	 * server that predates `metadata.runtime` (or was rolled back) can't send a fork down the path that would
	 * start `claude --resume` on it, and refuses when it can't tell. Absent: no record is kept.
	 */
	forkStatus?: (sessionId: string) => "fork" | "not_fork" | "unknown";
	/**
	 * Whether Claude Code on this machine still lists a fork this host holds no process for. A degraded fork's
	 * End asks: a command an earlier approval started may still be running (AGEN-117 T11). Absent: not asked.
	 */
	forkListed?: (sessionId: string) => Promise<"listed" | "not_listed" | "unknown">;
	/** Whether the server said it can do `feature` (registration and every heartbeat). Absent: it said nothing. */
	serverHas?: (feature: string) => boolean;
	/** Runs `callback` every `ms` until the returned handle stops it. The default is an unref'd interval. */
	schedule?: (callback: () => void, ms: number) => { stop(): void };
	/** Sends a turn's last status until the server answers. Absent: one attempt, as before. */
	finalReport?: FinalReporter;
	log?: (line: string) => void;
}

const defaultSchedule = (callback: () => void, ms: number) => {
	const timer = setInterval(callback, ms);
	timer.unref?.();
	return { stop: () => clearInterval(timer) };
};

const STOPPED_EVENT_CONTENT = "Managed session stopped by operator.";

/** A caught value as one line of host log; never sent to the server. */
function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The directory an action names itself; the gate only compares it with what it knows. */
function namedDirectory(action: ControlAction): string | undefined {
	if (action.actionType !== "prompt" && action.actionType !== "cleanup_workarea") return undefined;
	const cwd = asRecord(action.metadata)?.cwd;
	return typeof cwd === "string" && cwd ? cwd : undefined;
}

const PROMPT_WORDS = {
	missingPrompt: "Prompt action is missing its prompt text.",
	unknownAgent: "This host can't send prompts to this kind of session.",
	mismatch: "This session's records don't match how it was launched, so nothing was sent.",
	/** What a continued session's prompt failure says when the cause is the host's own to keep (detail goes to its log). */
	failed: "The prompt couldn't be sent. Try again.",
} as const;

/** The words a failed stop carries. Fixed: nothing about the host or the process is echoed. */
export const STOP_WORDS = {
	terminal:
		"A Claude session running in a terminal can't be stopped from AgentPulse. Close it in the terminal.",
	unsupported: "This host can't stop this kind of session.",
	finishing:
		"A command on this machine is still finishing, so the session can't be stopped yet. Try again when it's done.",
	failed: STOP_FAILED_ERROR,
} as const;

/**
 * What the server says this stop must stop (`metadata.runtime`). Absent is Codex, which is all a server
 * from before this field ever queued; a value this build doesn't know is not guessed at.
 */
function readStopRuntime(action: ControlAction): string | null {
	const runtime = asRecord(action.metadata)?.runtime;
	if (runtime === undefined) return STOP_RUNTIMES.codex;
	return typeof runtime === "string" ? runtime : null;
}

/** The plain words for why a Codex session in this state can't take a prompt. The raw value is never echoed. */
function wrongStateMessage(state: ManagedState | null): string {
	const words =
		state === "degraded"
			? "having trouble reaching Codex"
			: state === "pending" || state === "linked"
				? "still starting up"
				: state === "stopped" || state === "completed" || state === "failed"
					? "already finished"
					: "not ready";
	return `This session can't take a prompt because it's ${words}.`;
}

export function createControlActionHandler(
	deps: ControlActionDeps,
): (action: ControlAction) => Promise<void> {
	const { gate, providers } = deps;
	const log = deps.log ?? ((line: string) => console.log(line));
	const schedule = deps.schedule ?? defaultSchedule;
	const finalReport = deps.finalReport ?? sendOnce;

	/** Status results, always through the gate: `succeeded` for a session that is now excluded becomes the generic failure. */
	const report = async (
		action: ControlAction,
		body: Parameters<ReportGate["reportControlStatus"]>[2],
	): Promise<void> => {
		await gate.reportControlStatus(
			action.id,
			action.sessionId ?? null,
			body,
			namedDirectory(action),
		);
	};

	/** The session reads stopped, and the timeline says so in the words given (a stop of nothing doesn't claim a process was stopped). */
	async function reportStopped(sessionId: string, content = STOPPED_EVENT_CONTENT) {
		await gate.reportState({
			sessionId,
			status: "completed",
			managedState: "stopped" satisfies ManagedState,
			providerSyncState: "synced",
		});
		await gate.reportEvents(sessionId, [
			{
				eventType: "ManagedSessionStopped",
				category: "system_event",
				content,
			},
		]);
	}

	const failStop = (action: ControlAction, error: string) =>
		report(action, { status: "failed", error });

	async function stopCodex(action: ControlAction, sessionId: string) {
		try {
			await providers.stopManagedCodexSession(sessionId);
			await reportStopped(sessionId);
			await report(action, { status: "succeeded" });
		} catch (error) {
			log(`[control-actions] codex stop failed: ${errorText(error)}`);
			await failStop(action, STOP_WORDS.failed);
		}
	}

	/**
	 * A launched headless Claude: SIGTERM then SIGKILL to the child and its tool processes. With a child, its
	 * exit path reports the launch cancelled; with none registered (a restart, or a lost final report) the
	 * launch may still read running, which would hold the session's turn guard, so it is cancelled here.
	 */
	async function stopClaudeHeadless(action: ControlAction, sessionId: string) {
		try {
			const outcome = await providers.stopHeadlessClaude(sessionId);
			if (!outcome.gone) {
				await failStop(action, STOP_WORDS.finishing);
				return;
			}
			if (outcome.hadChild && !outcome.unchecked) {
				await reportStopped(sessionId);
				await report(action, { status: "succeeded" });
				return;
			}
			if (outcome.hadChild) {
				// The child is dead but nothing under it was looked for: the session reads stopped, and says so.
				await reportStopped(sessionId, STOPPED_UNCHECKED_NOTE);
				await report(action, {
					status: "succeeded",
					metadata: { ...(asRecord(action.metadata) ?? {}), note: STOPPED_UNCHECKED_NOTE },
				});
				return;
			}
			// Nothing registered under this host's control. The session still reads stopped (a lost final
			// report mustn't wedge it), but nothing here says a process was stopped.
			await reportStopped(sessionId, NOTHING_RUNNING_STOP_NOTE);
			await cancelLaunchOf(action);
			await report(action, {
				status: "succeeded",
				metadata: { ...(asRecord(action.metadata) ?? {}), note: NOTHING_RUNNING_STOP_NOTE },
			});
		} catch (error) {
			log(`[control-actions] claude stop failed: ${errorText(error)}`);
			await failStop(action, STOP_WORDS.failed);
		}
	}

	/** Cancels the launch a stop with no child leaves reading `running`. Its own try: the stop is done whether or not this lands. */
	async function cancelLaunchOf(action: ControlAction) {
		if (!action.launchRequestId) return;
		const launchId = action.launchRequestId;
		try {
			await finalReport(`launch:${launchId}`, () =>
				gate.reportLaunchStatus(launchId, { status: "cancelled" }),
			);
		} catch (error) {
			log(`[control-actions] cancelling launch after a stop failed: ${errorText(error)}`);
		}
	}

	/**
	 * A takeover fork: the fence, the interrupt and the ladder are the runtime's. Nothing registered (a restart,
	 * or a fork that already ended) reads stopped with the honest note; the carrier launch is not running, so
	 * there is nothing to cancel.
	 */
	async function stopClaudeStream(action: ControlAction, sessionId: string) {
		try {
			const outcome = await providers.stopClaudeStreamSession(sessionId);
			if (!outcome.gone) {
				await failStop(action, STOP_WORDS.finishing);
				return;
			}
			if (!outcome.hadChild) {
				// No process of ours, but an approved command may outlive a dead supervisor: if Claude still lists
				// the fork (or can't say), it isn't stopped yet.
				if (deps.forkListed && (await deps.forkListed(sessionId)) !== "not_listed") {
					await failStop(action, STOP_WORDS.finishing);
					return;
				}
				await reportStopped(sessionId, NOTHING_RUNNING_STOP_NOTE);
				await report(action, {
					status: "succeeded",
					metadata: { ...(asRecord(action.metadata) ?? {}), note: NOTHING_RUNNING_STOP_NOTE },
				});
				return;
			}
			const note = outcome.unchecked ? STOPPED_UNCHECKED_NOTE : undefined;
			await reportStopped(sessionId, note);
			await report(
				action,
				note
					? { status: "succeeded", metadata: { ...(asRecord(action.metadata) ?? {}), note } }
					: { status: "succeeded" },
			);
		} catch (error) {
			log(`[control-actions] claude fork stop failed: ${errorText(error)}`);
			await failStop(action, STOP_WORDS.failed);
		}
	}

	async function stop(action: ControlAction, sessionId: string) {
		switch (readStopRuntime(action)) {
			case STOP_RUNTIMES.codex:
				return stopCodex(action, sessionId);
			case STOP_RUNTIMES.claudeStream:
				return stopClaudeStream(action, sessionId);
			case STOP_RUNTIMES.claudeHeadless:
				return stopClaudeHeadless(action, sessionId);
			case STOP_RUNTIMES.claudeTerminal:
				return failStop(action, STOP_WORDS.terminal);
			default:
				return failStop(action, STOP_WORDS.unsupported);
		}
	}

	/**
	 * Stop turn (AGEN-119): a fork's turn is ended with Claude's own interrupt and nothing is signalled. The
	 * action ends `succeeded` with `{ interrupted, beforeSend? }` (false when the turn had already ended its own
	 * way) or `failed` with fixed words. It touches no lock: the prompt that holds it reports its own end.
	 */
	async function interrupt(action: ControlAction, sessionId: string) {
		const metadata = asRecord(action.metadata) ?? {};
		const target = metadata.targetPromptActionId;
		if (readStopRuntime(action) !== STOP_RUNTIMES.claudeStream || typeof target !== "string") {
			await report(action, { status: "failed", error: STOP_WORDS.unsupported });
			return;
		}
		try {
			const result = await providers.interruptClaudeStreamSession(sessionId, target);
			switch (result.status) {
				case "interrupted":
					await report(action, {
						status: "succeeded",
						metadata: {
							...metadata,
							interrupted: true,
							...(result.beforeSend ? { beforeSend: true } : {}),
						},
					});
					return;
				case "not_interrupted":
					await report(action, {
						status: "succeeded",
						metadata: { ...metadata, interrupted: false },
					});
					return;
				case "didnt_stop":
					await report(action, { status: "failed", error: TURN_DIDNT_STOP });
					return;
				case "not_sent":
					await report(action, { status: "failed", error: TURN_STOP_NOT_SENT });
					return;
			}
		} catch (error) {
			log(`[control-actions] claude fork interrupt failed: ${errorText(error)}`);
			await report(action, { status: "failed", error: TURN_STOP_NOT_SENT });
		}
	}

	/** A Codex session's prompt starts a turn on its live thread, or is refused with fixed words. Never the Claude path. */
	async function promptCodex(
		action: ControlAction,
		sessionId: string,
		text: string,
		managedState: ManagedState | null,
		callbacks: LaunchCallbacks,
	) {
		let metadata: Record<string, unknown>;
		try {
			if (!text) throw new Error(PROMPT_WORDS.missingPrompt);
			if (managedState !== "managed") throw new Error(wrongStateMessage(managedState));
			({ metadata } = await providers.promptManagedCodexSession(
				{ sessionId, prompt: text },
				callbacks,
			));
		} catch (error) {
			if (error instanceof CodexPromptWithheld) {
				log(`[supervisor] control action ${action.id} (prompt) withheld`);
				await gate.refuseControlAction(action.id);
				return;
			}
			// Replaces the stored metadata, which still holds the prompt text.
			await report(action, {
				status: "failed",
				error: error instanceof Error ? error.message : "Failed to send the prompt",
				metadata: { mode: "managed_codex" },
			});
			return;
		}
		// Codex has the prompt. A report that fails here must not turn into a failed action.
		try {
			await report(action, { status: "succeeded", metadata });
		} catch (error) {
			log(
				`[supervisor] prompt action ${action.id} was delivered but its status wasn't reported: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/**
	 * A running Claude prompt keeps the session's control lock by saying so: `running` at acceptance and
	 * every 30 s after, only to a server that advertises `claude_turn_control` (an older one would read it as
	 * a status change). A renewal that fails is logged and the turn goes on: the lock lasts 90 s, so two can
	 * fail. One request at a time, so a slow server isn't stacked on. The body is the status and nothing else.
	 */
	function startRenewals(action: ControlAction) {
		if (!deps.serverHas?.(CLAUDE_TURN_CONTROL)) {
			return { accepted: async () => {}, stop: () => {} };
		}
		let inFlight = false;
		const renew = async (accepted = false) => {
			if (inFlight) return;
			inFlight = true;
			try {
				await report(
					action,
					accepted ? { status: "running", accepted: true } : { status: "running" },
				);
			} catch (error) {
				log(
					`[control-actions] couldn't renew the lock of prompt ${action.id}: ${errorText(error)}`,
				);
			} finally {
				inFlight = false;
			}
		};
		const timer = schedule(() => void renew(), CLAUDE_TURN_RENEWAL_MS);
		return { accepted: () => renew(true), stop: () => timer.stop() };
	}

	/**
	 * A takeover fork's prompt goes to its live process, with no fall-through to a one-prompt `-p` run: that
	 * would start `claude --resume` on the fork. The turn stays `running` until its `result`, renewed like a
	 * launched Claude's, and ends `succeeded` or `failed` with fixed words. Whatever refuses it says why in
	 * the action's `error`; the stored metadata, which holds the prompt text, is replaced.
	 */
	async function promptClaudeStream(
		action: ControlAction,
		sessionId: string,
		text: string,
		callbacks: LaunchCallbacks,
	) {
		let sent: Awaited<ReturnType<ControlProviders["promptClaudeStreamSession"]>>;
		try {
			if (!text) throw new ClaudePromptRefusal("no_runtime", PROMPT_WORDS.missingPrompt);
			// A one-prompt child holds the id: a second process on the conversation is never started beside it.
			if (providers.hasHeadlessRuntime(sessionId)) {
				throw new ClaudePromptRefusal("no_runtime", CLAUDE_STREAM_HELD_ERROR);
			}
			sent = await providers.promptClaudeStreamSession(
				{ sessionId, prompt: text, actionId: action.id },
				callbacks,
			);
		} catch (error) {
			if (error instanceof ClaudePromptWithheld) {
				log(`[supervisor] control action ${action.id} (prompt) withheld`);
				await gate.refuseControlAction(action.id);
				return;
			}
			// Only a refusal this host wrote itself carries its words to the server. Anything else (a thrown
			// detail from the process, the filesystem, a report) goes to the host log and is a fixed sentence here.
			if (!(error instanceof ClaudePromptRefusal)) {
				log(`[control-actions] claude fork prompt failed: ${errorText(error)}`);
			}
			await report(action, {
				status: "failed",
				error: error instanceof ClaudePromptRefusal ? error.message : PROMPT_WORDS.failed,
				metadata: { mode: "claude_stream" },
			});
			return;
		}
		const renewals = startRenewals(action);
		await renewals.accepted();
		void sent.done
			.then(async (outcome) => {
				renewals.stop();
				await finalReport(`action:${action.id}`, () =>
					report(
						action,
						outcome.ok
							? { status: "succeeded", metadata: sent.metadata }
							: { status: "failed", error: outcome.error, metadata: { mode: "claude_stream" } },
					),
				);
			})
			.catch((error) => {
				renewals.stop();
				log(`[control-actions] claude fork prompt monitor failed: ${errorText(error)}`);
			});
	}

	async function prompt(action: ControlAction, sessionId: string) {
		const metadata = (action.metadata ?? {}) as Record<string, unknown>;
		const text = typeof metadata.prompt === "string" ? metadata.prompt : "";
		const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
		const model = typeof metadata.model === "string" ? metadata.model : null;
		// The agent type is the launch's, stamped by the server. It decides the provider before the mode does:
		// a mode names a Claude process shape, and sending a Codex session down that path would start
		// `claude --resume` in the launch directory.
		const agentType = typeof metadata.agentType === "string" ? metadata.agentType : null;
		// Coerce metadata.managedState (cross-process JSON, untyped) into the canonical ManagedState union;
		// an unknown value is null. For Claude that is the default headless path; for Codex it is "not ready".
		const managedState: ManagedState | null =
			typeof metadata.managedState === "string" &&
			(MANAGED_STATES as readonly string[]).includes(metadata.managedState)
				? (metadata.managedState as ManagedState)
				: null;
		// Absent (undefined) is not the same as null: null is the launch's recorded "agent
		// default", absent means the action didn't carry the privileges and a resume refuses.
		const approvalPolicy = "approvalPolicy" in metadata ? metadata.approvalPolicy : undefined;
		const sandboxMode = "sandboxMode" in metadata ? metadata.sandboxMode : undefined;
		const env = asRecord(metadata.env) ? (metadata.env as Record<string, string>) : {};
		const callbacks: LaunchCallbacks = {
			reportState: (body) => gate.reportState(body),
			reportEvents: (events) => gate.reportEvents(sessionId, events),
		};

		if (agentType === "codex_cli") {
			await promptCodex(action, sessionId, text, managedState, callbacks);
			return;
		}

		if (
			agentType === "claude_code" &&
			asRecord(action.metadata)?.runtime === STOP_RUNTIMES.claudeStream
		) {
			await promptClaudeStream(action, sessionId, text, callbacks);
			return;
		}

		try {
			if (agentType !== "claude_code") {
				log(
					`[supervisor] prompt action ${action.id} refused: unsupported agent type ${JSON.stringify(String(agentType)).slice(0, 80)}`,
				);
				throw new Error(PROMPT_WORDS.unknownAgent);
			}
			if (!text || !cwd) {
				throw new Error("Prompt action is missing prompt or working directory.");
			}
			if (providers.hasManagedCodexRuntime(sessionId)) {
				// This host holds a Codex process for the session, so the record the server sent is wrong.
				throw new Error(PROMPT_WORDS.mismatch);
			}
			// A fork never takes the one-prompt path: not when this host holds its process, and not when its own
			// record lists the id, whatever the action's metadata says (an older or rolled-back server).
			if (providers.hasClaudeStreamRuntime(sessionId)) throw new Error(CLAUDE_STREAM_HELD_ERROR);
			const forkStatus = deps.forkStatus?.(sessionId) ?? "not_fork";
			if (forkStatus === "fork") throw new Error(CLAUDE_FORK_NOT_HEADLESS_ERROR);
			if (forkStatus === "unknown") throw new Error(CLAUDE_FORK_RECORD_UNREADABLE_ERROR);

			if (managedState === "interactive_terminal") {
				const response = await providers.promptClaudeInteractiveSession(
					{
						sessionId,
						prompt: text,
						cwd,
						model,
						env,
						managedState,
					},
					callbacks,
				);
				await report(action, { status: "succeeded", metadata: response.metadata });
				return;
			}

			// A resume starts a new process in this directory, so it is judged like a launch: the
			// server picked the directory from the launch row, and the host still checks it.
			const spawnCwd = await canonicalSpawnCwd(cwd, deps.trustedRoots);
			const response = await providers.promptClaudeHeadlessSession(
				{
					sessionId,
					prompt: text,
					cwd: spawnCwd,
					model,
					env,
					managedState,
					approvalPolicy,
					sandboxMode,
				},
				async () => {},
				callbacks,
			);
			const renewals = startRenewals(action);
			await renewals.accepted();
			void response.monitor
				.then(async () => {
					renewals.stop();
					// A child a person's Stop ended is a failed prompt in the Stop's own words; the server has
					// usually failed it already, and a report for a finished action changes nothing.
					const stopped = response.metadata.executionState === "stopped";
					await finalReport(`action:${action.id}`, () =>
						report(
							action,
							stopped
								? { status: "failed", error: STOPPED_BY_PERSON_ERROR }
								: { status: "succeeded", metadata: response.metadata },
						),
					);
				})
				.catch(async (error) => {
					renewals.stop();
					await finalReport(`action:${action.id}`, () =>
						report(action, {
							status: "failed",
							error: error instanceof Error ? error.message : "Failed to execute prompt",
						}),
					);
				});
		} catch (error) {
			await report(action, {
				status: "failed",
				error: error instanceof Error ? error.message : "Failed to execute prompt action",
			});
		}
	}

	async function cleanup(action: ControlAction) {
		const metadata = (action.metadata ?? {}) as Record<string, unknown>;
		const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
		try {
			if (!cwd) throw new Error("cleanup_workarea action is missing cwd metadata.");
			const result = await deps.executeCleanupWorkArea({
				cwd,
				trustedRoots: deps.trustedRoots,
				logProgress: (msg) => log(`[cleanup] ${msg}`),
			});
			await report(action, {
				status: "succeeded",
				metadata: {
					...metadata,
					cleanup: { removed: result.removed, resolvedPath: result.resolvedPath },
				},
			});
		} catch (error) {
			const detail = error instanceof CleanupError ? error.toJSON() : null;
			if (gate.rulesState() !== "none") {
				// While rules exist every refusal looks the same from outside: whether a path is covered,
				// outside the roots or missing must not be learnable from the answer. What happened stays here.
				const why = detail
					? `${detail.code}: ${detail.message}`
					: error instanceof Error
						? error.message
						: "cleanup failed";
				log(`[cleanup] action ${action.id} refused: ${why}`);
				await report(action, controlRefusalBody());
				return;
			}
			await report(action, {
				status: "failed",
				error: detail?.message ?? (error instanceof Error ? error.message : "Cleanup failed"),
				metadata: detail ? { ...metadata, cleanupError: detail } : metadata,
			});
		}
	}

	return async function handleControlAction(action) {
		const sessionId = action.sessionId ?? null;
		// A resume runs BEFORE the gate's verdict: this host may not know the session yet (while exclude rules
		// exist the gate calls an unknown session excluded), and the resumer does its own sequence, judging the
		// real directory itself and refusing through refuseResume.
		if (action.actionType === "resume" && sessionId && deps.resumeSession) {
			return deps.resumeSession(action, sessionId);
		}
		const named = namedDirectory(action);
		const verdict = sessionId ? gate.verdict(sessionId, named) : gate.verdictForDirectory(named);
		if (verdict !== "send") {
			log(`[supervisor] control action ${action.id} (${action.actionType}) not executed`);
			await gate.refuseControlAction(action.id);
			return;
		}

		if (action.actionType === "stop" && sessionId) return stop(action, sessionId);
		if (action.actionType === "interrupt" && sessionId) return interrupt(action, sessionId);
		if (action.actionType === "prompt" && sessionId) return prompt(action, sessionId);
		if (action.actionType === "cleanup_workarea") return cleanup(action);

		await report(action, {
			status: "failed",
			error: `Unsupported control action: ${action.actionType}`,
		});
	};
}
