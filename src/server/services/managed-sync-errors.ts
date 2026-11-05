/**
 * The `providerSyncError` registration writes on a Codex session whose host's supervisor restarted: its
 * app-server process is gone. The writer (`degradeCodexSessionsOfRestartedHost`) and the replay guard in
 * `upsertManagedSessionState` both import this one string. Only registration writes it; a replayed
 * `managed` report must not undo a row that carries it.
 */
export const HOST_RESTARTED_SYNC_ERROR =
	"The host's supervisor restarted, so this session's Codex process is gone.";
