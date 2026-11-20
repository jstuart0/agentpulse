/**
 * The updater's own state file (`update-state.json`): the newest manifest it accepted (so an older signed
 * one can't be replayed to it), every key id it has seen revoked, versions it rolled back from (never tried
 * again) and what the last run ended with, as codes only. Read through `shared/update-files.ts`; written here.
 */
import { writePrivateFileAtomicNoFollow } from "../shared/private-file.js";
import type { LastSeen } from "../shared/release-manifest.js";
import { type UpdaterState, readUpdateState } from "../shared/update-files.js";
import type { UpdateOutcomeCode } from "../shared/update-status.js";
import { updaterPaths } from "./paths.js";

export function loadState(home: string): UpdaterState {
	return readUpdateState(home);
}

function serialise(state: UpdaterState): string {
	return `${JSON.stringify({ schema: 1, ...state })}\n`;
}

export function saveState(home: string, state: UpdaterState): void {
	writePrivateFileAtomicNoFollow(updaterPaths(home).state, serialise(state));
}

/** Records a verified manifest's replay point and the union of revoked keys. */
export function recordVerified(home: string, next: LastSeen, revoked: string[]): UpdaterState {
	const state = loadState(home);
	const merged: UpdaterState = {
		...state,
		last: next,
		revoked: [...new Set([...state.revoked, ...revoked])],
	};
	saveState(home, merged);
	return merged;
}

/** Sets or clears the automatic runs' backoff, leaving everything else in the state as it is. */
export function saveBackoff(home: string, backoff: UpdaterState["backoff"] | null): void {
	const state = loadState(home);
	const next: UpdaterState = { ...state };
	if (backoff) next.backoff = backoff;
	else next.backoff = undefined;
	saveState(home, next);
}

export function recordOutcome(
	home: string,
	input: {
		code: UpdateOutcomeCode;
		target?: string;
		at: number;
		refuse?: string;
		waitingSince?: string | null;
		/** Undefined leaves the backoff as it is; null clears it; a value sets it. Written with the outcome, in one write. */
		backoff?: UpdaterState["backoff"] | null;
	},
): void {
	const state = loadState(home);
	const next: UpdaterState = {
		...state,
		lastOutcome: input.code,
		at: new Date(input.at).toISOString(),
	};
	if (input.target) next.lastTarget = input.target;
	if (input.refuse) next.refused = { ...state.refused, [input.refuse]: input.code };
	if (input.waitingSince === null) next.waitingSince = undefined;
	else if (input.waitingSince) next.waitingSince = input.waitingSince;
	if (input.backoff === null) next.backoff = undefined;
	else if (input.backoff) next.backoff = input.backoff;
	saveState(home, next);
}
