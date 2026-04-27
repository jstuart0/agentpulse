import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { aiPendingProjectDrafts, askThreads, projects, sessions } = await import(
	"../../db/schema.js"
);
const {
	createLaunchDisambiguationDraft,
	encodePickerMeta,
	extractPickerMeta,
	parseDisambiguationReply,
	resolveLaunchDisambiguation,
} = await import("./launch-disambiguation-handler.js");

import type { ProjectChoiceSnapshot } from "../../db/schema.js";

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(aiPendingProjectDrafts).execute();
	await db.delete(askThreads).execute();
	await db.delete(projects).execute();
	await db.delete(sessions).execute();
});

const choices: ProjectChoiceSnapshot[] = [
	{ id: "p1", name: "agentpulse", cwd: "/Users/me/dev/agentpulse" },
	{ id: "p2", name: "monarch", cwd: "/Users/me/dev/Monarch" },
	{ id: "p3", name: "visiontest-ai", cwd: "/Users/me/dev/visiontest-ai" },
];

describe("parseDisambiguationReply", () => {
	test("parses a bare numeric pick", () => {
		const r = parseDisambiguationReply("1", choices);
		expect(r.tag).toBe("numeric_choice");
		if (r.tag === "numeric_choice") expect(r.choice.name).toBe("agentpulse");
	});

	test("parses '01.' as the first choice", () => {
		const r = parseDisambiguationReply("01.", choices);
		expect(r.tag).toBe("numeric_choice");
		if (r.tag === "numeric_choice") expect(r.choice.name).toBe("agentpulse");
	});

	test("parses 'new' as new_keyword (case-insensitive)", () => {
		expect(parseDisambiguationReply("new", choices).tag).toBe("new_keyword");
		expect(parseDisambiguationReply(" NEW ", choices).tag).toBe("new_keyword");
		expect(parseDisambiguationReply("Scaffold", choices).tag).toBe("new_keyword");
	});

	test("parses an absolute path starting with /", () => {
		const r = parseDisambiguationReply("/repos/some-thing", choices);
		expect(r.tag).toBe("absolute_path");
		if (r.tag === "absolute_path") expect(r.path).toBe("/repos/some-thing");
	});

	test("expands ~/ paths against $HOME", () => {
		const home = process.env.HOME ?? "/home/test";
		const r = parseDisambiguationReply("~/dev/foo", choices);
		expect(r.tag).toBe("absolute_path");
		if (r.tag === "absolute_path") expect(r.path).toBe(`${home}/dev/foo`);
	});

	test("fuzzy-matches a unique substring", () => {
		const r = parseDisambiguationReply("monarch", choices);
		expect(r.tag).toBe("fuzzy_match");
		if (r.tag === "fuzzy_match") expect(r.choice.name).toBe("monarch");
	});

	test("returns ambiguous when the substring matches multiple", () => {
		// "ai" matches both "visiontest-ai"
		const sneakyChoices: ProjectChoiceSnapshot[] = [
			{ id: "p1", name: "agentpulse-ai", cwd: "/x/agentpulse-ai" },
			{ id: "p2", name: "vision-ai", cwd: "/x/vision-ai" },
		];
		const r = parseDisambiguationReply("ai", sneakyChoices);
		expect(r.tag).toBe("ambiguous");
		if (r.tag === "ambiguous") expect(r.matches.length).toBe(2);
	});

	test("returns unparsed for garbage input", () => {
		const r = parseDisambiguationReply("???", choices);
		expect(r.tag).toBe("unparsed");
	});

	test("returns unparsed for out-of-range numeric pick", () => {
		const r = parseDisambiguationReply("99", choices);
		expect(r.tag).toBe("unparsed");
	});
});

describe("encodePickerMeta / extractPickerMeta", () => {
	test("round-trips a project picker meta payload", () => {
		const meta = {
			kind: "project_picker" as const,
			draftId: "abc",
			choices,
			taskHint: "make a plan",
			taskBriefSummary: "make a plan",
			telegramOrigin: false,
		};
		const encoded = `Pick a project${encodePickerMeta(meta)}`;
		const result = extractPickerMeta(encoded);
		expect(result).not.toBeNull();
		expect(result?.meta.draftId).toBe("abc");
		expect(result?.meta.choices.length).toBe(3);
		expect(result?.visibleText).toBe("Pick a project");
	});

	test("returns null when no sentinel fence is present", () => {
		expect(extractPickerMeta("just some plain reply text")).toBeNull();
	});

	test("returns null when sentinel JSON is malformed", () => {
		const broken = "Pick\n\n```ask-message-meta\nnot-json\n```";
		expect(extractPickerMeta(broken)).toBeNull();
	});
});

describe("schema back-compat", () => {
	test("existing rows without an explicit kind column are treated as add_project", async () => {
		const threadId = crypto.randomUUID();
		const now = new Date().toISOString();
		await db
			.insert(askThreads)
			.values({ id: threadId, title: "test", origin: "web", createdAt: now, updatedAt: now })
			.execute();
		// Insert via raw SQL to mirror a row created before the kind migration.
		const { sqlite } = await import("../../db/client.js");
		sqlite
			.prepare(
				`INSERT INTO ai_pending_project_drafts (
					id, ask_thread_id, channel_id, origin,
					draft_fields, next_question, status,
					created_at, updated_at
				) VALUES (?, ?, NULL, 'web',
					'{"name":"oldproj"}', '{"field":"name","prompt":"x","retryCount":0}',
					'drafting', ?, ?)`,
			)
			.run(crypto.randomUUID(), threadId, now, now);
		const [row] = await db.select().from(aiPendingProjectDrafts).execute();
		expect(row.kind).toBe("add_project");
	});
});

describe("createLaunchDisambiguationDraft", () => {
	test("persists a draft with kind=launch_disambiguation and renders the picker", async () => {
		const threadId = crypto.randomUUID();
		const now = new Date().toISOString();
		await db
			.insert(askThreads)
			.values({ id: threadId, title: "test", origin: "web", createdAt: now, updatedAt: now })
			.execute();

		const result = await createLaunchDisambiguationDraft({
			threadId,
			origin: "web",
			channelId: null,
			intent: {
				kind: "launch_needs_project",
				taskHint: "create a plan about caching",
				taskBrief: { summary: "Plan caching strategies" },
			},
			originalMessage: "create a plan about caching strategies",
			projects: choices,
		});

		expect(result.replyText).toContain("Which project should I work in?");
		expect(result.replyText).toContain("1. agentpulse");
		expect(result.replyText).toContain("2. monarch");

		const meta = extractPickerMeta(result.replyText);
		expect(meta).not.toBeNull();
		expect(meta?.meta.choices.length).toBe(3);

		const rows = await db.select().from(aiPendingProjectDrafts).execute();
		expect(rows.length).toBe(1);
		expect(rows[0].kind).toBe("launch_disambiguation");
		expect(rows[0].status).toBe("drafting");
	});

	test("renders an empty-state reply when no projects are configured", async () => {
		const threadId = crypto.randomUUID();
		const now = new Date().toISOString();
		await db
			.insert(askThreads)
			.values({ id: threadId, title: "test", origin: "web", createdAt: now, updatedAt: now })
			.execute();

		const result = await createLaunchDisambiguationDraft({
			threadId,
			origin: "web",
			channelId: null,
			intent: { kind: "launch_needs_project" },
			originalMessage: "create a plan",
			projects: [],
		});

		expect(result.replyText).toContain("You don't have any projects yet");
		expect(result.replyText).toContain("Settings → Projects");
	});

	test("supersedes any existing open draft on the same thread", async () => {
		const threadId = crypto.randomUUID();
		const now = new Date().toISOString();
		await db
			.insert(askThreads)
			.values({ id: threadId, title: "test", origin: "web", createdAt: now, updatedAt: now })
			.execute();

		// First draft
		await createLaunchDisambiguationDraft({
			threadId,
			origin: "web",
			channelId: null,
			intent: { kind: "launch_needs_project" },
			originalMessage: "first",
			projects: choices,
		});
		// Second draft for the same thread
		await createLaunchDisambiguationDraft({
			threadId,
			origin: "web",
			channelId: null,
			intent: { kind: "launch_needs_project" },
			originalMessage: "second",
			projects: choices,
		});

		const rows = await db.select().from(aiPendingProjectDrafts).execute();
		expect(rows.length).toBe(2);
		const drafting = rows.filter((r) => r.status === "drafting");
		const superseded = rows.filter((r) => r.status === "superseded");
		expect(drafting.length).toBe(1);
		expect(superseded.length).toBe(1);
	});
});

describe("resolveLaunchDisambiguation", () => {
	async function seedThreadAndDraft(opts?: { fields?: Partial<typeof choicesSeed> }) {
		const threadId = crypto.randomUUID();
		const now = new Date().toISOString();
		await db
			.insert(askThreads)
			.values({ id: threadId, title: "test", origin: "web", createdAt: now, updatedAt: now })
			.execute();
		const draftFields = {
			originalMessage: "create a plan about caching",
			taskHint: "plan caching",
			taskBrief: { summary: "Plan caching" },
			displayName: "plan-caching",
			proposedProjectChoices: choices,
			...(opts?.fields ?? {}),
		};
		const [row] = await db
			.insert(aiPendingProjectDrafts)
			.values({
				askThreadId: threadId,
				channelId: null,
				origin: "web",
				kind: "launch_disambiguation",
				draftFields,
				nextQuestion: { field: "name", prompt: "project_choice", retryCount: 0 },
				status: "drafting",
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return { threadId, draft: row };
	}
	const choicesSeed = {
		originalMessage: "x",
		proposedProjectChoices: choices,
	};

	test("`new` keeps the draft open and returns a not-yet-supported reply", async () => {
		const { threadId, draft } = await seedThreadAndDraft();
		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "new",
			origin: "web",
			threadId,
		});
		expect(result.replyText).toContain("isn't available yet");
		const [row] = await db.select().from(aiPendingProjectDrafts).execute();
		expect(row.status).toBe("drafting");
	});

	test("garbage input bumps retry count without resolving", async () => {
		const { threadId, draft } = await seedThreadAndDraft();
		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "???",
			origin: "web",
			threadId,
		});
		expect(result.replyText).toContain("I didn't understand that");
		const [row] = await db.select().from(aiPendingProjectDrafts).execute();
		expect(row.status).toBe("drafting");
		const nq = row.nextQuestion as { retryCount: number };
		expect(nq.retryCount).toBe(1);
	});

	test("garbage input three times expires the draft", async () => {
		const { threadId, draft } = await seedThreadAndDraft();
		await resolveLaunchDisambiguation({ draft, reply: "?", origin: "web", threadId });
		const [reloaded1] = await db.select().from(aiPendingProjectDrafts).execute();
		await resolveLaunchDisambiguation({
			draft: reloaded1,
			reply: "?",
			origin: "web",
			threadId,
		});
		const [reloaded2] = await db.select().from(aiPendingProjectDrafts).execute();
		const result = await resolveLaunchDisambiguation({
			draft: reloaded2,
			reply: "?",
			origin: "web",
			threadId,
		});
		expect(result.replyText).toContain("after 3 tries");
		const [row] = await db.select().from(aiPendingProjectDrafts).execute();
		expect(row.status).toBe("expired");
	});

	test("absolute path with no matching project returns guidance", async () => {
		const { threadId, draft } = await seedThreadAndDraft();
		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "/some/random/path",
			origin: "web",
			threadId,
		});
		expect(result.replyText).toContain("/some/random/path");
		expect(result.replyText).toContain("Settings → Projects");
		const [row] = await db.select().from(aiPendingProjectDrafts).execute();
		expect(row.status).toBe("superseded");
	});
});

describe("end-to-end: numeric reply produces an action_request", async () => {
	const { aiActionRequests, supervisors } = await import("../../db/schema.js");

	beforeEach(async () => {
		await db.delete(aiActionRequests).execute();
		await db.delete(supervisors).execute();
	});

	test("number pick handed off to handleAskLaunchIntent creates a launch action_request", async () => {
		// Seed: one project, one connected supervisor capable of claude_code
		// interactive_terminal launches.
		const projectId = crypto.randomUUID();
		const cwd = "/tmp/test-disambiguation-project";
		const now = new Date().toISOString();
		await db
			.insert(projects)
			.values({
				id: projectId,
				name: "agentpulse",
				cwd,
				defaultAgentType: "claude_code",
				defaultLaunchMode: "interactive_terminal",
				createdAt: now,
				updatedAt: now,
			})
			.execute();
		await db
			.insert(supervisors)
			.values({
				id: crypto.randomUUID(),
				hostName: "test-host",
				platform: "macos",
				arch: "x64",
				version: "1.0",
				capabilities: {
					version: 1,
					agentTypes: ["claude_code"],
					launchModes: ["interactive_terminal"],
					os: "macos",
					terminalSupport: ["iTerm.app"],
					features: [],
					executables: {
						claude: { available: true, version: "1.0", path: "/usr/bin/claude" },
					},
					interactiveTerminalControl: { available: true },
				},
				trustedRoots: ["/tmp/test-disambiguation-project"],
				status: "connected",
				capabilitySchemaVersion: 1,
				configSchemaVersion: 1,
				lastHeartbeatAt: now,
				// Lease must be in the future so deriveStatus() returns "connected".
				heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				enrollmentState: "active",
				createdAt: now,
				updatedAt: now,
			})
			.execute();

		// Refresh the projects cache so the launch handler can resolve by name.
		const { bumpVersionAndReload } = await import("../projects/cache.js");
		await bumpVersionAndReload();

		const threadId = crypto.randomUUID();
		await db
			.insert(askThreads)
			.values({ id: threadId, title: "test", origin: "web", createdAt: now, updatedAt: now })
			.execute();

		const choicesSnapshot: ProjectChoiceSnapshot[] = [{ id: projectId, name: "agentpulse", cwd }];
		const [draft] = await db
			.insert(aiPendingProjectDrafts)
			.values({
				askThreadId: threadId,
				channelId: null,
				origin: "web",
				kind: "launch_disambiguation",
				draftFields: {
					originalMessage: "create a plan about caching",
					taskHint: "plan caching",
					taskBrief: { summary: "Plan caching" },
					displayName: "plan-caching",
					proposedProjectChoices: choicesSnapshot,
				},
				nextQuestion: { field: "name", prompt: "project_choice", retryCount: 0 },
				status: "drafting",
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "1",
			origin: "web",
			threadId,
		});

		// The launch handler returns a queued-launch reply when an action_request was created.
		expect(result.replyText.toLowerCase()).toContain("queued");
		const actionRows = await db.select().from(aiActionRequests).execute();
		expect(actionRows.length).toBe(1);
		expect(actionRows[0].kind).toBe("launch_request");
		expect(actionRows[0].askThreadId).toBe(threadId);
		const payload = actionRows[0].payload as { projectId?: string; aiInitiated?: boolean };
		expect(payload.projectId).toBe(projectId);
		expect(payload.aiInitiated).toBe(true);

		const [draftAfter] = await db.select().from(aiPendingProjectDrafts).execute();
		expect(draftAfter.status).toBe("superseded");
	});
});
