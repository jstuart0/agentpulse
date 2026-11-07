import { homedir } from "node:os";
import { join } from "node:path";
import { DELIVERY_ID_HEADER, REPLAY_HEADER } from "../shared/hook-headers.js";
import type { ControlAction, LaunchRequest, ManagedSession } from "../shared/types.js";
import {
	ensureSupervisorConfigPrivate,
	loadSupervisorConfig,
	saveSupervisorConfig,
} from "./config.js";
import { createControlActionHandler } from "./control-actions.js";
import { createLaunchDispatcher } from "./launch-dispatch.js";
import { headlessRuntimeCount } from "./providers/claude-headless.js";
import { claudeStreamRuntimeCount } from "./providers/claude-stream.js";
import {
	hasClaudeStreamRuntime,
	hasHeadlessRuntime,
	launchClaudeHeadlessRequest,
	launchClaudeInteractiveRequest,
	promptClaudeHeadlessSession,
	promptClaudeInteractiveSession,
	promptClaudeStreamSession,
	stopClaudeStreamSession,
	stopHeadlessClaude,
} from "./providers/claude.js";
import { wireCodexApprovals } from "./providers/codex-approvals-wiring.js";
import {
	hasManagedCodexRuntime,
	launchManagedCodexRequest,
	managedCodexRuntimeCount,
	managedCodexRuntimeHolds,
	promptManagedCodexSession,
	reconcileManagedCodexTitles,
	resumeManagedCodexSession,
	stopManagedCodexSession,
} from "./providers/codex-managed.js";
import { warmCodexProtocolVerdict } from "./providers/codex-protocol.js";
import { createBridgeSpoolDrain } from "./services/bridge-spool.js";
import { createClaudeForkRecord } from "./services/claude-fork-record.js";
import { createClaudeTakeover } from "./services/claude-takeover.js";
import { executeCleanupWorkArea } from "./services/cleanup-workarea.js";
import { isCodexObserverEnabled, startCodexObserver } from "./services/codex-observer.js";
import {
	createRulesWatch,
	resolveAccountHome,
	warnIfHomeMismatch,
} from "./services/exclude-rules-watch.js";
import { disposeRuntimesAndExit } from "./services/fatal-exit.js";
import { createFinalReporter } from "./services/final-report.js";
import {
	countBridgesBounded,
	keepAliveLine,
	shouldExitOnStaleHeartbeat,
} from "./services/keep-alive.js";
import { parseErrorBodyField, sanitizeForLog } from "./services/log-sanitize.js";
import { createManagedThreadRecord } from "./services/managed-thread-record.js";
import { executePrelaunchActions } from "./services/prelaunch-actions.js";
import { retryWithBackoff } from "./services/registration-retry.js";
import { createReportGate, heartbeatBody, heartbeatOutbox } from "./services/report-gate.js";
import { createReportOutbox } from "./services/report-outbox.js";
import {
	SupervisorNetworkError,
	SupervisorRequestError,
	classifyReportFailure,
	createCredentialTripwire,
	credentialRejectionMayConfirm,
	parseRetryAfterMs,
	setSharedCredentialTripwire,
} from "./services/report-resilience.js";
import { createServerFeatures } from "./services/server-features.js";
import {
	createSessionResumer,
	isObserverHeld,
	resolveNeutralCwd,
} from "./services/session-resume.js";
import { assertTrustedRootsExcludeAgentpulseDir } from "./services/spawn-cwd.js";

const REQUEST_TIMEOUT_MS = 15_000;
/** How often the exclude rules are re-read for a changed symlink, the stamp is refreshed and sessions a new rule covers are closed. */
const EXCLUDE_SCAN_MS = 15_000;
/** How often the terminal bridges' spooled reports are sent. */
const BRIDGE_DRAIN_MS = 1_000;
/** How often queued reports are sent. */
const OUTBOX_FLUSH_MS = 3_000;
/** How often the heartbeat is tried while the server is unreachable. */
const OFFLINE_PROBE_MS = 10_000;
/** The watchdog does not wait longer than this to learn how many terminal bridges are alive. */
const BRIDGE_COUNT_TIMEOUT_MS = 2_000;

/** The only headers a caller may add to a request: the delivery id and the replay marker. Everything else is the transport's own. */
const CALLER_HEADERS = [DELIVERY_ID_HEADER, REPLAY_HEADER];

async function request(path: string, options?: RequestInit) {
	const config = await loadSupervisorConfig();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.supervisorCredential)
		headers["X-AgentPulse-Supervisor-Token"] = config.supervisorCredential;
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
	const callerHeaders = new Headers(options?.headers);
	for (const name of CALLER_HEADERS) {
		const value = callerHeaders.get(name);
		if (value) headers[name] = value;
	}

	let res: Response;
	try {
		res = await fetch(`${config.serverUrl}/api/v1${path}`, {
			...options,
			headers,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (cause) {
		// No answer at all (unreachable, reset, timed out): a different thing from an HTTP error.
		throw new SupervisorNetworkError(cause);
	}
	if (!res.ok) {
		// Best-effort: carry the server's own error string (F43) alongside the
		// raw status for logging. F49: both the body and statusText are
		// attacker-controlled (a malicious/compromised server, or a
		// network-position attacker on an unencrypted http:// path) — bound
		// the body read and strip control/ANSI characters before either ever
		// reaches a log line.
		const bodyError = await parseErrorBodyField(res);
		throw new SupervisorRequestError(
			res.status,
			sanitizeForLog(res.statusText),
			bodyError,
			parseRetryAfterMs(res.headers.get("retry-after"), Date.now()),
		);
	}
	try {
		return await res.json();
	} catch (cause) {
		// A 2xx that isn't JSON is not the server's answer (a captive portal, a proxy's error page): it is
		// treated like no answer at all, so nothing queued is taken as delivered.
		throw new SupervisorNetworkError(cause);
	}
}

async function main() {
	// AGEN-21: self-heal a pre-fix, over-permissive supervisor.json before
	// anything reads it.
	ensureSupervisorConfigPrivate();
	const config = await loadSupervisorConfig();
	// Refuse to run with a trusted root that contains this supervisor's own state directory.
	await assertTrustedRootsExcludeAgentpulseDir(config.trustedRoots);
	// F43/D10: registration retries forever on any HTTP failure (including
	// an old-shadow 401/403 from a not-yet-upgraded server during a
	// mixed-version rollout) and on no answer at all (the server is down or
	// unreachable, as it is when the supervisor restarts mid-outage) instead
	// of exiting and crash-looping, and on a 2xx that isn't JSON (treated as
	// no answer). Only a config load failure is fatal here.
	const registration = (await retryWithBackoff(
		() =>
			request("/supervisors/register", {
				method: "POST",
				body: JSON.stringify({
					id: config.id,
					enrollmentToken: config.enrollmentToken,
					hostName: config.hostName,
					platform: config.platform,
					arch: config.arch,
					version: config.version,
					trustedRoots: config.trustedRoots,
					capabilities: config.capabilities,
					capabilitySchemaVersion: 3,
					configSchemaVersion: 1,
				}),
			}),
		(error, attempt, delayMs) => {
			console.error(
				`[supervisor] registration failed (attempt ${attempt + 1}): ${
					error instanceof SupervisorRequestError
						? `status=${error.status} statusText=${error.statusText}${error.error ? ` body.error=${error.error}` : ""}`
						: "no response from the server (unreachable or timed out)"
				}; retrying in ${delayMs}ms`,
			);
		},
	)) as {
		supervisor: { id: string; hostName: string };
		heartbeatIntervalMs: number;
		supervisorCredential?: string;
		serverFeatures?: string[];
	};

	if (config.id !== registration.supervisor.id || registration.supervisorCredential) {
		await saveSupervisorConfig({
			...config,
			id: registration.supervisor.id,
			enrollmentToken: undefined,
			supervisorCredential: registration.supervisorCredential ?? config.supervisorCredential,
		});
	}

	console.log(
		`[supervisor] Registered ${registration.supervisor.hostName} (${registration.supervisor.id})`,
	);

	// The user's exclude rules, read once and shared by the report gate and the Codex observer.
	const home = process.env.HOME || homedir();
	const rules = createRulesWatch({ home });
	warnIfHomeMismatch(home, resolveAccountHome(), (line) => console.warn(line));

	// Observe local Codex rollout files and forward events as hooks. Codex's
	// own HTTP hooks have been stable since codex-cli 0.124.0 and are the
	// primary event source; the observer stays as belt-and-suspenders (dual
	// coverage) and backfill for sessions started before the supervisor was
	// running. Demotion to a pure fallback is a follow-up once more
	// reliability data is collected.
	//
	// AGENTPULSE_CODEX_OBSERVER=off is an operator-only escape hatch — no
	// installer sets it (Decision 19 supersedes the installer-disables-it
	// approach: it fails closed whenever native hooks are untrusted).
	// Sessions this host is resuming (D16): the observer reads their lines and posts nothing, so a resumed
	// turn can't also arrive as a second UserPromptSubmit and Stop beside the managed one.
	const resumingSessions = new Set<string>();
	const forkRecord = createClaudeForkRecord({
		path: join(home, ".agentpulse", "claude-forks.json"),
	});
	const threadRecord = createManagedThreadRecord({
		path: join(home, ".agentpulse", "managed-threads.json"),
	});
	if (isCodexObserverEnabled(process.env)) {
		void startCodexObserver({
			serverUrl: config.serverUrl,
			apiKey: config.apiKey ?? null,
			rules,
			hostName: config.hostName,
			isHeld: (id) => isObserverHeld(resumingSessions, hasManagedCodexRuntime, id),
		}).catch((error) => {
			console.error("[codex-observer] failed to start:", error);
		});
	} else {
		console.log("[codex-observer] disabled via AGENTPULSE_CODEX_OBSERVER=off");
	}

	// One tripwire serves every place a rejected credential can show up (the heartbeat, the report gate, the
	// terminal-bridge drain, in-session reporting), so a stray proxy 401 in one doesn't count as a confirmed
	// rejection on its own, and over plain HTTP to a non-local server none is ever acted on.
	const credentialTripwire = createCredentialTripwire({
		now: Date.now,
		canConfirm: credentialRejectionMayConfirm(config.serverUrl),
		log: (line) => console.warn(line),
	});
	setSharedCredentialTripwire(credentialTripwire);

	// The protocol check is started now so it is normally ready by a first launch.
	warmCodexProtocolVerdict();

	// Every report about a session leaves through this gate (see report-gate.ts): it holds the
	// directories sessions and launches were started in, and the one closing report a newly
	// excluded session gets. The rules it reads are the observer's too. Reports it can't deliver while
	// the server is unreachable are kept in the offline outbox and sent, in order, when it returns.
	const outbox = createReportOutbox({
		home,
		supervisorId: registration.supervisor.id,
		log: (line) => console.warn(line),
	});
	const gate = createReportGate({
		request,
		supervisorId: registration.supervisor.id,
		home,
		version: config.version,
		rules,
		outbox,
		isBridgeActive: (sessionId) => bridgeSpool.isBridgeActive(sessionId),
		credentialTripwire,
		onCredentialRejected: disposeRuntimesAndExit,
	});
	setInterval(() => {
		gate.flush().catch((error) => console.error("[supervisor] outbox flush failed", error));
	}, OUTBOX_FLUSH_MS).unref();

	// Every approval a managed Codex session asks for is answered here: declined unless the server issues
	// an accept for exactly that request. The tracker reaches the server only through the gate, and the
	// server tells it what it can do on registration and on every heartbeat (absent means off).
	const approvalsWiring = wireCodexApprovals({ gate, serverFeatures: registration.serverFeatures });
	// The same list for the Claude turn guard's renewals, kept current by every heartbeat.
	const serverFeatures = createServerFeatures(registration.serverFeatures);
	// A launch's or prompt's last status, kept and retried until the server answers.
	const finalReport = createFinalReporter();

	// The interactive terminal bridge holds no credential and opens no connection: it writes its reports to
	// disk and this drain sends them through the gate.
	const bridgeSpool = createBridgeSpoolDrain({ gate, home, credentialTripwire });
	void bridgeSpool.scrubLegacyBridgeConfigs().catch((error) => {
		console.error("[supervisor] couldn't scrub old bridge configs", error);
	});
	setInterval(() => void bridgeSpool.drain(), BRIDGE_DRAIN_MS).unref();

	// The watchdog: a heartbeat that has not succeeded for a while normally means the server is
	// unreachable, which is no reason to stop the agents running here. It exits for the service manager to
	// restart only when it holds nothing to look after (shouldExitOnStaleHeartbeat). Queued reports do not
	// keep it alive: they are on disk and are replayed after the restart.
	let lastHeartbeatOkAt = Date.now();
	let staleLogged = false;
	const watchdogStaleMs = Math.max(registration.heartbeatIntervalMs * 3, 90_000);
	setInterval(
		() => {
			void (async () => {
				const staleMs = Date.now() - lastHeartbeatOkAt;
				if (staleMs <= watchdogStaleMs) return;
				const codex = managedCodexRuntimeCount();
				// A takeover fork is a Claude process of ours like a one-prompt child, and keeps the host alive the same way.
				const headless = headlessRuntimeCount() + claudeStreamRuntimeCount();
				// Only a stale host with no agent of its own looks at the filesystem for live terminal bridges;
				// not knowing (an error, no answer in time) counts as "something may be running".
				const bridges =
					codex > 0 || headless > 0
						? 0
						: await countBridgesBounded(
								() => bridgeSpool.liveBridgeCount(),
								BRIDGE_COUNT_TIMEOUT_MS,
							);
				if (
					shouldExitOnStaleHeartbeat({
						staleMs,
						thresholdMs: watchdogStaleMs,
						codex,
						headless,
						bridges,
					})
				) {
					console.error(
						`[supervisor] watchdog: no successful heartbeat in ${Math.round(staleMs / 1000)}s — exiting for launchd/systemd restart`,
					);
					process.exit(1);
				}
				if (!staleLogged) {
					staleLogged = true;
					console.log(`[supervisor] ${keepAliveLine(staleMs, codex + headless + (bridges ?? 0))}`);
				}
			})().catch((error) => console.error("[supervisor] watchdog failed", error));
		},
		Math.max(10_000, Math.floor(registration.heartbeatIntervalMs / 2)),
	).unref();
	const dispatchLaunch = createLaunchDispatcher({
		gate,
		bridgeSpool,
		trustedRoots: config.trustedRoots,
		providers: {
			launchManagedCodex: launchManagedCodexRequest,
			launchClaudeHeadless: launchClaudeHeadlessRequest,
			launchClaudeInteractive: launchClaudeInteractiveRequest,
		},
		executePrelaunchActions,
		recordThread: (launchRequestId, threadId) => threadRecord.write(launchRequestId, threadId),
		finalReport,
	});
	const claudeTakeover = createClaudeTakeover({
		gate,
		hostName: config.hostName,
		trustedRoots: config.trustedRoots,
		forkRecord,
		env: process.env,
		probeCwd: join(home, ".agentpulse", "claude-probe"),
		tracker: approvalsWiring.approvals,
	});
	const resumeSession = createSessionResumer({
		gate,
		hostName: config.hostName,
		trustedRoots: config.trustedRoots,
		record: threadRecord,
		hold: resumingSessions,
		neutralCwd: () => resolveNeutralCwd(home),
		providers: { managedCodexRuntimeHolds, resumeManagedCodexSession },
		claude: claudeTakeover,
	});
	const handleControlAction = createControlActionHandler({
		resumeSession,
		gate,
		trustedRoots: config.trustedRoots,
		providers: {
			stopManagedCodexSession,
			promptManagedCodexSession,
			hasManagedCodexRuntime,
			promptClaudeHeadlessSession,
			promptClaudeInteractiveSession,
			stopHeadlessClaude,
			promptClaudeStreamSession,
			stopClaudeStreamSession,
			hasClaudeStreamRuntime,
			hasHeadlessRuntime,
		},
		forkStatus: (sessionId) => forkRecord.status(sessionId),
		forkListed: (sessionId) => claudeTakeover.isListed(sessionId),
		executeCleanupWorkArea,
		serverHas: serverFeatures.has,
		finalReport,
	});

	void gate.scan();
	setInterval(() => {
		gate.scan().catch((error) => console.error("[supervisor] exclude scan failed", error));
	}, EXCLUDE_SCAN_MS).unref();

	setInterval(async () => {
		try {
			const result = (await request(`/supervisors/${registration.supervisor.id}/launches/claim`, {
				method: "POST",
			})) as { launchRequest: LaunchRequest | null };
			if (result.launchRequest) {
				await dispatchLaunch(result.launchRequest);
			}
		} catch (error) {
			console.error("[supervisor] claim failed", error);
		}
	}, 3_000);

	let heartbeatInFlight = false;
	async function sendHeartbeat() {
		if (heartbeatInFlight) return;
		heartbeatInFlight = true;
		try {
			// Whether the exclude file on this host is in use, absent or broken, for the Hosts page.
			// Optional on the wire: a server that predates the field ignores the body.
			// The last successful answer's features win; a failed heartbeat leaves the last known value alone.
			const beat = await approvalsWiring.applyHeartbeat(
				() =>
					request(`/supervisors/${registration.supervisor.id}/heartbeat`, {
						method: "POST",
						body: heartbeatBody(gate.rulesState(), heartbeatOutbox(outbox.summary(), Date.now())),
					}) as Promise<{ serverFeatures?: string[] } | null>,
			);
			serverFeatures.set(beat?.serverFeatures);
			lastHeartbeatOkAt = Date.now();
			staleLogged = false;
			gate.noteServerReachable();
			console.log("[supervisor] heartbeat ok");
		} catch (error) {
			console.error("[supervisor] heartbeat failed", error);
			const failure = classifyReportFailure(error);
			if (failure === "network") {
				gate.noteServerUnreachable();
			} else {
				// Any answer from the server, even a refusal, shows it can be reached.
				if (error instanceof SupervisorRequestError) gate.noteServerContact();
				if (failure === "credential" && credentialTripwire.record() === "confirmed") {
					await disposeRuntimesAndExit();
				}
			}
		} finally {
			heartbeatInFlight = false;
		}
	}
	setInterval(() => void sendHeartbeat(), registration.heartbeatIntervalMs);
	// While the server is unreachable a heartbeat is also tried every 10 s, so the first one that gets
	// through lets queued reports flow again without waiting out the regular interval.
	setInterval(() => {
		if (gate.isOffline()) void sendHeartbeat();
	}, OFFLINE_PROBE_MS).unref();

	setInterval(async () => {
		try {
			const result = (await request(
				`/supervisors/${registration.supervisor.id}/provider-sync`,
			)) as { managedSessions: ManagedSession[] };
			await reconcileManagedCodexTitles(result.managedSessions ?? [], (body) =>
				gate.reportState(body),
			);
		} catch (error) {
			console.error("[supervisor] provider sync failed", error);
		}
	}, 3_000);

	setInterval(async () => {
		try {
			const result = (await request(
				`/supervisors/${registration.supervisor.id}/control-actions/claim`,
				{ method: "POST" },
			)) as { action: ControlAction | null };
			if (result.action) await handleControlAction(result.action);
		} catch (error) {
			console.error("[supervisor] control action failed", error);
		}
	}, 2_000);
}

main().catch((error) => {
	console.error("[supervisor] fatal", error);
	process.exit(1);
});
