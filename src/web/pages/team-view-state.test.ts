import { describe, expect, test } from "bun:test";
import type { AdminUserRow, ApiKeyRow } from "../lib/api.js";
import { ownershipUi } from "../lib/ownership-ui.js";
import {
	assignDialogCopy,
	buildServiceKeyDecisions,
	credentialsCopyText,
	decisionsComplete,
	demotionToast,
	disableDialogCopy,
	existingScreenStatus,
	incompleteKeyIds,
	initialKeyChoices,
	keyListIntro,
	keyRowModel,
	keysForSetup,
	lastUsedText,
	memberRows,
	membersManageKeyCount,
	mergeUndecidedKeys,
	ownerlessManageKeys,
	pastSessionsChoice,
	peopleSummary,
	promoteConfirm,
	relativeTime,
	soloRowState,
	soloSwitchCopy,
	teamChecklist,
	teamRowState,
	usernameProblem,
} from "./team-view-state.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function user(over: Partial<AdminUserRow> & { id: string; username: string }): AdminUserRow {
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

function key(over: Partial<ApiKeyRow> & { id: string }): ApiKeyRow {
	return {
		name: over.id,
		keyPrefix: "ap_ab12",
		isActive: true,
		createdAt: iso(10 * 24 * HOUR),
		lastUsedAt: null,
		scopes: ["ingest"],
		ownerUserId: null,
		createdByUserId: null,
		adminService: false,
		...over,
	};
}

// ── Solo row ────────────────────────────────────────────────────────────────

describe("soloRowState", () => {
	const admin = { role: "admin" as const, source: "local" as const };

	test("an admin on an install with auth can turn team mode on", () => {
		expect(soloRowState({ disableAuth: false, modeLockedByEnv: false, viewer: admin })).toEqual({
			kind: "available",
		});
	});

	test("with auth disabled it says why", () => {
		expect(soloRowState({ disableAuth: true, modeLockedByEnv: false, viewer: admin })).toEqual({
			kind: "auth_disabled",
			reason: "Team mode needs sign-in. Unset DISABLE_AUTH to use it.",
		});
	});

	test("locked by the environment", () => {
		expect(soloRowState({ disableAuth: false, modeLockedByEnv: true, viewer: admin })).toEqual({
			kind: "env_locked",
			reason: "Set by AGENTPULSE_MODE.",
		});
	});

	test("a local user who isn't an admin", () => {
		expect(
			soloRowState({
				disableAuth: false,
				modeLockedByEnv: false,
				viewer: { role: "user", source: "local" },
			}),
		).toEqual({
			kind: "not_admin",
			reason: "Only an admin can turn on team mode.",
			hint: null,
		});
	});

	test("an SSO user who isn't an admin also learns how to become one", () => {
		const state = soloRowState({
			disableAuth: false,
			modeLockedByEnv: false,
			viewer: { role: "user", source: "forwardauth" },
		});
		expect(state).toEqual({
			kind: "not_admin",
			reason: "Only an admin can turn on team mode.",
			hint: "Ask whoever runs this server to add you to AGENTPULSE_ADMIN_SSO_SUBJECTS.",
		});
	});

	test("an API key is never a human admin", () => {
		expect(
			soloRowState({
				disableAuth: false,
				modeLockedByEnv: false,
				viewer: { role: "admin", source: "api_key" },
			}).kind,
		).toBe("not_admin");
	});

	test("auth disabled wins over everything else, then the environment lock", () => {
		expect(soloRowState({ disableAuth: true, modeLockedByEnv: true, viewer: null }).kind).toBe(
			"auth_disabled",
		);
		expect(
			soloRowState({
				disableAuth: false,
				modeLockedByEnv: true,
				viewer: { role: "user", source: "local" },
			}).kind,
		).toBe("env_locked");
	});
});

describe("teamRowState", () => {
	test("an admin may switch back unless the environment fixes the mode", () => {
		expect(teamRowState({ modeLockedByEnv: false })).toEqual({ canSwitchBack: true, reason: null });
		expect(teamRowState({ modeLockedByEnv: true })).toEqual({
			canSwitchBack: false,
			reason: "Set by AGENTPULSE_MODE.",
		});
	});
});

// ── Members ─────────────────────────────────────────────────────────────────

describe("memberRows", () => {
	const alice = user({
		id: "u1",
		username: "alice",
		role: "admin",
		lastLoginAt: iso(2 * HOUR),
		keyCount: 3,
		hostCount: 1,
	});
	const carol = user({ id: "u3", username: "carol", role: "admin" });
	const bob = user({ id: "u2", username: "bob", keyCount: 1 });
	const sso = user({
		id: "u4",
		username: "Dave Jones",
		displayName: "Dave Jones",
		authSource: "forwardauth",
		provider: "authentik",
		subjectSource: "uid",
		lastLoginAt: iso(2 * HOUR),
		keyCount: 3,
		hostCount: 1,
	});

	test("the row says who, what role, where from, and when they last signed in", () => {
		const [row] = memberRows([sso], "u1", NOW);
		expect(row.name).toBe("Dave Jones");
		expect(row.role).toBe("member");
		expect(row.roleLabel).toBe("Member");
		expect(row.sourceLabel).toBe("Authentik");
		expect(row.meta).toBe("Authentik · last sign-in 2 h ago · 3 keys · 1 host");
		expect(row.isLocal).toBe(false);
		expect(row.canResetPassword).toBe(false);
	});

	test("a local account named admin shows its plain login, on your row and on anyone else's", () => {
		const admin = user({ id: "60b5aa01", username: "admin", role: "admin" });
		expect(memberRows([admin], "60b5aa01", NOW)[0].name).toBe("admin");
		expect(memberRows([admin], "u1", NOW)[0].name).toBe("admin");
		expect(memberRows([admin], "u1", NOW)[0].roleAriaLabel).toBe("Role for admin");
	});

	test("a local account that never signed in", () => {
		const [row] = memberRows([bob], "u1", NOW);
		expect(row.meta).toBe("Local account · never signed in · 1 key · 0 hosts");
		expect(row.isLocal).toBe(true);
		expect(row.canResetPassword).toBe(true);
	});

	test("order: you first, then admins, then members, then disabled, each by name", () => {
		const zed = user({ id: "u5", username: "zed" });
		const gone = user({ id: "u6", username: "adam", disabled: true });
		const rows = memberRows([zed, gone, bob, carol, alice], "u5", NOW);
		expect(rows.map((r) => r.name)).toEqual(["zed", "alice", "carol", "bob", "adam"]);
		expect(rows[0].isSelf).toBe(true);
	});

	test("the only admin can't be demoted or disabled, and the row says so", () => {
		const rows = memberRows([alice, bob], "u9", NOW);
		const only = rows.find((r) => r.id === "u1");
		const reason = "The only admin can't be demoted or disabled. Make someone else an admin first.";
		expect(only?.roleControl).toEqual({ enabled: false, reason });
		expect(only?.disableControl).toEqual({ enabled: false, reason });
	});

	test("with a second admin, either can be demoted", () => {
		const rows = memberRows([alice, carol], "u9", NOW);
		expect(rows.every((r) => r.roleControl.enabled && r.roleControl.reason === null)).toBe(true);
	});

	test("a disabled admin doesn't count as an admin, so the last active one is locked", () => {
		const off = user({ id: "u7", username: "old-admin", role: "admin", disabled: true });
		const rows = memberRows([alice, off], "u9", NOW);
		expect(rows.find((r) => r.id === "u1")?.roleControl.enabled).toBe(false);
	});

	test("an admin named in AGENTPULSE_ADMIN_SSO_SUBJECTS is locked, with the variable's name in the reason", () => {
		const env = user({
			id: "u8",
			username: "Erin",
			authSource: "forwardauth",
			provider: "authentik",
			subjectSource: "uid",
			role: "admin",
			roleLockedByEnv: true,
		});
		const row = memberRows([env, carol], "u9", NOW).find((r) => r.id === "u8");
		expect(row?.roleControl).toEqual({
			enabled: false,
			reason: "Admin role is set by AGENTPULSE_ADMIN_SSO_SUBJECTS and can't be changed here.",
		});
		expect(row?.disableControl).toEqual({
			enabled: false,
			reason: "This admin is listed in AGENTPULSE_ADMIN_SSO_SUBJECTS and can't be disabled here.",
		});
	});

	test("you can't disable your own account, and the row doesn't say so (there is no control to explain)", () => {
		const row = memberRows([alice, carol], "u1", NOW).find((r) => r.id === "u1");
		expect(row?.disableControl).toEqual({ enabled: false, reason: null });
		expect(row?.roleControl.enabled).toBe(true);
	});

	test("a disabled account offers Enable instead", () => {
		const row = memberRows(
			[alice, user({ id: "u6", username: "adam", disabled: true })],
			"u1",
			NOW,
		)[1];
		expect(row.disabled).toBe(true);
		expect(row.canEnable).toBe(true);
		expect(row.canResetPassword).toBe(false);
	});

	test("a member identified by username is badged; one with a uid is not; an unrecorded source counts as username", () => {
		const byName = user({
			id: "a",
			username: "x",
			authSource: "forwardauth",
			subjectSource: "username",
		});
		const byUid = user({ id: "b", username: "y", authSource: "forwardauth", subjectSource: "uid" });
		const unknown = user({
			id: "c",
			username: "z",
			authSource: "forwardauth",
			subjectSource: null,
		});
		const local = user({ id: "d", username: "w", subjectSource: null });
		const rows = memberRows([byName, byUid, unknown, local], "u9", NOW);
		const flag = (id: string) => rows.find((r) => r.id === id)?.identifiedByUsername;
		expect(flag("a")).toBe(true);
		expect(flag("b")).toBe(false);
		expect(flag("c")).toBe(true);
		expect(flag("d")).toBe(false);
	});

	test("a flagged account says it hasn't chosen its own password", () => {
		const row = memberRows(
			[user({ id: "n", username: "nina", mustChangePassword: true })],
			"u9",
			NOW,
		)[0];
		expect(row.mustChangePassword).toBe(true);
	});
});

describe("promoteConfirm and demotionToast", () => {
	test("promoting a member names what an admin can do", () => {
		const confirm = promoteConfirm({ name: "bob", identifiedByUsername: false });
		expect(confirm.title).toBe("Make bob an admin?");
		expect(confirm.body).toBe(
			"Admins can change settings, AI providers and users, and manage every key and host.",
		);
		expect(confirm.extra).toBeNull();
		expect(confirm.confirmLabel).toBe("Make admin");
	});

	test("a member identified by username gets the extra sentence", () => {
		expect(promoteConfirm({ name: "bob", identifiedByUsername: true }).extra).toBe(
			"The role and everything this member owns pass to whoever the identity provider gives this username to.",
		);
	});

	test("demotion is applied at once and says what happened", () => {
		expect(demotionToast({ name: "carol" })).toBe("carol is now a member.");
		expect(demotionToast({ name: "alice", isSelf: true })).toBe("You are now a member.");
	});
});

// ── Service keys ────────────────────────────────────────────────────────────

describe("initialKeyChoices", () => {
	test("a key the server already lists as kept opens as 'keep'; nothing else is preselected", () => {
		const keys = [
			key({ id: "kept", scopes: ["manage"], adminService: true }),
			key({ id: "undecided", scopes: ["manage"], adminService: false }),
			key({ id: "unknown", scopes: ["manage"] }),
			key({ id: "owned", scopes: ["manage"], ownerUserId: "u1", adminService: true }),
		];
		expect(initialKeyChoices(keys)).toEqual({ kept: { kind: "keep" } });
	});

	test("an older server that doesn't send the record preselects nothing", () => {
		expect(initialKeyChoices([key({ id: "k", scopes: ["manage"] })])).toEqual({});
	});
});

describe("ownerlessManageKeys", () => {
	test("active, ownerless keys holding manage or the wildcard; nothing else", () => {
		const keys = [
			key({ id: "m", scopes: ["ingest", "manage"], lastUsedAt: iso(3 * 24 * HOUR) }),
			key({ id: "w", scopes: ["*"] }),
			key({ id: "i", scopes: ["ingest"] }),
			key({ id: "o", scopes: ["observe"] }),
			key({ id: "owned", scopes: ["manage"], ownerUserId: "u1" }),
			key({ id: "dead", scopes: ["manage"], isActive: false }),
		];
		expect(ownerlessManageKeys(keys).map((k) => k.id)).toEqual(["m", "w"]);
	});

	test("carries the name, prefix and last-used date the dialog shows", () => {
		const [item] = ownerlessManageKeys([
			key({
				id: "m",
				name: "macbook-hooks",
				keyPrefix: "ap_9f3c",
				scopes: ["manage"],
				lastUsedAt: "2026-09-29T10:00:00Z",
			}),
		]);
		expect(item).toEqual({
			id: "m",
			name: "macbook-hooks",
			keyPrefix: "ap_9f3c",
			lastUsedAt: "2026-09-29T10:00:00Z",
		});
	});
});

describe("service key decisions", () => {
	const items = [
		{ id: "k1", name: "ci", keyPrefix: "ap_1", lastUsedAt: null },
		{ id: "k2", name: "hooks", keyPrefix: "ap_2", lastUsedAt: null },
	];

	test("no keys, nothing to decide: complete", () => {
		expect(decisionsComplete([], {})).toBe(true);
	});

	test("complete only when every key has a choice", () => {
		expect(decisionsComplete(items, {})).toBe(false);
		expect(decisionsComplete(items, { k1: { kind: "keep" } })).toBe(false);
		expect(decisionsComplete(items, { k1: { kind: "keep" }, k2: { kind: "revoke" } })).toBe(true);
	});

	test("'assign to…' with nobody picked yet isn't a choice", () => {
		const partial = { k1: { kind: "keep" }, k2: { kind: "assign", userId: null } } as const;
		expect(decisionsComplete(items, partial)).toBe(false);
		expect(incompleteKeyIds(items, partial)).toEqual(["k2"]);
		expect(
			decisionsComplete(items, { k1: { kind: "keep" }, k2: { kind: "assign", userId: "u2" } }),
		).toBe(true);
	});

	test("choices for keys that are no longer listed don't count either way", () => {
		expect(
			decisionsComplete(items, {
				k1: { kind: "keep" },
				k2: { kind: "keep" },
				gone: { kind: "revoke" },
			}),
		).toBe(true);
	});

	test("the payload is one decision per listed key, in list order, and nothing for stale choices", () => {
		expect(
			buildServiceKeyDecisions(items, {
				k2: { kind: "assign", userId: "u2" },
				k1: { kind: "revoke" },
				gone: { kind: "keep" },
			}),
		).toEqual([
			{ keyId: "k1", decision: "revoke" },
			{ keyId: "k2", decision: "assign", userId: "u2" },
		]);
	});

	test("an undecided key is left out of the payload rather than guessed", () => {
		expect(buildServiceKeyDecisions(items, { k1: { kind: "keep" } })).toEqual([
			{ keyId: "k1", decision: "keep" },
		]);
	});
});

describe("mergeUndecidedKeys", () => {
	// The server answers 409 with only the keys that still lack a decision in the
	// request it just refused: the ones the dialog didn't know about.
	const current = [
		{ id: "k1", name: "ci", keyPrefix: "ap_1", lastUsedAt: "2026-09-01T00:00:00Z" },
		{ id: "k2", name: "hooks", keyPrefix: "ap_2", lastUsedAt: null },
	];

	test("a key that appeared while the dialog was open is added after the ones already there, and reported as new", () => {
		const merged = mergeUndecidedKeys(current, [{ id: "k9", name: "late", keyPrefix: "ap_9" }]);
		expect(merged.items.map((k) => k.id)).toEqual(["k1", "k2", "k9"]);
		expect(merged.added).toEqual([{ id: "k9", name: "late", keyPrefix: "ap_9", lastUsedAt: null }]);
	});

	test("the keys already listed stay, with what the dialog knew about them", () => {
		const merged = mergeUndecidedKeys(current, [{ id: "k9", name: "late", keyPrefix: "ap_9" }]);
		expect(merged.items.slice(0, 2)).toEqual(current);
	});

	test("a key the dialog already lists is neither duplicated nor reported as new", () => {
		const merged = mergeUndecidedKeys(current, [{ id: "k1", name: "ci", keyPrefix: "ap_1" }]);
		expect(merged.items).toEqual(current);
		expect(merged.added).toEqual([]);
	});
});

describe("relativeTime and lastUsedText", () => {
	test("plain relative phrases", () => {
		expect(relativeTime(iso(20_000), NOW)).toBe("just now");
		expect(relativeTime(iso(5 * 60_000), NOW)).toBe("5 min ago");
		expect(relativeTime(iso(2 * HOUR), NOW)).toBe("2 h ago");
		expect(relativeTime(iso(3 * 24 * HOUR), NOW)).toBe("3 d ago");
		expect(relativeTime(null, NOW)).toBeNull();
		expect(relativeTime("not a date", NOW)).toBeNull();
	});

	test("last used for a key", () => {
		expect(lastUsedText(iso(3 * 24 * HOUR), NOW)).toBe("last used 3 d ago");
		expect(lastUsedText(null, NOW)).toBe("never used");
	});
});

// ── Dialog copy ─────────────────────────────────────────────────────────────

describe("peopleSummary", () => {
	const users = [
		user({ id: "u1", username: "dana", role: "admin" }),
		user({ id: "u3", username: "carol", role: "admin" }),
		user({ id: "u2", username: "bob" }),
		user({ id: "u4", username: "dave" }),
		user({ id: "u5", username: "gone", disabled: true }),
	];

	test("you first, members named, what members lose", () => {
		const summary = peopleSummary(users, "u1");
		expect(summary.admins).toEqual(["you", "carol"]);
		expect(summary.members).toEqual(["bob", "dave"]);
		expect(summary.text).toBe(
			"Admins: you, carol. Members: bob, dave. Members can no longer change settings, AI providers or users.",
		);
	});

	test("a viewer who is a member and sorts last still comes first", () => {
		const withZed = [...users, user({ id: "u9", username: "zed" })];
		const summary = peopleSummary(withZed, "u9");
		expect(summary.members).toEqual(["you", "bob", "dave"]);
		expect(summary.admins).toEqual(["carol", "dana"]);
	});

	test("with no one else yet, it says how later sign-ins will join", () => {
		const summary = peopleSummary([users[0]], "u1");
		expect(summary.text).toBe(
			"Admins: you. People who sign in later join as members, who can't change settings, AI providers or users.",
		);
	});
});

describe("pastSessionsChoice", () => {
	test("hidden when no session lacks an owner", () => {
		expect(pastSessionsChoice(0, 1).show).toBe(false);
	});

	test("pre-checked only with exactly one person who can sign in", () => {
		expect(pastSessionsChoice(214, 1).defaultChecked).toBe(true);
		expect(pastSessionsChoice(214, 2).defaultChecked).toBe(false);
	});

	test("the sentence carries the count", () => {
		const choice = pastSessionsChoice(214, 1);
		expect(choice.show).toBe(true);
		expect(choice.label).toBe("214 sessions are unassigned. Assign them to me.");
		expect(choice.help).toBe(
			"This sets the owner on 214 sessions. An admin can change a session's owner later.",
		);
		expect(pastSessionsChoice(1, 1).label).toBe("1 session is unassigned. Assign it to me.");
	});
});

describe("soloSwitchCopy and membersManageKeyCount", () => {
	test("the confirmation carries the risky count in bold", () => {
		const copy = soloSwitchCopy({ people: 5, memberManageKeys: 3 });
		expect(copy.title).toBe("Switch back to solo mode?");
		expect(copy.confirmLabel).toBe("Switch to solo mode");
		expect(copy.segments).toEqual([
			{
				text: "Roles stop being enforced for existing settings: all 5 people who can sign in can change settings, AI providers and keys again. ",
			},
			{ text: "3 keys with manage that members own regain full access.", strong: true },
			{
				text: " Owner labels are hidden, not deleted. Managing users still needs an admin.",
			},
		]);
	});

	test("no member-made manage keys: that sentence is left out", () => {
		const text = soloSwitchCopy({ people: 2, memberManageKeys: 0 })
			.segments.map((s) => s.text)
			.join("");
		expect(text).not.toContain("regain full access");
	});

	test("one key reads in the singular", () => {
		const strong = soloSwitchCopy({ people: 2, memberManageKeys: 1 }).segments.find(
			(s) => s.strong,
		);
		expect(strong?.text).toBe("1 key with manage that members own regains full access.");
	});

	test("only active keys of active members with manage or the wildcard count", () => {
		const users = [
			user({ id: "admin", username: "a", role: "admin" }),
			user({ id: "mem", username: "m" }),
			user({ id: "off", username: "o", disabled: true }),
		];
		const keys = [
			key({ id: "1", ownerUserId: "mem", scopes: ["manage"] }),
			key({ id: "2", ownerUserId: "mem", scopes: ["*"] }),
			key({ id: "3", ownerUserId: "mem", scopes: ["ingest"] }),
			key({ id: "4", ownerUserId: "admin", scopes: ["manage"] }),
			key({ id: "5", ownerUserId: "mem", scopes: ["manage"], isActive: false }),
			key({ id: "6", ownerUserId: null, scopes: ["manage"] }),
			key({ id: "7", ownerUserId: "off", scopes: ["manage"] }),
		];
		expect(membersManageKeyCount(keys, users)).toBe(2);
	});
});

// ── Checklist ───────────────────────────────────────────────────────────────

describe("teamChecklist", () => {
	const counts = { unassignedSessions: 214, serviceKeys: 3, undecidedManageServiceKeys: 2 };
	const base = {
		counts,
		ownerlessKeys: 3,
		ownerlessHosts: 1,
		otherPeople: 0,
		dismissed: new Set<string>(),
	};

	test("lists what is left, in a fixed order, in plain words", () => {
		expect(teamChecklist(base)).toEqual([
			{ id: "manage-keys", text: "2 service keys can manage but aren't admin" },
			{ id: "keys", text: "3 keys have no owner" },
			{
				id: "hosts",
				text: "1 host has no owner",
				detail:
					"Events from agents on this host for sessions launched from the dashboard are ignored until the host has an owner or its key is kept as a service key.",
			},
			{ id: "sessions", text: "214 sessions are unassigned" },
			{ id: "people", text: "No one else has signed in yet" },
		]);
	});

	test("done is empty", () => {
		expect(
			teamChecklist({
				counts: { unassignedSessions: 0, serviceKeys: 0, undecidedManageServiceKeys: 0 },
				ownerlessKeys: 0,
				ownerlessHosts: 0,
				otherPeople: 2,
				dismissed: new Set(),
			}),
		).toEqual([]);
	});

	test("singular forms", () => {
		const items = teamChecklist({
			...base,
			counts: { unassignedSessions: 1, serviceKeys: 1, undecidedManageServiceKeys: 1 },
			ownerlessKeys: 1,
			otherPeople: 1,
		});
		expect(items.map((i) => i.text)).toEqual([
			"1 service key can manage but isn't admin",
			"1 key has no owner",
			"1 host has no owner",
			"1 session is unassigned",
		]);
	});

	test("an item the admin dismissed stays out", () => {
		const ids = teamChecklist({ ...base, dismissed: new Set(["sessions", "people"]) }).map(
			(i) => i.id,
		);
		expect(ids).toEqual(["manage-keys", "keys", "hosts"]);
	});
});

// ── Disable dialog and add user ─────────────────────────────────────────────

describe("disableDialogCopy", () => {
	test("the dialog is written so it doesn't guess a pronoun", () => {
		const copy = disableDialogCopy({
			name: "Alice Smith",
			keyCount: 3,
			hostCount: 1,
			hostNames: ["alice-mbp"],
		});
		expect(copy.title).toBe("Disable Alice Smith?");
		expect(copy.body).toBe(
			"Alice Smith is signed out everywhere, including dashboards they have open, and can't sign back in. Their 3 API keys are revoked, so agents on their machines stop reporting until they have new keys. Their sessions stay visible. Enabling the account later does not restore keys or hosts.",
		);
		expect(copy.hostCheckbox?.label).toBe(
			"Also revoke their 1 host (alice-mbp). Unchecked, it stays enrolled and can still run launches.",
		);
		expect(copy.confirmLabel).toBe("Disable Alice Smith");
	});

	test("no keys: the key sentence goes; no hosts: no checkbox", () => {
		const copy = disableDialogCopy({ name: "bob", keyCount: 0, hostCount: 0, hostNames: [] });
		expect(copy.body).not.toContain("API key");
		expect(copy.hostCheckbox).toBeNull();
	});

	test("plurals", () => {
		const copy = disableDialogCopy({
			name: "bob",
			keyCount: 1,
			hostCount: 2,
			hostNames: ["a", "b"],
		});
		expect(copy.body).toContain("Their 1 API key is revoked");
		expect(copy.hostCheckbox?.label).toBe(
			"Also revoke their 2 hosts (a, b). Unchecked, they stay enrolled and can still run launches.",
		);
	});
});

describe("usernameProblem", () => {
	test("accepts what the server accepts", () => {
		for (const name of ["al", "alice", "a.b-c_d", "x".repeat(64)])
			expect(usernameProblem(name)).toBeNull();
	});

	test("says what to fix for what it would refuse", () => {
		const message = "Use 2 to 64 characters: letters, digits, _ - and .";
		for (const name of ["", "a", "has space", "sso:x", "x".repeat(65), "café"]) {
			expect(usernameProblem(name)).toBe(message);
		}
	});
});

describe("credentialsCopyText", () => {
	test("sign-in address, username and password, one per line", () => {
		expect(
			credentialsCopyText({
				signInAddress: "https://pulse.example",
				username: "bob",
				password: "pw",
			}),
		).toBe("Sign-in address: https://pulse.example\nUsername: bob\nPassword: pw");
	});
});

// ── Keys ────────────────────────────────────────────────────────────────────

describe("keyRowModel", () => {
	const solo = ownershipUi("solo", { effectiveRole: "admin" });
	const teamAdmin = ownershipUi("team", { effectiveRole: "admin" });
	const teamMember = ownershipUi("team", { effectiveRole: "member" });
	const names = (id: string) => ({ u1: "Alice", u2: "Bob" })[id as "u1" | "u2"] ?? "someone";
	const ctx = (ui: typeof solo, viewerUserId: string | null, isAdmin: boolean) => ({
		ui,
		viewerUserId,
		isAdmin,
		ownerName: names,
	});

	test("solo: exactly today's row: no owner text, no badges, revoke offered, no confirmation", () => {
		expect(keyRowModel(key({ id: "k", scopes: ["manage"] }), ctx(solo, null, true))).toEqual({
			note: null,
			canMarkService: false,
			ownerText: null,
			badges: [],
			canRevoke: true,
			canAssign: false,
			canKeepAsAdmin: false,
			revokeConfirm: null,
		});
	});

	test("team: a revoked key carries no owner or role badges", () => {
		const revoked = (over: Partial<ApiKeyRow>) =>
			keyRowModel(key({ id: "k", isActive: false, ...over }), ctx(teamAdmin, "u2", true));
		expect(revoked({ scopes: ["manage"], adminService: true, serviceKey: true }).badges).toEqual(
			[],
		);
		expect(revoked({ scopes: ["manage"], serviceKey: false }).badges).toEqual([]);
		expect(revoked({ ownerUserId: null, serviceKey: true }).badges).toEqual([]);
	});

	test("solo: a revoked key has nothing to revoke", () => {
		expect(keyRowModel(key({ id: "k", isActive: false }), ctx(solo, null, true)).canRevoke).toBe(
			false,
		);
	});

	test("team: an owned key shows its owner; no service badge", () => {
		const model = keyRowModel(key({ id: "k", ownerUserId: "u1" }), ctx(teamAdmin, "u2", true));
		expect(model.ownerText).toBe("Owner: Alice");
		expect(model.badges).toEqual([]);
	});

	test("team: a plain service key is badged 'Service key'", () => {
		expect(keyRowModel(key({ id: "k" }), ctx(teamAdmin, "u2", true)).badges).toEqual([
			{ text: "Service key", tone: "neutral" },
		]);
	});

	test("team: a kept admin service key is amber and says admin access", () => {
		expect(
			keyRowModel(
				key({ id: "k", scopes: ["manage"], adminService: true }),
				ctx(teamAdmin, "u2", true),
			).badges,
		).toEqual([{ text: "Service key · admin access", tone: "amber" }]);
	});

	test("team: a manage service key that isn't kept reads 'manage, not admin'", () => {
		const model = keyRowModel(key({ id: "k", scopes: ["manage"] }), ctx(teamAdmin, "u2", true));
		expect(model.badges).toEqual([{ text: "Service key · manage, not admin", tone: "neutral" }]);
		expect(model.canKeepAsAdmin).toBe(true);
	});

	test("team: an owned manage key can't be kept as an admin service key", () => {
		const model = keyRowModel(
			key({ id: "k", scopes: ["manage"], ownerUserId: "u1" }),
			ctx(teamAdmin, "u2", true),
		);
		expect(model.canKeepAsAdmin).toBe(false);
	});

	test("team: a member can revoke their own key (after a confirmation), but not someone else's", () => {
		const own = keyRowModel(key({ id: "k", ownerUserId: "u2" }), ctx(teamMember, "u2", false));
		expect(own.canRevoke).toBe(true);
		expect(own.revokeConfirm).toEqual({
			title: "Revoke k?",
			body: "This is your key. Agents using it stop reporting until they have a new key.",
		});
		const other = keyRowModel(key({ id: "k", ownerUserId: "u1" }), ctx(teamMember, "u2", false));
		expect(other.canRevoke).toBe(false);
		expect(other.canAssign).toBe(false);
	});

	test("team: an admin revoking someone else's key is asked first, with the key and its owner named", () => {
		const model = keyRowModel(
			key({ id: "k", name: "alice-laptop", ownerUserId: "u1" }),
			ctx(teamAdmin, "u2", true),
		);
		expect(model.canRevoke).toBe(true);
		expect(model.revokeConfirm).toEqual({
			title: "Revoke alice-laptop?",
			body: "This key belongs to Alice. Agents using it stop reporting until they have a new key.",
		});
	});

	test("team: revoking a service key is confirmed too, and admin access is called out", () => {
		const plain = keyRowModel(key({ id: "k", name: "ci" }), ctx(teamAdmin, "u2", true));
		expect(plain.revokeConfirm).toEqual({
			title: "Revoke ci?",
			body: "This is a service key. Agents using it stop reporting until they have a new key.",
		});
		const kept = keyRowModel(
			key({ id: "k", name: "ci", scopes: ["manage"], adminService: true }),
			ctx(teamAdmin, "u2", true),
		);
		expect(kept.revokeConfirm?.body).toBe(
			"This is a service key with admin access. Agents using it stop reporting until they have a new key.",
		);
	});

	test("team: only an admin assigns, and only a live key", () => {
		expect(keyRowModel(key({ id: "k" }), ctx(teamAdmin, "u2", true)).canAssign).toBe(true);
		expect(
			keyRowModel(key({ id: "k", isActive: false }), ctx(teamAdmin, "u2", true)).canAssign,
		).toBe(false);
		expect(keyRowModel(key({ id: "k" }), ctx(teamMember, "u2", false)).canAssign).toBe(false);
	});
});

describe("keyListIntro", () => {
	test("solo keeps today's words (null: the page's own text stays)", () => {
		expect(keyListIntro(ownershipUi("solo", { effectiveRole: "admin" }), true)).toEqual({
			intro: null,
		});
	});

	test("a member reads that these are their own keys", () => {
		expect(keyListIntro(ownershipUi("team", { effectiveRole: "member" }), false)).toEqual({
			intro: "Your API keys. Admins manage everyone's.",
		});
	});

	test("an admin reads that every key reports as its owner", () => {
		expect(keyListIntro(ownershipUi("team", { effectiveRole: "admin" }), true).intro).toBe(
			"Everyone's API keys. Each key reports sessions as its owner.",
		);
	});
});

describe("assignDialogCopy", () => {
	test("offers to hand over the sessions the key already reported, when there are some", () => {
		const copy = assignDialogCopy({ keyName: "alice-laptop", reportedSessions: 37 });
		expect(copy.title).toBe("Assign alice-laptop to…");
		expect(copy.sessionsCheckbox).toBe("Also assign the 37 sessions this key has already reported");
		expect(copy.note).toBe(
			"New sessions from this key will be recorded as theirs. If several people share this key, leave it as a service key.",
		);
	});

	test("nothing reported yet: no checkbox; one reads in the singular", () => {
		expect(assignDialogCopy({ keyName: "k", reportedSessions: 0 }).sessionsCheckbox).toBeNull();
		expect(assignDialogCopy({ keyName: "k", reportedSessions: 1 }).sessionsCheckbox).toBe(
			"Also assign the 1 session this key has already reported",
		);
	});
});

describe("keysForSetup", () => {
	const keys = [
		key({ id: "mine", ownerUserId: "u1" }),
		key({ id: "theirs", ownerUserId: "u2" }),
		key({ id: "service" }),
		key({ id: "mine-dead", ownerUserId: "u1", isActive: false }),
	];

	test("solo: every live key, as today", () => {
		expect(
			keysForSetup(keys, ownershipUi("solo", { effectiveRole: "admin" }), "u1").map((k) => k.id),
		).toEqual(["mine", "theirs", "service"]);
	});

	test("team: only your own live keys, even for an admin who can list everyone's", () => {
		expect(
			keysForSetup(keys, ownershipUi("team", { effectiveRole: "admin" }), "u1").map((k) => k.id),
		).toEqual(["mine"]);
	});

	test("team: someone with no user id has no keys of their own", () => {
		expect(keysForSetup(keys, ownershipUi("team", { effectiveRole: "member" }), null)).toEqual([]);
	});
});

describe("people rows: your own row and accessible names", () => {
	const me = user({ id: "me", username: "alice", role: "admin" });
	const other = user({ id: "u2", username: "carol", role: "admin" });
	const rows = memberRows([me, other, user({ id: "u3", username: "bob" })], "me", NOW);
	const byName = (name: string) => rows.find((r) => r.name === name);

	test("you can't reset your own password from the list: the Account panel is the way", () => {
		expect(byName("alice")?.canResetPassword).toBe(false);
		expect(byName("carol")?.canResetPassword).toBe(true);
		expect(byName("bob")?.canResetPassword).toBe(true);
	});

	test("the controls name the person, so a screen reader hears whose role it is", () => {
		expect(byName("carol")?.roleAriaLabel).toBe("Role for carol");
		expect(byName("carol")?.moreActionsLabel).toBe("More actions for carol");
	});
});

describe("key rows: the server's record of a service key", () => {
	const teamAdmin = ownershipUi("team", { effectiveRole: "admin" });
	const ctx2 = {
		ui: teamAdmin,
		viewerUserId: "u2",
		isAdmin: true,
		ownerName: (id: string) => id,
	};
	const sentence =
		"Until this key has an owner or is kept as a service key, events it sends for sessions launched from the dashboard are ignored.";

	test("a key marked as a service key is badged 'Service key', with no warning", () => {
		const model = keyRowModel(key({ id: "k", serviceKey: true }), ctx2);
		expect(model.badges).toEqual([{ text: "Service key", tone: "neutral" }]);
		expect(model.note).toBeNull();
		expect(model.canMarkService).toBe(false);
	});

	test("an ownerless key the server says is undecided is a service key nobody has decided on, explains what that costs, and can be kept", () => {
		const model = keyRowModel(key({ id: "k", serviceKey: false }), ctx2);
		expect(model.badges).toEqual([{ text: "Service key · not decided", tone: "neutral" }]);
		expect(model.note).toBe(sentence);
		expect(model.canMarkService).toBe(true);
	});

	test("a manage key that is undecided says what it can do", () => {
		const model = keyRowModel(
			key({ id: "k", serviceKey: false, scopes: ["ingest", "manage"] }),
			ctx2,
		);
		expect(model.badges).toEqual([
			{ text: "Service key · not decided · manage, not admin", tone: "neutral" },
		]);
		expect(model.note).toBe(sentence);
	});

	test("the ignored-events sentence is only for a key that can send events", () => {
		for (const scopes of [["manage"], ["observe"], ["manage", "observe"]]) {
			const model = keyRowModel(key({ id: "k", serviceKey: false, scopes }), ctx2);
			expect(model.note).toBeNull();
			expect(model.canMarkService).toBe(true);
		}
		expect(keyRowModel(key({ id: "k", serviceKey: false, scopes: ["*"] }), ctx2).note).toBe(
			sentence,
		);
	});

	test("a kept admin key is never 'undecided'", () => {
		const model = keyRowModel(
			key({ id: "k", serviceKey: false, scopes: ["manage"], adminService: true }),
			ctx2,
		);
		expect(model.note).toBeNull();
		expect(model.canMarkService).toBe(false);
	});

	test("a server that sends no record keeps today's behaviour: 'Service key', no sentence", () => {
		const model = keyRowModel(key({ id: "k" }), ctx2);
		expect(model.badges).toEqual([{ text: "Service key", tone: "neutral" }]);
		expect(model.note).toBeNull();
		expect(model.canMarkService).toBe(false);
	});

	test("an owned key has neither, and a member is never offered the button", () => {
		expect(
			keyRowModel(key({ id: "k", ownerUserId: "u1", serviceKey: false }), ctx2).note,
		).toBeNull();
		const asMember = keyRowModel(key({ id: "k", serviceKey: false }), {
			...ctx2,
			ui: ownershipUi("team", { effectiveRole: "member" }),
			isAdmin: false,
		});
		expect(asMember.canMarkService).toBe(false);
	});

	test("a revoked key's badges stay but nothing can be marked", () => {
		expect(
			keyRowModel(key({ id: "k", serviceKey: false, isActive: false }), ctx2).canMarkService,
		).toBe(false);
	});
});

describe("assignDialogCopy with an unknown count", () => {
	test("the checkbox stays, and says the sessions couldn't be counted", () => {
		const copy = assignDialogCopy({ keyName: "k", reportedSessions: null });
		expect(copy.sessionsCheckbox).toBe(
			"Also assign the sessions this key has already reported (couldn't count sessions)",
		);
	});

	test("an admin can send a key back to being a service key", () => {
		expect(assignDialogCopy({ keyName: "k", reportedSessions: 0 }).serviceOption).toBe(
			"No one (service key)",
		);
	});
});

describe("existingScreenStatus", () => {
	test("right after the switch it is step 2 of 2, and optional", () => {
		expect(existingScreenStatus({ followsSwitch: true })).toBe(
			"Team mode is on. Step 2 of 2, optional.",
		);
	});

	test("reopened from the checklist there is no step count", () => {
		expect(existingScreenStatus({ followsSwitch: false })).toBeNull();
	});
});
