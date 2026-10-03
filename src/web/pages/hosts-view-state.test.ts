import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupervisorRecord } from "../../shared/types.js";
import { ownershipUi } from "../lib/ownership-ui.js";
import {
	deriveHostAccess,
	deriveHostExcludeNotice,
	deriveHostsViewState,
	enrollmentOwnershipNote,
	hostActionConfirm,
	hostOwnerDialogNote,
	hostOwnerUnchanged,
	launchHostLabel,
} from "./hosts-view-state.js";

function supervisor(id: string): SupervisorRecord {
	return {
		id,
		hostName: `host-${id}`,
		platform: "linux",
		arch: "x64",
		version: "1.0.0",
		status: "connected",
		enrollmentState: "active",
		capabilities: {
			launchModes: [],
			agentTypes: [],
			features: [],
		},
		trustedRoots: [],
		lastHeartbeatAt: new Date().toISOString(),
	} as unknown as SupervisorRecord;
}

describe("deriveHostsViewState", () => {
	test("loading takes priority over everything else", () => {
		expect(
			deriveHostsViewState({ loading: true, loadError: "boom", supervisors: [supervisor("1")] }),
		).toEqual({ kind: "loading" });
	});

	test("load error (not loading) surfaces as a distinct error state, even with stale supervisors", () => {
		expect(
			deriveHostsViewState({
				loading: false,
				loadError: "Couldn't load hosts: 403 insufficient_scope",
				supervisors: [],
			}),
		).toEqual({ kind: "error", message: "Couldn't load hosts: 403 insufficient_scope" });
	});

	test("a load error takes priority over a non-empty (stale) supervisor list — the list may be stale/wrong", () => {
		expect(
			deriveHostsViewState({
				loading: false,
				loadError: "Couldn't load hosts: network error",
				supervisors: [supervisor("1")],
			}),
		).toEqual({ kind: "error", message: "Couldn't load hosts: network error" });
	});

	test("no error, empty list → genuine empty state", () => {
		expect(deriveHostsViewState({ loading: false, loadError: null, supervisors: [] })).toEqual({
			kind: "empty",
		});
	});

	test("no error, non-empty list → populated state carrying the supervisors", () => {
		const supervisors = [supervisor("1"), supervisor("2")];
		expect(deriveHostsViewState({ loading: false, loadError: null, supervisors })).toEqual({
			kind: "populated",
			supervisors,
		});
	});
});

describe("deriveHostAccess", () => {
	const names = (id: string) => ({ u1: "Alice", u2: "Bob" })[id as "u1" | "u2"] ?? "someone";
	const solo = ownershipUi("solo", { effectiveRole: "admin" });
	const member = ownershipUi("team", { effectiveRole: "member" });
	const admin = ownershipUi("team", { effectiveRole: "admin" });
	const access = (
		ownerUserId: string | null,
		ui: typeof solo,
		viewerUserId: string | null,
		isAdmin: boolean,
	) => deriveHostAccess({ ownerUserId }, { ui, viewerUserId, isAdmin, ownerName: names });

	test("solo: no owner field, rotate and revoke open, nothing to explain", () => {
		expect(access("u1", solo, "u2", true)).toEqual({
			ownerText: null,
			canManage: true,
			manageReason: null,
			launchNote: null,
			canChangeOwner: false,
		});
	});

	test("team: the owner's own host shows the owner and keeps both buttons", () => {
		expect(access("u1", member, "u1", false)).toEqual({
			ownerText: "Alice",
			canManage: true,
			manageReason: null,
			launchNote: null,
			canChangeOwner: false,
		});
	});

	test("team: on someone else's host a member gets both buttons disabled with the reason and a launch note", () => {
		expect(access("u1", member, "u2", false)).toEqual({
			ownerText: "Alice",
			canManage: false,
			manageReason: "Only Alice or an admin can rotate or revoke this host.",
			launchNote: "Anyone can still launch on this host.",
			canChangeOwner: false,
		});
	});

	test("team: an admin manages any host and may change its owner", () => {
		expect(access("u1", admin, "u2", true)).toEqual({
			ownerText: "Alice",
			canManage: true,
			manageReason: null,
			launchNote: null,
			canChangeOwner: true,
		});
	});

	test("team: a host nobody owns reads 'Unassigned' and is an admin's to manage", () => {
		expect(access(null, member, "u2", false)).toEqual({
			ownerText: "Unassigned",
			canManage: false,
			manageReason: "Only an admin can rotate or revoke an unassigned host.",
			launchNote: "Anyone can still launch on this host.",
			canChangeOwner: false,
		});
		const asAdmin = access(null, admin, "u2", true);
		expect(asAdmin.ownerText).toBe("Unassigned");
		expect(asAdmin.canManage).toBe(true);
	});
});

describe("enrollmentOwnershipNote", () => {
	test("only team mode says that hosts you enroll are yours", () => {
		expect(enrollmentOwnershipNote(ownershipUi("solo", { effectiveRole: "admin" }))).toBeNull();
		expect(enrollmentOwnershipNote(ownershipUi("team", { effectiveRole: "member" }))).toBe(
			"Hosts you enroll are yours.",
		);
	});
});

describe("launchHostLabel", () => {
	const lookup = (id: string) =>
		id === "u1" ? { id, displayName: "Alice", disabled: false } : undefined;
	const alicesMac = { hostName: "alice-mbp", ownerUserId: "u1" };

	test("solo: just the host name, as it always was", () => {
		expect(
			launchHostLabel(ownershipUi("solo", { effectiveRole: "admin" }), alicesMac, lookup, "u2"),
		).toBe("alice-mbp");
	});

	test("team: whose host it is, so nobody starts a process on a colleague's machine by accident", () => {
		const ui = ownershipUi("team", { effectiveRole: "member" });
		expect(launchHostLabel(ui, alicesMac, lookup, "u2")).toBe("alice-mbp (Alice's host)");
		expect(launchHostLabel(ui, alicesMac, lookup, "u1")).toBe("alice-mbp (your host)");
		expect(launchHostLabel(ui, { hostName: "lab", ownerUserId: null }, lookup, "u1")).toBe(
			"lab (unassigned host)",
		);
	});
});

describe("host access wording", () => {
	const names = (id: string) => (id === "u1" ? "Alice" : id === "ad" ? "admin" : "someone");
	const member = ownershipUi("team", { effectiveRole: "member" });
	const access = (
		host: { ownerUserId: string | null; enrollmentState?: "active" | "pending" | "revoked" },
		viewerUserId: string,
	) =>
		deriveHostAccess(host as never, { ui: member, viewerUserId, isAdmin: false, ownerName: names });

	test("a revoked host doesn't claim anyone can still launch on it", () => {
		const result = access({ ownerUserId: "u1", enrollmentState: "revoked" }, "u2");
		expect(result.manageReason).toBe("Only Alice or an admin can rotate or revoke this host.");
		expect(result.launchNote).toBeNull();
	});

	test("an active host still says so", () => {
		expect(access({ ownerUserId: "u1", enrollmentState: "active" }, "u2").launchNote).toBe(
			"Anyone can still launch on this host.",
		);
	});

	test("when the owner's name is 'admin' it doesn't read 'Only admin or an admin'", () => {
		expect(access({ ownerUserId: "ad" }, "u2").manageReason).toBe(
			"Only its owner (admin) or another admin can rotate or revoke this host.",
		);
	});
});

describe("hostActionConfirm", () => {
	test("rotating says what happens to the current credential", () => {
		expect(hostActionConfirm("rotate", "alice-mbp")).toEqual({
			title: "Re-enroll alice-mbp?",
			body: "This creates a one-time token. When it is used, the host's current credential is replaced and anything still using the old one stops working.",
			confirmLabel: "Create token",
		});
	});

	test("revoking says the host stays listed and who can bring it back", () => {
		expect(hostActionConfirm("revoke", "alice-mbp")).toEqual({
			title: "Revoke alice-mbp?",
			body: "The host can't report or run launches until an admin enrolls it again. It stays listed here.",
			confirmLabel: "Revoke host",
		});
	});
});

describe("hostOwnerDialogNote", () => {
	test("an active host: the owner manages it, anyone can still launch", () => {
		expect(hostOwnerDialogNote({ enrollmentState: "active" })).toBe(
			"The owner (and any admin) can rotate or revoke this host. Anyone can still launch on it.",
		);
	});

	test("a revoked host makes no launch promise", () => {
		expect(hostOwnerDialogNote({ enrollmentState: "revoked" })).toBe(
			"The owner (and any admin) can rotate or revoke this host.",
		);
	});
});

describe("hostOwnerUnchanged", () => {
	test("the owner a host already has, or none for none, sends nothing", () => {
		expect(hostOwnerUnchanged("u1", "u1")).toBe(true);
		expect(hostOwnerUnchanged(null, "")).toBe(true);
		expect(hostOwnerUnchanged(undefined, "")).toBe(true);
	});

	test("anything else is a change", () => {
		expect(hostOwnerUnchanged("u1", "u2")).toBe(false);
		expect(hostOwnerUnchanged("u1", "")).toBe(false);
		expect(hostOwnerUnchanged(null, "u1")).toBe(false);
	});
});

describe("deriveHostExcludeNotice", () => {
	const NOW = Date.parse("2026-03-01T12:00:00Z");
	const live = new Date(NOW + 60_000).toISOString();
	const expired = new Date(NOW - 1_000).toISOString();
	const notice = (
		state: unknown,
		over: { status?: string; heartbeatLeaseExpiresAt?: string } = {},
	) =>
		deriveHostExcludeNotice(
			{
				excludeRulesState: state,
				status: "connected",
				heartbeatLeaseExpiresAt: live,
				...over,
			} as unknown as Pick<
				SupervisorRecord,
				"excludeRulesState" | "status" | "heartbeatLeaseExpiresAt"
			>,
			NOW,
		);

	test("only an invalid exclude file earns a notice, in these words", () => {
		expect(notice("invalid")).toEqual({
			text: "This host's supervisor is sending nothing: its exclude file or its saved exclude state has an error. Run agentpulse exclude check on that machine.",
		});
	});

	test("rules in use or absent (the server no longer stores those), unknown (null or absent: an older supervisor) and anything unexpected show nothing", () => {
		for (const state of ["none", "ok", null, undefined, "frozen", 5, "", "INVALID"]) {
			expect(notice(state), String(state)).toBeNull();
		}
	});

	test("it never says the machine has stopped (the host is still reporting its own state; only session data is held back)", () => {
		expect(notice("invalid")?.text.toLowerCase()).not.toContain("stopped");
		// "on that machine" is where to run the check; nothing says the machine itself is down.
		expect(notice("invalid")?.text.toLowerCase()).not.toMatch(/machine (has|is|was)/);
	});

	test("a host whose heartbeat lease has expired shows no notice: the flag is the last thing it said, not what is true now", () => {
		expect(notice("invalid", { heartbeatLeaseExpiresAt: expired })).toBeNull();
		expect(notice("invalid", { status: "stale", heartbeatLeaseExpiresAt: expired })).toBeNull();
		expect(notice("invalid", { status: "offline", heartbeatLeaseExpiresAt: expired })).toBeNull();
	});

	test("a host the server already calls stale or offline shows none, even when the lease date in the record is still ahead of this browser's clock", () => {
		expect(notice("invalid", { status: "stale" })).toBeNull();
		expect(notice("invalid", { status: "offline" })).toBeNull();
	});

	test("an unreadable lease date is not a live lease", () => {
		expect(notice("invalid", { heartbeatLeaseExpiresAt: "not a date" })).toBeNull();
		expect(notice("invalid", { heartbeatLeaseExpiresAt: undefined })).toBeNull();
	});

	test("the lease's last instant still counts as expired, and the moment before it does not", () => {
		expect(notice("invalid", { heartbeatLeaseExpiresAt: new Date(NOW).toISOString() })).toBeNull();
		expect(
			notice("invalid", { heartbeatLeaseExpiresAt: new Date(NOW + 1).toISOString() }),
		).not.toBeNull();
	});
});

describe("the exclude notice on a member-owned host", () => {
	const names = (id: string) => ({ u1: "Alice", u2: "Bob" })[id as "u1" | "u2"] ?? "someone";
	const NOW = Date.parse("2026-03-01T12:00:00Z");
	const live = new Date(NOW + 60_000).toISOString();
	const host = (flag: "invalid" | null): SupervisorRecord => ({
		...supervisor("owned"),
		ownerUserId: "u1",
		excludeRulesState: flag,
		heartbeatLeaseExpiresAt: live,
	});
	const views = [
		{ who: "the owner", viewer: "u1", isAdmin: false, role: "member" as const },
		{ who: "another member", viewer: "u2", isAdmin: false, role: "member" as const },
		{ who: "an admin", viewer: "u2", isAdmin: true, role: "admin" as const },
	];

	test("every viewer gets the notice, as host data", () => {
		for (const v of views) {
			expect(deriveHostExcludeNotice(host("invalid"), NOW), v.who).not.toBeNull();
		}
	});

	test("the flag changes nothing about ownership or who may manage the host", () => {
		for (const v of views) {
			const ctx = {
				ui: ownershipUi("team", { effectiveRole: v.role }),
				viewerUserId: v.viewer,
				isAdmin: v.isAdmin,
				ownerName: names,
			};
			expect(deriveHostAccess(host("invalid"), ctx), v.who).toEqual(
				deriveHostAccess(host(null), ctx),
			);
			expect(deriveHostAccess(host("invalid"), ctx).ownerText, v.who).toBe("Alice");
		}
	});
});

describe("the owner dialogs", () => {
	const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");
	for (const [name, file] of [
		["host", ["components", "HostOwnerDialog.tsx"]],
		["session", ["components", "session-detail", "SessionOwnerDialog.tsx"]],
	] as const) {
		test(`the ${name} owner dialog starts on its select and keeps Save off until the owner changes`, () => {
			const source = read(...file);
			expect(source).toContain('data-autofocus=""');
			expect(source).toMatch(/disabled=\{busy \|\| unchanged\}/);
		});
	}

	test("both pages offer a disabled current owner in the picker", () => {
		expect(read("pages", "HostsPage.tsx")).toContain("withCurrentOwner(");
		expect(read("pages", "SessionDetailPage.tsx")).toContain("withCurrentOwner(");
	});
});
