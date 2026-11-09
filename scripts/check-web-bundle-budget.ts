#!/usr/bin/env bun
/**
 * AGEN-69: the web bundle must not grow without someone deciding it should.
 *
 *   bun run build && bun scripts/check-web-bundle-budget.ts
 *   bun scripts/check-web-bundle-budget.ts --scale 0.5     # self-test: must exit non-zero
 *   bun scripts/check-web-bundle-budget.ts --dir <assets>  # check another build's assets
 *
 * Limits are gzipped bytes of the built chunks, set from what the build measured at the end of
 * phase 8 plus modest headroom. Base (before the Summary work): SessionDetailPage 19,952,
 * DashboardPage 22,878, index 116,568. The plan allows the session page + 8 kB and the others
 * + 1 kB; measured after the phase 8 review fixes: 22,260, 23,003 and 117,056; the lazy panel 11,582. The Summary panel is a lazy chunk the page loads only when the tab opens, so a person
 * who never opens it never pays for it. After merging v0.7.2 (the dashboard machine filter, which grew the base
 * to DashboardPage 26,258 and index 116,943 on its own) the limits were re-based on that base + the same
 * modest headroom; measured with the Summary work: DashboardPage 26,341, index 117,586. AGEN-85 and AGEN-86 (the probe before a reload, the
 * paused socket's slow retry) measured index 118,197 and moved its limit to 118,400. AGEN-87 (the Codex approval card, a lazy chunk the page loads only for a managed Codex session) measured
 * CodexApprovalCard 9,385 and left every other limit where it was: index 118,191, SessionDetailPage 20,855, DashboardPage 26,393. The review of that card (ruby's phase 6 findings: the double-tap guards, the changed-request line, the per-file diff flags, the outcome in the dialog) is what raised its own limit to 12,000 (measured 11,626); the card has never shipped, and the limit exists to catch growth. The review measured index 118,196 and SessionDetailPage 20,926. AGEN-91 (the Codex prompt box: its states and copy, the send/follow hook, the failed-turn row, and the session-action access moved here from index) took SessionDetailPage to 23,943 and moved its limit to 24,500, and gave index back 130 bytes (118,271). AGEN-115 (taking a Codex session over and resuming one: the attempt, the labels, the Resume button and every refusal's sentence on the session page; the card, dialog and machine list as their own lazy chunk) measured
 * SessionDetailPage 25,321, SessionTakeoverCard 4,939 and index 118,384 (the two api methods and one error sentence), and moved the page limit to 25,900, the index limit to 118,600 and added the card's at 5,400. No chunk may carry zod (the
 * validating schema is server-only).
 * AGEN-117 P4 (the approval card learns a takeover fork of a Claude Code session: its two request kinds, the
 * write and decided-elsewhere copy, the peer-message notice and the focus rule for a row that closes itself)
 * took CodexApprovalCard from 11,641 to 13,475 and moved its limit to 13,600. SessionDetailPage was already at
 * 27,721 at the start of P4 (the P3 composer and fork routing; the limit was not moved then); P4 adds 21 bytes
 * and the limit is re-based to 27,900 so the check can pass again and go on catching growth.
 * AGEN-117 P6 (continuing a Claude session from the dashboard: the fork's status block and mode line, the prompt
 * box's states for a fork, End and its confirmation, the per-turn lines in Conversation, the Claude sentence for
 * every refusal, the "Continued as" link on the original, and the dialog's own copy as part of the card's lazy
 * chunk) measured SessionDetailPage 29,906 (+2,164 on 27,742), SessionTakeoverCard 6,663 (+1,724 on 4,939) and
 * CodexApprovalCard 13,616 (+141: the focus plan and the peer-message notice, split out so they can be tested
 * without a DOM). Limits moved to 30,000, 6,700 and 13,700 (+2,100, +1,300, +100). The page and card growth is
 * the plan's exact copy (about 1.7 kB gzip of it is the dialog, the machine-list reasons and the sentences the
 * card chunk alone shows); nothing else on the page grew, and DashboardPage (+99) and index (+51) stay under
 * their limits unmoved.
 * AGEN-117 P6 fix round (the review's findings: the clean-name rule, an archived original's link, the host's failure
 * sentences worded with the machine and the original, the command's lead line and label, the dialog's focus and
 * descriptions, the version row's version and range) measured SessionDetailPage 30,173 (+267 on 29,906) and
 * SessionTakeoverCard 6,870 (+207 on 6,663); CodexApprovalCard was unchanged at 13,616. Limits moved again to
 * 30,300 and 6,950 (+300 and +250).
 * AGEN-119..123 (fork follow-ups: Stop turn and its outcomes, the owner-only tool-call detail panel and Details
 * control, per-call result words, MCP and subagent options in the Continue dialog and their cards) measured
 * SessionDetailPage 34,782 (+4,609 on 30,173), CodexApprovalCard 15,022 (+1,406: the mcp and agent request kinds)
 * and SessionTakeoverCard 7,904 (+1,034: the dialog's two opt-in options and their consent copy); DashboardPage
 * 26,444 and index 118,531 stay under their limits unmoved. Limits moved to 35,100, 15,300 and 8,200.
 * AGEN-142 Phase 1 (ordered loads on the session and Hosts pages: a shared request-order chunk of 173 bytes)
 * measured SessionDetailPage 35,032 (+250) and index 118,535 (+4); no limit moved. Phase 2 (tabs for sessions that
 * no longer exist: the gone test, the restored-tab check mounted in the tab strip, the batch store methods, the
 * name read and the gone card) measured SessionDetailPage 35,236 (+204) and index 119,109 (+574, the check and the
 * stores it uses live in index). Limits moved to 35,500 and 119,400 (measured + about 300).
 * AGEN-142 Phase 3 (unsent prompt drafts: the per-viewer draft store with its debounce, index, TTL and LRU, the
 * sending marker and the follow that resumes from it, the key scheme, and the box's restored-draft line and
 * Discard) measured SessionDetailPage 37,653 (+2,417 on 35,236; the plan expected +1.0 to 1.5 kB, the composer
 * hook rewrite and the two views' markup took the rest) and index 119,467 (+358: the sign-out purge pulls the
 * key scheme and the storage helper into index; the store itself stays in the page chunk). Limits moved to
 * 38,000 and 119,800 (measured + about 350).
 * AGEN-142 fix pass (codex r2 and ruby's review: the last send's outcome kept in the store, the inline "Draft
 * discarded. Undo" row with its focus rules, the gone card as its own component with the "Session deleted"
 * wording, the timeout and late-accept copy, the full-word draft age) measured SessionDetailPage 38,477 (+824)
 * and index 119,532 (+65). The page limit moved to 38,800 (measured + about 320); index stays at 119,800.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export interface Budget {
	chunk: string;
	/** Largest gzipped size, in bytes. */
	maxGzip: number;
	/** What the build measured when the limit was set; the limit is at most this plus HEADROOM. */
	measured: number;
}

/** The most a limit may sit above what was measured. */
export const HEADROOM = 0.1;
export interface Finding {
	chunk: string;
	gzip: number | null;
	max: number;
	ok: boolean;
}

export const BUDGETS: Budget[] = [
	{ chunk: "SessionDetailPage", maxGzip: 38_800, measured: 38_477 },
	{ chunk: "SessionSummaryTab", maxGzip: 12_500, measured: 11_582 },
	{ chunk: "CodexApprovalCard", maxGzip: 15_300, measured: 15_022 },
	{ chunk: "SessionTakeoverCard", maxGzip: 8_200, measured: 7_904 },
	{ chunk: "DashboardPage", maxGzip: 27_200, measured: 26_341 },
	{ chunk: "index", maxGzip: 119_800, measured: 119_467 },
];

/** A missing chunk fails: a renamed chunk must not silently escape its budget. `scale` shrinks every limit (the self-test). */
export function checkBudget(
	sizes: Record<string, number>,
	budgets: Budget[],
	scale = 1,
): Finding[] {
	return budgets.map(({ chunk, maxGzip }) => {
		const max = Math.floor(maxGzip * scale);
		const gzip = Object.hasOwn(sizes, chunk) ? sizes[chunk] : null;
		return { chunk, gzip, max, ok: gzip !== null && gzip <= max };
	});
}

export function main(argv: string[] = process.argv.slice(2)): number {
	const option = (name: string): string | null => {
		const at = argv.indexOf(name);
		return at >= 0 ? (argv[at + 1] ?? null) : null;
	};
	const scale = Number(option("--scale") ?? 1);
	const dir = option("--dir") ?? join(import.meta.dir, "..", "dist", "web", "assets");
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".js"));
	} catch {
		console.error(`No build at ${dir}. Run bun run build first.`);
		return 2;
	}
	const sizes: Record<string, number> = {};
	let zod: string | null = null;
	for (const file of files) {
		const bytes = readFileSync(join(dir, file));
		const name = file.replace(/-[\w-]{6,}\.js$/, "");
		sizes[name] = Math.max(sizes[name] ?? 0, gzipSync(bytes).length);
		if (!zod && bytes.includes("ZodError")) zod = file;
	}
	let failed = false;
	for (const f of checkBudget(sizes, BUDGETS, scale)) {
		console.log(
			`${f.ok ? "ok  " : "FAIL"} ${f.chunk}: ${f.gzip ?? "missing"} gzip bytes (limit ${f.max})`,
		);
		failed ||= !f.ok;
	}
	if (zod) {
		console.log(`FAIL ${zod} carries zod`);
		failed = true;
	}
	return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main());
