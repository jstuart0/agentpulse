import type { ApiKeyInfo } from "../../shared/types.js";
import type { AdminUserRow, ApiKeyRow, InstanceCounts, ServiceKeyDecision } from "../lib/api.js";
import { formatProviderLabel } from "../lib/formatProviderLabel.js";
import { ownerLabel } from "../lib/owner-label.js";
import type { OwnershipUi } from "../lib/ownership-ui.js";
import { directoryEntryFromAdminRow } from "../lib/people.js";
/**
 * Pure view state for the team parts of Settings: the solo row, the people
 * list, the mode dialog, the checklist, and the key list. The components
 * render what these functions say; the sentences users read live here, where
 * they are tested.
 */
import { parseDate } from "../lib/utils.js";

const MS_MINUTE = 60_000;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;
const JUST_NOW_MS = MS_MINUTE;

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

function hasManageScope(scopes: readonly string[]): boolean {
	return scopes.includes("manage") || scopes.includes("*");
}

/** Whether a key can post hook events at all: only then does "its events are ignored" mean anything. */
export function canSendEvents(scopes: readonly string[]): boolean {
	return scopes.includes("ingest") || scopes.includes("*");
}

// ── Solo row ────────────────────────────────────────────────────────────────

export type SoloRowState =
	| { kind: "available" }
	| { kind: "auth_disabled"; reason: string }
	| { kind: "env_locked"; reason: string }
	| { kind: "not_admin"; reason: string; hint: string | null };

export interface ModeViewer {
	role?: "admin" | "user" | null;
	source?: "forwardauth" | "authentik" | "api_key" | "local" | null;
}

const ENV_LOCKED_REASON = "Set by AGENTPULSE_MODE.";

/** What the "Team mode · Off" row offers, and why it can't when it can't. */
export function soloRowState(input: {
	disableAuth: boolean;
	modeLockedByEnv: boolean;
	viewer: ModeViewer | null;
}): SoloRowState {
	if (input.disableAuth) {
		return {
			kind: "auth_disabled",
			reason: "Team mode needs sign-in. Unset DISABLE_AUTH to use it.",
		};
	}
	if (input.modeLockedByEnv) return { kind: "env_locked", reason: ENV_LOCKED_REASON };

	const { viewer } = input;
	const humanAdmin = viewer?.role === "admin" && viewer.source !== "api_key";
	if (humanAdmin) return { kind: "available" };

	const viaSso = viewer?.source === "forwardauth" || viewer?.source === "authentik";
	return {
		kind: "not_admin",
		reason: "Only an admin can turn on team mode.",
		hint: viaSso
			? "Ask whoever runs this server to add you to AGENTPULSE_ADMIN_SSO_SUBJECTS."
			: null,
	};
}

export function teamRowState(input: { modeLockedByEnv: boolean }): {
	canSwitchBack: boolean;
	reason: string | null;
} {
	return input.modeLockedByEnv
		? { canSwitchBack: false, reason: ENV_LOCKED_REASON }
		: { canSwitchBack: true, reason: null };
}

// ── Members ─────────────────────────────────────────────────────────────────

export interface MemberRow {
	id: string;
	name: string;
	isSelf: boolean;
	role: "admin" | "member";
	roleLabel: "Admin" | "Member";
	disabled: boolean;
	isLocal: boolean;
	sourceLabel: string;
	/** Matched by a username the identity provider could hand to someone else. */
	identifiedByUsername: boolean;
	mustChangePassword: boolean;
	meta: string;
	roleControl: { enabled: boolean; reason: string | null };
	disableControl: { enabled: boolean; reason: string | null };
	canEnable: boolean;
	canResetPassword: boolean;
	/** The role select's accessible name: it says whose role it sets. */
	roleAriaLabel: string;
	/** The "More" menu button's accessible name. */
	moreActionsLabel: string;
}

const LAST_ADMIN_REASON =
	"The only admin can't be demoted or disabled. Make someone else an admin first.";
const ROLE_LOCKED_REASON =
	"Admin role is set by AGENTPULSE_ADMIN_SSO_SUBJECTS and can't be changed here.";
const DISABLE_LOCKED_REASON =
	"This admin is listed in AGENTPULSE_ADMIN_SSO_SUBJECTS and can't be disabled here.";

/** A person's name as people see it: a local account's login, an SSO account's display name, else a stable fallback. */
function memberName(user: AdminUserRow): string {
	return ownerLabel(directoryEntryFromAdminRow({ ...user, disabled: false }), user.id);
}

export function relativeTime(iso: string | null, now: number): string | null {
	if (!iso) return null;
	const then = parseDate(iso);
	if (Number.isNaN(then)) return null;
	const age = now - then;
	if (age < JUST_NOW_MS) return "just now";
	if (age < MS_HOUR) return `${Math.floor(age / MS_MINUTE)} min ago`;
	if (age < MS_DAY) return `${Math.floor(age / MS_HOUR)} h ago`;
	return `${Math.floor(age / MS_DAY)} d ago`;
}

export function lastUsedText(iso: string | null, now: number): string {
	const ago = relativeTime(iso, now);
	return ago ? `last used ${ago}` : "never used";
}

function groupRank(user: AdminUserRow): number {
	if (user.disabled) return 2;
	return user.role === "admin" ? 0 : 1;
}

export function memberRows(
	users: readonly AdminUserRow[],
	viewerUserId: string | null,
	now: number,
): MemberRow[] {
	const activeAdmins = users.filter((u) => u.role === "admin" && !u.disabled).length;

	const rows = users.map((user): MemberRow => {
		const isSelf = viewerUserId !== null && user.id === viewerUserId;
		const isLocal = user.authSource === "local";
		const sourceLabel = isLocal
			? "Local account"
			: user.provider
				? formatProviderLabel(user.provider)
				: "SSO";
		const lastSignIn = relativeTime(user.lastLoginAt, now);
		const meta = [
			sourceLabel,
			lastSignIn ? `last sign-in ${lastSignIn}` : "never signed in",
			`${user.keyCount} ${plural(user.keyCount, "key", "keys")}`,
			`${user.hostCount} ${plural(user.hostCount, "host", "hosts")}`,
		].join(" · ");

		const onlyAdmin = user.role === "admin" && !user.disabled && activeAdmins === 1;
		const roleControl = user.roleLockedByEnv
			? { enabled: false, reason: ROLE_LOCKED_REASON }
			: onlyAdmin
				? { enabled: false, reason: LAST_ADMIN_REASON }
				: { enabled: true, reason: null };
		const disableControl = user.disabled
			? { enabled: true, reason: null }
			: user.roleLockedByEnv
				? { enabled: false, reason: DISABLE_LOCKED_REASON }
				: onlyAdmin
					? { enabled: false, reason: LAST_ADMIN_REASON }
					: isSelf
						? { enabled: false, reason: null }
						: { enabled: true, reason: null };

		return {
			id: user.id,
			name: memberName(user),
			isSelf,
			role: user.role === "admin" ? "admin" : "member",
			roleLabel: user.role === "admin" ? "Admin" : "Member",
			disabled: user.disabled,
			isLocal,
			sourceLabel,
			identifiedByUsername: !isLocal && user.subjectSource !== "uid",
			mustChangePassword: user.mustChangePassword,
			meta,
			roleControl,
			disableControl,
			canEnable: user.disabled,
			// Your own password is changed from the Account panel, which asks for the current one.
			canResetPassword: isLocal && !user.disabled && !isSelf,
			roleAriaLabel: `Role for ${memberName(user)}`,
			moreActionsLabel: `More actions for ${memberName(user)}`,
		};
	});

	const rankOf = new Map(users.map((user) => [user.id, groupRank(user)]));
	return rows.sort((a, b) => {
		if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
		const byGroup = (rankOf.get(a.id) ?? 1) - (rankOf.get(b.id) ?? 1);
		return byGroup !== 0
			? byGroup
			: a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});
}

export function promoteConfirm(row: Pick<MemberRow, "name" | "identifiedByUsername">): {
	title: string;
	body: string;
	extra: string | null;
	confirmLabel: string;
} {
	return {
		title: `Make ${row.name} an admin?`,
		body: "Admins can change settings, AI providers and users, and manage every key and host.",
		extra: row.identifiedByUsername
			? "The role and everything this member owns pass to whoever the identity provider gives this username to."
			: null,
		confirmLabel: "Make admin",
	};
}

export function demotionToast(row: Pick<MemberRow, "name"> & { isSelf?: boolean }): string {
	return row.isSelf ? "You are now a member." : `${row.name} is now a member.`;
}

// ── Mode dialog: service keys ───────────────────────────────────────────────

export interface ServiceKeyItem {
	id: string;
	name: string;
	keyPrefix: string;
	lastUsedAt: string | null;
}

export type KeyChoice =
	| { kind: "keep" }
	| { kind: "revoke" }
	| { kind: "assign"; userId: string | null };

type Choices = Readonly<Record<string, KeyChoice | undefined>>;

/** The keys team mode needs an answer for: live, ownerless, able to manage. */
export function ownerlessManageKeys(keys: readonly ApiKeyInfo[]): ServiceKeyItem[] {
	return keys
		.filter((key) => key.isActive && key.ownerUserId == null && hasManageScope(key.scopes))
		.map((key) => ({
			id: key.id,
			name: key.name,
			keyPrefix: key.keyPrefix,
			lastUsedAt: key.lastUsedAt,
		}));
}

/** Choices already settled on the server, so the dialog opens showing them. */
export function initialKeyChoices(keys: readonly ApiKeyInfo[]): Record<string, KeyChoice> {
	const choices: Record<string, KeyChoice> = {};
	for (const key of keys) {
		if (key.isActive && key.ownerUserId == null && key.adminService === true) {
			choices[key.id] = { kind: "keep" };
		}
	}
	return choices;
}

function isDecided(choice: KeyChoice | undefined): choice is KeyChoice {
	if (!choice) return false;
	return choice.kind !== "assign" || choice.userId !== null;
}

export function incompleteKeyIds(items: readonly ServiceKeyItem[], choices: Choices): string[] {
	return items.filter((item) => !isDecided(choices[item.id])).map((item) => item.id);
}

export function decisionsComplete(items: readonly ServiceKeyItem[], choices: Choices): boolean {
	return incompleteKeyIds(items, choices).length === 0;
}

export function buildServiceKeyDecisions(
	items: readonly ServiceKeyItem[],
	choices: Choices,
): ServiceKeyDecision[] {
	const decisions: ServiceKeyDecision[] = [];
	for (const item of items) {
		const choice = choices[item.id];
		if (!isDecided(choice)) continue;
		if (choice.kind === "assign") {
			decisions.push({ keyId: item.id, decision: "assign", userId: choice.userId as string });
		} else {
			decisions.push({ keyId: item.id, decision: choice.kind });
		}
	}
	return decisions;
}

/**
 * A 409 lists only the keys the refused request left undecided, which are the
 * ones the dialog didn't know about. They are added after the keys already
 * listed (which keep what the dialog knew, like the last-used date and the
 * choices made); a key that is already listed is neither repeated nor reported.
 */
export function mergeUndecidedKeys(
	current: readonly ServiceKeyItem[],
	fromServer: ReadonlyArray<{ id: string; name: string; keyPrefix: string }>,
): { items: ServiceKeyItem[]; added: ServiceKeyItem[] } {
	const known = new Set(current.map((item) => item.id));
	const added = fromServer
		.filter((key) => !known.has(key.id))
		.map((key) => ({ id: key.id, name: key.name, keyPrefix: key.keyPrefix, lastUsedAt: null }));
	return { items: [...current, ...added], added };
}

// ── Mode dialog: copy ───────────────────────────────────────────────────────

export function peopleSummary(
	users: readonly AdminUserRow[],
	viewerUserId: string | null,
): { admins: string[]; members: string[]; text: string } {
	const active = users.filter((user) => !user.disabled);
	const named = (role: "admin" | "user") =>
		active
			.filter((user) => (role === "admin" ? user.role === "admin" : user.role !== "admin"))
			.map((user) => ({ self: user.id === viewerUserId, name: memberName(user) }))
			.sort((a, b) =>
				a.self !== b.self
					? a.self
						? -1
						: 1
					: a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
			)
			.map((person) => (person.self ? "you" : person.name));

	const admins = named("admin");
	const members = named("user");
	const text =
		members.length > 0
			? `Admins: ${admins.join(", ")}. Members: ${members.join(", ")}. Members can no longer change settings, AI providers or users.`
			: `Admins: ${admins.join(", ")}. People who sign in later join as members, who can't change settings, AI providers or users.`;
	return { admins, members, text };
}

export function pastSessionsChoice(
	unassignedSessions: number,
	activeHumans: number,
): { show: boolean; defaultChecked: boolean; label: string; help: string } {
	const sessions = `${unassignedSessions} ${plural(unassignedSessions, "session", "sessions")}`;
	return {
		show: unassignedSessions > 0,
		defaultChecked: activeHumans === 1,
		label:
			unassignedSessions === 1
				? "1 session is unassigned. Assign it to me."
				: `${unassignedSessions} sessions are unassigned. Assign them to me.`,
		help: `This sets the owner on ${sessions}. An admin can change a session's owner later.`,
	};
}

export interface CopySegment {
	text: string;
	strong?: boolean;
}

/** Live keys with manage that a (non-disabled) member made: the ones solo mode would hand full access back to. */
export function membersManageKeyCount(
	keys: readonly ApiKeyInfo[],
	users: readonly AdminUserRow[],
): number {
	const members = new Set(
		users.filter((user) => user.role !== "admin" && !user.disabled).map((user) => user.id),
	);
	return keys.filter(
		(key) =>
			key.isActive &&
			key.ownerUserId != null &&
			members.has(key.ownerUserId) &&
			hasManageScope(key.scopes),
	).length;
}

export function soloSwitchCopy(input: { people: number; memberManageKeys: number }): {
	title: string;
	segments: CopySegment[];
	confirmLabel: string;
} {
	const who =
		input.people > 1 ? `all ${input.people} people who can sign in` : "everyone who can sign in";
	const lead = `Roles stop being enforced for existing settings: ${who} can change settings, AI providers and keys again.`;
	const tail = "Owner labels are hidden, not deleted. Managing users still needs an admin.";
	const count = input.memberManageKeys;
	const segments: CopySegment[] =
		count > 0
			? [
					{ text: `${lead} ` },
					{
						text: `${count} ${plural(count, "key", "keys")} with manage that members own ${plural(count, "regains", "regain")} full access.`,
						strong: true,
					},
					{ text: ` ${tail}` },
				]
			: [{ text: `${lead} ${tail}` }];
	return { title: "Switch back to solo mode?", segments, confirmLabel: "Switch to solo mode" };
}

// ── Checklist ───────────────────────────────────────────────────────────────

export type ChecklistId = "manage-keys" | "keys" | "hosts" | "sessions" | "people";

export interface ChecklistItem {
	id: ChecklistId;
	text: string;
	/** One sentence on what leaving it undecided costs, shown under the item. */
	detail?: string;
}

const HOST_NO_OWNER_CONSEQUENCE =
	"Events from agents on this host for sessions launched from the dashboard are ignored until the host has an owner or its key is kept as a service key.";

/** What is still open after the switch, in a fixed order. Anything dismissed stays out. */
export function teamChecklist(input: {
	counts: InstanceCounts;
	ownerlessKeys: number;
	ownerlessHosts: number;
	otherPeople: number;
	dismissed: ReadonlySet<string>;
}): ChecklistItem[] {
	const { counts, ownerlessKeys, ownerlessHosts, otherPeople } = input;
	const items: ChecklistItem[] = [];
	if (counts.undecidedManageServiceKeys > 0) {
		const n = counts.undecidedManageServiceKeys;
		items.push({
			id: "manage-keys",
			text: `${n} ${plural(n, "service key can manage but isn't admin", "service keys can manage but aren't admin")}`,
		});
	}
	if (ownerlessKeys > 0) {
		items.push({
			id: "keys",
			text: `${ownerlessKeys} ${plural(ownerlessKeys, "key has", "keys have")} no owner`,
		});
	}
	if (ownerlessHosts > 0) {
		items.push({
			id: "hosts",
			text: `${ownerlessHosts} ${plural(ownerlessHosts, "host has", "hosts have")} no owner`,
			detail: HOST_NO_OWNER_CONSEQUENCE,
		});
	}
	if (counts.unassignedSessions > 0) {
		const n = counts.unassignedSessions;
		items.push({
			id: "sessions",
			text: `${n} ${plural(n, "session is", "sessions are")} unassigned`,
		});
	}
	if (otherPeople === 0) items.push({ id: "people", text: "No one else has signed in yet" });
	return items.filter((item) => !input.dismissed.has(item.id));
}

// ── Disable dialog, add user ────────────────────────────────────────────────

export function disableDialogCopy(input: {
	name: string;
	keyCount: number;
	hostCount: number;
	hostNames: readonly string[];
}): {
	title: string;
	body: string;
	hostCheckbox: { label: string } | null;
	confirmLabel: string;
} {
	const { name, keyCount, hostCount, hostNames } = input;
	const keys =
		keyCount > 0
			? ` Their ${keyCount} API ${plural(keyCount, "key is", "keys are")} revoked, so agents on their machines stop reporting until they have new keys.`
			: "";
	const body = `${name} is signed out everywhere, including dashboards they have open, and can't sign back in.${keys} Their sessions stay visible. Enabling the account later does not restore keys or hosts.`;

	const named = hostNames.length > 0 ? ` (${hostNames.join(", ")})` : "";
	return {
		title: `Disable ${name}?`,
		body,
		hostCheckbox:
			hostCount > 0
				? {
						label: `Also revoke their ${hostCount} ${plural(hostCount, "host", "hosts")}${named}. Unchecked, ${plural(hostCount, "it stays", "they stay")} enrolled and can still run launches.`,
					}
				: null,
		confirmLabel: `Disable ${name}`,
	};
}

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{2,64}$/;

/** Mirrors the server's username rule so the form can say what to fix before asking. */
export function usernameProblem(username: string): string | null {
	return USERNAME_PATTERN.test(username)
		? null
		: "Use 2 to 64 characters: letters, digits, _ - and .";
}

export function credentialsCopyText(input: {
	signInAddress: string;
	username: string;
	password: string;
}): string {
	return `Sign-in address: ${input.signInAddress}\nUsername: ${input.username}\nPassword: ${input.password}`;
}

// ── Keys ────────────────────────────────────────────────────────────────────

export interface KeyRowModel {
	/** One plain sentence under the key when it needs a decision from an admin. */
	note: string | null;
	/** An admin may record this ownerless key as a plain service key. */
	canMarkService: boolean;
	ownerText: string | null;
	badges: Array<{ text: string; tone: "neutral" | "amber" }>;
	canRevoke: boolean;
	canAssign: boolean;
	canKeepAsAdmin: boolean;
	revokeConfirm: { title: string; body: string } | null;
}

const STOP_REPORTING = "Agents using it stop reporting until they have a new key.";
const UNDECIDED_KEY_NOTE =
	"Until this key has an owner or is kept as a service key, events it sends for sessions launched from the dashboard are ignored.";

export function keyRowModel(
	key: ApiKeyRow,
	ctx: {
		ui: OwnershipUi;
		viewerUserId: string | null;
		isAdmin: boolean;
		ownerName: (id: string) => string;
	},
): KeyRowModel {
	if (!ctx.ui.showKeyOwner) {
		return {
			note: null,
			canMarkService: false,
			ownerText: null,
			badges: [],
			canRevoke: key.isActive,
			canAssign: false,
			canKeepAsAdmin: false,
			revokeConfirm: null,
		};
	}

	const owner = key.ownerUserId ?? null;
	const canManage = hasManageScope(key.scopes);
	const isMine = owner !== null && owner === ctx.viewerUserId;
	// The server says this ownerless key hasn't been decided on: events from it
	// for dashboard-launched sessions are ignored until it has an owner or is kept.
	const undecided = owner === null && key.isActive && key.serviceKey === false && !key.adminService;

	const badges: KeyRowModel["badges"] = [];
	// A revoked key reports nothing and holds no access: its owner and role labels would only be noise.
	if (owner === null && key.isActive) {
		if (key.adminService) badges.push({ text: "Service key · admin access", tone: "amber" });
		else if (key.serviceKey === false) {
			badges.push({
				text: canManage
					? "Service key · not decided · manage, not admin"
					: "Service key · not decided",
				tone: "neutral",
			});
		} else if (canManage) {
			badges.push({ text: "Service key · manage, not admin", tone: "neutral" });
		} else badges.push({ text: "Service key", tone: "neutral" });
	}

	const canRevoke = key.isActive && (ctx.isAdmin || isMine);
	let revokeConfirm: KeyRowModel["revokeConfirm"] = null;
	if (canRevoke) {
		const whose = isMine
			? "This is your key."
			: owner === null
				? `This is a service key${key.adminService ? " with admin access" : ""}.`
				: `This key belongs to ${ctx.ownerName(owner)}.`;
		revokeConfirm = { title: `Revoke ${key.name}?`, body: `${whose} ${STOP_REPORTING}` };
	}

	return {
		note: undecided && canSendEvents(key.scopes) ? UNDECIDED_KEY_NOTE : null,
		canMarkService: ctx.isAdmin && undecided,
		ownerText: owner === null ? null : `Owner: ${ctx.ownerName(owner)}`,
		badges,
		canRevoke,
		canAssign: ctx.isAdmin && key.isActive,
		canKeepAsAdmin: ctx.isAdmin && key.isActive && owner === null && canManage && !key.adminService,
		revokeConfirm,
	};
}

export function keyListIntro(ui: OwnershipUi, isAdmin: boolean): { intro: string | null } {
	if (!ui.showKeyOwner) return { intro: null };
	return {
		intro: isAdmin
			? "Everyone's API keys. Each key reports sessions as its owner."
			: "Your API keys. Admins manage everyone's.",
	};
}

export function assignDialogCopy(input: { keyName: string; reportedSessions: number | null }): {
	title: string;
	sessionsCheckbox: string | null;
	serviceOption: string;
	note: string;
} {
	const n = input.reportedSessions;
	return {
		title: `Assign ${input.keyName} to…`,
		sessionsCheckbox:
			n === null
				? "Also assign the sessions this key has already reported (couldn't count sessions)"
				: n > 0
					? `Also assign the ${n} ${plural(n, "session", "sessions")} this key has already reported`
					: null,
		serviceOption: "No one (service key)",
		note: "New sessions from this key will be recorded as theirs. If several people share this key, leave it as a service key.",
	};
}

/** The keys Setup lists: in team mode only the caller's own; in solo, every live key as before. */
export function keysForSetup(
	keys: readonly ApiKeyInfo[],
	ui: OwnershipUi,
	viewerUserId: string | null,
): ApiKeyInfo[] {
	const live = keys.filter((key) => key.isActive);
	if (!ui.showTeamCopy) return live;
	return viewerUserId === null ? [] : live.filter((key) => key.ownerUserId === viewerUserId);
}

/** The line above the second screen's heading: only the screen that follows the switch calls it "step 2". */
export function existingScreenStatus(input: { followsSwitch: boolean }): string | null {
	return input.followsSwitch ? "Team mode is on. Step 2 of 2, optional." : null;
}
