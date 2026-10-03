import { describe, expect, test } from "bun:test";
import { sessionHostLabel } from "./session-host.js";

describe("sessionHostLabel", () => {
	test("a supervisor-launched session shows its supervisor's host, ahead of anything reported", () => {
		const label = sessionHostLabel({
			managedSession: { hostName: "build-01" },
			reportedHost: "some-laptop",
		});
		expect(label).toMatchObject({
			source: "supervisor",
			name: "build-01",
			text: "on build-01",
			fieldLabel: "Machine",
		});
		expect(label?.title).toContain("build-01");
		expect(label?.title).not.toContain("some-laptop");
	});

	test("an observed session shows the machine that reported it, and says it is reported", () => {
		const label = sessionHostLabel({ managedSession: null, reportedHost: "alice-mbp" });
		expect(label).toMatchObject({
			source: "reported",
			name: "alice-mbp",
			text: "on alice-mbp",
			fieldLabel: "Reported machine",
		});
		expect(label?.title.toLowerCase()).toContain("reported");
		expect(label?.title.toLowerCase()).toContain("not verified");
		expect(label?.srText).toBe("Reported machine: alice-mbp");
	});

	test("a list row from an older server (no machine field, no managed session) uses the reported host", () => {
		expect(sessionHostLabel({ reportedHost: "box" })?.text).toBe("on box");
	});

	test("nothing to show when nothing is known", () => {
		expect(sessionHostLabel({})).toBeNull();
		expect(sessionHostLabel({ managedSession: null, reportedHost: null })).toBeNull();
		expect(
			sessionHostLabel({ managedSession: { hostName: null }, reportedHost: undefined }),
		).toBeNull();
	});

	test("a blank supervisor host falls through to the reported one; blank values are nothing", () => {
		expect(
			sessionHostLabel({ managedSession: { hostName: "  " }, reportedHost: "box" })?.name,
		).toBe("box");
		expect(sessionHostLabel({ reportedHost: "   " })).toBeNull();
	});

	test("the name is plain text: markup is not interpreted or altered", () => {
		const label = sessionHostLabel({ reportedHost: "<b>x</b>" });
		expect(label?.name).toBe("<b>x</b>");
		expect(label?.text).toBe("on <b>x</b>");
	});
});

describe("sessionHostLabel on a row that carries the server's machine", () => {
	test("a supervisor-launched session's card shows its supervisor's host, the one the filter and grouping use", () => {
		const label = sessionHostLabel({ machine: "build-01", reportedHost: "some-laptop" });
		expect(label).toMatchObject({ source: "supervisor", name: "build-01", text: "on build-01" });
		expect(label?.title).not.toContain("some-laptop");
	});

	test("when the machine is the reported name, it is labelled as reported", () => {
		const label = sessionHostLabel({ machine: "alice-mbp", reportedHost: "  alice-mbp " });
		expect(label).toMatchObject({ source: "reported", name: "alice-mbp" });
	});

	test("a supervisor host with nothing reported is still the supervisor's", () => {
		expect(sessionHostLabel({ machine: "edge-02", reportedHost: null })?.source).toBe("supervisor");
	});

	test("no machine means no label, even if a stale reported name is still on the row", () => {
		expect(sessionHostLabel({ machine: null, reportedHost: "stale" })).toBeNull();
		expect(sessionHostLabel({ machine: "  ", reportedHost: null })).toBeNull();
	});

	test("the label always names what the filter would select: a name, trimmed, or nothing", () => {
		for (const machine of ["build-01", "  build-01  ", null, "", "  "]) {
			const label = sessionHostLabel({ machine, reportedHost: "other" });
			expect(label?.name ?? null).toBe(machine?.trim() || null);
		}
	});

	test("the detail view's loaded managed session still wins over a machine carried on the row", () => {
		const label = sessionHostLabel({
			managedSession: { hostName: "detail-host" },
			machine: "row-host",
			reportedHost: "r",
		});
		expect(label?.name).toBe("detail-host");
	});
});

describe("one term for a machine, everywhere a session names it", () => {
	test("the field labels and the screen-reader text say machine, never host, for both sources", () => {
		const supervisor = sessionHostLabel({ managedSession: { hostName: "build-01" } });
		const reported = sessionHostLabel({ reportedHost: "alice-mbp" });
		expect(supervisor?.fieldLabel).toBe("Machine");
		expect(supervisor?.srText).toBe("Machine: build-01");
		expect(reported?.fieldLabel).toBe("Reported machine");
		expect(reported?.srText).toBe("Reported machine: alice-mbp");
		for (const label of [supervisor, reported]) {
			expect(`${label?.fieldLabel} ${label?.srText}`.toLowerCase()).not.toContain("host");
		}
	});

	test("a supervisor host that is also what was reported is the supervisor's: it is not 'reported, not verified'", () => {
		const label = sessionHostLabel({
			managedSession: { hostName: "build-01" },
			reportedHost: "build-01",
		});
		expect(label?.source).toBe("supervisor");
		expect(label?.fieldLabel).toBe("Machine");
		expect(label?.title.toLowerCase()).not.toContain("not verified");
	});
});
