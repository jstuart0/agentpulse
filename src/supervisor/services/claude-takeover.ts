/**
 * The supervisor's half of a Claude takeover and of a fork's recovery (AGEN-117 T3, T4, T5, T7, T13). The
 * server queues one `resume` action; this host runs it:
 *
 *  Takeover (an action on the observed session S, naming the fork N the server minted):
 *   1. parse and assert N is a new UUID that is not S;
 *   2. the protocol gate (platform, https, version range) and a slot (`host_busy` before any process starts);
 *   3. the login probes pick the mode (`restricted` where the login is known to work under it, else `ask`),
 *      or refuse `claude_not_logged_in`; no user line is ever sent to a probe, so they cost nothing;
 *   4. `agents --json`: S listed refuses `running`; no answer refuses `liveness_unknown`;
 *   5. the directory is proved from S's own transcript (T7), canonicalised, trusted and not excluded;
 *   6. the gate learns N, the child is spawned on the fork argv, its `initialize` account must agree with the
 *      mode, its own `agents` entry must show N and not S, S's file must not have changed;
 *   7. the fork is recorded, the runtime is `settling`, and success is reported with the proved directory and
 *      the mode. The server writes N's rows only if it judges that report again; its answer decides:
 *      `succeeded` makes the runtime live, anything else (or a verdict that nothing may leave) kills the child.
 *  A lost answer never kills the child: the report is retried with backoff for as long as this process runs,
 *  and a committed settle answers `succeeded` to the same report. No `managed` row exists without a runtime.
 *
 *  Recovery (an action on N, whose rows exist): N's host record supplies the directory, the source and the
 *  mode; nothing re-picks the mode and no probe runs. N's file present: resumed in place; absent (never
 *  prompted): forked again from S under the same N.
 *
 * Every refusal is `gate.refuseResume`: while the host has an exclude file the body is one fixed sentence, the
 * cause goes to this host's log. S is never written, by anything here.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { forkChildEnv } from "../../shared/launch-env-policy.js";
import { privilegeCliArgs } from "../../shared/launch-privileges.js";
import { CLAUDE_FORK_EXITED_SYNC_ERROR } from "../../shared/managed-messages.js";
import {
	type AppliedForkOptions,
	CLAUDE_TAKEOVER_PRIVILEGES,
	type ClaudeForkMode,
	type ForkOptionsRequest,
	RESUME_REFUSED_MESSAGE,
	type ResumeFailureKind,
	type ResumeKind,
	isResumableSessionId,
	parseAppliedForkOptions,
	parseForkOptionsRequest,
	resumeFailureMessage,
} from "../../shared/session-resume.js";
import type { ControlAction } from "../../shared/types.js";
import { listClaudeAgentEntries } from "../providers/claude-agents.js";
import { forkArgv, inPlaceArgv } from "../providers/claude-argv.js";
import { type PreparedForkOptions, prepareForkOptions } from "../providers/claude-fork-tools.js";
import { type LoginProbe, createLoginProbe, pickForkMode } from "../providers/claude-login-mode.js";
import {
	CLAUDE_VERSION_RANGE_TEXT,
	type ClaudeBinary,
	claudeProtocolVerdict,
	resolveClaude,
} from "../providers/claude-protocol.js";
import {
	type ClaudeApprovalPort,
	ClaudeStartRefusal,
	type ClaudeStreamOptions,
	type ClaudeStreamRuntime,
	defaultConfigDir,
	hasClaudeStreamRuntime,
	reserveClaudeStreamSlot,
	startClaudeStream,
} from "../providers/claude-stream.js";
import type { ApprovalLaunch, CodexApprovalTracker } from "../providers/codex-approvals.js";
import type { Verdict } from "../providers/codex-protocol.js";
import { createDetailJudge } from "../providers/fork-tool-record.js";
import { forkTurnObserver } from "../providers/fork-turn-observer.js";
import { parseVersion } from "../providers/version-range.js";
import type { ClaudeForkRecord } from "./claude-fork-record.js";
import { findSourceDirectory } from "./claude-source-dir.js";
import type { ReportGate } from "./report-gate.js";
import { classifyReportFailure } from "./report-resilience.js";
import { canonicalSpawnCwd } from "./spawn-cwd.js";

export interface ClaudeTakeoverDeps {
	gate: ReportGate;
	hostName: string;
	trustedRoots: string[];
	forkRecord: ClaudeForkRecord;
	/** The supervisor's environment; the child's and the probes' are derived from it (T18). */
	env: Readonly<Record<string, string | undefined>>;
	/** A fixed, empty, private directory the probes and the `agents` calls run in; never S's. */
	probeCwd: string;
	tracker: Pick<CodexApprovalTracker, "attachClaude">;
	/** Whether the server offers a feature (from register and every heartbeat). Absent: none, so no call detail is sent. */
	serverHas?: (feature: string) => boolean;
	log?: (line: string) => void;
	/** Test seams. Each defaults to the real thing. */
	resolve?: typeof resolveClaude;
	verdictOf?: typeof claudeProtocolVerdict;
	listAgents?: typeof listClaudeAgentEntries;
	loginProbe?: (executable: string) => LoginProbe;
	start?: typeof startClaudeStream;
	startExtra?: Partial<ClaudeStreamOptions>;
	wait?: (ms: number) => Promise<void>;
	now?: () => number;
	/** How long before `forkDeadlineAt` a takeover is still worth starting. */
	deadlineMarginMs?: number;
	retryBaseMs?: number;
	retryMaxMs?: number;
}

export interface ClaudeTakeover {
	/** Runs a `resume` action about a Claude session: a takeover of S or a recovery of N. */
	run(action: ControlAction, sessionId: string): Promise<void>;
	/** Resolves when no report is still being retried (tests, shutdown). */
	idle(): Promise<void>;
	/**
	 * Whether Claude Code on this machine still lists the session (End of a fork this host holds no process
	 * for, T11/T17): an approved command may still be finishing. `unknown` when it can't be asked.
	 */
	isListed(sessionId: string): Promise<"listed" | "not_listed" | "unknown">;
}

class Refusal extends Error {
	constructor(
		readonly kind: ResumeFailureKind,
		readonly detail?: string,
		/** The Claude Code version and the tested range, for the one refusal whose words print them. */
		readonly version?: { found: string; range: string },
	) {
		super(kind);
	}
}

/** Read through a function: a runtime's state changes across awaits, which narrowing can't see. */
const isGone = (runtime: ClaudeStreamRuntime): boolean => (runtime.state as string) === "gone";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const defaultWait = (ms: number) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

/** How a protocol verdict's reason is worded to the person. */
function kindOfVerdict(verdict: Verdict): ResumeFailureKind {
	if (verdict.reason === "unsupported_platform") return "unsupported_platform";
	if (verdict.verdict === "insecure_transport") return "insecure_transport";
	return "unsupported_claude";
}

function mapStartRefusal(error: ClaudeStartRefusal): Refusal {
	return new Refusal(error.kind as ResumeFailureKind, error.message);
}

export function createClaudeTakeover(deps: ClaudeTakeoverDeps): ClaudeTakeover {
	const { gate } = deps;
	const log = deps.log ?? ((line: string) => console.log(line));
	const wait = deps.wait ?? defaultWait;
	const resolve = deps.resolve ?? resolveClaude;
	const verdictOf = deps.verdictOf ?? claudeProtocolVerdict;
	const listAgents = deps.listAgents ?? listClaudeAgentEntries;
	const start = deps.start ?? startClaudeStream;
	const configDir = defaultConfigDir(deps.env);
	const now = deps.now ?? Date.now;
	const retrying = new Set<Promise<void>>();

	async function listedIds(binary: ClaudeBinary): Promise<ReadonlySet<string>> {
		const listing = await listAgents({
			executable: binary.path,
			cwd: deps.probeCwd,
			env: forkChildEnv(deps.env),
		});
		if (!listing.ok) throw new Refusal("liveness_unknown", listing.why);
		return new Set(listing.entries.map((entry) => entry.sessionId));
	}

	/**
	 * The directory a fork is spawned in: canonical, under a trusted root, and not covered by an exclude rule.
	 * `alsoJudged` are directories that must not be covered either (the server's guess, which may no longer
	 * exist after a `cd`, so only the rules are asked about it).
	 */
	async function judgeDirectory(dir: string, ...alsoJudged: string[]): Promise<string> {
		let canonical: string;
		try {
			canonical = await canonicalSpawnCwd(dir, deps.trustedRoots);
		} catch {
			throw new Refusal("cwd_mismatch", "the directory isn't allowed here");
		}
		for (const judged of [canonical, dir, ...alsoJudged]) {
			if (gate.verdictForDirectory(judged) !== "send") {
				throw new Refusal("cwd_mismatch", "a directory is covered by a rule");
			}
		}
		return canonical;
	}

	/**
	 * Every directory the original worked in must be clear of the exclude rules, not only the one it started
	 * in (a `cd` into an excluded directory would carry that directory's content into the fork), and so must
	 * the real path of the server's candidate (AGEN-117 P5-X1). The words are the generic ones.
	 */
	function judgeWorkedDirectories(cwds: readonly string[], candidate: string): void {
		const all = new Set<string>(cwds);
		for (const dir of [...all, candidate]) {
			try {
				all.add(realpathSync(dir));
			} catch {
				// a directory that no longer exists has nothing to read
			}
		}
		all.add(candidate);
		for (const dir of all) {
			if (gate.verdictForDirectory(dir) !== "send") {
				throw new Refusal("cwd_mismatch", "a directory the session worked in is covered by a rule");
			}
		}
	}

	/** Tells the server the fork has no process behind it, so a `managed` row is never left standing alone (P5-B1). */
	async function reportDegraded(sessionId: string): Promise<void> {
		try {
			await gate.reportState({
				sessionId,
				agentType: "claude_code",
				managedState: "degraded",
				status: "idle",
				providerSyncState: "failed",
				providerSyncError: CLAUDE_FORK_EXITED_SYNC_ERROR,
			} as Parameters<ReportGate["reportState"]>[0]);
		} catch (error) {
			log(
				`[supervisor] couldn't report a fork with no process: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	function approvalFor(
		sessionId: string,
		cwd: string,
		mode: ClaudeForkMode,
		verdict: Verdict,
	): ClaudeApprovalPort {
		const launch: ApprovalLaunch & { cwd: string } = {
			sessionId,
			cwd,
			warn: async (content, detail) => {
				try {
					await gate.reportEvents(sessionId, [
						{
							eventType: "ManagedWarning",
							category: "system_event",
							content,
							rawPayload: { source: "approval_tracker", ...detail },
						},
					]);
				} catch {
					// A warning that can't be reported is dropped: it never stops a turn.
				}
			},
		};
		return deps.tracker.attachClaude(launch, { mode, configDir, verdict });
	}

	/** Spawns and verifies the child; every refusal inside leaves no process behind (`startClaudeStream`). */
	async function spawnFork(input: {
		binary: ClaudeBinary;
		sessionId: string;
		source?: string;
		sourceFile?: string | null;
		mode: ClaudeForkMode;
		args: string[];
		spawnDir: string;
		verdict: Verdict;
		/** What the fork's options came to; its policy built `args`, and its cleanup runs when the fork ends. */
		prepared: PreparedForkOptions;
		reservedSlot?: () => void;
	}): Promise<ClaudeStreamRuntime> {
		const approvals = approvalFor(input.sessionId, input.spawnDir, input.mode, input.verdict);
		const observer = forkTurnObserver(input.sessionId, {
			send: (sessionId, body) => gate.reportToolCalls(sessionId, body),
			serverHas: deps.serverHas,
			log,
		});
		try {
			return await start({
				sessionId: input.sessionId,
				...(input.source ? { source: input.source } : {}),
				sourceFile: input.sourceFile ?? null,
				mode: input.mode,
				executable: input.binary.path,
				args: input.args,
				cwd: input.spawnDir,
				env: deps.env,
				expectedVersion: input.binary.version,
				callbacks: {
					reportState: (body) => gate.reportState(body),
					reportEvents: (events) => gate.reportEvents(input.sessionId, events),
				},
				configDir: configDir ?? undefined,
				approvals,
				policy: input.prepared.policy,
				cleanup: input.prepared.cleanup,
				onTurnFinished: (turn) => observer.onTurnFinished(turn),
				onCallResulted: (call) => observer.onCallResulted(call),
				detailJudge: createDetailJudge({
					cwd: input.spawnDir,
					excludesPath: (path) => gate.excludesPath(path),
					excludeScope: () => gate.excludeScope(),
				}),
				agentsCwd: deps.probeCwd,
				...(input.reservedSlot ? { reservedSlot: input.reservedSlot } : {}),
				log,
				...deps.startExtra,
			});
		} catch (error) {
			// The port was attached before the child existed; a start that failed leaves it to be closed.
			approvals.dispose();
			if (error instanceof ClaudeStartRefusal) throw mapStartRefusal(error);
			throw new Refusal("rejected", error instanceof Error ? error.message : "start failed");
		}
	}

	function parse(action: ControlAction, sessionId: string, resumeKind: ResumeKind) {
		const meta = isRecord(action.metadata) ? action.metadata : {};
		if (meta.agentType !== "claude_code" || meta.resumeKind !== resumeKind) {
			throw new Refusal("rejected", "not a claude_code resume of this kind");
		}
		const expected = privilegeCliArgs(
			"claude_code",
			CLAUDE_TAKEOVER_PRIVILEGES.approvalPolicy,
			CLAUDE_TAKEOVER_PRIVILEGES.sandboxMode,
		);
		if (JSON.stringify(expected) !== JSON.stringify(meta.expectedEnforcedArgs)) {
			throw new Refusal("rejected", "the privileges don't match what the server expected");
		}
		if (!isResumableSessionId(sessionId))
			throw new Refusal("rejected", "the session id is not a UUID");
		return meta;
	}

	async function preflight(): Promise<{ binary: ClaudeBinary; verdict: Verdict }> {
		let resolved: Awaited<ReturnType<typeof resolveClaude>>;
		try {
			resolved = await resolve();
		} catch {
			throw new Refusal("rejected", "claude can't be resolved");
		}
		const verdict = verdictOf(resolved.binary, resolved.serverUrl);
		if (verdict.verdict !== "supported") {
			const kind = kindOfVerdict(verdict);
			// Only a version the binary really printed (it was parsed) is shown, with the range tested.
			const found = parseVersion(resolved.binary.version) ? resolved.binary.version : null;
			throw new Refusal(
				kind,
				verdict.reason,
				kind === "unsupported_claude" && found
					? { found, range: CLAUDE_VERSION_RANGE_TEXT }
					: undefined,
			);
		}
		return { binary: resolved.binary, verdict };
	}

	// ---- reporting the success, and living with a lost answer ----

	type Answer = "succeeded" | "failed" | "withheld" | "lost" | "blocked";

	/** One attempt at the success report, judged by what the gate and the server said. */
	async function reportOnce(
		action: ControlAction,
		sessionId: string,
		body: Parameters<ReportGate["reportControlStatus"]>[2],
	): Promise<Answer> {
		let outcome: Awaited<ReturnType<ReportGate["reportControlStatus"]>>;
		try {
			outcome = await gate.reportControlStatus(action.id, sessionId, body);
		} catch (error) {
			// A failure that says "ask again": no answer, a timeout, a 5xx, back-pressure. Any other answer
			// (a refusal included) means the server has heard, and what it said is final.
			const failure = classifyReportFailure(error);
			return failure === "network" || failure === "server" || failure === "backoff"
				? "lost"
				: "failed";
		}
		// `blocked`: the rules or the gate's saved state can't be trusted right now, which may pass. Anything
		// else the gate did not send (excluded, refused) is final.
		if (outcome.outcome === "blocked") return "blocked";
		if (outcome.outcome !== "sent") return "withheld";
		const status = outcome.action?.status;
		if (status === "succeeded") return "succeeded";
		if (status === "failed" || status === "cancelled") return "failed";
		return "lost";
	}

	/** Retries until the server answers; resolves with the answer. The child and the slot stay held meanwhile. */
	async function untilAnswered(
		action: ControlAction,
		sessionId: string,
		body: Parameters<ReportGate["reportControlStatus"]>[2],
		first: Answer,
	): Promise<Answer> {
		let answer = first;
		let delay = deps.retryBaseMs ?? 1_000;
		while (answer === "lost" || answer === "blocked") {
			log(
				`[supervisor] resume ${action.id}: no answer yet; the session stays held and will be asked again`,
			);
			await wait(delay);
			delay = Math.min(delay * 2, deps.retryMaxMs ?? 30_000);
			answer = await reportOnce(action, sessionId, body);
		}
		return answer;
	}

	function track(promise: Promise<void>): void {
		retrying.add(promise);
		const done = () => retrying.delete(promise);
		promise.then(done, done);
	}

	// ---- takeover ----

	async function takeover(action: ControlAction, sourceId: string): Promise<void> {
		const meta = parse(action, sourceId, "takeover");
		const forkId = typeof meta.forkSessionId === "string" ? meta.forkSessionId : "";
		const carrierId = typeof meta.carrierLaunchId === "string" ? meta.carrierLaunchId : "";
		const candidate = typeof meta.candidateCwd === "string" ? meta.candidateCwd : "";
		if (
			!isResumableSessionId(forkId) ||
			forkId === sourceId ||
			carrierId === "" ||
			candidate === ""
		) {
			throw new Refusal("rejected", "the fork id or carrier is not usable");
		}
		if (hasClaudeStreamRuntime(forkId))
			throw new Refusal("rejected", "that fork is already running here");
		// The slot first, synchronously, so two takeovers can't both pass a count and then probe (P5-B4).
		let release: () => void;
		try {
			release = reserveClaudeStreamSlot(forkId, deps.startExtra?.maxRuntimes);
		} catch (error) {
			if (error instanceof ClaudeStartRefusal) throw mapStartRefusal(error);
			throw error;
		}
		let handedOver = false;
		try {
			await runTakeover({ action, sourceId, forkId, carrierId, candidate, meta, release });
			handedOver = true;
		} finally {
			// A start that was handed the slot gives it back itself; everything before that is ours to release.
			if (!handedOver) release();
		}
	}

	async function runTakeover(input: {
		action: ControlAction;
		sourceId: string;
		forkId: string;
		carrierId: string;
		candidate: string;
		meta: Record<string, unknown>;
		release: () => void;
	}): Promise<void> {
		const { action, sourceId, forkId, carrierId, candidate, meta } = input;
		const { binary, verdict } = await preflight();

		// The login probes: before `agents` (so a probe can't be listed by it) and before S is read (so a host
		// with no login never opens the transcript).
		const choice = await pickForkMode(
			(
				deps.loginProbe ??
				((executable: string) =>
					createLoginProbe({ executable, env: deps.env, probeCwd: deps.probeCwd, log }))
			)(binary.path),
		);
		if ("refusal" in choice) throw new Refusal(choice.refusal);
		const mode = choice.mode;

		const listed = await listedIds(binary);
		if (listed.has(sourceId)) throw new Refusal("running", "S is listed by agents");

		const found = findSourceDirectory({ configDir, sessionId: sourceId, candidate });
		if (!found.ok) throw new Refusal(found.kind, "the source directory can't be proved");
		const spawnDir = await judgeDirectory(found.dir, candidate);
		judgeWorkedDirectories(found.cwds, candidate);

		// The server fails the action at its deadline; a fork started too near it would be killed by that.
		const deadline = Date.parse(String(meta.forkDeadlineAt ?? ""));
		if (Number.isFinite(deadline) && deadline - now() < (deps.deadlineMarginMs ?? 15_000)) {
			throw new Refusal("timeout", "too close to the action's deadline to start");
		}

		if (!gate.noteLaunch(carrierId, forkId, found.dir)) {
			throw new Refusal("rejected", "the gate can't take another launch");
		}
		const askedOptions = parseForkOptionsRequest(meta.forkOptions) ?? {};
		const prepared = await prepareForkOptions(askedOptions, {
			claudeVersion: binary.version,
			log,
		});
		let runtime: ClaudeStreamRuntime;
		try {
			runtime = await spawnFork({
				binary,
				sessionId: forkId,
				source: sourceId,
				sourceFile: found.transcript,
				mode,
				args: forkArgv({ source: sourceId, fork: forkId, mode, policy: prepared.policy }),
				spawnDir,
				verdict,
				prepared,
				reservedSlot: input.release,
			});
		} catch (error) {
			await prepared.cleanup();
			gate.forgetLaunch(carrierId, forkId);
			throw error;
		}

		const dispose = async () => {
			gate.forgetLaunch(carrierId, forkId);
			await runtime.dispose({ interruptMs: 0, stdinCloseMs: 1_000 }).catch(() => {});
		};
		if (!deps.forkRecord.write({ forkId, source: sourceId, mode, dir: found.dir })) {
			await dispose();
			throw new Refusal("rejected", "the fork can't be recorded");
		}
		runtime.beginSettle();
		const body = {
			status: "succeeded",
			provedCwd: found.dir,
			permissionMode: mode,
			applied: prepared.applied,
		} as const;

		/**
		 * What an answer means for the child. After any attempt that may have reached the server, the child is
		 * never disposed without telling it: a `managed` row with no process behind it and no exit report is
		 * the one state nothing recovers from (P5-B1). A fork the server never wrote is harmless to report on.
		 */
		const conclude = async (answer: Answer, afterPossibleCommit: boolean) => {
			if (answer === "succeeded") {
				if (isGone(runtime)) await reportDegraded(forkId);
				else runtime.settled();
				return;
			}
			if (answer === "failed") {
				await dispose();
				return;
			}
			if (afterPossibleCommit) await reportDegraded(forkId);
			await dispose();
			await refuseWith(action, "takeover", "rejected", "the report was withheld");
		};

		const first = await reportOnce(action, forkId, body);
		// Blocked on the first try sent nothing, so nothing can have been committed: it is a refusal.
		// Blocked after a lost try may hide a commit: the child is held until it can be told.
		if (first === "lost") {
			// Never killed for a lost answer: the server may have committed. Asked again in the background.
			track(untilAnswered(action, forkId, body, first).then((answer) => conclude(answer, true)));
			return;
		}
		if (first === "succeeded") {
			await conclude(first, false);
			log(`[supervisor] resume ${action.id}: taken over as ${forkId} (mode=${mode})`);
			return;
		}
		await conclude(first === "blocked" ? "withheld" : first, false);
	}

	// ---- recovery ----

	function fileExistsFor(sessionId: string): "one" | "none" | "many" {
		if (!configDir) return "none";
		const projects = join(configDir, "projects");
		let count = 0;
		try {
			for (const name of readdirSync(projects)) {
				try {
					if (lstatSync(join(projects, name, `${sessionId}.jsonl`)).isFile()) count += 1;
				} catch {
					// not in this project
				}
			}
		} catch {
			return "none";
		}
		return count === 0 ? "none" : count === 1 ? "one" : "many";
	}

	async function recover(action: ControlAction, forkId: string): Promise<void> {
		parse(action, forkId, "recovery");
		if (hasClaudeStreamRuntime(forkId))
			throw new Refusal("running", "this host already holds the fork");
		if (deps.forkRecord.status(forkId) === "unknown") throw new Refusal("thread_unverified");
		const record = deps.forkRecord.lookup(forkId);
		if (record === null) {
			// A record that names this fork but not a usable mode is a rules change no upgrade clears.
			throw new Refusal(
				deps.forkRecord.lookupRaw(forkId) !== null ? "branch_changed" : "thread_unverified",
			);
		}

		let release: () => void;
		try {
			release = reserveClaudeStreamSlot(forkId, deps.startExtra?.maxRuntimes);
		} catch (error) {
			if (error instanceof ClaudeStartRefusal) throw mapStartRefusal(error);
			throw error;
		}
		let handedOver = false;
		try {
			await runRecovery({
				action,
				forkId,
				record,
				release,
				handedOver: () => {
					handedOver = true;
				},
			});
		} finally {
			if (!handedOver) release();
		}
	}

	async function runRecovery(input: {
		action: ControlAction;
		forkId: string;
		record: NonNullable<ReturnType<ClaudeForkRecord["lookup"]>>;
		release: () => void;
		handedOver: () => void;
	}): Promise<void> {
		const { action, forkId, record } = input;
		const { binary, verdict } = await preflight();
		const listed = await listedIds(binary);
		if (listed.has(forkId)) throw new Refusal("running", "the fork is listed by agents");

		const spawnDir = await judgeDirectory(record.dir);
		const own = fileExistsFor(forkId);
		if (own === "many") throw new Refusal("rejected", "more than one transcript for the fork");
		// What the fork was started with comes from the resume action the server built, never from anything the
		// host could read about the session; an action without it (a server older than the options) is "none".
		const stored: AppliedForkOptions | null = parseAppliedForkOptions(
			(action.metadata as { storedForkOptions?: unknown } | null)?.storedForkOptions,
		);
		const askedOptions: ForkOptionsRequest = stored
			? { mcp: stored.mcpServers.length > 0, subagents: stored.subagents }
			: {};
		const prepared = await prepareForkOptions(askedOptions, {
			claudeVersion: binary.version,
			stored,
			log,
		});
		let args: string[] = [];
		let source: string | undefined;
		let sourceFile: string | null = null;
		try {
			if (own === "one") {
				args = inPlaceArgv({
					fork: forkId,
					record: { source: record.source, mode: record.mode },
					mode: record.mode,
					policy: prepared.policy,
				});
			} else {
				// Never prompted: no file, so it can't be resumed; fork again from S under the same N (0b-a4).
				if (listed.has(record.source)) throw new Refusal("running", "S is listed by agents");
				const found = findSourceDirectory({
					configDir,
					sessionId: record.source,
					candidate: record.dir,
				});
				if (!found.ok) throw new Refusal(found.kind, "the source can't be proved");
				judgeWorkedDirectories(found.cwds, record.dir);
				args = forkArgv({
					source: record.source,
					fork: forkId,
					mode: record.mode,
					policy: prepared.policy,
				});
				source = record.source;
				sourceFile = found.transcript;
			}
		} catch (error) {
			await prepared.cleanup();
			throw error;
		}

		input.handedOver();
		let runtime: ClaudeStreamRuntime;
		try {
			runtime = await spawnFork({
				binary,
				sessionId: forkId,
				...(source ? { source } : {}),
				sourceFile,
				mode: record.mode,
				args,
				spawnDir,
				verdict,
				prepared,
				reservedSlot: input.release,
			});
		} catch (error) {
			await prepared.cleanup();
			throw error;
		}
		const dispose = () => runtime.dispose({ interruptMs: 0, stdinCloseMs: 1_000 }).catch(() => {});
		runtime.beginSettle();
		const stateBody = {
			sessionId: forkId,
			launchRequestId: action.launchRequestId ?? undefined,
			agentType: "claude_code",
			managedState: "managed",
			status: "idle",
			providerSyncState: "synced",
			clearProviderSyncError: true,
			resumeActionId: action.id,
		} as Parameters<ReportGate["reportResumeState"]>[0];

		/** One attempt at the (idempotent) state upsert: sent, lost (ask again), or refused for good. */
		const stateOnce = async (): Promise<"sent" | "lost" | "withheld" | "failed"> => {
			try {
				const outcome = await gate.reportResumeState(stateBody);
				// Blocked may pass (the rules are repaired): held like a lost answer, never read as a failure.
				if (outcome === "sent") return "sent";
				return outcome === "blocked" ? "lost" : "withheld";
			} catch (error) {
				const failure = classifyReportFailure(error);
				return failure === "network" || failure === "server" || failure === "backoff"
					? "lost"
					: "failed";
			}
		};
		/** The child holds the session until the state is in: a lost answer is asked again, never read as a failure (P5-B2). */
		const finishRecovery = async (state: "sent" | "lost" | "withheld" | "failed") => {
			let delay = deps.retryBaseMs ?? 1_000;
			let current = state;
			while (current === "lost") {
				await wait(delay);
				delay = Math.min(delay * 2, deps.retryMaxMs ?? 30_000);
				current = await stateOnce();
			}
			if (current !== "sent") {
				// The upsert may have landed: the row must not stay `managed` over a process we are about to end.
				await reportDegraded(forkId);
				await dispose();
				await refuseWith(
					action,
					"recovery",
					"rejected",
					`the state report was ${current}`,
					record.mode,
				);
				return;
			}
			if (isGone(runtime)) {
				await reportDegraded(forkId);
				return;
			}
			runtime.settled();
			const body = { status: "succeeded" } as const;
			const answer = await untilAnswered(
				action,
				forkId,
				body,
				await reportOnce(action, forkId, body),
			);
			if (answer === "succeeded" && isGone(runtime)) await reportDegraded(forkId);
		};
		const first = await stateOnce();
		if (first === "lost") {
			track(finishRecovery(first));
			return;
		}
		await finishRecovery(first);
	}

	// ---- the entry ----

	async function refuseWith(
		action: ControlAction,
		resumeKind: ResumeKind,
		kind: ResumeFailureKind,
		detail?: string,
		mode?: ClaudeForkMode,
		version?: { found: string; range: string },
	): Promise<void> {
		log(
			`[supervisor] resume ${action.id} refused: ${kind}${detail ? ` (${detail.slice(0, 200)})` : ""}`,
		);
		const words =
			gate.rulesState() !== "none"
				? RESUME_REFUSED_MESSAGE[resumeKind](deps.hostName)
				: resumeFailureMessage(
						kind,
						deps.hostName,
						resumeKind,
						"claude_code",
						mode,
						isRecord(action.metadata) && typeof action.metadata.sourceName === "string"
							? action.metadata.sourceName
							: null,
						version,
					);
		try {
			await gate.refuseResume(action.id, words);
		} catch (error) {
			log(
				`[supervisor] couldn't report a refused resume: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return {
		async run(action, sessionId) {
			const meta = isRecord(action.metadata) ? action.metadata : {};
			const resumeKind: ResumeKind = meta.resumeKind === "recovery" ? "recovery" : "takeover";
			try {
				// The directory `agents --json` runs in: private, empty, never S's.
				mkdirSync(deps.probeCwd, { recursive: true, mode: 0o700 });
				if (resumeKind === "recovery") await recover(action, sessionId);
				else await takeover(action, sessionId);
			} catch (error) {
				if (error instanceof Refusal) {
					const mode =
						resumeKind === "recovery" ? deps.forkRecord.lookup(sessionId)?.mode : undefined;
					return refuseWith(action, resumeKind, error.kind, error.detail, mode, error.version);
				}
				return refuseWith(
					action,
					resumeKind,
					"rejected",
					error instanceof Error ? error.message : "resume failed",
				);
			}
		},
		async idle() {
			while (retrying.size > 0) await Promise.allSettled([...retrying]);
		},
		async isListed(sessionId) {
			try {
				mkdirSync(deps.probeCwd, { recursive: true, mode: 0o700 });
				const { binary } = await resolve();
				return (await listedIds(binary)).has(sessionId) ? "listed" : "not_listed";
			} catch {
				return "unknown";
			}
		},
	};
}
