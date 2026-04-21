import type { LaunchRequest } from "../../shared/types.js";
import { findPendingLaunchForObservedSession } from "./launch-dispatch.js";

/**
 * Pure correlation resolver (WS1). Takes an observed session id + an
 * optional supervisor id and returns a resolution record — never writes
 * to any table. Callers that want to associate the session must use a
 * dedicated writer service (e.g. `launchDispatch.associateObservedSession`).
 *
 * Keeping this function pure is the enforcement boundary: linker state
 * and launch lifecycle state always have one writer each, and no route
 * handler composes multi-service writes through the resolver.
 */

export interface CorrelationResolution {
	launchRequest: LaunchRequest;
	resolvedSupervisorId: string;
}

export async function resolveObservedSessionCorrelation(
	sessionId: string,
	supervisorId?: string | null,
): Promise<CorrelationResolution | null> {
	const launchRequest = await findPendingLaunchForObservedSession(sessionId);
	if (!launchRequest) return null;

	const resolvedSupervisorId =
		supervisorId ??
		launchRequest.claimedBySupervisorId ??
		launchRequest.requestedSupervisorId ??
		"unknown";

	return { launchRequest, resolvedSupervisorId };
}
