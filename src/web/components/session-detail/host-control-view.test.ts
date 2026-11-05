import { describe, expect, test } from "bun:test";
import type { Session } from "../../../shared/types.js";
import { ApiError } from "../../lib/api.js";
import {
	controlBlockedReason,
	hostCanControl,
	hostControlHint,
	hostRefusalMessage,
	showProviderSyncError,
	showProviderSyncState,
} from "./host-control-view.js";

type Probe = Pick<Session, "hostControl" | "managedSession">;

function probe(
	state: "live" | "offline" | "gone" | null,
	hostName: string | null = "studio",
): Probe {
	return {
		hostControl: state === null ? undefined : { state, lastSeenAt: "2026-11-03T10:00:00.000Z" },
		managedSession: { hostName } as Probe["managedSession"],
	};
}
const conflict = (code: string) => new ApiError(409, "x", { error: code });
const fmt = () => "10:00";

describe("when the host can take a stop or a prompt", () => {
	test("live and unknown both read as controllable, with nothing to say", () => {
		for (const state of ["live", null] as const) {
			const session = probe(state);
			expect(hostCanControl(session)).toBe(true);
			expect(controlBlockedReason(session)).toBeNull();
			expect(hostControlHint(session)).toBeNull();
			expect(showProviderSyncState(session)).toBe(true);
		}
	});
});

describe("an offline host", () => {
	test("the blocked reason names the host and says nothing was sent", () => {
		const session = probe("offline");
		expect(hostCanControl(session)).toBe(false);
		expect(controlBlockedReason(session)).toBe(
			"studio is offline, so this session can't be controlled right now. Nothing was sent.",
		);
		expect(showProviderSyncState(session)).toBe(false);
	});

	test("the hint gives the time it was last seen and the re-enrollment caveat", () => {
		expect(hostControlHint(probe("offline"), fmt)).toBe(
			"studio has been offline since 10:00. If you re-enrolled it, this session stays with the old enrollment and can't be controlled from the new one. You can archive it.",
		);
	});

	test("with no host name the copy says 'This session's host'; with no last-seen time it leaves 'since' out", () => {
		const session = probe("offline", null);
		expect(controlBlockedReason(session)).toStartWith("This session's host is offline");
		const unseen: Probe = { ...session, hostControl: { state: "offline", lastSeenAt: null } };
		expect(hostControlHint(unseen, fmt)).toStartWith("This session's host has been offline.");
	});
});

describe("with a Codex approval open on the session", () => {
	const asking = (session: Probe): Probe & Pick<Session, "metadata"> => ({
		...session,
		metadata: { permissionWait: { ids: ["approval:a1"] } },
	});

	test("the notice drops only the archive clause", () => {
		expect(hostControlHint(asking(probe("offline")), fmt)).toBe(
			"studio has been offline since 10:00. If you re-enrolled it, this session stays with the old enrollment and can't be controlled from the new one.",
		);
		expect(hostControlHint(asking(probe("gone")))).toBe(
			"This session's host was removed from AgentPulse, so it can't be controlled.",
		);
	});

	test("a different kind of wait keeps it, and so does the composer's reason", () => {
		const other = { ...probe("offline"), metadata: { permissionWait: { ids: ["toolu_1"] } } };
		expect(hostControlHint(other, fmt)).toEndWith("You can archive it.");
		expect(controlBlockedReason(asking(probe("gone")))).toEndWith("You can archive it.");
	});
});

describe("a host that was removed", () => {
	test("the reason and the hint are the same sentence, and it points at archiving", () => {
		const session = probe("gone");
		const text =
			"This session's host was removed from AgentPulse, so it can't be controlled. You can archive it.";
		expect(controlBlockedReason(session)).toBe(text);
		expect(hostControlHint(session)).toBe(text);
		expect(hostCanControl(session)).toBe(false);
	});
});

describe("hostRefusalMessage", () => {
	test("maps the three 409 codes and nothing else", () => {
		const session = probe("live");
		expect(hostRefusalMessage(conflict("host_offline"), session)).toContain("studio is offline");
		expect(hostRefusalMessage(conflict("host_gone"), session)).toContain("was removed");
		expect(hostRefusalMessage(conflict("host_upgrade_required"), session)).toBe(
			"This session's host is running an older supervisor that can't send prompts to Codex. Update the supervisor on that host.",
		);
		expect(hostRefusalMessage(conflict("control_busy"), session)).toBeNull();
		expect(hostRefusalMessage(new ApiError(400, "x", { error: "host_gone" }), session)).toBeNull();
		expect(hostRefusalMessage(new Error("host_gone"), session)).toBeNull();
		expect(hostRefusalMessage(conflict("constructor"), session)).toBeNull();
	});
});

describe("a stored sync error on a session that has ended", () => {
	const open = { isArchived: false, endedAt: null, status: "active" } as const;
	test("shown while the session is open, hidden once it has ended or been archived", () => {
		expect(showProviderSyncError(open)).toBe(true);
		expect(showProviderSyncError({ ...open, status: "idle" })).toBe(true);
		expect(showProviderSyncError({ ...open, status: "completed" })).toBe(false);
		expect(showProviderSyncError({ ...open, status: "failed" })).toBe(false);
		expect(showProviderSyncError({ ...open, endedAt: "2026-01-01T00:00:00Z" })).toBe(false);
		expect(showProviderSyncError({ ...open, isArchived: true })).toBe(false);
	});
});
