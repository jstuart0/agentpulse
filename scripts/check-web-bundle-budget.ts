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
 * modest headroom; measured with the Summary work: DashboardPage 26,341, index 117,586. No chunk may carry zod (the validating schema is
 * server-only).
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
	{ chunk: "SessionDetailPage", maxGzip: 23_500, measured: 22_260 },
	{ chunk: "SessionSummaryTab", maxGzip: 12_500, measured: 11_582 },
	{ chunk: "DashboardPage", maxGzip: 27_200, measured: 26_341 },
	{ chunk: "index", maxGzip: 117_900, measured: 117_586 },
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
