/**
 * Sentences the server writes onto a managed session or its control action, and the web matches or shows.
 * One module, so the writer and every reader hold the same string (AGEN-91).
 */

/**
 * The `providerSyncError` registration writes on a Codex session whose host's supervisor restarted: its
 * app-server process is gone. The writer (`degradeCodexSessionsOfRestartedHost`) and the replay guard in
 * `upsertManagedSessionState` both import this one string, and so does the composer, to say why a degraded
 * session can't take prompts. Only registration writes it; a replayed `managed` report must not undo a row
 * that carries it.
 */
export const HOST_RESTARTED_SYNC_ERROR =
	"The host's supervisor restarted, so this session's Codex process is gone.";

/** The `error` an action carries when its lock ran out before the supervisor reported: its outcome is unknown. */
export const CONTROL_TIMEOUT_ERROR = "Control action timed out waiting for supervisor completion.";

/** The words every reader of the "host can't take Codex prompts" refusal shares: the 409 body, the AI path, the claim-time failure, the web. */
export const HOST_UPGRADE_REQUIRED_MESSAGE =
	"This session's host is running an older supervisor that can't send prompts to Codex. Update it, then start a new session for this work. Updating ends the sessions running there.";

/**
 * What a person is told when a Claude stop is refused because the host's supervisor predates it (the
 * `host_upgrade_required` of a stop). Fixed: nothing about the host is echoed.
 */
export const CLAUDE_STOP_UPGRADE_MESSAGE =
	"This session's host is running an older supervisor that can't stop Claude sessions. Update it, then try again.";

/**
 * The words of a stop that found nothing to stop (AGEN-110): no process registered for the session under this
 * host's control. The session still reads stopped, so a lost final report can't wedge it, but neither the
 * timeline event nor the action claims a process was stopped.
 */
export const NOTHING_RUNNING_STOP_NOTE =
	"Stop requested. Nothing was running under this host's control, so nothing was stopped. A process from before a supervisor restart may still be running.";

/** The `error` a stop action carries when the host's attempt failed in a way it won't describe. Fixed: detail stays in the host log. */
export const STOP_FAILED_ERROR =
	"The stop didn't finish, so the session may still be running on this machine. Try again.";

/**
 * What a stop says when the child is gone but AgentPulse could never read the process table while it lived,
 * so the commands the child started were never looked for. The session still reads stopped (the child is
 * dead); this is the honest sentence on the timeline event and the action in place of "stopped by operator".
 */
export const STOPPED_UNCHECKED_NOTE =
	"Claude stopped, but AgentPulse couldn't check for commands it started; some may still be running.";

/** The `error` a Claude prompt carries when a person's Stop pre-empted it (AGEN-117 T12). Fixed. */
export const STOPPED_BY_PERSON_ERROR = "Stopped by a person.";

/** The `error` a Claude prompt or headless launch carries when its host's supervisor restarted mid-turn. Fixed. */
export const HOST_RESTARTED_TURN_ERROR =
	"The host's supervisor restarted, so this turn ended without a result.";

/** Why a host refuses to start a second Claude process for a session that already has one. Fixed: nothing about the process is echoed. */
export const CLAUDE_TURN_RUNNING_ERROR =
	"Claude is still working on the last prompt, so nothing was sent. Try again when it finishes.";

/** Why a headless resume is refused: `claude agents` lists the session, so another Claude may be writing to it. */
export const CLAUDE_SESSION_OPEN_ERROR =
	"This conversation is still open on this machine, in a terminal or as a background agent, so nothing was sent. Close it there, then try again.";
