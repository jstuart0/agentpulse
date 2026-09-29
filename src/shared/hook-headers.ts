/**
 * Cross-branch hook-delivery literals (AGEN-16). Constants only — no
 * runtime logic, so this is safe to import from both the supervisor
 * process (src/supervisor/**) and the server (src/server/**) without
 * creating a dependency between them.
 *
 * DELIVERY_ID_HEADER / ORIGIN_HEADER / ORIGIN_CODEX_OBSERVER: the
 * codex-observer (Phase 4) stamps these on every POST /api/v1/hooks
 * request; the server (Phase 7) reads them to build durable dedup
 * identity and to distinguish observer-origin deliveries from native
 * agent hooks and relay-forwarded ones.
 *
 * CODEX_NATIVE_MARKER_DIR: the sibling campaign's Codex hook shim writes
 * an empty marker file at `$HOME/<CODEX_NATIVE_MARKER_DIR>/<session_id>`
 * before its curl call (Decision 19 / mozart D12). This campaign's
 * observer reads it via isNativeCovered() to stand down for sessions
 * native hooks already cover. `$HOME`, not `$AGENTPULSE_DIR`: the
 * Codex-spawned shim and the supervisor process don't share an
 * environment, so the path must be fixed.
 */

export const DELIVERY_ID_HEADER = "X-AgentPulse-Delivery-Id";
export const ORIGIN_HEADER = "X-AgentPulse-Origin";
export const ORIGIN_CODEX_OBSERVER = "codex-observer";
export const CODEX_NATIVE_MARKER_DIR = ".agentpulse/codex-native";
