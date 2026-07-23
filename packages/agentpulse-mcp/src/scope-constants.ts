/**
 * Vendored API-key scope literals (AGEN-12 follow-on, D3 — package
 * extraction campaign 2026-07-23-deliver-agentpulse-mcp-package, Phase 2).
 *
 * Canonical definition: src/server/auth/api-key.ts. These are wire-protocol
 * literals ("*"/"manage"/"observe" as sent/received over HTTP), duplicated
 * by design (Pattern B in the plan) — renaming a scope server-side is a
 * cross-package breaking change, not just an in-repo import update. A
 * parity note lives at both definition sites.
 */

export const SCOPE_ALL = "*";
export const SCOPE_MANAGE = "manage";
export const SCOPE_OBSERVE = "observe";
