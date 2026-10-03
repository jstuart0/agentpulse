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
			fieldLabel: "Host",
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
			fieldLabel: "Reported host",
		});
		expect(label?.title.toLowerCase()).toContain("reported");
		expect(label?.title.toLowerCase()).toContain("not verified");
		expect(label?.srText).toBe("Reported machine: alice-mbp");
	});

	test("a list row (no managed session loaded) uses the reported host", () => {
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
