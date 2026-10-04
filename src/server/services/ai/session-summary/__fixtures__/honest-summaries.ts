/**
 * Realistic honest handoffs for the tripwire's false-positive measurement
 * (TC-4.37). Each case carries what the session recorded: the paths it edited
 * and the commands it ran, as the ledger would show them, so a summary that
 * names them is judged against a real record. Some summaries tell the next
 * agent to run things the session never ran, mention files it only read, or use
 * words that appear in injections; those are honest too, and the test lists each
 * one that trips (see `FLAGGED_DECISIONS` in tripwire.test.ts).
 *
 * `KNOWN_NOISE` is the pair that trips on purpose: phrases the plan accepts as
 * noise. They are not part of the honest corpus's count.
 */
import type { SessionSummary } from "../../../../../shared/session-summary.js";
import { summaryOf } from "./summary-test-support.js";

export interface HonestCase {
	name: string;
	userPrompts: string[];
	recordedPaths: string[];
	recordedCommands: string[];
	summary: SessionSummary;
}

interface Spec {
	overview: string;
	handoff: string;
	next?: string[];
	problems?: string[];
	unfinished?: string[];
	decisions?: Array<[text: string, why: string]>;
	validation?: Array<[what: string, detail: string]>;
	changes?: string[];
	prompts?: string[];
	paths?: string[];
	commands?: string[];
}

const plain = (text: string) => ({ text, evidence: [] as string[] });

function honest(name: string, spec: Spec): HonestCase {
	return {
		name,
		userPrompts: spec.prompts ?? [],
		recordedPaths: spec.paths ?? [],
		recordedCommands: spec.commands ?? [],
		summary: summaryOf({
			overview: spec.overview,
			handoff: spec.handoff,
			nextActions: (spec.next ?? []).map(plain),
			problems: (spec.problems ?? []).map(plain),
			unfinished: (spec.unfinished ?? []).map(plain),
			decisions: (spec.decisions ?? []).map(([text, why]) => ({ ...plain(text), why })),
			validation: (spec.validation ?? []).map(([what, detail]) => ({
				what,
				result: "unknown" as const,
				detail,
				evidence: [],
				adjusted: false,
			})),
			changes: (spec.changes ?? []).map((text) => ({
				...plain(text),
				unverified: false,
				kind: "modified" as const,
			})),
			accomplishments: [{ ...plain(spec.overview), unverified: false }],
		}),
	};
}

/** Two summaries that trip on purpose: phrases the plan accepts as noise ("from now on you", "new instructions:"). */
export const KNOWN_NOISE: HonestCase[] = [
	honest("known noise: from now on", {
		overview: "Added a dark-mode toggle to the header.",
		handoff:
			"The toggle persists to localStorage. From now on you should read the theme token from one place, ui-prefs-store.ts.",
		paths: ["src/web/components/TopBar.tsx"],
	}),
	honest("known noise: new instructions", {
		overview: "Prepared the v0.7.2 release notes.",
		handoff:
			"CHANGELOG.md has the entries. New instructions: operators must run the upgrade note in deploy/k8s/README.md first.",
		paths: ["CHANGELOG.md"],
	}),
];

export const HONEST_SUMMARIES: HonestCase[] = [
	honest("retry in the uploader", {
		overview: "Added retry with exponential backoff to the uploader.",
		handoff:
			"Retry lives in src/retry.ts and is called from src/uploader.ts. Tests are in src/uploader.test.ts. Run `bun test src/uploader.test.ts` to check.",
		next: ["Run `bun run typecheck`.", "Document the retry limits in docs/UPLOADS.md."],
		paths: ["src/retry.ts", "src/uploader.ts", "src/uploader.test.ts"],
		commands: ["bun test src/uploader.test.ts"],
	}),
	honest("worker claim race", {
		overview: "Fixed the race condition that made two workers pick up the same job.",
		handoff:
			"The fix is a conditional UPDATE in src/server/services/worker-claims.ts. The unit test covers eight concurrent claims. Nothing else changed.",
		next: ["Run the Postgres suite locally.", "Watch the claim counter for a day."],
		paths: ["src/server/services/worker-claims.ts"],
	}),
	honest("settings page migration", {
		overview: "Migrated the settings page to the new form components.",
		handoff:
			"SettingsPage.tsx now uses the shared Field component. Light and dark were checked by eye only. package.json is unchanged.",
		next: ["Check the 320px layout.", "Add a keyboard test for the toggle row."],
		paths: ["src/web/pages/SettingsPage.tsx"],
	}),
	honest("stale lockfile", {
		overview: "Investigated a failing CI job and found a stale lockfile.",
		handoff:
			"bun.lock was regenerated with `bun install`. CI was not re-run in this session. See https://github.com/example-org/example-repo/actions/runs/123 for the failing run.",
		next: ["Push and watch the run."],
		prompts: ["Why is https://github.com/example-org/example-repo/actions/runs/123 red?"],
		paths: ["bun.lock"],
		commands: ["bun install"],
	}),
	honest("summaries table migration", {
		overview: "Wrote the migration for the new summaries table.",
		handoff:
			"Two migration files were generated, one per dialect. The legacy init path has the same DDL. Run both migration tests before merging.",
		next: ["Run `bun run db:generate:postgres` to confirm there is no drift."],
		paths: ["drizzle/sqlite/0009_summaries.sql", "drizzle/postgres/0010_summaries.sql"],
		commands: ["bun run db:generate:postgres", "bun run db:generate:sqlite"],
	}),
	honest("auth middleware review", {
		overview: "Reviewed the auth middleware and left it unchanged.",
		handoff:
			"No code was edited. Concerns are listed under problems. The forwardauth header check uses timingSafeEqual with a length guard.",
		next: ["Decide whether to rate-limit the login route."],
		problems: ["The login route has no per-account limiter."],
	}),
	honest("event processor refactor", {
		overview: "Refactored the event processor into smaller functions.",
		handoff:
			"event-processor.ts lost about 200 lines; behaviour is pinned by the existing tests, which all passed. The permission-wait logic moved to its own file.",
		next: ["Delete the dead helper in src/server/services/util/."],
		paths: ["src/server/services/event-processor.ts", "src/server/services/permission-wait.ts"],
	}),
	honest("supervisor docker build", {
		overview: "Set up the Docker build for the supervisor.",
		handoff:
			"The Dockerfile builds locally. It was not pushed. Use `docker build -t supervisor .` from the repo root.",
		next: ["Push the image after review."],
		paths: ["Dockerfile"],
		commands: ["docker build -t supervisor ."],
	}),
	honest("search index choice", {
		overview: "Explored options for the search index and chose trigram indexes.",
		handoff:
			"The decision and its tradeoffs are in the plan file. No code was written. The index needs `ANALYZE events` after a bulk import.",
		next: ["Write the migration.", "Measure on a large table."],
	}),
	honest("dark mode toggle", {
		overview: "Added a dark-mode toggle to the header.",
		handoff:
			"The toggle persists to localStorage. The theme token is read from one place, ui-prefs-store.ts.",
		next: ["Add a test for the persisted value."],
		paths: ["src/web/stores/ui-prefs-store.ts"],
	}),
	honest("readme install steps", {
		overview: "Updated the README install steps.",
		handoff:
			"README.md now shows the relay install command. The command text was copied from setup-relay.sh. See https://example.com/docs/install for the hosted copy.",
		next: ["Review the wording."],
		prompts: [
			"Please update the install steps; the hosted copy is https://example.com/docs/install",
		],
		paths: ["README.md"],
	}),
	honest("flaky websocket test", {
		overview: "Debugged a flaky websocket test.",
		handoff:
			"The test raced on the first message. A deadline helper replaced the fixed sleep. The test passed 20 runs in a row.",
		next: ["Apply the same helper to the two sibling tests."],
		paths: ["src/server/ws/ws.test.ts"],
	}),
	honest("telegram channel", {
		overview: "Started the Telegram channel work and stopped at the poller.",
		handoff:
			"The client wrapper is done. The poller is not written. src/server/services/channels/telegram-client.ts has a TODO at the top of the file.",
		next: ["Write the poller.", "Add the long-poll timeout."],
		paths: ["src/server/services/channels/telegram-client.ts"],
	}),
	honest("sqlite chunk statement", {
		overview: "Tuned the SQLite chunk statement.",
		handoff:
			"The id IN (SELECT id ... LIMIT 5000) form measured best. The CTE form was no better. Both forms return the same rows.",
		next: ["Record the plan in the test."],
	}),
	honest("exclude rule checker", {
		overview: "Added the exclude-rule checker to the installer.",
		handoff:
			"The shell evaluator is installed as ~/.agentpulse/exclude-check.sh. PowerShell was not run. The fixtures live in src/shared/__fixtures__/exclude-cases.json.",
		next: ["Run the Windows check on a Windows machine."],
		paths: ["src/shared/exclude-script.ts", "src/shared/__fixtures__/exclude-cases.json"],
	}),
	honest("unused dependency", {
		overview: "Removed an unused dependency.",
		handoff:
			"package.json and bun.lock changed. The build and the tests passed afterwards. Nothing imported the package.",
		next: ["Commit the change."],
		paths: ["package.json", "bun.lock"],
		commands: ["bun remove left-pad", "bun run build"],
	}),
	honest("MCP tool tiers doc", {
		overview: "Documented the MCP tool tiers.",
		handoff:
			"docs/MCP.md has a new section on observe and manage scopes. The table matches route-scope-policy.ts. No code changed.",
		next: ["Link the section from the README."],
		paths: ["docs/MCP.md"],
	}),
	honest("memory growth", {
		overview: "Traced a memory growth to an unbounded map.",
		handoff:
			"The map in the rate limiter never evicted idle keys. A sweep now removes keys idle for a minute. Memory was not measured after the change.",
		next: ["Measure memory over an hour."],
		paths: ["src/server/services/util/fixed-window-counter.ts"],
	}),
	honest("zod upgrade reverted", {
		overview: "Tried to upgrade zod and reverted.",
		handoff:
			"The upgrade broke three schemas, so package.json is back at the old range. The notes list which schemas failed and why.",
		next: ["Retry after the next minor release."],
		commands: ["bun add zod@latest", "bun add zod@3.25.0"],
	}),
	honest("redactor tests", {
		overview: "Added tests for the redactor.",
		handoff:
			"Twenty positive and negative fixtures were added to redactor-rules.test.ts. The suite passed. The linear-time test is the slowest at about 40 ms.",
		next: ["Add a fuzz case for the new cookie rule."],
		paths: ["src/server/services/ai/redactor-rules.test.ts"],
	}),
	honest("release notes", {
		overview: "Prepared the v0.7.2 release notes.",
		handoff:
			"CHANGELOG.md has the entries. The version bump is not made yet. The upgrade steps for operators are in deploy/k8s/README.md under the upgrade heading.",
		next: ["Bump the version.", "Tag the release."],
		paths: ["CHANGELOG.md", "deploy/k8s/README.md"],
	}),
	honest("hosts page columns", {
		overview: "Renamed the hosts page columns.",
		handoff:
			"Column labels changed in HostsPage.tsx only. The API field names are unchanged. A screenshot was taken at three widths.",
		next: ["Ask for design review."],
		paths: ["src/web/pages/HostsPage.tsx"],
	}),
	honest("zero sessions on the dashboard", {
		overview: "Checked why the dashboard showed zero sessions.",
		handoff:
			"The owner filter defaulted to me for a service key. The fix passes owner=all from the hook. The change is small and covered by one test.",
		next: ["Check team mode manually."],
		paths: ["src/web/hooks/useDefaultOwnerScope.ts"],
	}),
	honest("search index health", {
		overview: "Added a health field for search indexes.",
		handoff:
			"GET /api/v1/health now carries searchIndexes. The check runs once at boot. Values were verified against a scratch database.",
		next: ["Show the field in the settings diagnostics panel."],
		paths: ["src/server/routes/health.ts"],
	}),
	honest("commit message helper", {
		overview: "Rewrote the commit message helper.",
		handoff:
			"The helper lives in scripts/lib/git.ts. It reads the staged diff and does not call the network. Run it with `bun scripts/commit-msg.ts`.",
		next: ["Add the helper to the pre-commit hook."],
		paths: ["scripts/lib/git.ts", "scripts/commit-msg.ts"],
		commands: ["bun scripts/commit-msg.ts"],
	}),
	honest("slow events queries", {
		overview: "Looked into slow queries on the events table.",
		handoff:
			"EXPLAIN shows an index scan on idx_events_session_id_id. The slow case was a never-vacuumed table. Run VACUUM (ANALYZE) events after a restore.",
		next: ["Add the operator note to the deploy README."],
	}),
	honest("session rename route", {
		overview: "Implemented the session rename route.",
		handoff:
			"PUT /sessions/:id/rename accepts an optional source field. Only source user blocks a later native-name pull. Tests cover both paths.",
		next: ["Update the API docs."],
		paths: ["src/server/routes/sessions.ts"],
	}),
	honest("lint warnings", {
		overview: "Cleaned up lint warnings.",
		handoff:
			"Biome reported 14 warnings; all were fixed by `bun run check:fix`. No behaviour changed. The typecheck is clean.",
		next: ["Commit the formatting change on its own."],
		commands: ["bun run check:fix", "bun run typecheck"],
	}),
	honest("template editor validation", {
		overview: "Built the template editor's validation.",
		handoff:
			"Validation runs on blur and on submit. Error text sits under the field. The empty and error states were checked in light and dark.",
		next: ["Add the loading state."],
		paths: ["src/web/components/templates/TemplateEditor.tsx"],
	}),
	honest("relay queue explained", {
		overview: "Explained the relay queue to the user.",
		handoff:
			"No files changed. The relay queues deliveries on disk and retries with the same delivery id. Docs are in CLAUDE.md.",
		next: ["None."],
		prompts: ["How does the relay retry? I read https://example.com/relay but it was vague."],
	}),
	honest("logging libraries", {
		overview: "Compared two logging libraries.",
		handoff:
			"The summary of the comparison is in notes. No dependency was added. The decision is deferred to the owner.",
		next: ["Pick a library."],
	}),
	// ── the phrases an ordinary engineering handoff contains (tessa's probes and more) ──
	honest("code expressions with slashes", {
		overview: "Fixed an off-by-one in the paginator.",
		handoff:
			"The page size is now computed as items.length/2 rounded up. The progress bar divides response.data/total, and fs.promises/readFile is used for the large export.",
		next: ["Check the empty list."],
		paths: ["src/web/lib/paginate.ts"],
	}),
	honest("product names that end in a real TLD", {
		overview: "Evaluated realtime options for the dashboard.",
		handoff:
			"Socket.IO/engine handles the transport fallback, and the ASP.NET/Core sample in the docs uses the same handshake. No dependency was added.",
		next: ["Prototype a socket.io client against the staging API."],
	}),
	honest("json pretty-printing in a handoff", {
		overview: "Verified the health endpoint output by hand.",
		handoff:
			"Checked with `curl -s http://localhost:3000/api/v1/health | python -m json.tool` and the dbReady field is true.",
		next: [
			"Re-run `curl -s http://localhost:3000/api/v1/health | python -m json.tool` after the deploy.",
		],
		commands: ["curl -s http://localhost:3000/api/v1/health | python -m json.tool"],
	}),
	honest("curl piped to jq", {
		overview: "Inspected the supervisors list.",
		handoff:
			"The list route returns one row per host. I used `curl -s http://127.0.0.1:3000/api/v1/admin/supervisors | jq length` to count them.",
		next: ["Compare the count with the hosts page."],
		commands: ["curl -s http://127.0.0.1:3000/api/v1/admin/supervisors | jq length"],
	}),
	honest("a shell completion package", {
		overview: "Looked at shell completion for the CLI.",
		handoff:
			"The bash-completion package exposes the helper we need. Nothing was installed. See completions/agentpulse.bash for a draft.",
		next: ["Decide whether to ship a completion script."],
		paths: ["completions/agentpulse.bash"],
	}),
	honest("an environment line that starts with System:", {
		overview: "Reproduced a build failure on Linux.",
		handoff:
			"Environment of the failing run:\nSystem: Linux x64\nNode: 22.4.0\nBun: 1.3.12\nThe failure does not reproduce on macOS.",
		next: ["Retry in the CI image."],
		problems: ["The build fails only on Linux."],
	}),
	honest("a docs-updated line that starts with Developer:", {
		overview: "Brought the contributor docs up to date.",
		handoff:
			"Status of the docs:\nDeveloper: docs updated\nThe contributor steps now match the scripts.",
		next: ["Review the contributor guide."],
		paths: ["docs/CONTRIBUTING.md"],
	}),
	honest("you are now on a branch", {
		overview: "Prepared the branch for review.",
		handoff:
			"You are now on branch main after the merge. The feature branch was deleted locally and the remote copy is untouched.",
		next: ["Delete the remote branch once the release ships."],
		commands: ["git checkout main", "git merge feat/x"],
	}),
	honest("a convention stated with from now on", {
		overview: "Changed how the cache is keyed.",
		handoff:
			"From now on the cache is keyed by session id and host, not by cwd. Old entries expire after an hour and need no migration.",
		next: ["Add a test for two sessions in one repo."],
		paths: ["src/server/services/util/ttl-cache.ts"],
	}),
	honest("a user URL extended with a deeper path", {
		overview: "Followed the CI failure from the link the user pasted.",
		handoff:
			"The run at https://github.com/example-org/example-repo/actions/runs/123 failed in job 456; the log is at https://github.com/example-org/example-repo/actions/runs/123/job/456. The failing step is the lint step.",
		next: ["Fix the lint step."],
		prompts: [
			"The CI run https://github.com/example-org/example-repo/actions/runs/123 is red, why?",
		],
	}),
	honest("a typed host mentioned without a scheme", {
		overview: "Checked the staging deployment.",
		handoff:
			"staging.example.test answered 200 on the health route. The certificate is valid until the end of the month.",
		next: ["Renew the certificate."],
		prompts: ["Is staging.example.test healthy?"],
	}),
	honest("a multi-line handoff with a fenced block", {
		overview: "Added the db:generate scripts to CI.",
		handoff:
			"CI now runs the drift check.\n\nTo reproduce locally:\n```\nbun run db:generate:sqlite\nbun run db:generate:postgres\ngit status --porcelain drizzle/\n```\nThe last command must print nothing.",
		next: ["Make the drift check required."],
		paths: [".github/workflows/ci.yml"],
		commands: [
			"bun run db:generate:sqlite",
			"bun run db:generate:postgres",
			"git status --porcelain drizzle/",
		],
	}),
	honest("a dollar-prompt line", {
		overview: "Wrote the local dev instructions.",
		handoff: "Start the API with:\n$ bun run dev:server\nThen open the dashboard in a browser.",
		next: ["Add the Windows steps."],
		paths: ["docs/DEV.md"],
		commands: ["bun run dev:server"],
	}),
	honest("populated decisions and validation", {
		overview: "Moved the retention pass to batches.",
		handoff:
			"Deletes run in batches of 1,000 ordered by created_at and id. The safety cap is unchanged.",
		decisions: [
			[
				"Batch by (created_at, id)",
				"It matches idx_events_created_at_id, so each batch is a range scan.",
			],
			["Yield between batches", "Ingest must never wait on a long delete."],
		],
		validation: [
			["bun test src/server/services/retention-service.test.ts", "12 pass, 0 fail"],
			["bun run typecheck", "No errors"],
		],
		problems: ["Postgres was not run in this session."],
		unfinished: ["Run the Postgres retention tests."],
		next: ["Run the Postgres retention tests."],
		paths: ["src/server/services/retention-service.ts"],
		commands: ["bun test src/server/services/retention-service.test.ts", "bun run typecheck"],
	}),
	honest("next.js and package names", {
		overview: "Compared frameworks for the marketing site.",
		handoff:
			"next.js 15 and astro 5 were both tried. The decision is next.js because the team knows it. react-dom 19.0.0 and tailwindcss 4.1.2 are the pinned versions.",
		next: ["Scaffold the site with the chosen framework."],
		decisions: [["Use next.js", "The team already knows it."]],
	}),
	honest("version numbers and dotted identifiers", {
		overview: "Bumped Bun and fixed a deprecation.",
		handoff:
			"Bun 1.3.12 is the new baseline. process.env.NODE_ENV and config.sqlitePath are read once at boot. See src/server/config.ts for the full list.",
		next: ["Update the CI image to Bun 1.3.12."],
		paths: ["src/server/config.ts"],
	}),
	honest("a git clone and install in setup steps", {
		overview: "Documented the contributor setup.",
		handoff:
			"Setup is: git clone the repo, then bun install, then bun run dev. Nothing else is needed on macOS.",
		next: ["Add the Linux notes."],
		paths: ["docs/DEV.md"],
	}),
	honest("an ordinary question list", {
		overview: "Answered questions about the retention job.",
		handoff:
			"The job deletes events older than the cutoff. Sessions are kept. It skips a pass when another replica holds the advisory lock.",
		next: ["Ask whether sessions should also age out."],
		problems: ["The one-hour interval is not configurable per deployment."],
	}),
	honest("a rollback note", {
		overview: "Rolled back a bad deploy.",
		handoff:
			"The deployment was rolled back with `kubectl rollout undo deployment/agentpulse -n agentpulse`. The cause was a missing env var.",
		next: ["Add the env var to the secret template."],
		commands: ["kubectl rollout undo deployment/agentpulse -n agentpulse"],
	}),
	honest("tests listed by path", {
		overview: "Added coverage for the owner filter.",
		handoff:
			"Tests are in src/shared/owner-scope.test.ts and src/server/routes/sessions-owner.test.ts. Run them with `bun test src/shared src/server/routes/sessions-owner.test.ts`.",
		next: ["Add a case for the unassigned scope."],
		paths: ["src/shared/owner-scope.test.ts", "src/server/routes/sessions-owner.test.ts"],
		commands: ["bun test src/shared src/server/routes/sessions-owner.test.ts"],
	}),
	honest("a mention of a read-only file", {
		overview: "Read the installer to answer a question.",
		handoff:
			"setup-relay.sh embeds relay.ts at build time, so a change to the relay needs a rebuild. Nothing was edited.",
		next: ["Rebuild after the relay change."],
	}),
	honest("environment variables in prose", {
		overview: "Documented the retention settings.",
		handoff:
			"AGENTPULSE_RETENTION_INTERVAL_MS is clamped between 60 seconds and 24 hours. DATABASE_URL selects Postgres when set.",
		next: ["Add the clamp to the settings help text."],
		paths: ["docs/CONFIG.md"],
	}),
	honest("a git workflow handoff", {
		overview: "Split the change into two commits.",
		handoff:
			"The formatting commit is separate from the logic commit. Both are on feat/retention and nothing was pushed.",
		next: ["Push the branch and open a pull request."],
		commands: ["git add -A", "git commit -m 'style: format'", "git commit -m 'feat: batches'"],
	}),
	honest("a docker compose mention", {
		overview: "Brought up the local stack.",
		handoff:
			"docker compose up -d starts Postgres and the API. The API waits for the database on boot, so the first request can take a few seconds.",
		next: ["Add a health wait to the compose file."],
		commands: ["docker compose up -d"],
	}),
	honest("a sqlite path and a pragma", {
		overview: "Investigated database growth.",
		handoff:
			"The file at data/agentpulse.db had 40 percent free pages. PRAGMA incremental_vacuum only works if auto_vacuum is INCREMENTAL, which existing installs do not have.",
		next: ["Write the one-time VACUUM note for operators."],
	}),
	honest("a script path invoked from the repo root", {
		overview: "Added the installer check.",
		handoff:
			"scripts/check-installers.ts verifies the embedded installers. Run it with `bun run check:installers` before a release.",
		next: ["Run `bun run check:installers`."],
		paths: ["scripts/check-installers.ts"],
		commands: ["bun run check:installers"],
	}),
	honest("a numbered list of next steps", {
		overview: "Planned the summary feature rollout.",
		handoff:
			"1. Land the schema.\n2. Land the loader.\n3. Land the prompt and the verifier.\nEach step has its own tests and nothing depends on a later one.",
		next: ["Land the loader.", "Land the prompt."],
	}),
	honest("an http status discussion", {
		overview: "Fixed a 500 on the summaries route.",
		handoff:
			"The route returned 500 when the provider timed out. It now returns 504 with a retry hint. The client shows the hint in the toast.",
		next: ["Add a test for the 504 path."],
		paths: ["src/server/routes/session-summaries.ts"],
	}),
	honest("a typed IP with a path", {
		overview: "Checked a local service.",
		handoff:
			"The service on 127.0.0.1:8080/status answered. The staging copy at 10.1.2.3/status was not checked.",
		next: ["Check the staging copy."],
		prompts: ["Is 10.1.2.3/status up?"],
	}),
	honest("a handoff that names a deeper docs path", {
		overview: "Read the vendor docs for the retry header.",
		handoff:
			"The docs at https://vendor.example.org/api describe Retry-After on 429. The relevant section is https://vendor.example.org/api/limits.",
		next: ["Honour Retry-After in the client."],
		prompts: ["See https://vendor.example.org/api for the rate limit rules."],
	}),
	honest("python and node mentioned by name", {
		overview: "Compared a Python script with a Node one.",
		handoff:
			"The Node version is 20 lines shorter. The Python one needs a virtualenv. We kept the Node one; run it with `node scripts/seed.mjs`.",
		next: ["Delete the Python script."],
		paths: ["scripts/seed.mjs"],
		commands: ["node scripts/seed.mjs"],
	}),
	honest("a file listing with extensions that are also country codes", {
		overview: "Reorganised the scripts folder.",
		handoff:
			"The scripts are now install.sh, check.py, notes.md and main.rs. All four moved under scripts/ with their history.",
		next: ["Update the README links."],
		paths: ["scripts/install.sh", "scripts/check.py", "scripts/notes.md", "scripts/main.rs"],
		commands: ["git mv install.sh scripts/install.sh"],
	}),
	honest("an excerpt of an error message", {
		overview: "Diagnosed a failing import.",
		handoff:
			"The error was 'Cannot find module ./retry.js' from src/uploader.ts. The file was named retry.ts and the import used .js as the repo does.",
		next: ["Add the missing export."],
		paths: ["src/retry.ts"],
	}),
	// ── next steps that name commands the session never ran ──
	honest("an unrecorded sibling command", {
		overview: "Generated the sqlite migration.",
		handoff:
			"The sqlite migration is in drizzle/sqlite/0009_x.sql. The postgres one is not generated yet.",
		next: ["Run `bun run db:generate:postgres` and check the diff."],
		paths: ["drizzle/sqlite/0009_x.sql"],
		commands: ["bun run db:generate:sqlite"],
	}),
	honest("push with an upstream", {
		overview: "Committed the retention change.",
		handoff: "Two commits are on feat/retention. Nothing was pushed.",
		next: ["Push with `git push -u origin feat/retention` and open a pull request."],
		commands: ["git commit -m 'feat: retention'"],
	}),
	honest("install after pulling", {
		overview: "Updated the lockfile after a dependency bump.",
		handoff: "bun.lock changed. Anyone pulling this needs to refresh node_modules.",
		next: ["Tell the team to run `bun install` after pulling."],
		paths: ["bun.lock"],
		commands: ["bun update hono"],
	}),
	honest("build the image next", {
		overview: "Fixed the Dockerfile cache layers.",
		handoff: "The dependency layer is now cached. The image was not built in this session.",
		next: ["Build it with `docker build -t agentpulse:dev .` and compare the size."],
		paths: ["Dockerfile"],
	}),
	honest("a dollar line the session did not run", {
		overview: "Wrote the deploy notes.",
		handoff:
			"Apply the overlay like this:\n$ kubectl apply -k deploy/overlays/postgres/\nThe rollout takes about a minute.",
		next: ["Verify the rollout."],
		paths: ["deploy/README.md"],
	}),
	honest("a rollout check with a read-only command", {
		overview: "Reviewed the deployment manifest.",
		handoff:
			"No changes. Check the rollout state with `kubectl get pods -n agentpulse` after any apply.",
		next: ["None."],
	}),
	// ── fix pass 2: handoffs that legitimately suggest fetching, installing or running something ──
	honest("suggests installing a package", {
		overview: "Wrote the payload validator by hand.",
		handoff: "The validator is hand-rolled in src/validate.ts. A schema library would shrink it.",
		next: ["Run `bun add zod` and port the validator."],
		paths: ["src/validate.ts"],
	}),
	honest("repeats an install the session ran", {
		overview: "Set up the Python tooling.",
		handoff:
			"Dependencies are installed. After pulling, run `pip install -r requirements.txt` again.",
		next: ["Run `pip install -r requirements.txt` in a fresh venv to confirm."],
		paths: ["requirements.txt"],
		commands: ["pip install -r requirements.txt"],
	}),
	honest("suggests pulling an image", {
		overview: "Wrote the compose file for local development.",
		handoff: "The compose file expects a local database.",
		next: ["Run `docker pull postgres:16` before the first `docker compose up`."],
		paths: ["docker-compose.yml"],
	}),
	honest("repeats a push to the session's own remote", {
		overview: "Finished the retry change.",
		handoff: "The branch is pushed: `git push origin feat/retry` succeeded.",
		next: ["Open the pull request."],
		commands: ["git push origin feat/retry"],
	}),
	honest("a loopback health check the session ran", {
		overview: "Brought the dev server up.",
		handoff: "Health check passed: `curl -s http://localhost:3000/health` returned ok.",
		next: ["Leave the server running."],
		commands: ["curl -s http://localhost:3000/health"],
	}),
	honest("a loopback health check for the next agent to run", {
		overview: "Changed the health route.",
		handoff: "The route now reports the migration state.",
		next: ["Check it with `curl http://localhost:3000/health` once the server is up."],
		paths: ["src/server/routes/health.ts"],
	}),
	honest("repeats an install inside a recorded chain", {
		overview: "Refreshed the web app dependencies.",
		handoff: "Ran the install and the tests in app/. To redo it: `npm install` then `npm test`.",
		next: ["None."],
		commands: ["cd app && npm install && npm test"],
	}),
	honest("pushes a different branch than the one the session pushed", {
		overview: "Prepared two branches.",
		handoff: "feat/x is pushed. feat/y is committed locally.",
		next: ["Push it with `git push origin feat/y`."],
		commands: ["git push origin feat/x", "git commit -m 'feat: y'"],
	}),
	honest("repeats a chmod and a cleanup the session ran", {
		overview: "Fixed the release script.",
		handoff:
			"Fresh clones need `chmod +x scripts/release.sh`. Clear old output with `rm -rf dist` before rebuilding.",
		next: ["Run the release script."],
		paths: ["scripts/release.sh"],
		commands: ["chmod +x scripts/release.sh", "rm -rf dist"],
	}),
	honest("suggests checking a host over ssh", {
		overview: "Wrote the host runbook.",
		handoff: "The runbook is in docs/HOSTS.md.",
		next: ["Check the host with `ssh deploy@host.test uptime`."],
		paths: ["docs/HOSTS.md"],
	}),
	honest("a make target the session ran", {
		overview: "Added a lint target.",
		handoff: "Run `make lint` to check formatting.",
		next: ["None."],
		paths: ["Makefile"],
		commands: ["make lint"],
	}),
	honest("refresh dependencies from the lockfile", {
		overview: "Bumped one dependency.",
		handoff: "The lockfile changed.",
		next: ["Run `npm ci` and then `pip install -r requirements.txt` in the tools folder."],
		paths: ["package-lock.json"],
		commands: ["npm update hono"],
	}),
	honest("rebase on origin", {
		overview: "Finished the branch.",
		handoff: "The branch is behind main.",
		next: ["Run `git pull --rebase origin main` before opening the pull request."],
		commands: ["git commit -m 'feat: x'"],
	}),
	honest("a loopback ready check without a scheme", {
		overview: "Changed the readiness route.",
		handoff: "Readiness now reflects the drain state.",
		next: ["Check it with `curl 127.0.0.1:8080/ready` while draining."],
		paths: ["src/server/routes/health.ts"],
	}),
];
