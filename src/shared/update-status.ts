/**
 * What every client is told about updates: the status the server reports, the closed outcome codes the
 * updater writes, and the fixed text templates that say how to update.
 *
 * Nothing here comes from the release feed as text. The state is computed from a verified manifest, and
 * the only manifest datum that reaches a template is the version number, inserted after it parses as a
 * release version (rules 21, 22, 39). Imports of the manifest module are types only, so this file is safe
 * for the web bundle.
 *
 * Representation of the states the plan names that are not in `UpdateStateName`:
 *  - `stale_manifest` is the `stale` flag, carried beside the state and never instead of it, so an
 *    auto-updater can refuse on `stale` without needing a state of its own;
 *  - `unreachable` is `lastResult: "unreachable"`: a failed check leaves the state from the last verified
 *    manifest (or `unverified` when there is none), so an airgapped install shows no alarm;
 *  - `unknown` exists only on the wire from an older server or a newer one: `state` is open-valued, and
 *    `isKnownUpdateState` is how a client tells.
 */
import type { InstallKind } from "./install-record.js";
import type { UpdateStateName, VerifyFailureCode } from "./release-manifest.js";
import { parseReleaseVersion } from "./version.js";

/** Every `UpdateStateName`; the `satisfies` and the type check below fail the build when one is added. */
export const UPDATE_STATE_NAMES = [
	"disabled",
	"unverified",
	"current_pulled",
	"below_minimum",
	"security",
	"available",
	"current",
] as const satisfies readonly UpdateStateName[];
type MissingStateName = Exclude<UpdateStateName, (typeof UPDATE_STATE_NAMES)[number]>;
const everyStateListed: [MissingStateName] extends [never] ? true : never = true;
void everyStateListed;

/** The states that mean "this server needs attention now". Admins see them as red, members only these. */
export const RED_UPDATE_STATES = [
	"security",
	"current_pulled",
	"below_minimum",
] as const satisfies readonly UpdateStateName[];

/** Outcome codes the updater writes (phase 4) and the web explains; one closed set. */
export const UPDATE_OUTCOME_CODES = [
	// consent and install
	"no_consent",
	"container",
	"kubernetes",
	"no_service_manager",
	"tracking_ref",
	"fork_install",
	"no_install_record",
	"symlinked_install",
	// manifest and target
	"unverified",
	"stale",
	"pulled",
	"downgrade",
	"refused_before",
	"server_version_unknown",
	"up_to_date",
	"canary_wait",
	// migrations
	"migration_needs_consent",
	"postgres_migration",
	// preflight
	"dirty_tree",
	"untracked_files",
	"disk_space",
	"not_fast_forward",
	"commit_mismatch",
	"db_path_mismatch",
	"outside_window",
	"locked",
	// staging
	"install_failed",
	"build_failed",
	"smoke_failed",
	"snapshot_failed",
	// supervisor and services
	"supervisor_busy",
	"drain_timeout",
	"stop_failed",
	"health_failed",
	"supervisor_failed",
	// result
	"rolled_back",
	"rollback_failed",
	"nothing_to_roll_back",
	"downgrade_schema",
	"updated",
] as const;
/**
 * The updater's `Outcome` (phase 4) is this type itself, not a second union: the web copy table is held equal to
 * `UPDATE_OUTCOME_CODES`, so a code the updater invents that isn't listed here fails to compile.
 */
export type UpdateOutcomeCode = (typeof UPDATE_OUTCOME_CODES)[number];

/**
 * How the last check ended. `older` and `replayed` mean "valid, but nothing newer than what we hold".
 * `not_published` means no signed release information exists yet: the feed answered 404, or this build ships no
 * release keys, so nothing could be verified. It is the pre-first-release state of every install, and it is
 * quiet by design: no log line, no backoff, and the web shows it in the Updates panel only, never as a badge.
 * `unknown_key` (a fetched manifest signed by a key this build doesn't hold) is therefore a real failure.
 */
export type UpdateCheckResult = "ok" | "unreachable" | "not_published" | VerifyFailureCode;

/** Every value `lastResult` can take, for allowlisting what is read back from storage or the wire. */
export const UPDATE_CHECK_RESULTS: readonly UpdateCheckResult[] = [
	"ok",
	"unreachable",
	"not_published",
	"too_large",
	"bad_envelope",
	"unknown_key",
	"revoked_key",
	"bad_signature",
	"replayed",
	"older",
	"future",
	"bad_payload",
];

/** What the machine's own updater last did (phase 5 fills it; absent on every other install). */
export interface LocalApplyStatus {
	auto: boolean;
	lastOutcome?: UpdateOutcomeCode;
	lastTarget?: string;
	at?: string;
	waitingSince?: string;
}

export interface UpdateStatus {
	/** The version this server is running. */
	current: string;
	/** The manifest's newest release, or null when no manifest has been verified. */
	latest: string | null;
	/** Open on the wire: a client maps a value it doesn't know to "unknown". */
	state: UpdateStateName;
	/** The manifest's validity has passed (the signer has stopped re-signing, or the feed is frozen). */
	stale: boolean;
	severity: "normal" | "security" | null;
	/** When this server last tried to check, whatever came of it. Null before the first try. */
	checkedAt: string | null;
	lastResult: UpdateCheckResult | null;
	manifestIssuedAt: string | null;
	installKind: InstallKind;
	/** Only a local install has a track. */
	track: "release" | "ref" | null;
	localApply: LocalApplyStatus | null;
}

/** `UpdateStatus` as a client receives it: `state` is open and every field may be missing (an older or newer server). */
export type UpdateStatusWire = Partial<Omit<UpdateStatus, "state">> & { state: string };

/** What a caller with no authority to operate the server may read: versions, the state and when it was checked. */
export type PublicUpdateStatus = Pick<
	UpdateStatus,
	"current" | "latest" | "state" | "stale" | "severity" | "checkedAt"
>;

/**
 * The status trimmed for a caller that is neither a manage key nor a signed-in admin. An allowlist, so a field
 * added to `UpdateStatus` later (the install kind, the track, the last result, phase 5's `localApply`) stays
 * private until someone lists it here.
 */
export function publicUpdateStatus(status: UpdateStatus): PublicUpdateStatus {
	const { current, latest, state, stale, severity, checkedAt } = status;
	return { current, latest, state, stale, severity, checkedAt };
}

export function isKnownUpdateState(state: string): state is UpdateStateName {
	return (UPDATE_STATE_NAMES as readonly string[]).includes(state);
}

const RELEASES_URL = "https://github.com/jstuart0/agentpulse/releases/tag";

/** The release-notes page for a version, or null when `version` isn't a release version. */
export function releaseNotesUrl(version: string): string | null {
	return parseReleaseVersion(version) ? `${RELEASES_URL}/v${version}` : null;
}
