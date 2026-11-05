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
