import { attachManagedSessionToLaunch } from "./managed-session-state.js";
import { findPendingLaunchForObservedSession, markLaunchRunning } from "./launch-dispatch.js";

export async function enrichObservedSession(sessionId: string, supervisorId?: string | null) {
	const launchRequest = await findPendingLaunchForObservedSession(sessionId);
	if (!launchRequest) return null;

	const resolvedSupervisorId =
		supervisorId ?? launchRequest.claimedBySupervisorId ?? launchRequest.requestedSupervisorId ?? "unknown";

	await attachManagedSessionToLaunch({
		sessionId,
		launchRequestId: launchRequest.id,
		supervisorId: resolvedSupervisorId,
		correlationSource: "session_id",
	});

	return markLaunchRunning(launchRequest.id);
}

