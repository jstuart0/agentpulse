/**
 * Instance mode: solo (the default; everyone who can sign in sees everything,
 * nothing about ownership is enforced) or team (members, admins, owner-checked
 * actions).
 *
 * Where the mode comes from, in order: the AGENTPULSE_MODE env var (which
 * locks it — the UI can't change it), the stored `instance.mode` setting,
 * then solo. Nothing is cached: the stored setting is one primary-key read per
 * call, so a switch takes effect on the very next request on every replica.
 *
 * Hides: that precedence, the boot refusals for an unsafe combination, and
 * the mode switch — admin-only, all-or-nothing, with the service-key
 * decisions validated and re-enumerated inside the admin lock so a key minted
 * while the dialog was open can't slip past.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import { deactivateCreatorlessEnrollmentTokens } from "../auth/supervisor-auth.js";
import { config } from "../config.js";
import { withAdminLock } from "../db/admin-lock.js";
import { getDb } from "../db/client.js";
import { apiKeys, sessions, settings, users } from "../db/schema/index.js";
import {
	type ServiceKeySummary,
	countUndecidedServiceKeys,
	delistServiceKey,
	listActiveOwnerlessManageKeys,
	listUndecidedServiceKeys,
	writeAdminServiceKeyIds,
} from "./service-keys.js";
import { upsertSetting } from "./settings-service.js";

export type InstanceMode = "solo" | "team";

const MODE_SETTING = "instance.mode";
const MAX_ECHOED_ENV_LENGTH = 50;

export class ModeLockedByEnvError extends Error {
	constructor() {
		super("The mode is set by AGENTPULSE_MODE and can't be changed here.");
		this.name = "ModeLockedByEnvError";
	}
}

export class TeamRequiresAuthError extends Error {
	constructor() {
		super("Team mode needs authentication; it can't be turned on while DISABLE_AUTH=true.");
		this.name = "TeamRequiresAuthError";
	}
}

export class HumanAdminRequiredError extends Error {
	constructor() {
		super("Only a signed-in admin can change the mode.");
		this.name = "HumanAdminRequiredError";
	}
}

export class ServiceKeysUndecidedError extends Error {
	readonly keys: ServiceKeySummary[];
	constructor(keys: ServiceKeySummary[]) {
		super("Some admin service keys still need a decision before switching to team mode.");
		this.name = "ServiceKeysUndecidedError";
		this.keys = keys;
	}
}

export type InvalidDecisionCode =
	| "not_a_service_key"
	| "duplicate_decision"
	| "assign_requires_user"
	| "assign_user_not_found"
	| "assign_user_disabled"
	| "decisions_not_applicable";

export class InvalidServiceKeyDecisionError extends Error {
	readonly code: InvalidDecisionCode;
	readonly keyId: string | null;
	constructor(code: InvalidDecisionCode, keyId: string | null = null) {
		super(`Invalid service-key decision (${code}).`);
		this.name = "InvalidServiceKeyDecisionError";
		this.code = code;
		this.keyId = keyId;
	}
}

export type ServiceKeyDecision =
	| { keyId: string; decision: "keep" }
	| { keyId: string; decision: "revoke" }
	| { keyId: string; decision: "assign"; userId?: string };

export interface SetModeInput {
	mode: InstanceMode;
	serviceKeyDecisions: ServiceKeyDecision[];
}

export interface SetModeResult {
	mode: InstanceMode;
	changed: boolean;
}

/** The current mode: the env, else the stored setting, else solo. One primary-key read, no cache. */
export async function getMode(): Promise<InstanceMode> {
	const fromEnv = config.modeEnv;
	if (fromEnv) return fromEnv;
	return (await readStoredMode(getDb())) ?? "solo";
}

/**
 * The stored mode as a column of a read that is happening anyway, so a handler
 * that has that row needs no statement of its own for the mode. Decode the
 * value with `modeFromStoredColumn`, which applies the env override.
 */
export const storedModeColumn =
	sql`(select ${settings.value} from ${settings} where ${settings.key} = ${MODE_SETTING})`.mapWith(
		settings.value,
	);

/** The mode a `storedModeColumn` value means: the env, else the stored setting, else solo. */
export function modeFromStoredColumn(stored: unknown): InstanceMode {
	return config.modeEnv ?? parseStoredMode(stored) ?? "solo";
}

function parseStoredMode(value: unknown): InstanceMode | null {
	if (value === "team") return "team";
	return value === "solo" ? "solo" : null;
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
async function readStoredMode(handle: any): Promise<InstanceMode | null> {
	const [row] = await handle
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, MODE_SETTING))
		.limit(1);
	return parseStoredMode(row?.value);
}

export interface InstanceCounts {
	/** Sessions nobody owns and no key is recorded for. */
	unassignedSessions: number;
	/** Active API keys with no owner. */
	serviceKeys: number;
	/** Active ownerless manage keys that aren't kept as admin service keys. */
	undecidedManageServiceKeys: number;
	/** Active ownerless keys that are not service keys by any route: no admin has decided about them. */
	undecidedServiceKeys: number;
}

/** What GET /instance reports besides the mode: what still needs an admin's attention. */
export async function getInstanceCounts(): Promise<InstanceCounts> {
	const db = getDb();
	const [unassigned] = await db
		.select({ count: sql<number>`count(*)`.mapWith(Number) })
		.from(sessions)
		.where(and(isNull(sessions.ownerUserId), isNull(sessions.ingestKeyId)));
	const [service] = await db
		.select({ count: sql<number>`count(*)`.mapWith(Number) })
		.from(apiKeys)
		.where(and(isNull(apiKeys.ownerUserId), eq(apiKeys.isActive, true)));
	const undecided = await listUndecidedServiceKeys();
	return {
		unassignedSessions: unassigned?.count ?? 0,
		serviceKeys: service?.count ?? 0,
		undecidedManageServiceKeys: undecided.length,
		undecidedServiceKeys: await countUndecidedServiceKeys(),
	};
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Refuses (throws) to start in a configuration that can't work:
 *  - AGENTPULSE_MODE set to something other than solo or team;
 *  - team mode with DISABLE_AUTH=true, however the mode was chosen;
 *  - team mode locked by env with no way to sign in as an admin.
 * Every message names AGENTPULSE_MODE=solo first, as the way out. A stored
 * team mode with no admin still boots: an admin made the switch, and the last
 * one can't be disabled or demoted.
 */
export async function assertBootable(): Promise<void> {
	const rawEnv = config.modeEnvRaw;
	if (rawEnv !== null && config.modeEnv === null) {
		const shown = rawEnv.replace(/[\r\n]/g, " ").slice(0, MAX_ECHOED_ENV_LENGTH);
		throw new Error(
			`AGENTPULSE_MODE must be "solo" or "team"; got "${shown}". Set AGENTPULSE_MODE=solo (or team), or unset it.`,
		);
	}

	if ((await getMode()) !== "team") return;

	if (config.disableAuth) {
		throw new Error(
			"Team mode needs authentication, but DISABLE_AUTH=true. Set AGENTPULSE_MODE=solo to run without authentication, or turn DISABLE_AUTH off.",
		);
	}

	if (config.modeEnv === "team" && !(await hasAdminSource())) {
		throw new Error(
			"AGENTPULSE_MODE=team is set, but nobody could sign in as an admin. Set AGENTPULSE_MODE=solo to run without teams, or provide an admin: AGENTPULSE_LOCAL_ADMIN_USERNAME with AGENTPULSE_LOCAL_ADMIN_PASSWORD, or a subject in AGENTPULSE_ADMIN_SSO_SUBJECTS.",
		);
	}
}

/**
 * Some way to get an admin: the bootstrap env (username and password both
 * set; the bootstrap itself runs after the server starts, so the env counts),
 * a listed SSO subject, or an active admin row (local, or an SSO admin an
 * earlier promotion made — removing a subject doesn't demote).
 */
async function hasAdminSource(): Promise<boolean> {
	if (config.localAdminUsername.trim() && config.localAdminPassword) return true;
	if (config.adminSsoSubjects.length > 0) return true;
	const [admin] = await getDb()
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.role, "admin"), isNull(users.disabledAt)))
		.limit(1);
	return admin !== undefined;
}

/** Boot warning: in env-locked team mode, ownerless manage keys that aren't on the admin list are plain members. One line. */
export async function warnAboutUnlistedAdminServiceKeysAtBoot(): Promise<void> {
	if (config.modeEnv !== "team") return;
	const keys = await listUndecidedServiceKeys();
	if (keys.length === 0) return;
	console.warn(
		JSON.stringify({
			kind: "unlisted_admin_service_keys",
			level: "warn",
			message:
				"AGENTPULSE_MODE=team: these API keys have no owner and manage scope but are not kept as admin service keys, so they act as members. Keep, assign or revoke them in Settings.",
			keys: keys.map((key) => ({ prefix: key.keyPrefix, name: key.name })),
		}),
	);
}

/**
 * Boot warning: an active SSO admin whose identity is a username (or whose
 * source was never recorded) passes, with its role and everything it owns, to
 * whoever the identity provider next gives that username to. One line.
 */
export async function warnAboutRiskySubjectSourceAdmins(): Promise<void> {
	const rows = await getDb()
		.select({ id: users.id, authSource: users.authSource, subjectSource: users.subjectSource })
		.from(users)
		.where(and(eq(users.role, "admin"), isNull(users.disabledAt)));
	const risky = rows.filter(
		(row: { authSource: string; subjectSource: string | null }) =>
			row.authSource !== "local" && row.subjectSource !== "uid",
	);
	if (risky.length === 0) return;
	console.warn(
		JSON.stringify({
			kind: "admin_identified_by_username",
			level: "warn",
			message:
				"These active admins are identified by a username (or an unrecorded source), not a uid: if the identity provider gives that username to someone else, they inherit the admin role. Configure a uid header (see deploy/k8s/FORWARDAUTH.md).",
			userIds: risky.map((row: { id: string }) => row.id),
		}),
	);
}

// ── The switch ───────────────────────────────────────────────────────────────

/**
 * Switch the mode. Order of refusals: locked by env, team under DISABLE_AUTH,
 * then — inside the admin lock — an actor that isn't an active admin signed in
 * as a human, invalid or missing service-key decisions. Everything else is
 * one transaction: the decisions and the mode commit together or not at all.
 *
 * solo → team re-reads the active ownerless manage/wildcard keys inside the
 * lock and needs exactly one decision for each (keep: stays admin-equivalent,
 * assign: gets an owner, revoke: deactivated). team → solo clears the kept
 * list, so switching back asks again. Asking for the mode already stored
 * is a no-op.
 *
 * Nothing awaited inside the locked body is anything but a database call.
 */
export async function setMode(input: SetModeInput, actor: Actor): Promise<SetModeResult> {
	if (config.modeEnv !== null) throw new ModeLockedByEnvError();
	if (input.mode === "team" && config.disableAuth) throw new TeamRequiresAuthError();

	const outcome = await withAdminLock(async (tx) => {
		await modeSwitchStepHook?.("lock-acquired");
		await assertHumanAdmin(tx, actor);

		const from = (await readStoredMode(tx)) ?? "solo";
		if (from === input.mode) return { changed: false as const, from };

		const tally =
			input.mode === "team"
				? await applyDecisionsForTeam(tx, input.serviceKeyDecisions)
				: await clearForSolo(tx, input.serviceKeyDecisions);
		await modeSwitchStepHook?.("decisions-applied");

		await upsertSetting(MODE_SETTING, input.mode, { allowProtected: true, tx });
		await modeSwitchStepHook?.("mode-written");
		return { changed: true as const, from, tally };
	});

	if (!outcome.changed) return { mode: input.mode, changed: false };
	console.log(
		JSON.stringify({
			kind: "instance_mode_changed",
			level: "info",
			from: outcome.from,
			to: input.mode,
			by: actor.userId,
			...outcome.tally,
		}),
	);
	return { mode: input.mode, changed: true };
}

interface DecisionTally {
	kept: number;
	assigned: number;
	revoked: number;
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
async function assertHumanAdmin(tx: any, actor: Actor): Promise<void> {
	if (actor.label !== "user" || !actor.userId) throw new HumanAdminRequiredError();
	const [row] = await tx
		.select({ role: users.role, disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, actor.userId))
		.limit(1);
	if (!row || row.role !== "admin" || row.disabledAt !== null) throw new HumanAdminRequiredError();
}

async function applyDecisionsForTeam(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	decisions: ServiceKeyDecision[],
): Promise<DecisionTally> {
	const eligible = await listActiveOwnerlessManageKeys(tx);
	const eligibleIds = new Set(eligible.map((key) => key.id));

	const seen = new Set<string>();
	for (const decision of decisions) {
		if (!eligibleIds.has(decision.keyId)) {
			throw new InvalidServiceKeyDecisionError("not_a_service_key", decision.keyId);
		}
		if (seen.has(decision.keyId)) {
			throw new InvalidServiceKeyDecisionError("duplicate_decision", decision.keyId);
		}
		seen.add(decision.keyId);
		if (decision.decision === "assign") await assertAssignable(tx, decision);
	}

	const undecided = eligible.filter((key) => !seen.has(key.id));
	if (undecided.length > 0) throw new ServiceKeysUndecidedError(undecided);

	await deactivateCreatorlessEnrollmentTokens(tx);

	const tally: DecisionTally = { kept: 0, assigned: 0, revoked: 0 };
	const keptIds: string[] = [];
	for (const decision of decisions) {
		if (decision.decision === "keep") {
			keptIds.push(decision.keyId);
			tally.kept++;
		} else if (decision.decision === "revoke") {
			await tx.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, decision.keyId));
			await delistServiceKey(decision.keyId, tx);
			tally.revoked++;
		} else {
			await tx
				.update(apiKeys)
				.set({ ownerUserId: decision.userId })
				.where(eq(apiKeys.id, decision.keyId));
			await delistServiceKey(decision.keyId, tx);
			tally.assigned++;
		}
	}
	await writeAdminServiceKeyIds(keptIds, tx);
	return tally;
}

async function assertAssignable(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	decision: { keyId: string; userId?: string },
): Promise<void> {
	if (!decision.userId)
		throw new InvalidServiceKeyDecisionError("assign_requires_user", decision.keyId);
	const [target] = await tx
		.select({ disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, decision.userId))
		.limit(1);
	if (!target) throw new InvalidServiceKeyDecisionError("assign_user_not_found", decision.keyId);
	if (target.disabledAt !== null) {
		throw new InvalidServiceKeyDecisionError("assign_user_disabled", decision.keyId);
	}
}

async function clearForSolo(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	decisions: ServiceKeyDecision[],
): Promise<DecisionTally> {
	if (decisions.length > 0) throw new InvalidServiceKeyDecisionError("decisions_not_applicable");
	await writeAdminServiceKeyIds([], tx);
	return { kept: 0, assigned: 0, revoked: 0 };
}

// ── Test-only seam ────────────────────────────────────────────────────────
// Lets instance-mode.test.ts act inside the lock at fixed points of a
// switch: mint a key after the lock is held but before the enumeration (a
// real race), or fail partway to prove the switch is all-or-nothing.
// Enforced by check-no-test-seam-leaks.ts: this export may only be
// referenced from a *.test.ts file or test-utils/.
export type ModeSwitchStep = "lock-acquired" | "decisions-applied" | "mode-written";

let modeSwitchStepHook: ((step: ModeSwitchStep) => Promise<void>) | null = null;
export function _setModeSwitchStepHookForTest(
	hook: ((step: ModeSwitchStep) => Promise<void>) | null,
): void {
	modeSwitchStepHook = hook;
}
