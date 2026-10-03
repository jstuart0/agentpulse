import type { SupervisorRecord } from "../../shared/types.js";
import type { AdminUserRow, ApiKeyRow, InstanceCounts } from "../lib/api.js";
import type { OwnershipUi } from "../lib/ownership-ui.js";
import type { PersonOption } from "../lib/people.js";
import {
	type ChecklistItem,
	type KeyChoice,
	type MemberRow,
	type ServiceKeyItem,
	incompleteKeyIds,
	mergeUndecidedKeys,
	teamChecklist,
} from "./team-view-state.js";

/**
 * The decisions behind the team dialogs and the checklist, as pure functions:
 * which keys and hosts still need an owner, what a failed mode switch means,
 * what Apply may do, and what a role change asks first. Components gather the
 * facts and act on the answers.
 */

type Choices = Readonly<Record<string, KeyChoice | undefined>>;

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

/** "a", "a and b", "a, b and 1 more": names in a sentence without growing past a line. */
function listNames(names: readonly string[]): string {
	if (names.length <= 1) return names.join("");
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

// ── Keys and hosts that still need a decision ───────────────────────────────

/**
 * Live ownerless keys nobody has decided about: not an admin's kept service
 * key and not recorded as a service key. The server's record is the truth for
 * a key that has one; the per-person "looked at" set only stands in for a
 * server that doesn't send it. The second screen's key list and the
 * checklist's count both come from here, so they can't disagree.
 */
export function undecidedOwnerlessKeys(
	keys: readonly ApiKeyRow[],
	reviewedFallback: ReadonlySet<string>,
): ApiKeyRow[] {
	return keys.filter(
		(key) =>
			key.isActive &&
			key.ownerUserId == null &&
			!key.adminService &&
			key.serviceKey !== true &&
			(key.serviceKey !== undefined || !reviewedFallback.has(key.id)),
	);
}

/** Live hosts nobody owns. The server's state only: leaving a host unassigned is a choice, not a way to clear it. */
export function ownerlessHostsToReview(hosts: readonly SupervisorRecord[]): SupervisorRecord[] {
	return hosts.filter((host) => host.enrollmentState !== "revoked" && host.ownerUserId == null);
}

export function assembleChecklist(input: {
	counts: InstanceCounts;
	keys: readonly ApiKeyRow[];
	hosts: readonly SupervisorRecord[];
	users: readonly AdminUserRow[];
	viewerUserId: string | null;
	reviewedKeys: ReadonlySet<string>;
	dismissed: ReadonlySet<string>;
}): ChecklistItem[] {
	return teamChecklist({
		counts: input.counts,
		ownerlessKeys:
			input.counts.undecidedServiceKeys ??
			undecidedOwnerlessKeys(input.keys, input.reviewedKeys).length,
		ownerlessHosts: ownerlessHostsToReview(input.hosts).length,
		otherPeople: input.users.filter((user) => user.id !== input.viewerUserId && !user.disabled)
			.length,
		dismissed: input.dismissed,
	});
}

// ── Turning team mode on ────────────────────────────────────────────────────

export interface ModeSwitchFailure {
	kind: "added" | "already_listed" | "key_changed" | "person_changed" | "needs_person" | "generic";
	message: string;
	items: ServiceKeyItem[];
	/** Which list to fetch again so the dialog shows what the server now knows. */
	refresh: "keys" | "people" | null;
	/** A choice that can't stand any more (its person is gone). */
	clearChoiceFor: string | null;
	/** The key to bring into view and focus. */
	focusKeyId: string | null;
}

/**
 * What a refused "turn on team mode" means for the open dialog. A 409 lists
 * the keys the request left undecided; a 400 says which decision was invalid
 * and why, and "the key changed" and "the chosen person changed" are different
 * sentences that refresh different lists.
 */
export function modeSwitchFailure(input: {
	code: string | null;
	body: unknown;
	items: readonly ServiceKeyItem[];
	choices: Choices;
	people: readonly PersonOption[];
	fallback: string;
}): ModeSwitchFailure {
	const items = [...input.items];
	const nameOf = (id: string | null | undefined) =>
		id ? (items.find((item) => item.id === id)?.name ?? null) : null;
	const generic: ModeSwitchFailure = {
		kind: "generic",
		message: input.fallback,
		items,
		refresh: null,
		clearChoiceFor: null,
		focusKeyId: null,
	};

	if (input.code === "service_keys_undecided") {
		const fromServer =
			(input.body as { keys?: Array<{ id: string; name: string; keyPrefix: string }> } | null)
				?.keys ?? [];
		const merged = mergeUndecidedKeys(items, fromServer);
		if (merged.added.length > 0) {
			const names = merged.added.map((key) => key.name);
			const verb = plural(names.length, "was", "were");
			const target = plural(names.length, "it", "each");
			return {
				...generic,
				kind: "added",
				items: merged.items,
				message: `${listNames(names)} ${verb} added while this was open. Choose what happens to ${target}.`,
				focusKeyId: merged.added[0].id,
			};
		}
		if (fromServer.length > 0) {
			const names = fromServer.map((key) => key.name);
			const sentence =
				names.length === 1
					? `${names[0]} still needs a decision. Choose what happens to it.`
					: `${listNames(names)} still need a decision. Choose what happens to each.`;
			return {
				...generic,
				kind: "already_listed",
				message: sentence,
				focusKeyId: fromServer[0].id,
			};
		}
		return generic;
	}

	if (input.code === "invalid_service_key_decision") {
		const detail = input.body as { code?: string; keyId?: string } | null;
		const keyName = nameOf(detail?.keyId);
		const choice = detail?.keyId ? input.choices[detail.keyId] : undefined;
		const personLabel =
			(choice?.kind === "assign" && choice.userId
				? input.people.find((person) => person.id === choice.userId)?.label
				: null) ?? "That person";

		if (detail?.code === "assign_user_not_found" || detail?.code === "assign_user_disabled") {
			const state = detail.code === "assign_user_disabled" ? "is disabled now" : "no longer exists";
			return {
				...generic,
				kind: "person_changed",
				message: `${personLabel} ${state}. Choose someone else for ${keyName ?? "this key"}.`,
				refresh: "people",
				clearChoiceFor: detail.keyId ?? null,
				focusKeyId: detail.keyId ?? null,
			};
		}
		if (detail?.code === "assign_requires_user") {
			return {
				...generic,
				kind: "needs_person",
				message: keyName
					? `Choose a person for ${keyName}.`
					: "Choose a person for each key you're assigning.",
				focusKeyId: detail.keyId ?? null,
			};
		}
		return {
			...generic,
			kind: "key_changed",
			message: `${keyName ?? "A key"} changed while this was open. The list is up to date: check it and try again.`,
			refresh: "keys",
		};
	}

	return generic;
}

/** Why "Turn on team mode" is disabled, in terms of the key that is missing a choice. */
export function modeSwitchBlockedReason(
	items: readonly ServiceKeyItem[],
	choices: Choices,
): string | null {
	const missing = incompleteKeyIds(items, choices);
	if (missing.length === 0) return null;
	const first = items.find((item) => item.id === missing[0]);
	const name = first?.name ?? "the key";
	if (missing.length === 1) {
		const choice = choices[missing[0]];
		return choice?.kind === "assign"
			? `Choose a person for ${name}.`
			: `Choose what happens to ${name}.`;
	}
	const more = missing.length - 1;
	return `Choose what happens to ${name} and ${more} more ${plural(more, "key", "keys")}.`;
}

export function keyChoiceNote(choice: KeyChoice | undefined): string | null {
	return choice?.kind === "revoke"
		? "Revoked when you turn on team mode. This can't be undone."
		: null;
}

// ── People ──────────────────────────────────────────────────────────────────

export type RoleChangeAction = "none" | "confirm_promote" | "confirm_self_demote" | "demote";

export function roleChangeAction(
	row: Pick<MemberRow, "role" | "isSelf">,
	next: "admin" | "member",
): RoleChangeAction {
	if (next === row.role) return "none";
	if (next === "admin") return "confirm_promote";
	return row.isSelf ? "confirm_self_demote" : "demote";
}

export function selfDemoteConfirm(): { title: string; body: string; confirmLabel: string } {
	return {
		title: "Make yourself a member?",
		body: "You'll lose access to settings, AI providers and users right away. Another admin can make you an admin again.",
		confirmLabel: "Make me a member",
	};
}

/** After a demotion: yours reloads who you are (the role is stale) and has no Undo (you couldn't use it). */
export function demotionFollowUp(row: Pick<MemberRow, "isSelf">): {
	offerUndo: boolean;
	reloadUser: boolean;
} {
	return { offerUndo: !row.isSelf, reloadUser: row.isSelf };
}

/** With no host to keep, the flag is true: there is nothing for it to spare. */
export function disableRequestBody(input: { hasHostCheckbox: boolean; revokeHosts: boolean }): {
	revokeHosts: boolean;
} {
	return { revokeHosts: input.hasHostCheckbox ? input.revokeHosts : true };
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** The Assign dialog's "no one" choice, kept apart from every real user id. */
export const SERVICE_OWNER_CHOICE = "__service__";

export type AssignKeyOp =
	| { kind: "set-owner"; userId: string | null }
	| { kind: "mark-service-key" };

/** What the Change owner dialog starts on: the key's owner, or "No one (service key)" for a key kept as one. */
export function initialKeyOwnerChoice(key: {
	ownerUserId?: string | null;
	serviceKey?: boolean;
}): string {
	if (key.ownerUserId) return key.ownerUserId;
	return key.serviceKey ? SERVICE_OWNER_CHOICE : "";
}

export function assignKeyPlan(input: {
	keyHadOwner: boolean;
	choice: string;
	recordServiceKeys: boolean;
	/** The key's owner now; choosing the same person again changes nothing. */
	currentOwnerId?: string | null;
	/** Also hand over the sessions the key already reported: a real change even for the same owner. */
	attributeSessions?: boolean;
	/** The key is already recorded as a service key: choosing that again changes nothing. */
	currentIsService?: boolean;
}): { error: string | null; ops: AssignKeyOp[]; unchanged?: true } {
	if (input.choice === "") return { error: "Choose a person first.", ops: [] };
	if (
		input.choice !== SERVICE_OWNER_CHOICE &&
		input.choice === input.currentOwnerId &&
		!input.attributeSessions
	) {
		return { error: null, ops: [], unchanged: true };
	}
	if (input.choice === SERVICE_OWNER_CHOICE && !input.keyHadOwner && input.currentIsService) {
		return { error: null, ops: [], unchanged: true };
	}
	if (input.choice !== SERVICE_OWNER_CHOICE) {
		return { error: null, ops: [{ kind: "set-owner", userId: input.choice }] };
	}
	const ops: AssignKeyOp[] = [];
	if (input.keyHadOwner) ops.push({ kind: "set-owner", userId: null });
	if (input.recordServiceKeys) ops.push({ kind: "mark-service-key" });
	return { error: null, ops };
}

export const SERVICE_KEY_CHECKBOX_LABEL = "Service key (belongs to no one)";
export const SERVICE_KEY_HELPER =
	"Service keys belong to no one. Sessions they report have no owner.";

export function canCreateServiceKey(ui: OwnershipUi, isAdmin: boolean): boolean {
	return ui.showTeamCopy && isAdmin;
}

export function createKeyRequest(input: {
	name: string;
	ingest: boolean;
	manage: boolean;
	observe: boolean;
	service: boolean;
	allowService: boolean;
}): { name: string; scopes: string[]; service?: true } {
	const scopes: string[] = [];
	if (input.ingest) scopes.push("ingest");
	if (input.manage) scopes.push("manage");
	if (input.observe) scopes.push("observe");
	if (scopes.length === 0) scopes.push("ingest");
	return {
		name: input.name.trim(),
		scopes,
		...(input.service && input.allowService ? { service: true as const } : {}),
	};
}

/**
 * What the switch-back-to-solo confirmation may do while it reads the people
 * on the install: Switch waits for them (the sentence names them), and when
 * the read failed there is a way to ask again rather than a button that never
 * enables.
 */
export function soloSwitchGate(input: { loaded: boolean; loadFailed: boolean }): {
	confirmDisabled: boolean;
	showRetry: boolean;
} {
	return { confirmDisabled: !input.loaded, showRetry: input.loadFailed && !input.loaded };
}
