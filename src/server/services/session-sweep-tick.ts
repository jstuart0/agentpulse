/**
 * The 60-second tick that keeps sessions honest: settle the resume actions whose lock has run out, then
 * let the inactivity sweep move quiet sessions along. The two are independent, so each has its own
 * try/catch: a failure in one never skips the other.
 */
import { sweepExpiredResumeActions } from "./control-actions.js";
import { updateStaleSessions } from "./session-tracker.js";

export interface SessionSweepTickDeps {
	sweepResume?: () => Promise<unknown>;
	updateStale?: () => Promise<number>;
}

export async function runSessionSweepTick(deps: SessionSweepTickDeps = {}): Promise<void> {
	const sweepResume = deps.sweepResume ?? sweepExpiredResumeActions;
	const updateStale = deps.updateStale ?? updateStaleSessions;
	try {
		await sweepResume();
	} catch (err) {
		console.error("[tracker] Error settling expired resume actions:", err);
	}
	try {
		const ended = await updateStale();
		if (ended > 0) {
			console.log(`[tracker] Marked ${ended} stale sessions as completed`);
		}
	} catch (err) {
		console.error("[tracker] Error updating stale sessions:", err);
	}
}
