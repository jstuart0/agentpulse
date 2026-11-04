/**
 * Static checks on the Codex approval card (AGEN-87). The harness has no DOM, so these read the
 * source: they can show a class or a prop is written, not that the element on screen is right.
 * The pinned facts are the ones whose loss would be silent: wrapping (without it a long command
 * runs past the edge of a phone: scrollWidth 2539 against clientWidth 260), the safe default focus
 * of the confirm step, no markup built from agent text, and a lazy chunk.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf-8");

const FEATURE_FILES = [
	"components/session-detail/CodexApprovalCard.tsx",
	"components/session-detail/codex-approval-view.ts",
	"hooks/useCodexApprovals.ts",
	"lib/approval-errors.ts",
	"lib/codex-approval-wait.ts",
	"lib/codex-approvals-api.ts",
];

function code(rel: string): string {
	return read(rel)
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
	}
	return out;
}

const card = code("components/session-detail/CodexApprovalCard.tsx");

describe("the card draws agent text as text", () => {
	test("every pre wraps: whitespace-pre-wrap break-words", () => {
		expect(card).toMatch(/const PRE_CLASS =\s*"[^"]*whitespace-pre-wrap break-words/);
		const pres = card.match(/<pre\b[^>]*>/g) ?? [];
		const withClass = (card.match(/<pre\b[\s\S]*?className=\{`\$\{PRE_CLASS\}/g) ?? []).length;
		expect(pres.length).toBeGreaterThanOrEqual(3);
		expect(withClass).toBe(pres.length);
	});

	test("a scrollable command is reachable by keyboard and named", () => {
		expect(card).toMatch(/<pre[^>]*tabIndex=\{0\}[^>]*aria-label="Command"/);
		expect(card).toMatch(/aria-label=\{`Changes to \$\{change\.path\}`\}/);
	});

	test("no markup is built from agent text: no innerHTML, no Markdown renderer, no auto-linking", () => {
		for (const rel of FEATURE_FILES) {
			const c = code(rel);
			expect(c, rel).not.toMatch(
				new RegExp(
					["dangerously" + "SetInnerHTML", "inner" + "HTML", "insertAdjacent" + "HTML"].join("|"),
				),
			);
			expect(c, rel).not.toMatch(
				/MarkdownContent|react-markdown|\bmarked\b|remark|rehype|linkify/i,
			);
			expect(c, rel).not.toMatch(/<a\b|href=/);
		}
	});

	test("an approvable command has no collapse: the cut applies to a request that can only be declined", () => {
		expect(card).toMatch(/const cut = capped && !expanded/);
		expect(card).toMatch(/capped=\{state === "not_approvable"\}/);
	});
});

describe("answering", () => {
	test("both confirm dialogs focus Cancel first", () => {
		const dialogs = card.match(/<ConfirmDialog\b[\s\S]*?>/g) ?? [];
		expect(dialogs).toHaveLength(2);
		for (const d of dialogs) expect(d).toMatch(/\bfocusCancel\b/);
	});

	test("the confirm button is disabled by a mid-confirm event, and the reason is shown through the dialog's error", () => {
		expect(card).toMatch(/confirmDisabled=\{event !== null\}/);
		expect(card).toMatch(/error=\{view\?\.text \?\? dialog\.error\}/);
	});

	test("an accept's hash is the frozen one, from the version the confirm opened on", () => {
		expect(card).toMatch(/decisionBody\(decision, frozen\)/);
		expect(card).toMatch(/freezeConfirm\(loaded\)/);
		expect(card).not.toMatch(/presentationHash:\s*current/);
	});

	test("Approve is drawn only when the whole request for this version is loaded", () => {
		expect(card).toMatch(/offers\.approve && detail\s*\?/);
	});

	test("no keyboard shortcut approves", () => {
		for (const rel of FEATURE_FILES) {
			expect(code(rel), rel).not.toMatch(
				/onKeyDown|onKeyUp|onKeyPress|accessKey|addEventListener\("key/,
			);
		}
	});

	test("errors are not shown as a toast beside an announcement", () => {
		for (const rel of FEATURE_FILES) expect(code(rel), rel).not.toMatch(/\btoast\b|sonner/);
	});
});

describe("the error table", () => {
	test("is not registered in the global table, where expired and already_resolved already carry the watcher's words", () => {
		for (const rel of FEATURE_FILES) {
			expect(code(rel), rel).not.toMatch(/registerApiErrorMessages/);
		}
	});

	test("is an exhaustive Record over the server's refusal codes", () => {
		expect(code("lib/approval-errors.ts")).toMatch(
			/const ERROR_COPY: Record<ApprovalErrorCode, \(ctx: ErrorCtx\) => string>/,
		);
	});
});

describe("the chunk", () => {
	test("the page loads the card with lazy() and nothing imports it statically", () => {
		const page = read("pages/SessionDetailPage.tsx");
		expect(page).toMatch(
			/const CodexApprovalCard = lazy\(\(\) =>\s*import\("[^"]*CodexApprovalCard\.js"\)/,
		);
		for (const file of walk(WEB)) {
			const text = readFileSync(file, "utf-8");
			const staticImport = /^import[^;]*from\s+"[^"]*CodexApprovalCard\.js"/m.test(text);
			expect(staticImport, file).toBe(false);
		}
	});

	test("a chunk that fails to load says so when Codex is asking, and only then", () => {
		const page = read("pages/SessionDetailPage.tsx");
		expect(page).toMatch(/\.catch\(\(\) =>/);
		expect(page).toMatch(/hasPendingCodexApproval\(session\) \?/);
		expect(page).toMatch(/CHUNK_LOAD_FAILED_COPY/);
	});

	test("the person routes are called from the hook and the card, nowhere else", () => {
		const users = walk(WEB).filter((f) =>
			/codex-approvals-api\.js"/.test(readFileSync(f, "utf-8")),
		);
		expect(users.map((f) => f.slice(WEB.length + 1)).sort()).toEqual([
			"components/session-detail/CodexApprovalCard.tsx",
			"hooks/useCodexApprovals.ts",
		]);
	});

	test("only the lazy chunk reads the heavy modules: the shared lib stays small", () => {
		const wait = code("lib/codex-approval-wait.ts");
		expect(wait).not.toMatch(/from "react"|api\.js|codex-approval-view/);
	});
});

describe("no example names", () => {
	const EXAMPLES =
		/\b(alice|bob|carol|dave|eve|mallory|jay|jstuart|macbook|mac-mini|my-laptop|laptop-\d|host-[a-z0-9]|example\.(com|org))\b/i;
	test("the feature's files carry {host} and {owner} only as fields, never as a sample name", () => {
		for (const rel of FEATURE_FILES) expect(read(rel), rel).not.toMatch(EXAMPLES);
	});
	test("nor does the card's pending-approval note", () => {
		expect(read("pages/dashboard-view-state.ts")).not.toMatch(/codex[^\n]*\b(alice|bob)\b/i);
	});
});
