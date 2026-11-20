/**
 * The pure decisions behind the update badge, banner, stale-tab line and the Updates panel. The components
 * render exactly what these return, so the rules (who sees what, in what colour, what a dismissal remembers)
 * are held here without a DOM.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RED_UPDATE_STATES } from "../../shared/update-status.js";
import { MEMBER_RED_COPY } from "../lib/update-notice-copy.js";
import { checkNoticeText, derivePanelView, isLoopbackBrowserHost } from "./update-panel-view.js";
import {
	type UpdateWire,
	bannerAnnouncement,
	deriveStaleTab,
	deriveUpdateBadge,
	deriveUpdateBanner,
	dismissBanner,
	dismissalKey,
	focusAfterBannerDismiss,
	focusAfterDismiss,
	isBannerDismissed,
	orderNotices,
} from "./update-view.js";

const status = (over: Partial<UpdateWire> = {}): UpdateWire => ({
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
	...over,
});
const admin = { adminSettingsLocked: false };
const member = { adminSettingsLocked: true };

describe("the badge", () => {
	test("an admin sees available as a quiet badge named with the version", () => {
		expect(deriveUpdateBadge(status(), admin)).toEqual({
			tone: "quiet",
			state: "available",
			text: "Update available",
			shortText: "Update",
			name: "Update available: 0.12.0",
		});
	});

	test("the visible words are inside the accessible name (label in name)", () => {
		for (const state of ["available", ...RED_UPDATE_STATES, "unverified"]) {
			const badge = deriveUpdateBadge(status({ state, lastResult: "bad_signature" }), admin);
			expect(
				(badge?.name ?? "").toLowerCase().includes((badge?.shortText ?? "x").toLowerCase()),
			).toBe(true);
			expect(badge).not.toBeNull();
			expect((badge?.name ?? "").startsWith(badge?.text ?? "x")).toBe(true);
		}
	});

	test("the three red states are red for an admin", () => {
		for (const state of RED_UPDATE_STATES) {
			expect(deriveUpdateBadge(status({ state }), admin)?.tone).toBe("red");
		}
	});

	test("a manifest that was fetched and failed verification is a quiet badge, never red", () => {
		for (const lastResult of [
			"bad_signature",
			"unknown_key",
			"bad_payload",
			"revoked_key",
			"bad_envelope",
		]) {
			const badge = deriveUpdateBadge(
				status({ state: "unverified", latest: null, lastResult: lastResult as never }),
				admin,
			);
			expect(badge?.tone).toBe("quiet");
			expect(badge?.name).toBe("Can't verify updates. Update by hand.");
			expect(badge?.shortText).toBe("Can't verify");
		}
	});

	test("nothing published, feed unreachable, never checked: no badge at all (the panel says it)", () => {
		for (const lastResult of ["not_published", "unreachable", null, "ok", undefined]) {
			expect(
				deriveUpdateBadge(
					status({ state: "unverified", latest: null, lastResult: lastResult as never }),
					admin,
				),
			).toBeNull();
		}
	});

	test("current, disabled and unknown show nothing", () => {
		for (const state of ["current", "disabled", "unknown", "from_the_future"]) {
			expect(deriveUpdateBadge(status({ state }), admin)).toBeNull();
		}
		expect(deriveUpdateBadge(null, admin)).toBeNull();
	});

	test("a member gets no quiet badge (available, unverified) but does get the red ones", () => {
		expect(deriveUpdateBadge(status({ state: "available" }), member)).toBeNull();
		expect(
			deriveUpdateBadge(status({ state: "unverified", lastResult: "bad_signature" }), member),
		).toBeNull();
		for (const state of RED_UPDATE_STATES) {
			expect(deriveUpdateBadge(status({ state }), member)?.tone).toBe("red");
		}
	});

	test("a latest that is not a release version is never put in a name", () => {
		const badge = deriveUpdateBadge(status({ latest: "0.12.0\n<b>x</b>" }), admin);
		expect(badge?.name).toBe("Update available");
	});
});

describe("the banner: red states only", () => {
	test("available, unverified, current and disabled have no banner", () => {
		for (const state of ["available", "unverified", "current", "disabled", "unknown"]) {
			expect(deriveUpdateBanner(status({ state }), admin)).toBeNull();
		}
	});

	test("an admin's banner says what is wrong, names the version and points at the Updates panel", () => {
		const banner = deriveUpdateBanner(status({ state: "security" }), admin);
		expect(banner).toMatchObject({ state: "security", howTo: true, latest: "0.12.0" });
		expect(banner?.text).toContain("security problem");
		expect(banner?.text).toContain("0.12.0");
	});

	test("a member's banner is the fixed member sentence for the state, with no command and no how-to", () => {
		for (const state of RED_UPDATE_STATES) {
			const banner = deriveUpdateBanner(status({ state }), member);
			expect(banner?.text).toBe(MEMBER_RED_COPY[state]);
			expect(banner?.howTo).toBe(false);
		}
	});

	test("both get the release notes link built from the version; a bad version gives none", () => {
		expect(deriveUpdateBanner(status({ state: "security" }), member)?.notesUrl).toBe(
			"https://github.com/jstuart0/agentpulse/releases/tag/v0.12.0",
		);
		expect(
			deriveUpdateBanner(status({ state: "security", latest: "x; y" }), member)?.notesUrl,
		).toBeNull();
	});
});

describe("dismissal is per session and keyed by state and version", () => {
	function storage() {
		const map = new Map<string, string>();
		return {
			map,
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
		};
	}

	test("the key is agentpulse.update.dismissed.<state>.<latest>", () => {
		expect(dismissalKey("security", "0.12.0")).toBe("agentpulse.update.dismissed.security.0.12.0");
		expect(dismissalKey("security", null)).toBe("agentpulse.update.dismissed.security.none");
	});

	test("dismissing hides the same state and version, and a new state or a new version shows again", () => {
		const s = storage();
		const view = deriveUpdateBanner(status({ state: "security" }), admin);
		if (!view) throw new Error("expected a banner");
		expect(isBannerDismissed(s, view)).toBe(false);
		dismissBanner(s, view);
		expect(isBannerDismissed(s, view)).toBe(true);
		const otherState = deriveUpdateBanner(status({ state: "below_minimum" }), admin);
		const otherVersion = deriveUpdateBanner(status({ state: "security", latest: "0.12.1" }), admin);
		if (!otherState || !otherVersion) throw new Error("expected banners");
		expect(isBannerDismissed(s, otherState)).toBe(false);
		expect(isBannerDismissed(s, otherVersion)).toBe(false);
	});

	test("storage that is missing or throws never hides a banner", () => {
		const view = deriveUpdateBanner(status({ state: "security" }), admin);
		if (!view) throw new Error("expected a banner");
		expect(isBannerDismissed(null, view)).toBe(false);
		const throwing = {
			getItem() {
				throw new Error("denied");
			},
			setItem() {
				throw new Error("denied");
			},
		};
		expect(isBannerDismissed(throwing, view)).toBe(false);
		expect(() => dismissBanner(throwing, view)).not.toThrow();
		expect(() => dismissBanner(null, view)).not.toThrow();
	});
});

describe("what a screen reader is told", () => {
	test("nothing on first load, even when the state is already red", () => {
		const banner = deriveUpdateBanner(status({ state: "security" }), admin);
		expect(bannerAnnouncement(null, banner)).toBeNull();
	});

	test("the announcement is the banner's text only when the state turns red during the session", () => {
		const banner = deriveUpdateBanner(status({ state: "security" }), admin);
		expect(bannerAnnouncement("available", banner)).toBe(banner?.text ?? "");
		expect(bannerAnnouncement("security", banner)).toBeNull();
		expect(bannerAnnouncement("available", null)).toBeNull();
	});
});

describe("focus after a dismissal", () => {
	test("goes to the first badge that is actually shown (offsetParent set), else the page heading", () => {
		const hidden = { offsetParent: null, id: "desktop" };
		const shown = { offsetParent: {}, id: "mobile" };
		const h1 = { offsetParent: {}, id: "h1" };
		expect(focusAfterDismiss([hidden, shown], h1)).toBe(shown);
		expect(focusAfterDismiss([shown, hidden], h1)).toBe(shown);
		expect(focusAfterDismiss([hidden, { ...hidden, id: "x" }], h1)).toBe(h1);
		expect(focusAfterDismiss([], h1)).toBe(h1);
	});
});

describe("focus after a dismissal, against a stand-in document", () => {
	const el = (id: string, shown: boolean) => {
		const attrs = new Map<string, string>();
		const node = {
			id,
			focused: false,
			offsetParent: shown ? {} : null,
			hasAttribute: (n: string) => attrs.has(n),
			setAttribute: (n: string, v: string) => void attrs.set(n, v),
			attrs,
			focus() {
				node.focused = true;
			},
		};
		return node;
	};
	const docWith = (badges: ReturnType<typeof el>[], h1: ReturnType<typeof el> | null) => ({
		querySelectorAll: () => badges,
		querySelector: () => h1,
	});

	test("the visible badge takes focus and gets no tabindex", () => {
		const desktop = el("d", false);
		const mobile = el("m", true);
		const h1 = el("h1", true);
		expect(focusAfterBannerDismiss(docWith([desktop, mobile], h1))).toBe(mobile);
		expect(mobile.focused).toBe(true);
		expect(mobile.attrs.has("tabindex")).toBe(false);
		expect(h1.focused).toBe(false);
	});

	test("with no visible badge the page heading takes focus and is made focusable with tabindex=-1", () => {
		const hidden = el("d", false);
		const h1 = el("h1", true);
		expect(focusAfterBannerDismiss(docWith([hidden], h1))).toBe(h1);
		expect(h1.focused).toBe(true);
		expect(h1.attrs.get("tabindex")).toBe("-1");
	});

	test("a heading that already has a tabindex keeps it; no heading and no badge focuses nothing", () => {
		const h1 = el("h1", true);
		h1.setAttribute("tabindex", "0");
		focusAfterBannerDismiss(docWith([], h1));
		expect(h1.attrs.get("tabindex")).toBe("0");
		expect(focusAfterBannerDismiss(docWith([], null))).toBeNull();
	});
});

describe("the stale-tab line", () => {
	test("shows when the server's version differs from the build this tab loaded", () => {
		expect(deriveStaleTab("0.12.0", "0.11.0")).toEqual({
			text: "AgentPulse is now running 0.12.0. Reload to use it.",
			reloadLabel: "Reload",
		});
	});

	test("never in a dev build, with no build version, with equal versions, or for a version that isn't one", () => {
		expect(deriveStaleTab("0.12.0", "dev")).toBeNull();
		expect(deriveStaleTab("0.12.0", undefined)).toBeNull();
		expect(deriveStaleTab("0.12.0", "0.12.0")).toBeNull();
		expect(deriveStaleTab(undefined, "0.11.0")).toBeNull();
		expect(deriveStaleTab("<b>0.12.0</b>", "0.11.0")).toBeNull();
	});

	test("it stacks before a red banner, since a reload may clear the red state", () => {
		const banner = deriveUpdateBanner(status({ state: "security" }), admin);
		const stale = deriveStaleTab("0.12.0", "0.11.0");
		expect(orderNotices({ staleTab: stale, banner })).toEqual(["stale_tab", "banner"]);
		expect(orderNotices({ staleTab: null, banner })).toEqual(["banner"]);
		expect(orderNotices({ staleTab: stale, banner: null })).toEqual(["stale_tab"]);
		expect(orderNotices({ staleTab: null, banner: null })).toEqual([]);
	});

	test("the places that read the build version are a known set, with the sidebar chip in it", () => {
		const root = new URL("..", import.meta.url).pathname;
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) {
					if (readFileSync(path, "utf8").includes("VITE_APP_VERSION"))
						found.push(path.slice(root.length));
				}
			}
		};
		walk(root);
		expect(found.length).toBeGreaterThanOrEqual(2);
		expect(found).toContain("components/Layout.tsx");
		expect(found.sort()).toEqual(
			["components/Layout.tsx", "components/UpdateNotices.tsx", "pages/SettingsPage.tsx"].sort(),
		);
	});
});

describe("the Updates panel", () => {
	const ctx = (over = {}) => ({
		adminSettingsLocked: false,
		effectiveRole: "admin" as const,
		disableAuth: false,
		hostname: "agentpulse.example.test",
		...over,
	});

	test("the local command is preceded by where to run it and followed by the recovery line", () => {
		const view = derivePanelView(status(), ctx());
		expect(view.command).toEqual([
			{ before: "Run this on the machine that runs the AgentPulse server." },
			{ before: "", command: "~/.agentpulse/bin/agentpulse update" },
			{ before: "If that command isn't there, re-run install-local.sh on that machine." },
		]);
	});

	test("a ref-track local install gets the branch sentence and no command, and never shows the ref", () => {
		const view = derivePanelView(status({ track: "ref" }), ctx());
		expect(view.command).toEqual([
			{
				before:
					"This install follows a branch, so it isn't updated for you. Re-run the installer without --ref to follow releases.",
			},
		]);
		expect(JSON.stringify(view)).not.toContain("main");
	});

	test("the container text has three lines, the third with the docker-compose.image.yml form", () => {
		const view = derivePanelView(status({ installKind: "container", track: null }), ctx());
		expect(view.command).toHaveLength(3);
		expect(view.command?.[1].command).toContain("docker-compose.image.yml");
		expect(view.command?.[1].command).toContain("AGENTPULSE_TAG=0.12.0");
	});

	test("kubernetes and source installs get their templates", () => {
		expect(
			derivePanelView(status({ installKind: "kubernetes", track: null }), ctx()).command,
		).toEqual([{ before: "Set both images (agentpulse and agentpulse-backup) to tag 0.12.0." }]);
		expect(
			derivePanelView(status({ installKind: "source", track: null }), ctx()).command?.[0].command,
		).toBe(
			"git fetch --tags && git checkout v0.12.0 && bun install --frozen-lockfile && bun run build",
		);
	});

	test("a member gets the admin-only notice in place of the command, and still the notes link", () => {
		const view = derivePanelView(
			status(),
			ctx({ adminSettingsLocked: true, effectiveRole: "member" }),
		);
		expect(view.command).toBeNull();
		expect(view.memberNotice).toBe("Only admins can change these settings.");
		expect(view.notesUrl).toBe("https://github.com/jstuart0/agentpulse/releases/tag/v0.12.0");
	});

	test("there is no command when no newer version is offered", () => {
		for (const state of ["current", "unverified", "disabled"]) {
			expect(derivePanelView(status({ state }), ctx()).command).toBeNull();
		}
		expect(derivePanelView(status({ state: "security" }), ctx()).command).not.toBeNull();
	});

	test("a stale manifest says it is out of date and when it was last published", () => {
		const view = derivePanelView(status({ stale: true }), ctx());
		expect(view.staleLine).toBe(
			"This update information is out of date (last published 2026-11-19).",
		);
		expect(derivePanelView(status({ stale: false }), ctx()).staleLine).toBeNull();
	});

	test("Check now: an admin sees it; a member doesn't; when the check is off, nobody does", () => {
		expect(derivePanelView(status(), ctx()).checkNow).toBe("button");
		expect(
			derivePanelView(status(), ctx({ effectiveRole: "member", adminSettingsLocked: true }))
				.checkNow,
		).toBe("hidden");
		expect(derivePanelView(status(), ctx({ effectiveRole: undefined })).checkNow).toBe("hidden");
		expect(derivePanelView(status({ state: "disabled" }), ctx()).checkNow).toBe("hidden");
	});

	test("under auth off, from a non-loopback host, Check now is replaced by the localhost line", () => {
		const view = derivePanelView(status(), ctx({ disableAuth: true, hostname: "192.168.1.5" }));
		expect(view.checkNow).toBe("localhost_only");
		expect(view.localhostLine).toBe(
			"Check now works only when you open AgentPulse on the server's own machine (localhost).",
		);
		expect(
			derivePanelView(status(), ctx({ disableAuth: true, hostname: "localhost" })).checkNow,
		).toBe("button");
		expect(derivePanelView(status(), ctx({ disableAuth: true, hostname: "[::1]" })).checkNow).toBe(
			"button",
		);
	});

	test("loopback host test is whole-name: nothing that merely starts with localhost", () => {
		for (const h of ["localhost", "127.0.0.1", "127.5.5.5", "[::1]", "::1"])
			expect(isLoopbackBrowserHost(h)).toBe(true);
		for (const h of ["localhost.evil.com", "127.0.0.1.nip.io", "192.168.1.5", "", "0.0.0.0"])
			expect(isLoopbackBrowserHost(h)).toBe(false);
	});

	test("the state sentence is the quiet unverified words for an install nothing can verify", () => {
		const view = derivePanelView(
			status({ state: "unverified", latest: null, lastResult: "bad_signature" }),
			ctx(),
		);
		expect(view.stateSentence).toBe("Can't verify updates. Update by hand.");
	});

	test("the rows are the latest release and when it was last checked (the running version is in Server Info)", () => {
		const view = derivePanelView(status(), ctx(), {
			ago: () => "3h ago",
			full: (iso) => `full ${iso}`,
		});
		expect(view.rows).toEqual([
			{ label: "Latest release", value: "0.12.0" },
			{ label: "Last checked", value: "3h ago", title: "full 2026-11-19T12:00:00.000Z" },
		]);
		expect(derivePanelView(status({ state: "mystery" }), ctx()).stateSentence).toBe(
			derivePanelView({ state: "unknown" }, ctx()).stateSentence,
		);
		expect(derivePanelView(null, ctx()).stateSentence.length).toBeGreaterThan(0);
	});

	test("localApply shows as its own rows, in the copy table's words, for an admin only", () => {
		const fmt = { ago: (iso: string) => `ago(${iso.slice(11, 16)})`, full: (iso: string) => iso };
		const withApply = (localApply: unknown) => status({ localApply: localApply as never });
		const view = derivePanelView(
			withApply({
				auto: true,
				lastOutcome: "supervisor_busy",
				lastTarget: "0.12.0",
				at: "2026-11-19T10:00:00.000Z",
				waitingSince: "2026-11-19T04:00:00.000Z",
				backoffUntil: "2026-11-19T16:00:00.000Z",
			}),
			ctx(),
			fmt,
		);
		expect(view.autoRows).toEqual([
			{ label: "Automatic updates", value: "On, on this machine" },
			{
				label: "Last update run",
				value: "This host's supervisor is busy with a session. (0.12.0) ago(10:00)",
				title: "2026-11-19T10:00:00.000Z",
			},
			{
				label: "Next automatic try",
				value: "not before 2026-11-19T16:00:00.000Z",
				title: "2026-11-19T16:00:00.000Z",
			},
			{ label: "Waiting since", value: "ago(04:00)", title: "2026-11-19T04:00:00.000Z" },
		]);
		// the rows are not part of the release rows
		expect(view.rows.map((r) => r.label)).toEqual(["Latest release", "Last checked"]);
		expect(derivePanelView(withApply({ auto: false }), ctx(), fmt).autoRows).toEqual([
			{ label: "Automatic updates", value: "Off" },
		]);
		// a made-up code gets the generic words, a made-up version is left out
		const odd = derivePanelView(
			withApply({ auto: true, lastOutcome: "zzz", lastTarget: "x; id" }),
			ctx(),
		);
		expect(odd.autoRows[1]?.value).toBe(
			"The updater reported something this page doesn't recognise.",
		);
		// no localApply (a member's view, an older server, a container): no rows; and none for a viewer locked out of admin settings
		expect(derivePanelView(withApply(null), ctx()).autoRows).toEqual([]);
		expect(derivePanelView(status(), ctx()).autoRows).toEqual([]);
		expect(
			derivePanelView(withApply({ auto: true }), ctx({ adminSettingsLocked: true })).autoRows,
		).toEqual([]);
	});

	test("an unverified install says why: not published, unreachable, never checked, or a real failure", () => {
		const say = (lastResult: unknown) =>
			derivePanelView(
				status({ state: "unverified", latest: null, lastResult: lastResult as never }),
				ctx(),
			).stateSentence;
		expect(say("not_published")).toBe(
			"No signed release information is available yet, so this server can't tell you about new versions.",
		);
		expect(say("unreachable")).toBe(
			"Couldn't reach the release feed, so this server can't tell you about new versions.",
		);
		expect(say(null)).toBe("Update information hasn't been checked yet.");
		for (const failure of ["bad_signature", "unknown_key", "bad_payload"]) {
			expect(say(failure)).toBe("Can't verify updates. Update by hand.");
		}
	});

	test("what Check now found is said in words: just now, feed unreachable, nothing published, refused, too soon", () => {
		expect(checkNoticeText("checked", "ok")).toBe("Checked just now.");
		expect(checkNoticeText("checked", "older")).toBe("Checked just now.");
		expect(checkNoticeText("checked", "unreachable")).toBe(
			"Couldn't reach the release feed. Showing the last verified information.",
		);
		expect(checkNoticeText("checked", "not_published")).toBe(
			"No signed release information is available yet, so this server can't tell you about new versions.",
		);
		expect(checkNoticeText("localhost_only", null)).toBe(
			"Check now works only when you open AgentPulse on the server's own machine (localhost).",
		);
		expect(checkNoticeText("rate_limited", null)).toBe(
			"Checked a moment ago. Try again in a minute.",
		);
		expect(checkNoticeText("failed", null)).toBe("Couldn't check just now. Try again later.");
		expect(checkNoticeText("none", "ok")).toBeNull();
	});

	test("an install kind the build doesn't know gives no command", () => {
		expect(derivePanelView(status({ installKind: "weird" as never }), ctx()).command).toBeNull();
	});

	test("the stale line says how long ago, from the injected formatter", () => {
		const view = derivePanelView(status({ stale: true }), ctx(), {
			ago: () => "11d ago",
			full: (i) => i,
		});
		expect(view.staleLine).toBe("This update information is out of date (last published 11d ago).");
	});
});
