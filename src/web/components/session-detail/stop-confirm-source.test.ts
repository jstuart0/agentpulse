/**
 * Static checks that the Stop confirmation is wired (AGEN-110). The harness has no DOM, so these read the
 * source: the hook test proves a tap that only calls `request` sends nothing, and these prove that is the
 * only thing every Stop control calls, and that the request itself is reachable only through the dialog's
 * confirm. A page that passed `performStop` to a button would pass the hook test and fail here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf-8");
const code = (rel: string) =>
	read(rel)
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
	}
	return out;
}

const page = code("pages/SessionDetailPage.tsx");

describe("every Stop control only opens the confirmation", () => {
	test("the header's onStop is the hook's request, never the request itself", () => {
		expect(page).toMatch(/onStop=\{stopConfirm\.request\}/);
		expect(page).not.toMatch(/onStop=\{(handleStop|performStop)\}/);
	});

	test("the stop request is made in one place, and the only caller of that place is the dialog's confirm", () => {
		const callers = walk(WEB).filter((file) =>
			/api\.stopSession\(/.test(readFileSync(file, "utf-8")),
		);
		expect(callers.map((file) => file.slice(WEB.length + 1))).toEqual([
			"pages/SessionDetailPage.tsx",
		]);
		expect(page.match(/api\.stopSession\(/g)).toHaveLength(1);
		expect(page.match(/performStop/g)).toHaveLength(2); // its declaration and the one confirm call
		expect(page).toMatch(/onConfirm=\{\(\) => void stopConfirm\.confirm\(performStop\)\}/);
	});

	test("the header and the overflow menu hold no request of their own", () => {
		for (const file of [
			"components/session-detail/SessionHeader.tsx",
			"components/session-detail/SessionOverflowMenu.tsx",
		]) {
			const source = code(file);
			expect(source).not.toMatch(/api\.stopSession|from "\.\.\/\.\.\/lib\/api\.js"/);
		}
	});
});

describe("the page's wiring of the dialog", () => {
	test("the dialog is rendered only while the hook says it is open, with the hook's busy and error", () => {
		expect(page).toMatch(/\{stopConfirm\.open && \(\s*<StopConfirmDialog/);
		expect(page).toMatch(/busy=\{stopConfirm\.busy\}/);
		expect(page).toMatch(/error=\{stopConfirm\.error\}/);
		expect(page).toMatch(/onCancel=\{stopConfirm\.cancel\}/);
	});

	test("the dialog's own words and weight are held by stop-confirm-dialog.test.ts, which calls the component", () => {
		const dialog = code("components/session-detail/StopConfirmDialog.tsx");
		expect(dialog).toMatch(/stopConfirmCopy\(session, fork\)/);
	});

	test("the hook is keyed by the session, so Back with the dialog open can't leave it over another one", () => {
		expect(page).toMatch(/useStopConfirm\(sessionId, focusLandingAfterRender\)/);
	});

	test("the dialog closes when Stop stops applying to the session", () => {
		expect(page).toMatch(/canStopSession\(session\)/);
		expect(page).toMatch(/stopConfirm\.cancel\(\)/);
	});
});

describe("while a stop is in flight, and when it fails", () => {
	test("the header gets the flag and the composer gets the line, both from the stop follower", () => {
		expect(page).toMatch(/stopping=\{stopFollow\.stopping\}/);
		expect(page).toMatch(/stoppingText=\{stopFollow\.stopping \? stoppingText\(session\) : null\}/);
	});

	test("the follower reads the control actions and speaks through the page's live region", () => {
		expect(page).toMatch(/useStopFollow\(\{[\s\S]*?announce: setLiveAnnouncement/);
	});

	test("a failed stop is a standing alert beside the composer", () => {
		expect(page).toMatch(
			/stopFollow\.failure !== null && <StopFailureAlert text=\{stopFollow\.failure\} \/>/,
		);
	});

	test("a confirmed stop is announced", () => {
		expect(page).toMatch(/setLiveAnnouncement\("Stopping…"\)/);
	});
});

describe("who is offered Stop", () => {
	test("the header is told whether the viewer may change the session, by the composer's own rule", () => {
		expect(page).toMatch(/mayStop=\{mayChangeSession\}/);
		expect(page).toMatch(/mayChangeSession = access\?\.canPrompt \?\? true/);
	});

	test("the overflow menu is given the agent's label", () => {
		const header = code("components/session-detail/SessionHeader.tsx");
		expect(header).toMatch(/stopLabel=\{stopControlLabel\(session\)\}/);
		expect(code("components/session-detail/SessionOverflowMenu.tsx")).toMatch(
			/label=\{stopLabel\}/,
		);
	});
});

describe("leaving the session while a stop is being confirmed", () => {
	test("the request is told whether the session is still the one on screen, and skips its aftermath when it isn't", () => {
		expect(page).toMatch(/async function performStop\(isCurrent: \(\) => boolean\)/);
		expect(page).toMatch(/if \(!isCurrent\(\)\) return null;\s*setLiveAnnouncement\("Stopping…"\)/);
	});

	test("a load that finishes for a session no longer shown is dropped", () => {
		expect(page).toMatch(/if \(shownSessionId\.current !== sessionId\) return;/);
	});
});

describe("saying it once", () => {
	test("the standing failure has no live role of its own (the live region speaks it)", () => {
		expect(code("components/session-detail/StopFailureAlert.tsx")).not.toMatch(/role=/);
	});

	test("the header's disabled Stop button carries no 'Stopping' sentence; the reason span is for blocked reasons only", () => {
		const header = code("components/session-detail/SessionHeader.tsx");
		expect(header).not.toMatch(/stoppingText/);
		expect(header).toMatch(/const stopDisabled = stopBlockedReason !== null \|\| stopping;/);
		expect(header).toMatch(/disabled=\{stopDisabled\}/);
	});

	test("the header takes a visible focus ring", () => {
		expect(code("components/session-detail/SessionHeader.tsx")).toMatch(
			/id="session-header"[\s\S]*?focus-visible:ring-2/,
		);
	});
});

describe("the overflow menu on a phone", () => {
	test("Stop is shown disabled with its reason (not hidden), like the desktop button", () => {
		const header = code("components/session-detail/SessionHeader.tsx");
		expect(header).toMatch(/canStop=\{canStop\}/);
		expect(header).toMatch(/stopDisabledReason=\{stopBlockedReason\}/);
		const menu = code("components/session-detail/SessionOverflowMenu.tsx");
		expect(menu).toMatch(/disabled=\{stopDisabledReason !== null \|\| stopping\}/);
		expect(menu).toMatch(/disabledReason=\{stopDisabledReason\}/);
	});
});
