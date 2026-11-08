/**
 * Fails when a test suite a fork follow-up track says must run on Postgres is not in the pull-request
 * workflow's `bun test` lists (AGEN-119..123 Track 0). The workflow's `paths:` filter only decides when it
 * runs; what it runs is the explicit lists, and a suite left out of them is silently never run on Postgres.
 *
 * Each track appends its own suites to EXPECTED_SUITES (and to the workflow) in the same change. A listed
 * suite counts as run when a token of a `run:` block equals its path, or is a directory or path prefix of it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = ".github/workflows/codex-approvals-postgres.yml";

/** Suites that must run on Postgres. Append-only, each entry commented with its ticket (`// AGEN-1xx`). */
export const EXPECTED_SUITES: readonly string[] = [
	// AGEN-122: the fork call row's whitelist, and the two readers whose SQL gains a JSON branch.
	"src/server/services/fork-call-row.test.ts",
	"src/server/services/managed-session-state.test.ts",
	"src/server/services/ai/classifier.test.ts",
	"src/server/services/ai/session-summary/evidence-loader.test.ts",
	"src/server/services/ai/session-summary/ledger.test.ts",
	"src/server/services/session-summary-plans.test.ts",
	// AGEN-119: Stop turn
	"src/server/services/control-actions-claude-interrupt.test.ts",
	"src/server/services/codex-approvals-turn-fence.test.ts",
	"src/server/routes/sessions-interrupt.test.ts",
	// AGEN-123
	"src/server/services/fork-tool-detail.test.ts",
	"src/server/routes/fork-tool-calls.test.ts",
	"src/server/routes/fork-tool-calls-leak.test.ts",
	"src/server/services/retention-service.test.ts",
	"src/server/db/fork-tool-calls-migration.test.ts",
];

/** Every path-like token of every `run:` block (folded `>-`, literal `|` or one line). */
export function runListTokens(workflow: string): string[] {
	const tokens: string[] = [];
	const lines = workflow.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i] as string);
		if (!match) continue;
		const indent = (match[1] as string).length;
		const body: string[] = [];
		if ((match[2] as string).replace(/^[>|][-+]?$/, "") !== "") body.push(match[2] as string);
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j] as string;
			if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
			body.push(next);
		}
		for (const word of body.join(" ").split(/[\s\\]+/)) {
			if (word.startsWith("src/") || word.startsWith("scripts/") || word.startsWith("packages/")) {
				tokens.push(word);
			}
		}
	}
	return tokens;
}

/** The expected suites the lists do not cover, and the ones that are not files in the tree. */
export function missingSuites(
	workflow: string,
	expected: readonly string[],
	exists: (path: string) => boolean,
): { notInWorkflow: string[]; notOnDisk: string[] } {
	const tokens = runListTokens(workflow);
	const notInWorkflow = expected.filter(
		(suite) => !tokens.some((token) => suite === token || suite.startsWith(token)),
	);
	const notOnDisk = expected.filter((suite) => !exists(suite));
	return { notInWorkflow, notOnDisk };
}

if (import.meta.main) {
	const workflow = readFileSync(join(ROOT, WORKFLOW), "utf8");
	const { notInWorkflow, notOnDisk } = missingSuites(workflow, EXPECTED_SUITES, (p) =>
		existsSync(join(ROOT, p)),
	);
	for (const suite of notInWorkflow) {
		console.error(`[postgres-suites] ${suite} is not in ${WORKFLOW}'s run lists`);
	}
	for (const suite of notOnDisk) console.error(`[postgres-suites] ${suite} does not exist`);
	if (notInWorkflow.length > 0 || notOnDisk.length > 0) process.exit(1);
	console.log(
		`[postgres-suites] ${EXPECTED_SUITES.length} expected suites, all in the workflow's run lists`,
	);
}
