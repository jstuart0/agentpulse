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
import type { ControlAction, ManagedState } from "../shared/types.js";
import { MANAGED_STATES } from "../shared/types.js";
import type { LaunchCallbacks } from "./providers/claude-shared.js";
import type {
	promptClaudeHeadlessSession,
	promptClaudeInteractiveSession,
} from "./providers/claude.js";
import type {
	hasManagedCodexRuntime,
	promptManagedCodexSession,
	stopManagedCodexSession,
} from "./providers/codex-managed.js";
import { CodexPromptWithheld } from "./providers/codex-shared.js";
import { CleanupError, type executeCleanupWorkArea } from "./services/cleanup-workarea.js";
import { type ReportGate, controlRefusalBody } from "./services/report-gate.js";
import { canonicalSpawnCwd } from "./services/spawn-cwd.js";

export type ControlProviders = {
	stopManagedCodexSession: typeof stopManagedCodexSession;
	promptManagedCodexSession: typeof promptManagedCodexSession;
	hasManagedCodexRuntime: typeof hasManagedCodexRuntime;
	promptClaudeHeadlessSession: typeof promptClaudeHeadlessSession;
	promptClaudeInteractiveSession: typeof promptClaudeInteractiveSession;
};

export interface ControlActionDeps {
	gate: ReportGate;
	trustedRoots: string[];
	providers: ControlProviders;
	executeCleanupWorkArea: typeof executeCleanupWorkArea;
	/** Runs a `resume` action (see services/session-resume.ts). Absent: this build can't, and says so. */
	resumeSession?: (action: ControlAction, sessionId: string) => Promise<void>;
	log?: (line: string) => void;
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
} as const;

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

	/** Status results, always through the gate: `succeeded` for a session that is now excluded becomes the generic failure. */
	const report = (action: ControlAction, body: Parameters<ReportGate["reportControlStatus"]>[2]) =>
		gate.reportControlStatus(action.id, action.sessionId ?? null, body, namedDirectory(action));

	async function stop(action: ControlAction, sessionId: string) {
		try {
			await providers.stopManagedCodexSession(sessionId);
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
					content: "Managed session stopped by operator.",
				},
			]);
			await report(action, { status: "succeeded" });
		} catch (error) {
			await report(action, {
				status: "failed",
				error: error instanceof Error ? error.message : "Failed to stop managed session",
			});
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
			void response.monitor
				.then(async () => {
					await report(action, { status: "succeeded", metadata: response.metadata });
				})
				.catch(async (error) => {
					await report(action, {
						status: "failed",
						error: error instanceof Error ? error.message : "Failed to execute prompt",
					});
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
		if (action.actionType === "prompt" && sessionId) return prompt(action, sessionId);
		if (action.actionType === "cleanup_workarea") return cleanup(action);

		await report(action, {
			status: "failed",
			error: `Unsupported control action: ${action.actionType}`,
		});
	};
}
