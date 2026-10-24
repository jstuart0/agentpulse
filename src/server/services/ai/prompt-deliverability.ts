/**
 * Can AgentPulse type a prompt into this session right now?
 *
 * Only a session it launched (a managed row) with a connected supervisor, in a
 * state that takes prompts, with no other control action holding its lock.
 * A hook-observed session can never receive a prompt: nothing in the codebase
 * can inject text into a terminal AgentPulse didn't launch.
 *
 * The answer is advisory (for the UI, and for the runner to choose between an
 * auto send and a HITL). The authoritative check is the conditional control
 * lock taken inside the dispatch transaction.
 */
import { eq } from "drizzle-orm";
import type { ManagedState } from "../../../shared/types.js";
import { getDb } from "../../db/client.js";
import { managedSessions } from "../../db/schema/index.js";
import { expireStaleControlLock } from "../control-actions.js";
import { getSessionOwnerConnections } from "../session-ownership.js";
import { CONTINUABLE_MANAGED_STATES } from "./continuability.js";

export type PromptNotDeliverableReason =
	| "observed"
	| "supervisor_offline"
	| "managed_state"
	| "control_busy";

export type PromptDeliverability =
	| { deliverable: true }
	| { deliverable: false; reason: PromptNotDeliverableReason };

/** The managed row's state and whether its owner-of-record supervisor is connected, or null when unmanaged. */
export async function loadManagedContext(sessionId: string): Promise<{
	managedSession: { managedState: ManagedState };
	supervisorConnected: boolean;
} | null> {
	const [managedRow] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managedRow) return null;
	const connected = (await getSessionOwnerConnections([sessionId])).get(sessionId) ?? false;
	return {
		// Drizzle column is `text`, but every producer only writes
		// ManagedState members — narrow at the boundary.
		managedSession: { managedState: managedRow.managedState as ManagedState },
		supervisorConnected: connected,
	};
}

export async function promptDeliverability(sessionId: string): Promise<PromptDeliverability> {
	// A stale lock would read as "busy"; expiring it is the write queuePromptAction
	// makes first as well.
	await expireStaleControlLock(getDb(), sessionId);

	const managed = await loadManagedContext(sessionId);
	if (!managed) return { deliverable: false, reason: "observed" };
	if (!managed.supervisorConnected) return { deliverable: false, reason: "supervisor_offline" };
	if (!CONTINUABLE_MANAGED_STATES.has(managed.managedSession.managedState)) {
		return { deliverable: false, reason: "managed_state" };
	}

	const [row] = await getDb()
		.select({ activeControlActionId: managedSessions.activeControlActionId })
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (row?.activeControlActionId) return { deliverable: false, reason: "control_busy" };
	return { deliverable: true };
}
