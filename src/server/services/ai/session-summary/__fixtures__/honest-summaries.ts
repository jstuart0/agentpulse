/**
 * Plausible honest summaries for the tripwire's false-positive budget
 * (TC-4.37): normal handoff language, paths, commands, and URLs only where the
 * user typed them. Two entries use phrases the plan accepts as noise
 * ("from now on", "new instructions").
 */
import type { SessionSummary } from "../../../../../shared/session-summary.js";
import { summaryOf } from "./summary-test-support.js";

export interface HonestCase {
	userPrompts: string[];
	summary: SessionSummary;
}

const item = (text: string) => ({ text, evidence: [] as string[] });
function honest(
	overview: string,
	handoff: string,
	next: string[],
	userPrompts: string[] = [],
	extra: Partial<SessionSummary> = {},
): HonestCase {
	return {
		userPrompts,
		summary: summaryOf({
			overview,
			handoff,
			nextActions: next.map(item),
			accomplishments: [{ ...item(overview), unverified: false }],
			...extra,
		}),
	};
}

export const HONEST_SUMMARIES: HonestCase[] = [
	honest(
		"Added retry with exponential backoff to the uploader.",
		"Retry lives in src/retry.ts and is called from src/uploader.ts. Tests are in src/uploader.test.ts. Run `bun test src/uploader.test.ts` to check.",
		["Run `bun run typecheck`.", "Document the retry limits in docs/UPLOADS.md."],
	),
	honest(
		"Fixed the race condition that made two workers pick up the same job.",
		"The fix is a conditional UPDATE in src/server/services/worker-claims.ts. The unit test covers eight concurrent claims. Nothing else changed.",
		["Run the Postgres suite locally.", "Watch the claim counter for a day."],
	),
	honest(
		"Migrated the settings page to the new form components.",
		"SettingsPage.tsx now uses the shared Field component. Light and dark were checked by eye only. package.json is unchanged.",
		["Check the 320px layout.", "Add a keyboard test for the toggle row."],
	),
	honest(
		"Investigated a failing CI job and found a stale lockfile.",
		"bun.lock was regenerated with `bun install`. CI was not re-run in this session. See https://github.com/example-org/example-repo/actions/runs/123 for the failing run.",
		["Push and watch the run."],
		["Why is https://github.com/example-org/example-repo/actions/runs/123 red?"],
	),
	honest(
		"Wrote the migration for the new summaries table.",
		"Two migration files were generated, one per dialect. The legacy init path has the same DDL. Run both migration tests before merging.",
		["Run `bun run db:generate:postgres` to confirm there is no drift."],
	),
	honest(
		"Reviewed the auth middleware and left it unchanged.",
		"No code was edited. Concerns are listed under problems. The forwardauth header check uses timingSafeEqual with a length guard.",
		["Decide whether to rate-limit the login route."],
	),
	honest(
		"Refactored the event processor into smaller functions.",
		"event-processor.ts lost about 200 lines; behaviour is pinned by the existing tests, which all passed. The permission-wait logic moved to its own file.",
		["Delete the dead helper in src/server/services/util/."],
	),
	honest(
		"Set up the Docker build for the supervisor.",
		"The Dockerfile builds locally. It was not pushed. Use `docker build -t supervisor .` from the repo root. curl -I against the health route returns 200.",
		["Push the image after review."],
	),
	honest(
		"Explored options for the search index and chose trigram indexes.",
		"The decision and its tradeoffs are in the plan file. No code was written. The index needs `ANALYZE events` after a bulk import.",
		["Write the migration.", "Measure on a large table."],
	),
	honest(
		"Added a dark-mode toggle to the header.",
		"The toggle persists to localStorage. From now on the theme token is read from one place, ui-prefs-store.ts.",
		["Add a test for the persisted value."],
	),
	honest(
		"Updated the README install steps.",
		"README.md now shows the relay install command. The command text was copied from setup-relay.sh. See https://example.com/docs/install for the hosted copy.",
		["Review the wording."],
		["Please update the install steps; the hosted copy is https://example.com/docs/install"],
	),
	honest(
		"Debugged a flaky websocket test.",
		"The test raced on the first message. A deadline helper replaced the fixed sleep. The test passed 20 runs in a row.",
		["Apply the same helper to the two sibling tests."],
	),
	honest(
		"Started the Telegram channel work and stopped at the poller.",
		"The client wrapper is done. The poller is not written. src/server/services/channels/telegram-client.ts has a TODO at the top of the file.",
		["Write the poller.", "Add the long-poll timeout."],
	),
	honest(
		"Tuned the SQLite chunk statement.",
		"The id IN (SELECT id ... LIMIT 5000) form measured best. The CTE form was no better. Both forms return the same rows.",
		["Record the plan in the test."],
	),
	honest(
		"Added the exclude-rule checker to the installer.",
		"The shell evaluator is installed as ~/.agentpulse/exclude-check.sh. PowerShell was not run. The fixtures live in src/shared/__fixtures__/exclude-cases.json.",
		["Run the Windows check on a Windows machine."],
	),
	honest(
		"Removed an unused dependency.",
		"package.json and bun.lock changed. The build and the tests passed afterwards. Nothing imported the package.",
		["Commit the change."],
	),
	honest(
		"Documented the MCP tool tiers.",
		"docs/MCP.md has a new section on observe and manage scopes. The table matches route-scope-policy.ts. No code changed.",
		["Link the section from the README."],
	),
	honest(
		"Traced a memory growth to an unbounded map.",
		"The map in the rate limiter never evicted idle keys. A sweep now removes keys idle for a minute. Memory was not measured after the change.",
		["Measure memory over an hour."],
	),
	honest(
		"Tried to upgrade zod and reverted.",
		"The upgrade broke three schemas, so package.json is back at the old range. The notes list which schemas failed and why.",
		["Retry after the next minor release."],
	),
	honest(
		"Added tests for the redactor.",
		"Twenty positive and negative fixtures were added to redactor-rules.test.ts. The suite passed. The linear-time test is the slowest at about 40 ms.",
		["Add a fuzz case for the new cookie rule."],
	),
	honest(
		"Prepared the v0.7.2 release notes.",
		"CHANGELOG.md has the entries. The version bump is not made yet. New instructions for operators are in deploy/k8s/README.md under the upgrade heading.",
		["Bump the version.", "Tag the release."],
	),
	honest(
		"Renamed the hosts page columns.",
		"Column labels changed in HostsPage.tsx only. The API field names are unchanged. A screenshot was taken at three widths.",
		["Ask for design review."],
	),
	honest(
		"Checked why the dashboard showed zero sessions.",
		"The owner filter defaulted to me for a service key. The fix passes owner=all from the hook. The change is small and covered by one test.",
		["Check team mode manually."],
	),
	honest(
		"Added a health field for search indexes.",
		"GET /api/v1/health now carries searchIndexes. The check runs once at boot. Values were verified against a scratch database.",
		["Show the field in the settings diagnostics panel."],
	),
	honest(
		"Rewrote the commit message helper.",
		"The helper lives in scripts/lib/git.ts. It reads the staged diff and does not call the network. Run it with `bun scripts/commit-msg.ts`.",
		["Add the helper to the pre-commit hook."],
	),
	honest(
		"Looked into slow queries on the events table.",
		"EXPLAIN shows an index scan on idx_events_session_id_id. The slow case was a never-vacuumed table. Run VACUUM (ANALYZE) events after a restore.",
		["Add the operator note to the deploy README."],
	),
	honest(
		"Implemented the session rename route.",
		"PUT /sessions/:id/rename accepts an optional source field. Only source user blocks a later native-name pull. Tests cover both paths.",
		["Update the API docs."],
	),
	honest(
		"Cleaned up lint warnings.",
		"Biome reported 14 warnings; all were fixed by `bun run check:fix`. No behaviour changed. The typecheck is clean.",
		["Commit the formatting change on its own."],
	),
	honest(
		"Built the template editor's validation.",
		"Validation runs on blur and on submit. Error text sits under the field. The empty and error states were checked in light and dark.",
		["Add the loading state."],
	),
	honest(
		"Explained the relay queue to the user.",
		"No files changed. The relay queues deliveries on disk and retries with the same delivery id. Docs are in CLAUDE.md.",
		["None."],
		["How does the relay retry? I read https://example.com/relay but it was vague."],
	),
	honest(
		"Compared two logging libraries.",
		"The summary of the comparison is in notes. No dependency was added. The decision is deferred to the owner.",
		["Pick a library."],
	),
];
