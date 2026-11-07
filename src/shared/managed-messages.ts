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

/** Stored on a taken-over Claude session when its host's supervisor registered again: the process it ran is gone (AGEN-117 T10). */
export const HOST_RESTARTED_FORK_SYNC_ERROR =
	"The host's supervisor restarted, so this session's Claude process is gone.";

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

/**
 * The words of a prompt a Claude fork refuses because its text starts with a slash (AGEN-117 T16). The
 * server and the host both refuse it, so both say this; a slash line would otherwise reach the model as text.
 */
export const CLAUDE_FORK_SLASH_MESSAGE =
	"Messages starting with / don't work in this session. Reword it so it starts with something else.";

/** A fork's prompt when this host holds no Claude process for it: the person resumes the session, then sends again. Fixed. */
export const CLAUDE_FORK_NO_RUNTIME_ERROR =
	"Claude isn't running for this session on this machine, so nothing was sent. Resume the session, then send your prompt again.";

/** A prompt for a session the host runs as a long-lived fork can't be started as a one-prompt process. Fixed. */
export const CLAUDE_FORK_NOT_HEADLESS_ERROR =
	"This session runs as a continued conversation, so it can't take a prompt this way. Nothing was sent.";

/** The prompt of a session whose Claude process is the host's long-lived one, sent down the one-prompt path. Fixed. */
export const CLAUDE_STREAM_HELD_ERROR =
	"This session's Claude is already running as a continued conversation on this machine, so nothing was sent.";

/** The `error` of a fork's prompt when another Claude has the conversation open on the machine. Fixed. */
export const CLAUDE_FORK_TERMINAL_FOUND_ERROR =
	"This session is open in a terminal on this machine, so nothing was sent. Close it there. `claude --continue` in this directory opens this session.";

/** The `error` when the host could not check whether the fork is open elsewhere. Fixed. */
export const CLAUDE_FORK_CHECK_FAILED_ERROR =
	"AgentPulse couldn't check whether this session is open elsewhere on this machine, so nothing was sent. Your text is here. Send it again.";

/** The `error` of a prompt sent while the fork's turn is still running. Fixed. */
export const CLAUDE_FORK_BUSY_ERROR =
	"Claude is still on this turn. Your text is here. Send it when the turn ends.";

/** A first prompt that did not find the process the way the host expected: it was stopped. Fixed. */
export const CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR =
	"Claude didn't start the way AgentPulse expected, so it was stopped. Continue the original session in a new session to try again.";

/** Claude Code lost its login between turns. Fixed. */
export const CLAUDE_LOGIN_LOST_ERROR =
	"Claude Code on this machine lost its login. If the supervisor uses a token from `claude setup-token`, it may have expired. Give the supervisor a new token or an API key, restart it, then resume this session and send your prompt again.";

/** Claude hit an API error before it could reply. Fixed. */
export const CLAUDE_API_ERROR_MESSAGE =
	"Claude Code on this machine hit an error before it could reply. Send your prompt again.";

/** The fork's process changed how it was running (another session id or permission mode on a line), so the host stopped it. Fixed. */
export const CLAUDE_FORK_CHANGED_SYNC_ERROR =
	"Claude Code on this machine changed how it was running, so AgentPulse stopped it. Its last turn may not all be here. Resume it to keep going.";

/** Something that was not the host sent the fork a message; the host stopped it. Fixed. */
export const CLAUDE_FORK_PEER_SYNC_ERROR =
	"Something else on this machine sent this session a message, so AgentPulse stopped it.";

/**
 * AgentPulse tried to end a fork's process (a protocol violation, or a failed start) and could not confirm it
 * ended. The host keeps holding the fork, so it cannot be resumed beside the process; End it again. Fixed.
 */
export const CLAUDE_FORK_UNSTOPPABLE_SYNC_ERROR =
	"AgentPulse couldn't confirm that Claude stopped on this machine, so this session can't take prompts or be resumed yet. End it again, or stop the Claude process yourself.";

/** The fork's process exited without a Stop. Fixed. */
export const CLAUDE_FORK_EXITED_SYNC_ERROR =
	"Claude stopped running on this machine, so this session can't take prompts. Resume it to keep going.";

/** A prompt to a continued session that runs under the person's own Claude settings is refused for an API key or the watcher. Fixed. */
export const FORK_PROMPT_NEEDS_PERSON_MESSAGE =
	"This session runs under your own Claude settings, which can allow actions without asking, so only a signed-in person can send it a prompt.";

/** The label above the text of a message something else sent a continued session: it is the last one found, which may not be the one that stopped it. */
export const PEER_TURN_LABEL = "The last message found in the transcript:";

/** The one-prompt path refuses when this host's record of the forks it started can't be read, because it can't tell a fork from a launched session. Fixed. */
export const CLAUDE_FORK_RECORD_UNREADABLE_ERROR =
	"This machine's record of continued sessions can't be read, so it can't tell whether this one is continued, and nothing was sent. Check the record under ~/.agentpulse, then try again.";
