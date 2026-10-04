/**
 * The git branch a session shows is read from a Bash tool's output. A tool
 * response that arrives as an object is serialised to JSON before it is
 * searched, which turns every newline into the two characters backslash and n:
 * a branch name followed by a newline must end at the name, not run on into the
 * next line of output ("feat/x\nYour" on the dashboard).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { eq } = await import("drizzle-orm");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { processHookEvent } = await import("./event-processor.js");
import type { HookEventPayload } from "../../shared/types.js";

beforeAll(async () => {
	await initializeDatabase();
});
beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

let n = 0;
async function branchAfter(command: string, toolResponse: unknown): Promise<string | null> {
	n += 1;
	const id = `git-branch-${n}`;
	await processHookEvent(
		{ session_id: id, hook_event_name: "SessionStart" } as HookEventPayload,
		"claude_code",
	);
	await processHookEvent(
		{
			session_id: id,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command },
			tool_response: toolResponse,
		} as unknown as HookEventPayload,
		"claude_code",
	);
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, id));
	return row.gitBranch;
}

const STATUS =
	"On branch tooling/env-example-curation-12\nYour branch is up to date with 'origin/x'.\n";

describe("git branch from a tool response", () => {
	test("an object response (JSON-serialised before matching) stops at the end of the branch name", async () => {
		// If the capture ran past the escaped newline it would be "tooling/env-example-curation-12\nYour".
		expect(await branchAfter("git status", { stdout: STATUS, stderr: "" })).toBe(
			"tooling/env-example-curation-12",
		);
	});

	test("a string response, `git branch` output and `rev-parse` still work", async () => {
		expect(await branchAfter("git status", STATUS)).toBe("tooling/env-example-curation-12");
		expect(await branchAfter("git branch", { stdout: "  main\n* feat/other\n" })).toBe(
			"feat/other",
		);
		expect(
			await branchAfter("git status -sb", {
				stdout: "## HEAD -> release/1.2, origin/release/1.2\n",
			}),
		).toBe("release/1.2");
	});

	test("a Windows line ending and a tab after the name end it too", async () => {
		expect(
			await branchAfter("git status", { stdout: "On branch win-branch\r\nnothing to commit" }),
		).toBe("win-branch");
		expect(await branchAfter("git status", { stdout: "On branch tab-branch\tstuff" })).toBe(
			"tab-branch",
		);
	});

	test("nothing that isn't a git command, or has no branch, sets one", async () => {
		expect(await branchAfter("ls", { stdout: STATUS })).toBeNull();
		expect(await branchAfter("git status", { stdout: "fatal: not a git repository" })).toBeNull();
	});
});
