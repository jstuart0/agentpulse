/**
 * The audit line for an admin action: one structured JSON line naming who did
 * it (`by` is the acting user's id, or null for a key, the DISABLE_AUTH
 * operator or a system actor, whose kind is in `actor`). It is the only record
 * of the action, so it carries ids and facts, never secrets: callers must not
 * put a password, a key or a token in `fields`.
 */
import type { Actor } from "../auth/actor.js";

export function logAdminAction(kind: string, actor: Actor, fields: Record<string, unknown>): void {
	console.log(
		JSON.stringify({ kind, level: "info", by: actor.userId, actor: actor.label, ...fields }),
	);
}
