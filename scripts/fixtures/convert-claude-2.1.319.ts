/**
 * Converts the 2.1.319 measurement captures (`{t, d, m}` lines, kept out of the public repo) to the fixture
 * line format of `claude-2.1.318` (`{dir, frame}`), applying the pattern-based redactions in
 * `redactions-2.1.319.json`. Only the runs listed in RUNS are converted; `proc` and `exit` records are dropped
 * (the manifest keeps whether `--restricted` was in the argv).
 *
 *   bun scripts/fixtures/convert-claude-2.1.319.ts <captures dir> src/supervisor/providers/__fixtures__/claude-2.1.319
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUNS = [
	"int-bash-key",
	"int-sub-key",
	"int-sub-helper",
	"s1-key",
	"s1-helper",
	"s2-key-bgoff",
	"s2-key-bgon",
	"s5-general-key",
	"s5b-custom-helper",
	"m1-base-key",
	"m1-base-helper",
	"m1-allowrule-key",
	"m1-usercfg-strict-helper",
	"m1-usercfg-nostrict-helper",
];

type Rule = { pattern: string; flags?: string; replacement: string };
const rules: Rule[] = JSON.parse(
	readFileSync(join(import.meta.dir, "redactions-2.1.319.json"), "utf8"),
).rules;

export function redact(text: string): string {
	let out = text;
	for (const rule of rules)
		out = out.replace(new RegExp(rule.pattern, rule.flags ?? "g"), rule.replacement);
	return out;
}

function main(): void {
	const [from, to] = process.argv.slice(2);
	if (!from || !to)
		throw new Error("usage: convert-claude-2.1.319.ts <captures dir> <fixture dir>");
	mkdirSync(to, { recursive: true });
	const manifest: Record<string, { restricted: boolean; source: string }> = {};
	for (const run of RUNS) {
		const records = readFileSync(join(from, `${run}.jsonl`), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { d: string; m: unknown });
		const proc = records.find((r) => r.d === "proc")?.m as { argv?: string[] } | undefined;
		const lines = records
			.filter((r) => r.d === "in" || r.d === "out")
			.map((r) => redact(JSON.stringify({ dir: r.d, frame: r.m })));
		writeFileSync(join(to, `${run}.jsonl`), `${lines.join("\n")}\n`);
		manifest[`${run}.jsonl`] = {
			restricted: proc?.argv?.includes("--restricted") === true,
			source: `claude 2.1.319 measurement ${run}`,
		};
	}
	writeFileSync(join(to, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

if (import.meta.main) main();
