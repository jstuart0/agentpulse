/**
 * Static checks on the take-over card and its dialog (AGEN-115). The harness has no DOM, so these read the
 * source: they show a prop or a class is written, not that the element on screen is right. The arming
 * behaviour itself (a tap before 700 ms does nothing, the button looks disabled) is tested in
 * ConfirmDialog's own tests, where it is driven, and is cited here rather than repeated.
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

const FEATURE = [
	"components/session-detail/SessionTakeoverCard.tsx",
	"components/session-detail/session-takeover-view.ts",
	"components/session-detail/takeover-card-view.ts",
];
const card = code("components/session-detail/SessionTakeoverCard.tsx");

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
	}
	return out;
}

describe("the take-over dialog", () => {
	test("it arms after 700 ms and focuses Cancel first (weak: a source read; the behaviour is driven in hooks/useArmedAfter.test.ts)", () => {
		expect(card).toMatch(/armAfterMs=\{700\}/);
		expect(card).toMatch(/\bfocusCancel\b/);
		expect(read("hooks/useArmedAfter.test.ts")).toMatch(
			/starts unarmed, stays unarmed before the time, and arms after it/,
		);
		expect(read("components/ConfirmDialog.tsx")).toMatch(/useArmedAfter\(armAfterMs\)/);
	});

	test("focus has somewhere to land if the opener is gone: the slot", () => {
		expect(card).toMatch(/fallbackFocusId=\{TAKEOVER_SLOT_ID\}/);
		expect(card).toMatch(/tabIndex=\{-1\}/);
	});

	test("the fields are outside the description region", () => {
		expect(card).toMatch(/fields=\{/);
		const dialog = read("components/ConfirmDialog.tsx");
		expect(dialog).toMatch(/fields\?: ReactNode/);
	});

	test("only a 202 closes it: a refusal goes to the dialog's error and keeps the choice", () => {
		expect(card).toMatch(/error=\{/);
		expect(card).toMatch(/bindRefusalMessage/);
	});

	test("the select is 16px on a phone", () => {
		expect(card).toContain("text-base md:text-sm");
	});
});

describe("the feature's own code", () => {
	test("reaches the server only through api.ts: no fetch, no XMLHttpRequest", () => {
		for (const rel of FEATURE) {
			const src = code(rel);
			expect(src).not.toMatch(/\bfetch\(/);
			expect(src).not.toMatch(/XMLHttpRequest/);
		}
		expect(card).toMatch(/api\.bindSession/);
		expect(code("components/session-detail/SessionPromptComposer.tsx")).toMatch(
			/api\.resumeSession/,
		);
	});

	test("the machine list is built from hosts alone: the session's reported machine never filters or preselects", () => {
		const view = code("components/session-detail/takeover-card-view.ts");
		const start = view.indexOf("export function bindableHosts");
		const body = view.slice(start, view.indexOf("\n}\n", start));
		expect(start).toBeGreaterThan(0);
		expect(body).not.toMatch(/reportedHost|\.machine\b/);
		// And nothing in the card chooses a host for the person: the state starts empty and only onChange sets it.
		expect(card).toMatch(/useState\(""\)/);
		expect(card).not.toMatch(/setHostId\((?!""|id\))/);
	});

	test("never compares the instance mode: that is ownership-ui.ts's alone", () => {
		for (const rel of FEATURE) {
			expect(code(rel)).not.toMatch(/mode\s*===\s*["']team["']|mode\s*!==\s*["']team["']/);
			expect(code(rel)).not.toMatch(/useUserStore\(\(s\)\s*=>\s*s\.mode\)/);
		}
	});

	test("draws no markup from text it was handed", () => {
		for (const rel of FEATURE) {
			expect(code(rel)).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/);
			expect(code(rel)).not.toMatch(/MarkdownContent/);
		}
	});

	test("'bind' never reaches a string a person reads", () => {
		const strings = FEATURE.flatMap((rel) =>
			(code(rel).match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []).map((s) => s),
		);
		for (const s of strings) {
			if (!/[A-Za-z]{3,} [A-Za-z]{2,}/.test(s)) continue;
			expect(s.toLowerCase()).not.toMatch(/\bbind(ing)?\b|\bbound\b/);
		}
	});

	test("the lazy chunk and the page: the card is imported by the page and by no other page", () => {
		const users = walk(WEB).filter((f) => /SessionTakeoverCard/.test(readFileSync(f, "utf-8")));
		const names = users.map((f) => f.slice(WEB.length + 1));
		for (const name of names) {
			expect(
				name === "pages/SessionDetailPage.tsx" || name.startsWith("components/session-detail/"),
			).toBe(true);
		}
	});
});
