import { describe, expect, test } from "bun:test";
import type { SupervisorRecord } from "../../shared/types.js";
import type { AdminUserRow, ApiKeyRow } from "../lib/api.js";
import { ownershipUi } from "../lib/ownership-ui.js";
import {
	SERVICE_KEY_CHECKBOX_LABEL,
	SERVICE_KEY_HELPER,
	SERVICE_OWNER_CHOICE,
	assembleChecklist,
	assignKeyPlan,
	canCreateServiceKey,
	createKeyRequest,
	demotionFollowUp,
	disableRequestBody,
	initialKeyOwnerChoice,
	keyChoiceNote,
	modeSwitchBlockedReason,
	modeSwitchFailure,
	ownerlessHostsToReview,
	roleChangeAction,
	selfDemoteConfirm,
	undecidedOwnerlessKeys,
} from "./team-flows.js";

function key(over: Partial<ApiKeyRow> & { id: string }): ApiKeyRow {
	return {
		name: over.id,
		keyPrefix: "ap_ab12",
		isActive: true,
		createdAt: "2026-09-01T00:00:00Z",
		lastUsedAt: null,
		scopes: ["ingest"],
		ownerUserId: null,
		...over,
	};
}

function host(over: Partial<SupervisorRecord> & { id: string }): SupervisorRecord {
	return {
		hostName: over.id,
		ownerUserId: null,
		enrollmentState: "active",
		...over,
	} as SupervisorRecord;
}

function person(over: Partial<AdminUserRow> & { id: string; username: string }): AdminUserRow {
	return {
		displayName: null,
		role: "user",
		disabled: false,
		authSource: "local",
		provider: null,
		subjectSource: null,
		lastLoginAt: null,
		roleLockedByEnv: false,
		mustChangePassword: false,
		keyCount: 0,
		hostCount: 0,
		...over,
	};
}

const COUNTS = { unassignedSessions: 0, serviceKeys: 0, undecidedManageServiceKeys: 0 };

describe("undecidedOwnerlessKeys", () => {
	const keys = [
		key({ id: "plain" }),
		key({ id: "manage", scopes: ["manage"] }),
		key({ id: "kept", scopes: ["manage"], adminService: true }),
		key({ id: "marked", serviceKey: true }),
		key({ id: "not-marked", serviceKey: false }),
		key({ id: "owned", ownerUserId: "u1" }),
		key({ id: "dead", isActive: false }),
	];

	test("live, ownerless, not a kept admin key, not marked as a service key", () => {
		expect(undecidedOwnerlessKeys(keys, new Set()).map((k) => k.id)).toEqual([
			"plain",
			"manage",
			"not-marked",
		]);
	});

	test("the per-person reviewed set only matters for keys the server gives no record for", () => {
		const reviewed = new Set(["plain", "not-marked"]);
		expect(undecidedOwnerlessKeys(keys, reviewed).map((k) => k.id)).toEqual([
			"manage",
			"not-marked",
		]);
	});
});

describe("ownerlessHostsToReview", () => {
	test("live hosts nobody owns", () => {
		const hosts = [
			host({ id: "free" }),
			host({ id: "owned", ownerUserId: "u1" }),
			host({ id: "revoked", enrollmentState: "revoked" }),
			host({ id: "looked-at" }),
		];
		expect(ownerlessHostsToReview(hosts).map((h) => h.id)).toEqual(["free", "looked-at"]);
	});
});

describe("assembleChecklist", () => {
	const base = {
		counts: COUNTS,
		keys: [] as ApiKeyRow[],
		hosts: [] as SupervisorRecord[],
		users: [person({ id: "u1", username: "me" }), person({ id: "u2", username: "bob" })],
		viewerUserId: "u1",
		reviewedKeys: new Set<string>(),
		dismissed: new Set<string>(),
	};

	test("the server's count of undecided keys is the number shown", () => {
		const items = assembleChecklist({
			...base,
			counts: { ...COUNTS, undecidedServiceKeys: 4 },
			keys: [key({ id: "only-one" })],
		});
		expect(items).toEqual([{ id: "keys", text: "4 keys have no owner" }]);
	});

	test("without it (older server) the same rule counts the list, the same list the second screen shows", () => {
		const keys = [key({ id: "a" }), key({ id: "b", scopes: ["manage"] }), key({ id: "c" })];
		const items = assembleChecklist({ ...base, keys, reviewedKeys: new Set(["c"]) });
		expect(items).toEqual([{ id: "keys", text: "2 keys have no owner" }]);
		expect(undecidedOwnerlessKeys(keys, new Set(["c"]))).toHaveLength(2);
	});

	test("ownerless hosts are counted, revoked ones are not, and a host stays until it has an owner", () => {
		const items = assembleChecklist({
			...base,
			hosts: [
				host({ id: "a" }),
				host({ id: "b" }),
				host({ id: "revoked", enrollmentState: "revoked" }),
				host({ id: "mine", ownerUserId: "u1" }),
			],
		});
		expect(items).toEqual([
			{
				id: "hosts",
				text: "2 hosts have no owner",
				detail:
					"Events from agents on this host for sessions launched from the dashboard are ignored until the host has an owner or its key is kept as a service key.",
			},
		]);
	});

	test("someone else who can sign in clears the people item; a disabled person doesn't", () => {
		expect(assembleChecklist(base)).toEqual([]);
		const alone = assembleChecklist({
			...base,
			users: [base.users[0], person({ id: "u3", username: "gone", disabled: true })],
		});
		expect(alone).toEqual([{ id: "people", text: "No one else has signed in yet" }]);
	});

	test("a dismissed item stays out, and sessions and manage keys are kept", () => {
		const items = assembleChecklist({
			...base,
			counts: { unassignedSessions: 3, serviceKeys: 1, undecidedManageServiceKeys: 1 },
			dismissed: new Set(["sessions"]),
		});
		expect(items.map((i) => i.id)).toEqual(["manage-keys"]);
	});
});

describe("modeSwitchFailure", () => {
	const items = [
		{ id: "k1", name: "ci-manage", keyPrefix: "ap_1", lastUsedAt: null },
		{ id: "k2", name: "deploy", keyPrefix: "ap_2", lastUsedAt: null },
	];
	const people = [
		{ id: "u1", label: "You" },
		{ id: "u2", label: "bob" },
	];
	const run = (code: string | null, body: unknown, choices = {}) =>
		modeSwitchFailure({ code, body, items, choices, people, fallback: "Couldn't turn on." });

	test("a key added while open is appended and named, and focus goes to it", () => {
		const result = run("service_keys_undecided", {
			keys: [{ id: "k3", name: "late-manage-2", keyPrefix: "ap_3" }],
		});
		expect(result.kind).toBe("added");
		expect(result.message).toBe(
			"late-manage-2 was added while this was open. Choose what happens to it.",
		);
		expect(result.items.map((i) => i.id)).toEqual(["k1", "k2", "k3"]);
		expect(result.focusKeyId).toBe("k3");
	});

	test("two or three added are listed in words", () => {
		const two = run("service_keys_undecided", {
			keys: [
				{ id: "a", name: "late-a", keyPrefix: "x" },
				{ id: "b", name: "late-b", keyPrefix: "x" },
			],
		});
		expect(two.message).toBe(
			"late-a and late-b were added while this was open. Choose what happens to each.",
		);
		const three = run("service_keys_undecided", {
			keys: ["a", "b", "c"].map((id) => ({ id, name: `late-${id}`, keyPrefix: "x" })),
		});
		expect(three.message).toBe(
			"late-a, late-b and 1 more were added while this was open. Choose what happens to each.",
		);
	});

	test("a 409 naming only keys already listed still says something, and points at the first", () => {
		const result = run("service_keys_undecided", {
			keys: [{ id: "k2", name: "deploy", keyPrefix: "ap_2" }],
		});
		expect(result.kind).toBe("already_listed");
		expect(result.message).toBe("deploy still needs a decision. Choose what happens to it.");
		expect(result.items.map((i) => i.id)).toEqual(["k1", "k2"]);
		expect(result.focusKeyId).toBe("k2");
	});

	test("the key itself changed (revoked or no longer qualifies): refresh the keys", () => {
		const result = run("invalid_service_key_decision", { code: "not_a_service_key", keyId: "k1" });
		expect(result.kind).toBe("key_changed");
		expect(result.refresh).toBe("keys");
		expect(result.clearChoiceFor).toBeNull();
		expect(result.message).toBe(
			"ci-manage changed while this was open. The list is up to date: check it and try again.",
		);
	});

	test("the chosen person no longer exists: refresh the people and clear that choice", () => {
		const result = run(
			"invalid_service_key_decision",
			{ code: "assign_user_not_found", keyId: "k1" },
			{ k1: { kind: "assign", userId: "u2" } },
		);
		expect(result.kind).toBe("person_changed");
		expect(result.refresh).toBe("people");
		expect(result.clearChoiceFor).toBe("k1");
		expect(result.message).toBe("bob no longer exists. Choose someone else for ci-manage.");
	});

	test("the chosen person was disabled meanwhile", () => {
		const result = run(
			"invalid_service_key_decision",
			{ code: "assign_user_disabled", keyId: "k1" },
			{ k1: { kind: "assign", userId: "u2" } },
		);
		expect(result.message).toBe("bob is disabled now. Choose someone else for ci-manage.");
		expect(result.refresh).toBe("people");
	});

	test("a choice with no person says to choose one, and refreshes nothing", () => {
		const result = run("invalid_service_key_decision", {
			code: "assign_requires_user",
			keyId: "k2",
		});
		expect(result.kind).toBe("needs_person");
		expect(result.message).toBe("Choose a person for deploy.");
		expect(result.refresh).toBeNull();
	});

	test("an unknown sub-code reads as the key changing, and an unknown key still has a name", () => {
		const result = run("invalid_service_key_decision", { code: "decisions_not_applicable" });
		expect(result.kind).toBe("key_changed");
		expect(result.message).toBe(
			"A key changed while this was open. The list is up to date: check it and try again.",
		);
	});

	test("anything else is the caller's own sentence", () => {
		const result = run("mode_locked_by_env", null);
		expect(result.kind).toBe("generic");
		expect(result.message).toBe("Couldn't turn on.");
		expect(result.items.map((i) => i.id)).toEqual(["k1", "k2"]);
	});
});

describe("modeSwitchBlockedReason", () => {
	const items = [
		{ id: "k1", name: "ci-manage", keyPrefix: "ap_1", lastUsedAt: null },
		{ id: "k2", name: "deploy", keyPrefix: "ap_2", lastUsedAt: null },
		{ id: "k3", name: "nightly", keyPrefix: "ap_3", lastUsedAt: null },
	];

	test("nothing missing: no reason", () => {
		expect(modeSwitchBlockedReason(items.slice(0, 1), { k1: { kind: "keep" } })).toBeNull();
	});

	test("one key with no choice: it is named", () => {
		expect(modeSwitchBlockedReason(items.slice(0, 1), {})).toBe(
			"Choose what happens to ci-manage.",
		);
	});

	test("one key set to 'assign' with nobody chosen: a person is asked for", () => {
		expect(
			modeSwitchBlockedReason(items.slice(0, 1), { k1: { kind: "assign", userId: null } }),
		).toBe("Choose a person for ci-manage.");
	});

	test("several: the first is named and the rest counted", () => {
		expect(modeSwitchBlockedReason(items.slice(0, 2), {})).toBe(
			"Choose what happens to ci-manage and 1 more key.",
		);
		expect(modeSwitchBlockedReason(items, { k1: { kind: "keep" } })).toBe(
			"Choose what happens to deploy and 1 more key.",
		);
		expect(modeSwitchBlockedReason(items, {})).toBe(
			"Choose what happens to ci-manage and 2 more keys.",
		);
	});
});

describe("keyChoiceNote", () => {
	test("revoke says when it happens and that it can't be undone", () => {
		expect(keyChoiceNote({ kind: "revoke" })).toBe(
			"Revoked when you turn on team mode. This can't be undone.",
		);
	});

	test("keep and assign need no warning", () => {
		expect(keyChoiceNote({ kind: "keep" })).toBeNull();
		expect(keyChoiceNote({ kind: "assign", userId: "u1" })).toBeNull();
		expect(keyChoiceNote(undefined)).toBeNull();
	});
});

describe("role changes", () => {
	test("promoting asks first; demoting someone else goes straight through", () => {
		expect(roleChangeAction({ role: "member", isSelf: false }, "admin")).toBe("confirm_promote");
		expect(roleChangeAction({ role: "admin", isSelf: false }, "member")).toBe("demote");
	});

	test("demoting yourself asks first", () => {
		expect(roleChangeAction({ role: "admin", isSelf: true }, "member")).toBe("confirm_self_demote");
	});

	test("choosing the role they already have is nothing", () => {
		expect(roleChangeAction({ role: "admin", isSelf: false }, "admin")).toBe("none");
		expect(roleChangeAction({ role: "member", isSelf: true }, "member")).toBe("none");
	});

	test("the self-demotion confirmation says what you lose", () => {
		expect(selfDemoteConfirm()).toEqual({
			title: "Make yourself a member?",
			body: "You'll lose access to settings, AI providers and users right away. Another admin can make you an admin again.",
			confirmLabel: "Make me a member",
		});
	});

	test("after demoting yourself the user is reloaded and no Undo is offered (you couldn't use it)", () => {
		expect(demotionFollowUp({ isSelf: true })).toEqual({ offerUndo: false, reloadUser: true });
		expect(demotionFollowUp({ isSelf: false })).toEqual({ offerUndo: true, reloadUser: false });
	});
});

describe("disableRequestBody", () => {
	test("the checkbox decides when it is shown, checked or not", () => {
		expect(disableRequestBody({ hasHostCheckbox: true, revokeHosts: true })).toEqual({
			revokeHosts: true,
		});
		expect(disableRequestBody({ hasHostCheckbox: true, revokeHosts: false })).toEqual({
			revokeHosts: false,
		});
	});

	test("with no hosts there is nothing to keep, so the flag is true regardless", () => {
		expect(disableRequestBody({ hasHostCheckbox: false, revokeHosts: false })).toEqual({
			revokeHosts: true,
		});
	});
});

describe("assignKeyPlan", () => {
	test("no choice yet is refused with a sentence", () => {
		expect(assignKeyPlan({ keyHadOwner: false, choice: "", recordServiceKeys: true })).toEqual({
			error: "Choose a person first.",
			ops: [],
		});
	});

	test("a person: one write", () => {
		expect(assignKeyPlan({ keyHadOwner: false, choice: "u2", recordServiceKeys: true })).toEqual({
			error: null,
			ops: [{ kind: "set-owner", userId: "u2" }],
		});
	});

	test("'No one (service key)' on an owned key clears the owner, then records the decision", () => {
		expect(
			assignKeyPlan({ keyHadOwner: true, choice: SERVICE_OWNER_CHOICE, recordServiceKeys: true }),
		).toEqual({
			error: null,
			ops: [{ kind: "set-owner", userId: null }, { kind: "mark-service-key" }],
		});
	});

	test("on a key that has no owner there is nothing to clear", () => {
		expect(
			assignKeyPlan({ keyHadOwner: false, choice: SERVICE_OWNER_CHOICE, recordServiceKeys: true })
				.ops,
		).toEqual([{ kind: "mark-service-key" }]);
	});

	test("the person who already owns it: no write at all", () => {
		expect(
			assignKeyPlan({
				keyHadOwner: true,
				choice: "u2",
				recordServiceKeys: true,
				currentOwnerId: "u2",
			}),
		).toEqual({ error: null, ops: [], unchanged: true });
	});

	test("the same person with their past sessions handed over is still a write", () => {
		expect(
			assignKeyPlan({
				keyHadOwner: true,
				choice: "u2",
				recordServiceKeys: true,
				currentOwnerId: "u2",
				attributeSessions: true,
			}).ops,
		).toEqual([{ kind: "set-owner", userId: "u2" }]);
	});

	test("a different person is a write", () => {
		expect(
			assignKeyPlan({
				keyHadOwner: true,
				choice: "u3",
				recordServiceKeys: true,
				currentOwnerId: "u2",
			}).ops,
		).toEqual([{ kind: "set-owner", userId: "u3" }]);
	});

	test("a server that doesn't record the decision gets only the owner change", () => {
		expect(
			assignKeyPlan({ keyHadOwner: true, choice: SERVICE_OWNER_CHOICE, recordServiceKeys: false })
				.ops,
		).toEqual([{ kind: "set-owner", userId: null }]);
	});
});

describe("creating a service key", () => {
	test("the words on the checkbox and under it", () => {
		expect(SERVICE_KEY_CHECKBOX_LABEL).toBe("Service key (belongs to no one)");
		expect(SERVICE_KEY_HELPER).toBe(
			"Service keys belong to no one. Sessions they report have no owner.",
		);
	});

	test("only an admin in team mode is offered it", () => {
		const team = ownershipUi("team", { effectiveRole: "admin" });
		expect(canCreateServiceKey(team, true)).toBe(true);
		expect(canCreateServiceKey(ownershipUi("team", { effectiveRole: "member" }), false)).toBe(
			false,
		);
		expect(canCreateServiceKey(ownershipUi("solo", { effectiveRole: "admin" }), true)).toBe(false);
	});

	test("the request carries service: true only when asked for and allowed", () => {
		const input = { name: " ci ", ingest: true, manage: false, observe: false };
		expect(createKeyRequest({ ...input, service: true, allowService: true })).toEqual({
			name: "ci",
			scopes: ["ingest"],
			service: true,
		});
		expect(createKeyRequest({ ...input, service: true, allowService: false })).toEqual({
			name: "ci",
			scopes: ["ingest"],
		});
		expect(createKeyRequest({ ...input, service: false, allowService: true })).toEqual({
			name: "ci",
			scopes: ["ingest"],
		});
	});

	test("scopes come out in order, and no scope at all still means ingest", () => {
		expect(
			createKeyRequest({
				name: "k",
				ingest: true,
				manage: true,
				observe: true,
				service: false,
				allowService: false,
			}).scopes,
		).toEqual(["ingest", "manage", "observe"]);
		expect(
			createKeyRequest({
				name: "k",
				ingest: false,
				manage: false,
				observe: false,
				service: false,
				allowService: false,
			}).scopes,
		).toEqual(["ingest"]);
	});
});

describe("the Change owner dialog for a key", () => {
	test("starts on the key's owner, on 'No one (service key)' for a kept service key, and on nothing otherwise", () => {
		expect(initialKeyOwnerChoice({ ownerUserId: "u1" })).toBe("u1");
		expect(initialKeyOwnerChoice({ ownerUserId: null, serviceKey: true })).toBe(
			SERVICE_OWNER_CHOICE,
		);
		expect(initialKeyOwnerChoice({ ownerUserId: null })).toBe("");
		expect(initialKeyOwnerChoice({})).toBe("");
	});

	test("choosing a service key's own state again is not a change", () => {
		expect(
			assignKeyPlan({
				keyHadOwner: false,
				choice: SERVICE_OWNER_CHOICE,
				recordServiceKeys: true,
				currentIsService: true,
			}),
		).toEqual({ error: null, ops: [], unchanged: true });
	});

	test("an ownerless key not yet recorded as a service key still gets recorded", () => {
		expect(
			assignKeyPlan({ keyHadOwner: false, choice: SERVICE_OWNER_CHOICE, recordServiceKeys: true })
				.ops,
		).toEqual([{ kind: "mark-service-key" }]);
	});
});
