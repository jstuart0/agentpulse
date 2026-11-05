/**
 * The supervisor's handling of a `resume` control action (AGEN-115, D11 steps 1 to 6 and 15, and the
 * failure path). The provider (providers/codex-managed.ts) does steps 7 to 14. Everything here is judged
 * on THIS host's own records: the server's thread id, directory and privileges are claims to check.
 *
 *  1. hold the session and its thread id for the Codex observer, from here through any failure;
 *  2. parse: a UUID thread id, codex_cli, a known resume kind, privileges that resolve through the one mapping
 *     and match the flags the server expected; for a recovery, this host's own record of the thread;
 *  3. refuse while earlier reports for the session are still queued (this one would jump ahead of them);
 *  4. a runtime already holding the session or thread: a takeover is refused `running`; a recovery just
 *     reports it managed again, with no process;
 *  5. the candidate directory must be allowed here before any process exists.
 * Every refusal goes through `gate.refuseResume`, never `decide`: the gate may not know the session. While
 * exclude rules exist the body is one fixed sentence per resume kind built from the host's name alone,
 * whatever the cause; the cause goes to this host's log.
 */
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	LaunchPrivilegeError,
	privilegeCliArgs,
	requireLaunchPrivileges,
} from "../../shared/launch-privileges.js";
import {
	RESUME_REFUSED_MESSAGE,
	type ResumeKind,
	isResumableSessionId,
	resumeFailureMessage,
} from "../../shared/session-resume.js";
import type { ControlAction } from "../../shared/types.js";
import type {
	ResumeCallbacks,
	ResumeInput,
	managedCodexRuntimeHolds,
	resumeManagedCodexSession,
} from "../providers/codex-managed.js";
import { CodexResumeError, type CodexResumeKind } from "../providers/codex-shared.js";
import type { ManagedThreadRecord } from "./managed-thread-record.js";
import type { ReportGate } from "./report-gate.js";
import { canonicalSpawnCwd } from "./spawn-cwd.js";

export interface SessionResumerDeps {
	gate: ReportGate;
	hostName: string;
	trustedRoots: string[];
	record: ManagedThreadRecord;
	/** The observer's hold: the ids it must not post for while a resume is in progress. */
	hold: { add(id: string): void; delete(id: string): void };
	neutralCwd: () => Promise<string>;
	providers: {
		managedCodexRuntimeHolds: typeof managedCodexRuntimeHolds;
		resumeManagedCodexSession: typeof resumeManagedCodexSession;
	};
	log?: (line: string) => void;
}

/**
 * `~/.agentpulse/codex-neutral`: the directory the resume's app-server runs in, so no project config applies
 * to the process. It must be a real directory this account owns, private and EMPTY; it is created if absent.
 * Anything else is refused before a process starts.
 */
export async function resolveNeutralCwd(home: string): Promise<string> {
	const dir = join(home, ".agentpulse", "codex-neutral");
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw new CodexResumeError("rejected", "the neutral directory can't be created");
		}
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(dir);
	} catch {
		throw new CodexResumeError("rejected", "the neutral directory can't be inspected");
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(uid !== undefined && stat.uid !== uid) ||
		(stat.mode & 0o077) !== 0
	) {
		throw new CodexResumeError(
			"rejected",
			"the neutral directory is not a private directory of ours",
		);
	}
	if (readdirSync(dir).length > 0) {
		throw new CodexResumeError("rejected", "the neutral directory is not empty");
	}
	return dir;
}

/** The creation time a UUIDv7 carries (its first 48 bits), or null for any other version. */
function uuidV7Millis(id: string): number | null {
	const hex = id.replace(/-/g, "");
	if (hex.length !== 32 || hex[12] !== "7") return null;
	const ms = Number.parseInt(hex.slice(0, 12), 16);
	return Number.isFinite(ms) ? ms : null;
}

export { uuidV7Millis };

export function createSessionResumer(
	deps: SessionResumerDeps,
): (action: ControlAction, sessionId: string) => Promise<void> {
	const { gate } = deps;
	const log = deps.log ?? ((line: string) => console.log(line));

	return async function resume(action, sessionId) {
		const metadata = (action.metadata ?? {}) as Record<string, unknown>;
		const resumeKind: ResumeKind = metadata.resumeKind === "recovery" ? "recovery" : "takeover";
		const threadId = typeof metadata.threadId === "string" ? metadata.threadId : "";

		async function refuse(kind: CodexResumeKind, detail?: string) {
			log(
				`[supervisor] resume ${action.id} refused: ${kind}${detail ? ` (${detail.slice(0, 200)})` : ""}`,
			);
			const words =
				gate.rulesState() !== "none"
					? RESUME_REFUSED_MESSAGE[resumeKind](deps.hostName)
					: resumeFailureMessage(kind, deps.hostName, resumeKind);
			try {
				await gate.refuseResume(action.id, words);
			} catch (error) {
				log(
					`[supervisor] couldn't report a refused resume: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// 1: the observer must not post for this session, or its thread, from here on.
		const held = [sessionId, threadId].filter((id, i, all) => id && all.indexOf(id) === i);
		for (const id of held) deps.hold.add(id);
		try {
			// 2: parse. The session id is checked before it can reach a filesystem call.
			if (!isResumableSessionId(sessionId) || !isResumableSessionId(threadId)) {
				return await refuse("rejected", "an id is not a UUID");
			}
			if (metadata.agentType !== "codex_cli" || metadata.resumeKind !== resumeKind) {
				return await refuse("rejected", "not a codex_cli resume of a known kind");
			}
			if (typeof metadata.cwd !== "string" || metadata.cwd === "") {
				return await refuse("rejected", "no directory");
			}
			let privileges: ReturnType<typeof requireLaunchPrivileges>;
			try {
				privileges = requireLaunchPrivileges(
					"codex_cli",
					metadata.approvalPolicy ?? null,
					metadata.sandboxMode ?? null,
				);
			} catch (error) {
				return await refuse(
					"rejected",
					error instanceof LaunchPrivilegeError ? error.errors.join(" ") : "bad privileges",
				);
			}
			const expected = privilegeCliArgs("codex_cli", metadata.approvalPolicy, metadata.sandboxMode);
			if (JSON.stringify(expected) !== JSON.stringify(metadata.expectedEnforcedArgs)) {
				return await refuse("rejected", "the privileges don't match what the server expected");
			}
			const launchRequestId = action.launchRequestId ?? "";
			let preUpgrade: ResumeInput["preUpgrade"];
			if (resumeKind === "recovery") {
				const recorded = deps.record.lookup(launchRequestId);
				if (recorded !== null && recorded !== threadId) {
					return await refuse("thread_unverified", "the record names another thread");
				}
				if (recorded === null) {
					const createdAt = deps.record.createdAt();
					const createdAtMs = createdAt === null ? Number.NaN : Date.parse(createdAt);
					if (!Number.isFinite(createdAtMs)) {
						return await refuse(
							"thread_unverified",
							"no trustworthy record of the threads this host started",
						);
					}
					preUpgrade = { createdAtMs };
				}
			}

			// 3
			const queued = gate.queuedState(sessionId);
			if (queued !== "none") {
				return await refuse(queued === "held" ? "reports_held" : "reports_pending");
			}

			const callbacks: ResumeCallbacks = {
				reportState: (body) => gate.reportState(body),
				reportEvents: (events) => gate.reportEvents(sessionId, events),
				neutralCwd: deps.neutralCwd,
				noteLaunch: (l, s, c) => gate.noteLaunch(l, s, c),
				verdict: (id, cwd) => gate.verdict(id, cwd),
				verdictForDirectory: (cwd) => gate.verdictForDirectory(cwd),
				forgetLaunch: (l, s) => gate.forgetLaunch(l, s),
				reportResumeState: (body) => gate.reportResumeState(body),
				recordThread: (l, t) => deps.record.write(l, t),
				trustedRoots: deps.trustedRoots,
			};

			// 4
			if (
				deps.providers.managedCodexRuntimeHolds(sessionId) ||
				deps.providers.managedCodexRuntimeHolds(threadId)
			) {
				if (resumeKind === "takeover")
					return await refuse("running", "this host already holds the session");
				try {
					const outcome = await gate.reportResumeState({
						sessionId,
						launchRequestId,
						managedState: "managed",
						status: "idle",
						providerSyncState: "synced",
						clearProviderSyncError: true,
						resumeActionId: action.id,
					});
					if (outcome !== "sent")
						return await refuse("rejected", `the state report was ${outcome}`);
				} catch (error) {
					return await refuse("rejected", error instanceof Error ? error.message : "report failed");
				}
				return await succeed();
			}

			// 5
			let candidate: string;
			try {
				candidate = await canonicalSpawnCwd(metadata.cwd, deps.trustedRoots);
			} catch {
				return await refuse("cwd_mismatch", "the candidate directory isn't allowed here");
			}
			if (gate.verdictForDirectory(candidate) !== "send") {
				return await refuse("cwd_mismatch", "the candidate directory is covered by a rule");
			}

			try {
				await deps.providers.resumeManagedCodexSession(
					{
						sessionId,
						launchRequestId,
						threadId,
						candidateCwd: candidate,
						privileges,
						resumeKind,
						resumeActionId: action.id,
						sessionName:
							typeof metadata.sessionName === "string"
								? metadata.sessionName
								: sessionId.slice(0, 8),
						...(preUpgrade ? { preUpgrade } : {}),
					},
					callbacks,
				);
			} catch (error) {
				if (error instanceof CodexResumeError) return await refuse(error.kind, error.detail);
				return await refuse("rejected", error instanceof Error ? error.message : "resume failed");
			}
			return await succeed();
		} finally {
			for (const id of held) deps.hold.delete(id);
		}

		/** 15: the runtime is up and the server has the state; the action's status goes once more if the first send fails. */
		async function succeed() {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await gate.reportControlStatus(action.id, sessionId, { status: "succeeded" });
					return;
				} catch (error) {
					log(
						`[supervisor] resume ${action.id} worked but its status wasn't reported: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	};
}
