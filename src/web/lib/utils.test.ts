import { describe, expect, test } from "bun:test";
import { MANAGED_STATES, type ManagedState } from "../../shared/types.js";
import {
	canAcknowledgeSession,
	explicitAckAccess,
	getSessionMode,
	parseDate,
	projectColor,
} from "./utils.js";

// parseDate is a thin wrapper over the shared parseStoredTimestamp (see
// timestamp.test.ts for the full zone-handling matrix) — these tests cover
// only its own contract: a zone-less stored value reads as UTC, and
// unparsable input is NaN (never null, never a thrown error), since
// formatDuration/formatTimeAgo rely on `Number.isNaN(diff)` to detect it.
describe("parseDate", () => {
	test("a zone-less SQLite-style timestamp is read as UTC, not local time", () => {
		expect(parseDate("2026-10-01 10:00:00")).toBe(Date.UTC(2026, 9, 1, 10, 0, 0));
	});

	test("an ISO timestamp with an explicit Z offset parses the same way", () => {
		expect(parseDate("2026-10-01T10:00:00Z")).toBe(Date.UTC(2026, 9, 1, 10, 0, 0));
	});

	test("invalid input is NaN, not null and not a thrown error", () => {
		expect(Number.isNaN(parseDate("not-a-date"))).toBe(true);
		expect(Number.isNaN(parseDate(""))).toBe(true);
		expect(Number.isNaN(parseDate("2026-13-99 99:99:99"))).toBe(true);
	});
});

// Slice TYPE-2b: getSessionMode used to read managedState as a plain
// `string` and silently fall through `default: "observed"` for any
// unknown value. The promotion to a typed Record<ManagedState, …> means
// adding a new state to MANAGED_STATES forces a compile error in
// utils.ts; this test guards the runtime side — every member of the
// union must produce a defined SessionModeStyle without falling into
// `undefined` (which would happen if the Record were partial).
describe("getSessionMode", () => {
	test("returns observed style when no managedSession is present", () => {
		const style = getSessionMode({ managedSession: null });
		expect(style.mode).toBe("observed");
		expect(style.label).toBe("observed");
	});

	test("returns observed style when managedSession is undefined", () => {
		const style = getSessionMode({});
		expect(style.mode).toBe("observed");
	});

	test("every ManagedState member maps to a defined style", () => {
		for (const state of MANAGED_STATES) {
			const style = getSessionMode({ managedSession: { managedState: state } });
			expect(style).toBeDefined();
			expect(style.mode).toBeDefined();
			expect(style.label).toBeDefined();
			expect(style.barClass).toBeDefined();
			expect(style.chipClass).toBeDefined();
		}
	});

	test("interactive_terminal maps to interactive mode", () => {
		const style = getSessionMode({ managedSession: { managedState: "interactive_terminal" } });
		expect(style.mode).toBe("interactive");
	});

	test("headless maps to headless mode", () => {
		const style = getSessionMode({ managedSession: { managedState: "headless" } });
		expect(style.mode).toBe("headless");
	});

	test("managed and degraded both map to managed mode", () => {
		expect(getSessionMode({ managedSession: { managedState: "managed" } }).mode).toBe("managed");
		expect(getSessionMode({ managedSession: { managedState: "degraded" } }).mode).toBe("managed");
	});

	test("terminal lifecycle states (stopped/completed/failed) collapse to observed style", () => {
		// These previously hit the `default:` branch. Locked down so future
		// reshuffles can't accidentally promote them.
		for (const state of [
			"stopped",
			"completed",
			"failed",
			"pending",
			"linked",
		] satisfies ManagedState[]) {
			const style = getSessionMode({ managedSession: { managedState: state } });
			expect(style.mode).toBe("observed");
		}
	});
});

// AGEN: a project tint must never be mistaken for the ERROR badge (red,
// hue ~0) or the WAITING badge (amber, hue ~38-45) sitting right next to
// it on the same card. The hue bands below (20-359 wrap excluded) are
// swept exhaustively over a large, varied name sample rather than a
// handful of fixed strings, since hueFromString's hash can land anywhere
// in its curated bands.
describe("projectColor — hue bands never collide with the ERROR/WAITING badges", () => {
	function namesSample(): string[] {
		const names: string[] = [];
		for (let i = 0; i < 500; i++) names.push(`/repos/project-${i}`);
		names.push("/home/user/agentpulse", "/home/user/monarch", "/srv/k8s-home-lab");
		return names;
	}

	test("no project hue falls in the red/pink or amber bands", () => {
		for (const cwd of namesSample()) {
			const color = projectColor(cwd);
			expect(color).not.toBeNull();
			const hue = color?.hue as number;
			// Red/pink: a hue within 15 degrees of pure red (0/360) reads as
			// "red" next to the ERROR badge, regardless of direction around
			// the wheel.
			const distanceFromRed = Math.min(hue, 360 - hue);
			expect(distanceFromRed).toBeGreaterThan(15);
			// Amber: Tailwind's amber-500 (the WAITING badge) sits at ~38deg;
			// exclude the whole amber/orange band it belongs to.
			expect(hue < 20 || hue > 60).toBe(true);
		}
	});
});

describe("projectColor — cool hues only", () => {
	test("every project hue is between green and violet, so no tint reads as wine or red in dark mode", () => {
		const seen = new Set<number>();
		for (let i = 0; i < 2000; i++) {
			const hue = projectColor(`/repos/project-${i}`)?.hue as number;
			expect(hue).toBeGreaterThanOrEqual(100);
			expect(hue).toBeLessThanOrEqual(270);
			seen.add(Math.floor(hue / 10));
		}
		// Still a spread, not one shade.
		expect(seen.size).toBeGreaterThan(10);
	});
});

describe("projectColor — projects differ in more than hue", () => {
	const names = Array.from(
		{ length: 11 },
		(_, i) =>
			`/repos/service-${["api", "web", "docs", "infra", "mobile", "billing", "auth", "ml", "ops", "site", "kit"][i]}`,
	);

	test("eleven projects use every saturation and lightness step, not one wash in different hues", () => {
		const colors = names.map((cwd) => projectColor(cwd));
		expect(new Set(colors.map((c) => c?.satStep)).size).toBe(3);
		expect(new Set(colors.map((c) => c?.lightStep)).size).toBe(3);
	});

	test("no more than two of the eleven look alike (same hue family, saturation and lightness)", () => {
		const keys = names.map((cwd) => {
			const c = projectColor(cwd);
			return `${Math.floor((c?.hue ?? 0) / 20)}-${c?.satStep}-${c?.lightStep}`;
		});
		const counts = new Map<string, number>();
		for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
		expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
	});

	test("a project's tint is the same every time", () => {
		expect(projectColor("/repos/api")).toEqual(projectColor("/repos/api"));
	});
});

describe("canAcknowledgeSession", () => {
	test("unowned session: any viewer, auth enabled or not", () => {
		expect(canAcknowledgeSession({ ownerUserId: null }, null, false)).toBe(true);
		expect(canAcknowledgeSession({ ownerUserId: null }, "user-X", false)).toBe(true);
	});

	test("owned session: the owner may acknowledge", () => {
		expect(canAcknowledgeSession({ ownerUserId: "user-A" }, "user-A", false)).toBe(true);
	});

	test("owned session: a different viewer may not", () => {
		expect(canAcknowledgeSession({ ownerUserId: "user-A" }, "user-B", false)).toBe(false);
		expect(canAcknowledgeSession({ ownerUserId: "user-A" }, null, false)).toBe(false);
	});

	test("auth disabled: anyone may acknowledge, even a mismatched owner", () => {
		expect(canAcknowledgeSession({ ownerUserId: "user-A" }, "user-B", true)).toBe(true);
	});

	test("an admin's override is not part of this predicate: auto-acknowledge and mark-all stay owner-only", () => {
		expect(canAcknowledgeSession({ ownerUserId: "user-A" }, "user-B", false)).toBe(false);
	});

	test("an older server that sends no ownerUserId reads as unowned", () => {
		expect(canAcknowledgeSession({}, "user-B", false)).toBe(true);
	});
});

describe("explicitAckAccess (the single-session buttons)", () => {
	test("the owner, an unowned session and auth-disabled need no override", () => {
		expect(explicitAckAccess({ ownerUserId: "A" }, "A", false, false)).toEqual({
			allowed: true,
			forOwnerId: null,
		});
		expect(explicitAckAccess({ ownerUserId: null }, "B", false, false)).toEqual({
			allowed: true,
			forOwnerId: null,
		});
		expect(explicitAckAccess({}, "B", false, false)).toEqual({ allowed: true, forOwnerId: null });
		expect(explicitAckAccess({ ownerUserId: "A" }, "B", true, false)).toEqual({
			allowed: true,
			forOwnerId: null,
		});
	});

	test("an admin acting on someone else's session is allowed, and says whose it is", () => {
		expect(explicitAckAccess({ ownerUserId: "A" }, "B", false, true)).toEqual({
			allowed: true,
			forOwnerId: "A",
		});
	});

	test("an admin on their own session is just the owner", () => {
		expect(explicitAckAccess({ ownerUserId: "A" }, "A", false, true)).toEqual({
			allowed: true,
			forOwnerId: null,
		});
	});

	test("a member on someone else's session is refused", () => {
		expect(explicitAckAccess({ ownerUserId: "A" }, "B", false, false)).toEqual({
			allowed: false,
			forOwnerId: null,
		});
		expect(explicitAckAccess({ ownerUserId: "A" }, null, false, false).allowed).toBe(false);
	});
});
