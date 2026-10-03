/**
 * One retry of the "can't reach the server" notice. While the viewer's
 * standing is unknown (the first identity check, or a sign-in that polls keep
 * refusing) the probe IS the identity check, so it is the one request that
 * decides whether the outage is over; otherwise a cheap health call is enough.
 * A probe that doesn't settle the question counts as one failure, which is
 * what lengthens the next wait.
 */
export interface RetryProbeDeps {
	identityPending: boolean;
	loadIdentity: () => Promise<unknown>;
	identityConfirmed: () => boolean;
	health: () => Promise<unknown>;
	onFail: () => void;
}

export async function runRetryProbe(deps: RetryProbeDeps): Promise<void> {
	if (deps.identityPending) {
		try {
			await deps.loadIdentity();
		} catch {
			// Reported through the failure path below.
		}
		if (!deps.identityConfirmed()) deps.onFail();
		return;
	}
	try {
		await deps.health();
	} catch {
		deps.onFail();
	}
}
