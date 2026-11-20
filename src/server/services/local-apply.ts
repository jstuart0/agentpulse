import type { InstallKind } from "../../shared/install-record.js";
/**
 * What this machine's own updater has done, as the server may say it: `UpdateStatus.localApply`.
 *
 * It reads two small files under the account's `.agentpulse/` through `shared/update-files.ts`, which believes
 * nothing it can't verify (private, owned by this account, plain, bounded, well-formed) and hands back only
 * closed outcome codes, release versions and timestamps. No path, log text, error message or version string
 * the file made up reaches a client. It never writes, and there is no route that could start an update.
 *
 * Present only for a local install, and only when the updater's state file can be believed: a state file that
 * exists but is malformed reads as `null` (we don't know), never as a guess. A machine whose updater has never
 * run has no state file, which is `{ auto }` alone.
 */
import { readConsent, readUpdateStateChecked } from "../../shared/update-files.js";
import type { LocalApplyStatus } from "../../shared/update-status.js";

export function readLocalApply(
	home: string,
	kind: InstallKind,
	nowMs: number = Date.now(),
): LocalApplyStatus | null {
	if (kind !== "local") return null;
	const state = readUpdateStateChecked(home);
	if (state.kind === "invalid") return null;
	const auto = readConsent(home).on;
	if (state.kind === "absent") return { auto };
	const { lastOutcome, lastTarget, at, waitingSince, backoff } = state.state;
	const until = backoff ? Date.parse(backoff.notBefore) : Number.NaN;
	return {
		auto,
		...(lastOutcome ? { lastOutcome } : {}),
		...(lastTarget ? { lastTarget } : {}),
		...(at ? { at } : {}),
		...(waitingSince ? { waitingSince } : {}),
		...(backoff && until > nowMs ? { backoffUntil: backoff.notBefore } : {}),
	};
}

const CACHE_MS = 5_000;
let cached: { at: number; key: string; value: LocalApplyStatus | null } | null = null;

/** `readLocalApply` with a five-second memory, so a busy `/capabilities` costs two file reads at most that often. */
export function readLocalApplyCached(
	home: string,
	kind: InstallKind,
	nowMs: number,
): LocalApplyStatus | null {
	const key = `${home}\0${kind}`;
	if (cached && cached.key === key && nowMs - cached.at < CACHE_MS) return cached.value;
	const value = readLocalApply(home, kind, nowMs);
	cached = { at: nowMs, key, value };
	return value;
}
