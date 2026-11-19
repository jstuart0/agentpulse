/**
 * The update badge, notices, panel and host notice as markup: accessible names, the 44px target, no
 * role="alert" on load, the sr-only output, links that leave the app, and colour that never carries the
 * meaning alone. Each component has a presentational view that takes what update-view.ts derives; a static
 * render never sees a zustand store's live state (it reads the initial one), so the views are what is rendered
 * here and the store-reading connectors are held by the wiring checks below.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SupervisorRecord } from "../../shared/types.js";
import { HostUpdateNotice } from "./HostUpdateNotice.js";
import { UpdateBadgeLink } from "./UpdateBadge.js";
import { UpdateNoticesView } from "./UpdateNotices.js";
import { UpdatesPanelView } from "./settings/UpdatesPanel.js";
import { derivePanelView } from "./update-panel-view.js";
import {
	type UpdateWire,
	deriveStaleTab,
	deriveUpdateBadge,
	deriveUpdateBanner,
} from "./update-view.js";

const STATUS: UpdateWire = {
	current: "0.11.0",
	latest: "0.12.0",
	state: "available",
	stale: false,
	severity: "normal",
	checkedAt: "2026-11-19T12:00:00.000Z",
	lastResult: "ok",
	manifestIssuedAt: "2026-11-19T11:00:00.000Z",
	installKind: "local",
	track: "release",
	localApply: null,
};

let viewerKind: "admin" | "member" | "solo" = "solo";
let wire: UpdateWire = { ...STATUS };
let disableAuth = false;
function setViewer(kind: "admin" | "member" | "solo") {
	viewerKind = kind;
}
const setStatus = (over: Record<string, unknown> = {}) => {
	wire = { ...STATUS, ...over } as UpdateWire;
};
const viewer = () => ({ adminSettingsLocked: viewerKind === "member" });

const inRouter = (node: ReturnType<typeof createElement>) =>
	renderToStaticMarkup(createElement(MemoryRouter, null, node));

beforeEach(() => {
	setViewer("solo");
	setStatus();
	disableAuth = false;
});
afterEach(() => setViewer("solo"));

const badgeHtml = (surface: "desktop" | "mobile") => {
	const badge = deriveUpdateBadge(wire, viewer());
	return badge ? inRouter(createElement(UpdateBadgeLink, { badge, surface })) : "";
};

describe("UpdateBadge", () => {
	test("available: a link to the Updates panel, named with the version, a 44px target, an icon screen readers skip", () => {
		setStatus();
		const html = badgeHtml("desktop");
		expect(html).toContain('href="/settings?panel=updates"');
		expect(html).toContain('aria-label="Update available: 0.12.0"');
		expect(html).toContain("min-h-[44px]");
		expect(html).toContain("min-w-[44px]");
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain("Update available");
		expect(html).toContain('data-update-badge="desktop"');
		expect(html).not.toContain("text-red");
	});

	test("the three red states use the red pair and say so in words", () => {
		for (const state of ["security", "current_pulled", "below_minimum"]) {
			setStatus({ state });
			const html = badgeHtml("mobile");
			expect({ state, red: html.includes("text-red-800 dark:text-red-300") }).toEqual({
				state,
				red: true,
			});
			expect(html).toContain("bg-red-500/10");
			expect(html).toContain('data-update-badge="mobile"');
		}
	});

	test("unverified is the quiet 'Can't verify updates. Update by hand.', never red", () => {
		setStatus({ state: "unverified", latest: null });
		const html = badgeHtml("desktop");
		expect(html).toContain("Can&#x27;t verify updates. Update by hand.");
		expect(html).not.toMatch(/red|amber/);
	});

	test("nothing at all for current, and for a member's quiet states", () => {
		setStatus({ state: "current" });
		expect(badgeHtml("desktop")).toBe("");
		setViewer("member");
		setStatus({ state: "available" });
		expect(badgeHtml("desktop")).toBe("");
		setStatus({ state: "security" });
		expect(badgeHtml("desktop")).toContain("Security update");
	});

	test("nothing before the first answer", () => {
		wire = null as never;
		expect(badgeHtml("desktop")).toBe("");
	});
});

describe("UpdateNotices: the red banner and the stale-tab line", () => {
	const render = (buildVersion?: string) =>
		inRouter(
			createElement(UpdateNoticesView, {
				staleTab: deriveStaleTab(wire.current, buildVersion),
				banner: deriveUpdateBanner(wire, viewer()),
				announcement: "",
				onDismiss: () => {},
			}),
		);

	test("a red state is a labelled region with a dismiss button, and never role=alert", () => {
		setStatus({ state: "security" });
		const html = render("0.11.0");
		expect(html).toContain('aria-label="Update notice"');
		expect(html).toContain('aria-label="Dismiss update notice for this session"');
		expect(html).not.toContain('role="alert"');
		expect(html).toContain("min-h-[44px]");
		expect(html).toContain("text-red-800 dark:text-red-300");
		expect(html).toContain("bg-red-500/10");
	});

	test("it carries a sr-only output that is empty on load", () => {
		setStatus({ state: "security" });
		const html = render("0.11.0");
		expect(html).toMatch(/<output[^>]*class="[^"]*sr-only[^"]*"[^>]*><\/output>/);
	});

	test("an admin is pointed at the Updates panel; a member gets the fixed sentence and no command", () => {
		setStatus({ state: "security" });
		expect(render("0.11.0")).toContain('href="/settings?panel=updates"');
		setViewer("member");
		const html = render("0.11.0");
		expect(html).toContain(
			"The server is running a version with a known security problem. An admin needs to update it.",
		);
		expect(html).not.toContain("agentpulse update");
		expect(html).not.toContain("/settings?panel=updates");
	});

	test("the notes link leaves the app safely and says where it goes", () => {
		setStatus({ state: "security" });
		const html = render("0.11.0");
		expect(html).toContain('href="https://github.com/jstuart0/agentpulse/releases/tag/v0.12.0"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noreferrer"');
		expect(html).toContain("(GitHub)");
	});

	test("the quiet states have no banner", () => {
		for (const state of ["available", "unverified", "current", "disabled"]) {
			setStatus({ state, current: "0.11.0" });
			expect({ state, html: render("0.11.0") }).toEqual({ state, html: "" });
		}
	});

	test("the stale-tab line is role=status with a Reload button, when the server's version differs from this build's", () => {
		setStatus({ state: "current", current: "0.12.0" });
		const html = render("0.11.0");
		expect(html).toContain('role="status"');
		expect(html).toContain("AgentPulse was updated to 0.12.0. Reload to use the new version.");
		expect(html).toMatch(/<button[^>]*type="button"[^>]*>Reload<\/button>/);
		expect(html).toContain("min-h-[44px]");
	});

	test("no stale-tab line in a dev build, or when the versions match", () => {
		setStatus({ state: "current", current: "0.12.0" });
		expect(render("dev")).toBe("");
		expect(render("0.12.0")).toBe("");
		expect(render(undefined)).toBe("");
	});

	test("both together: the stale-tab line first, then the red banner", () => {
		setStatus({ state: "security", current: "0.12.0" });
		const html = render("0.11.0");
		expect(html.indexOf("AgentPulse was updated")).toBeGreaterThan(-1);
		expect(html.indexOf("AgentPulse was updated")).toBeLessThan(
			html.indexOf('aria-label="Update notice"'),
		);
	});

	test("text from the status is never rendered as markup", () => {
		setStatus({ state: "security", latest: "<img src=x onerror=alert(1)>" });
		const html = render("0.11.0");
		expect(html).not.toContain("<img");
	});
});

describe("UpdatesPanel", () => {
	const render = (
		hostname = "agentpulse.example.test",
		notice: "none" | "rate_limited" | "failed" = "none",
	) =>
		inRouter(
			createElement(UpdatesPanelView, {
				view: derivePanelView(wire, {
					adminSettingsLocked: viewerKind === "member",
					effectiveRole: viewerKind === "member" ? "member" : "admin",
					disableAuth,
					hostname,
				}),
				checking: false,
				notice,
				onCheck: () => {},
			}),
		);

	test("rows, the state sentence and the local command with its framing lines, as text", () => {
		setStatus();
		const html = render();
		expect(html).toContain("0.11.0");
		expect(html).toContain("0.12.0");
		expect(html).toContain("Run this on the machine that runs the AgentPulse server.");
		expect(html).toContain("~/.agentpulse/bin/agentpulse update");
		expect(html).toContain(
			"If that command isn&#x27;t there, re-run install-local.sh on that machine.",
		);
		expect(html).toContain("Copy command");
		expect(html).toMatch(/<output[^>]*class="[^"]*sr-only/);
	});

	test("the notes link is marked (GitHub) and opens a new tab without a referrer", () => {
		setStatus();
		const html = render();
		expect(html).toContain('href="https://github.com/jstuart0/agentpulse/releases/tag/v0.12.0"');
		expect(html).toContain("(GitHub)");
		expect(html).toContain('rel="noreferrer"');
	});

	test("Check now is a 44px button for an admin; the localhost line replaces it under auth off from another host", () => {
		setStatus();
		expect(render()).toMatch(/<button[^>]*>Check now<\/button>/);
		expect(render()).toContain("min-h-[44px]");
		disableAuth = true;
		const remote = render("192.168.1.5");
		expect(remote).not.toContain("Check now");
		expect(remote).toContain("Run the check from this machine (localhost).");
		expect(render("localhost")).toContain("Check now");
	});

	test("a member sees the admin-only notice and no command and no Check now", () => {
		setViewer("member");
		setStatus();
		const html = render();
		expect(html).toContain("Only admins can change these settings.");
		expect(html).not.toContain("agentpulse update");
		expect(html).not.toContain("Check now");
	});

	test("stale says so, with when it was last published", () => {
		setStatus({ stale: true });
		expect(render()).toContain(
			"This update information is out of date (last published 2026-11-19).",
		);
	});

	test("unverified: the quiet words and no command", () => {
		setStatus({ state: "unverified", latest: null });
		const html = render();
		expect(html).toContain("Can&#x27;t verify updates. Update by hand.");
		expect(html).not.toContain("agentpulse update");
		expect(html).not.toMatch(/text-red/);
	});

	test("a latest that isn't a release version produces no command and no link", () => {
		setStatus({ latest: "0.12.0; rm -rf /" });
		const html = render();
		expect(html).not.toContain("rm -rf");
		expect(html).not.toContain("releases/tag");
	});

	test("a refused or failed Check now says so in words, in a status element", () => {
		setStatus();
		expect(render("agentpulse.example.test", "rate_limited")).toContain(
			"Checked a moment ago. Try again in a minute.",
		);
		expect(render("agentpulse.example.test", "failed")).toContain(
			"Couldn&#x27;t check just now. Try again later.",
		);
		expect(render()).toMatch(/<output[^>]*class="[^"]*text-muted-foreground[^"]*"[^>]*><\/output>/);
	});

	test("the panel has its anchor id and a heading", () => {
		setStatus();
		const html = render();
		expect(html).toContain('id="settings-updates"');
		expect(html).toContain("<h2");
	});
});

describe("HostUpdateNotice", () => {
	const host = (version: string, features: string[] = [], hostName = "build-01") =>
		({
			id: "h1",
			hostName,
			version,
			enrollmentState: "active",
			capabilities: { features },
		}) as unknown as SupervisorRecord;
	const render = (h: SupervisorRecord, canManage = true) =>
		renderToStaticMarkup(
			createElement(HostUpdateNotice, {
				supervisor: h,
				server: { current: "0.12.0", state: "current" },
				canManage,
			}),
		);

	test("with local_updater: the command in code and the host name as plain text", () => {
		const html = render(host("0.11.0", ["local_updater"]));
		expect(html).toContain("<code");
		expect(html).toContain("~/.agentpulse/bin/agentpulse update");
		expect(html).toContain("build-01");
		expect(html).toMatch(/<output[^>]*class="[^"]*sr-only/);
	});

	test("a hostile host name is escaped", () => {
		const html = render(host("0.11.0", ["local_updater"], "<img src=x>"));
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	test("nothing when up to date or when the viewer can't manage the host", () => {
		expect(render(host("0.12.0"))).toBe("");
		expect(render(host("0.11.0"), false)).toBe("");
	});

	test("no red: a host that is behind is a notice, not an alarm", () => {
		expect(render(host("0.11.0", ["local_updater"]))).not.toContain("red");
	});
});

describe("the connectors are wired into the pages", () => {
	const root = new URL("..", import.meta.url).pathname;
	const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

	test("Layout mounts the sync, the notices and the mobile badge; TopBar has the desktop one", () => {
		const layout = read("components/Layout.tsx");
		expect(layout).toContain("useUpdateSync()");
		expect(layout).toContain("<UpdateNotices");
		expect(layout).toContain('<UpdateBadge surface="mobile"');
		expect(read("components/TopBar.tsx")).toContain('<UpdateBadge surface="desktop"');
	});

	test("Settings has the Updates panel and the host notice; the Hosts page shows the host notice", () => {
		const settings = read("pages/SettingsPage.tsx");
		expect(settings).toContain("<UpdatesPanel");
		expect(settings).toContain("<HostUpdateNotice");
		expect(read("pages/HostsPage.tsx")).toContain("<HostUpdateNotice");
	});

	test("every connector reads the status through the store, never fetches on its own", () => {
		for (const file of [
			"components/UpdateBadge.tsx",
			"components/UpdateNotices.tsx",
			"components/settings/UpdatesPanel.tsx",
		]) {
			const text = read(file);
			expect(text).toContain("useUpdateStore");
			expect(text).not.toMatch(/\bfetch\(|api\.getCapabilities/);
		}
	});
});
