import { describe, expect, test } from "bun:test";
import {
	RESUMES_SESSIONS,
	RESUME_FAILURE_KINDS,
	RESUME_REFUSAL_CODES,
	RESUME_REFUSED_MESSAGE,
	type ResumeKind,
} from "../../../shared/session-resume.js";
import type { ControlAction, Session, SupervisorRecord } from "../../../shared/types.js";
import { ApiError } from "../../lib/api.js";
import { ownershipUi } from "../../lib/ownership-ui.js";
import {
	TAKEOVER_FAILURE_FALLBACK,
	TAKEOVER_NO_HOST_SOLO,
	TAKEOVER_NO_HOST_TEAM,
	TAKEOVER_NOT_ADMIN,
	TAKEOVER_STILL_WAITING,
	bindRefusalMessage,
	bindableHosts,
	bottomSlot,
	isTakenOver,
	launchSummaryLine,
	overviewOriginField,
	showsStatusHint,
	takeoverAttempt,
	takeoverCardView,
	takeoverConfirmLabel,
	takeoverDialogLines,
	takeoverEligibility,
	takeoverProgress,
} from "./session-takeover-view.js";

const MIN = 60_000;
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function action(
	id: string,
	status: ControlAction["status"],
	createdAtMs: number,
	over: Partial<ControlAction> & { kind?: ResumeKind } = {},
): ControlAction {
	const { kind = "takeover", ...rest } = over;
	return {
		id,
		sessionId: "s1",
		launchRequestId: "l1",
		actionType: "resume",
		requestedBy: null,
		requestedByUserId: null,
		status,
		error: null,
		metadata: { resumeKind: kind },
		idempotencyKey: null,
		claimedBySupervisorId: null,
		finishedAt: null,
		createdAt: new Date(createdAtMs).toISOString(),
		updatedAt: new Date(createdAtMs).toISOString(),
		...rest,
	};
}
const prompt = (id: string, createdAtMs: number): ControlAction =>
	action(id, "succeeded", createdAtMs, { actionType: "prompt", metadata: {} });

describe("takeoverAttempt: derived from resume actions, never card state", () => {
	test("no resume action is no attempt, and a prompt or stop is not a resume", () => {
		expect(takeoverAttempt([])).toEqual({ state: "none" });
		expect(takeoverAttempt([prompt("p", NOW)])).toEqual({ state: "none" });
	});

	test("queued and running are in flight, with the kind and when it began", () => {
		for (const status of ["queued", "running"] as const) {
			expect(takeoverAttempt([action("a", status, NOW - 5_000)])).toEqual({
				state: "in_flight",
				actionId: "a",
				kind: "takeover",
				startedAt: new Date(NOW - 5_000).toISOString(),
			});
		}
		expect(takeoverAttempt([action("r", "queued", NOW, { kind: "recovery" })])).toMatchObject({
			state: "in_flight",
			kind: "recovery",
		});
	});

	test("a poll landing mid-attempt: the same action reads in flight on every list that holds it", () => {
		const during = [prompt("p", NOW - 99_000), action("a", "running", NOW - 2_000)];
		const later = [...during, prompt("q", NOW - 1_000)];
		expect(takeoverAttempt(during)).toMatchObject({ state: "in_flight", actionId: "a" });
		expect(takeoverAttempt(later)).toMatchObject({ state: "in_flight", actionId: "a" });
	});

	test("the newest failed attempt with no later success is a failure carrying the host's sentence", () => {
		const sentence = "studio can't find this session's history, so it wasn't taken over.";
		const failed = action("a", "failed", NOW - 9_000, { error: sentence });
		expect(takeoverAttempt([failed])).toEqual({
			state: "failed",
			actionId: "a",
			kind: "takeover",
			reason: sentence,
		});
	});

	test("a reload after a failure still has the reason: it needs only the list the server returns", () => {
		const failed = action("a", "failed", NOW - 60 * MIN, { error: "Try again." });
		expect(takeoverAttempt([prompt("p", NOW - 90 * MIN), failed])).toMatchObject({
			state: "failed",
			reason: "Try again.",
		});
	});

	test("a later success clears an earlier failure, and a later attempt in flight replaces it", () => {
		const failed = action("a", "failed", NOW - 20_000, { error: "no" });
		expect(takeoverAttempt([failed, action("b", "succeeded", NOW - 10_000)])).toEqual({
			state: "none",
		});
		expect(takeoverAttempt([failed, action("b", "queued", NOW - 10_000)])).toMatchObject({
			state: "in_flight",
			actionId: "b",
		});
	});

	test("order in the list doesn't matter: the newest by time decides", () => {
		const failed = action("a", "failed", NOW - 20_000, { error: "no" });
		const ok = action("b", "succeeded", NOW - 10_000);
		expect(takeoverAttempt([ok, failed])).toEqual({ state: "none" });
	});

	test("a failure with no usable error falls back to a sentence, and host text is cleaned", () => {
		expect(takeoverAttempt([action("a", "failed", NOW, { error: null })])).toMatchObject({
			reason: TAKEOVER_FAILURE_FALLBACK,
		});
		expect(
			takeoverAttempt([action("a", "failed", NOW, { error: "bad‮text\u0000here" })]),
		).toMatchObject({ reason: "badtext here" });
	});
});

function probe(over: Partial<Session> = {}): Session {
	return {
		sessionId: "s1",
		agentType: "codex_cli",
		isArchived: false,
		isWorking: false,
		managedSession: null,
		managed: false,
		lastActivityAt: ago(2 * 60 * MIN),
		metadata: {},
		cwd: "/work/repo",
		ownerUserId: null,
		...over,
	} as unknown as Session;
}

describe("takeoverEligibility: display only, the server decides", () => {
	test("never for Claude, Copilot, an archived session, or one AgentPulse already runs", () => {
		for (const over of [
			{ agentType: "claude_code" },
			{ agentType: "copilot_cli" },
			{ isArchived: true },
			{ managed: true },
			{ managedSession: { managedState: "managed" } },
		]) {
			expect(takeoverEligibility(probe(over as Partial<Session>), NOW)).toEqual({
				kind: "unavailable",
			});
		}
	});

	test("a finished session quiet for under 5 minutes waits; at exactly 5 minutes it is eligible", () => {
		expect(takeoverEligibility(probe({ lastActivityAt: ago(5 * MIN - 1) }), NOW)).toEqual({
			kind: "quiet_wait",
		});
		expect(takeoverEligibility(probe({ lastActivityAt: ago(5 * MIN) }), NOW)).toEqual({
			kind: "eligible",
		});
	});

	test("working under 5 minutes shows nothing", () => {
		expect(
			takeoverEligibility(probe({ isWorking: true, lastActivityAt: ago(5 * MIN - 1) }), NOW),
		).toEqual({ kind: "unavailable" });
	});

	test("working and quiet for 5 to 60 minutes says when AgentPulse last heard; from 60 minutes it is eligible", () => {
		const last = ago(5 * MIN);
		expect(takeoverEligibility(probe({ isWorking: true, lastActivityAt: last }), NOW)).toEqual({
			kind: "stale_working",
			lastHeardAt: last,
		});
		expect(
			takeoverEligibility(probe({ isWorking: true, lastActivityAt: ago(60 * MIN - 1) }), NOW),
		).toMatchObject({ kind: "stale_working" });
		expect(
			takeoverEligibility(probe({ isWorking: true, lastActivityAt: ago(60 * MIN) }), NOW),
		).toEqual({ kind: "eligible" });
	});

	test("an outstanding permission wait counts as waiting, the same way", () => {
		const waiting = { permissionWait: { ids: ["t1"], anon: 0, prevStatus: null } };
		expect(
			takeoverEligibility(probe({ metadata: waiting, lastActivityAt: ago(4 * MIN) }), NOW),
		).toEqual({ kind: "unavailable" });
		expect(
			takeoverEligibility(probe({ metadata: waiting, lastActivityAt: ago(30 * MIN) }), NOW),
		).toMatchObject({ kind: "stale_working" });
		expect(
			takeoverEligibility(probe({ metadata: waiting, lastActivityAt: ago(61 * MIN) }), NOW),
		).toEqual({ kind: "eligible" });
		const anon = { permissionWait: { ids: [], anon: 2, prevStatus: null } };
		expect(
			takeoverEligibility(probe({ metadata: anon, lastActivityAt: ago(30 * MIN) }), NOW),
		).toMatchObject({ kind: "stale_working" });
	});

	test("an unreadable activity time shows nothing: the server would call the session active", () => {
		expect(takeoverEligibility(probe({ lastActivityAt: "garbage" }), NOW)).toEqual({
			kind: "unavailable",
		});
	});
});

function host(id: string, over: Partial<SupervisorRecord> = {}): SupervisorRecord {
	return {
		id,
		hostName: id,
		platform: "darwin",
		arch: "arm64",
		version: "1",
		capabilities: { version: 1, features: [RESUMES_SESSIONS] },
		trustedRoots: ["/work"],
		status: "connected",
		heartbeatLeaseExpiresAt: new Date(NOW + 60_000).toISOString(),
		enrollmentState: "active",
		ownerUserId: null,
		...over,
	} as unknown as SupervisorRecord;
}
const SOLO = ownershipUi("solo", { effectiveRole: "member" });
const TEAM_MEMBER = ownershipUi("team", { effectiveRole: "member" });
const TEAM_ADMIN = ownershipUi("team", { effectiveRole: "admin" });
const SESSION = { ownerUserId: null, cwd: "/work/repo" };

describe("bindableHosts: usable hosts, disabled options with reasons, none preselected", () => {
	const solo = (hosts: SupervisorRecord[], session = SESSION) =>
		bindableHosts(hosts, {
			ui: SOLO,
			viewerUserId: null,
			isAdmin: true,
			session,
			now: NOW,
		});

	test("a live current host is usable; offline and old hosts are listed disabled, with the reason in the label", () => {
		const result = solo([
			host("mac"),
			host("off", { heartbeatLeaseExpiresAt: new Date(NOW - 1).toISOString() }),
			host("old", { capabilities: { version: 1, features: [] } } as Partial<SupervisorRecord>),
		]);
		expect(result.usable).toBe(1);
		expect(result.options.map((o) => [o.id, o.disabled, o.label])).toEqual([
			["mac", false, "mac"],
			["off", true, "off (offline)"],
			["old", true, "old (needs a supervisor update)"],
		]);
	});

	test("a directory outside the host's trusted roots is a disabled option, not a hidden one", () => {
		const result = solo([host("mac", { trustedRoots: ["/elsewhere"] })]);
		expect(result.options).toMatchObject([
			{ id: "mac", disabled: true, label: "mac (doesn't allow this directory)" },
		]);
		expect(result.usable).toBe(0);
		expect(solo([host("mac")], { ownerUserId: null, cwd: "/workshop/x" }).options[0]?.disabled).toBe(
			true,
		);
		expect(solo([host("mac")], { ownerUserId: null, cwd: "/work/../etc" }).options[0]?.disabled).toBe(
			true,
		);
		expect(solo([host("mac")], { ownerUserId: null, cwd: "/work" }).options[0]?.disabled).toBe(
			false,
		);
	});

	test("a revoked or not-yet-enrolled host is not offered at all", () => {
		const result = solo([
			host("a", { enrollmentState: "revoked" }),
			host("b", { enrollmentState: "pending" }),
		]);
		expect(result.options).toEqual([]);
	});

	test("an empty list is empty: the card gives the setup line instead of a dead control", () => {
		expect(solo([])).toEqual({ options: [], usable: 0 });
	});

	test("an admin isn't offered a host the server would refuse as host_owner_mismatch", () => {
		const result = bindableHosts(
			[host("theirs", { ownerUserId: "bob" }), host("mine", { ownerUserId: "alice" })],
			{
				ui: TEAM_ADMIN,
				viewerUserId: "root",
				isAdmin: true,
				session: { ownerUserId: "alice", cwd: "/work/repo" },
				now: NOW,
			},
		);
		expect(result.options.map((o) => o.id)).toEqual(["mine"]);
	});

	test("an admin may use any host, an unowned one included, for an unowned session", () => {
		const result = bindableHosts([host("a", { ownerUserId: "bob" }), host("b")], {
			ui: TEAM_ADMIN,
			viewerUserId: "root",
			isAdmin: true,
			session: { ownerUserId: null, cwd: "/work/repo" },
			now: NOW,
		});
		expect(result.options.map((o) => o.id)).toEqual(["a", "b"]);
	});

	test("a member sees only their own hosts, including offline ones as disabled options", () => {
		const result = bindableHosts(
			[
				host("mine", { ownerUserId: "alice" }),
				host("mine-off", {
					ownerUserId: "alice",
					heartbeatLeaseExpiresAt: new Date(NOW - 5).toISOString(),
				}),
				host("shared"),
				host("theirs", { ownerUserId: "bob" }),
			],
			{
				ui: TEAM_MEMBER,
				viewerUserId: "alice",
				isAdmin: false,
				session: { ownerUserId: "alice", cwd: "/work/repo" },
				now: NOW,
			},
		);
		expect(result.options.map((o) => [o.id, o.disabled])).toEqual([
			["mine", false],
			["mine-off", true],
		]);
	});

	test("the session's reported machine never filters or preselects: no option is chosen for the person", () => {
		const hosts = [host("a"), host("b")];
		const result = bindableHosts(hosts, {
			ui: SOLO,
			viewerUserId: null,
			isAdmin: true,
			session: { ownerUserId: null, cwd: "/work/repo", reportedHost: "b", machine: "b" } as never,
			now: NOW,
		});
		expect(result.options.map((o) => o.id)).toEqual(["a", "b"]);
		expect(JSON.stringify(result)).not.toContain("selected");
		expect(JSON.stringify(result)).not.toContain("default");
	});
});

describe("the dialog's words", () => {
	const base = {
		sessionName: "fix the tests",
		owner: null,
		ownerName: null,
		assigneeName: null,
		reportedHost: null,
		hostName: null,
		cwd: "/work/repo",
		team: false,
		viewerIsAdmin: true,
	};

	test("the lead says only continue if the session has ended, and names the exit-first step", () => {
		const lines = takeoverDialogLines(base);
		expect(lines.lead).toBe(
			"Only continue if this session has ended on the machine it ran on. If it's still open in a terminal, exit it first. AgentPulse checks the machine too, but can't always tell.",
		);
		expect(lines.title).toBe("Take over fix the tests?");
		expect(lines.directory).toBe("Directory: /work/repo");
		expect(lines.whatHappens).toBe(
			"Codex will run on that machine. Commands and file changes ask for your approval here, and writes stay inside this directory. These settings stay with the session, even if you reopen it elsewhere later. Anyone who can already send prompts to your sessions, including API keys you've issued, can send them to this one. You can stop it from here, but a stopped session can't be taken over again.",
		);
	});

	test("the reported machine is a sentence to check, or says none was reported", () => {
		expect(takeoverDialogLines({ ...base, reportedHost: "studio" }).reportedHostNote).toBe(
			"This session's events named studio. That name isn't verified, so check it yourself.",
		);
		expect(takeoverDialogLines(base).reportedHostNote).toBe(
			"This session didn't report a machine name.",
		);
	});

	test("an admin on someone else's session, and on an unowned one, each get their line; solo gets neither", () => {
		expect(
			takeoverDialogLines({ ...base, team: true, owner: "u2", ownerName: "Bob" }).adminNote,
		).toBe("This is Bob's session. It stays theirs, and they'll see that you took it over.");
		expect(takeoverDialogLines({ ...base, team: true, assigneeName: "Ann" }).adminNote).toBe(
			"This session has no owner, so it will belong to Ann from now on.",
		);
		expect(takeoverDialogLines(base).adminNote).toBeNull();
		expect(
			takeoverDialogLines({ ...base, team: true, owner: "u2", ownerName: "Bob", viewerIsAdmin: false })
				.adminNote,
		).toBeNull();
	});

	test("team mode adds the shared-account line, naming the chosen machine", () => {
		expect(takeoverDialogLines({ ...base, team: true, hostName: "studio" }).teamNote).toBe(
			"AgentPulse checks who reported this session, not who typed in it. If people share one account on studio, check that this is your session first.",
		);
		expect(takeoverDialogLines({ ...base, team: true }).teamNote).toContain(
			"If people share one account on that machine,",
		);
		expect(takeoverDialogLines(base).teamNote).toBeNull();
	});

	test("session names with markup stay as plain characters in the title", () => {
		expect(takeoverDialogLines({ ...base, sessionName: "<img src=x onerror=1>" }).title).toBe(
			"Take over <img src=x onerror=1>?",
		);
	});

	test("the confirm button says Take over until a machine is chosen, then names it", () => {
		expect(takeoverConfirmLabel(null)).toBe("Take over");
		expect(takeoverConfirmLabel("studio")).toBe("Take over on studio");
	});
});

describe("refusals in the dialog: every code the routes can answer has a sentence", () => {
	const refuse = (code: string, kind: ResumeKind = "takeover") =>
		bindRefusalMessage(new ApiError(409, code, { error: code }), { host: "studio", kind });

	test("the whole union has copy, for both kinds, and none falls through to the unknown-code sentence", () => {
		const unknown = bindRefusalMessage(new ApiError(500, "boom", { error: "zzz_not_a_code" }), {
			host: "studio",
			kind: "takeover",
		});
		for (const kind of ["takeover", "recovery"] as const) {
			for (const code of RESUME_REFUSAL_CODES) {
				const out = refuse(code, kind);
				expect(out.length).toBeGreaterThan(10);
				expect(out).not.toBe(unknown);
			}
			for (const code of ["invalid_body", "payload_too_large", "unsupported_media_type"]) {
				expect(refuse(code, kind)).not.toBe(unknown);
			}
		}
	});

	test("no sentence shows the raw code or uses the word bind", () => {
		for (const code of [...RESUME_REFUSAL_CODES, "invalid_body", "payload_too_large"]) {
			for (const kind of ["takeover", "recovery"] as const) {
				const out = refuse(code, kind);
				expect(out).not.toContain(code);
				expect(out.toLowerCase()).not.toMatch(/\bbind|\bbound\b/);
			}
		}
	});

	test("the plan's literal sentences", () => {
		expect(refuse("session_active")).toBe(
			"This session looks active: AgentPulse heard from it in the last 5 minutes, or it hasn't finished a turn. Exit it there and try again in a few minutes. A session that crashed becomes available about an hour after its last activity.",
		);
		expect(refuse("already_managed")).toBe(
			"AgentPulse already has a record of running this session, so it can't be taken over.",
		);
		expect(refuse("session_id_unsupported")).toBe(
			"This session's ID isn't in a form AgentPulse can resume, so it can't be taken over.",
		);
		expect(refuse("agent_not_supported")).toBe(
			"AgentPulse can only take over Codex sessions for now.",
		);
		expect(refuse("cwd_unknown")).toBe(
			"This session never reported a directory, so it can't be taken over.",
		);
		expect(refuse("cwd_not_trusted")).toBe(
			"studio doesn't allow this session's directory. Its trusted roots are listed on Hosts.",
		);
		expect(refuse("host_owner_mismatch")).toBe(
			"studio belongs to someone other than this session's owner. Change the session's owner first, or choose a host of theirs.",
		);
		expect(refuse("host_not_allowed")).toBe(
			"You can't use that machine. Choose one of your own, or ask an admin.",
		);
		expect(refuse("not_owner")).toBe("Only an admin can take over a session with no owner.");
		expect(refuse("session_not_found")).toBe("This session isn't available.");
		expect(refuse("host_offline")).toBe(
			"studio is offline, so nothing was started. Try again when it's back, or choose another machine.",
		);
		expect(refuse("host_gone")).toBe("studio was removed from AgentPulse. Choose another machine.");
		expect(refuse("host_upgrade_required")).toBe(
			"studio is running an older supervisor that can't take over sessions. Update it, then try again.",
		);
		expect(refuse("session_key_mismatch")).toBe(
			"This session was reported by a key that isn't tied to studio. Ask an admin to take it over.",
		);
		expect(refuse("rate_limited")).toBe("Too many attempts. Try again in a minute.");
		expect(refuse("takeover_in_progress")).toBe(
			"This session is being taken over. Try again when that's finished.",
		);
		expect(refuse("human_required")).toBe(
			"Taking over a session needs a signed-in person, not an API key.",
		);
		expect(refuse("retry_not_available")).toBe(
			"This session was taken over, not launched, so it can't be retried. Send it a prompt, or start a new session.",
		);
		expect(refuse("host_cannot_run_codex")).toContain("studio can't run Codex sessions");
		expect(refuse("not_resumable", "recovery")).toBe(
			"AgentPulse can't confirm this session can be resumed on studio. Start a new session for this work.",
		);
	});

	test("recovery doesn't offer another machine, which would be false for a session with one host", () => {
		expect(refuse("host_offline", "recovery")).toBe(
			"studio is offline, so nothing was started. Try again when it's back.",
		);
		expect(refuse("host_gone", "recovery")).not.toContain("Choose another machine");
		expect(refuse("host_upgrade_required", "recovery")).toBe(
			"studio is running an older supervisor that can't resume sessions. Update it, then try again.",
		);
	});

	test("a failure that isn't a known refusal gets the caller's own fallback, never a code or a stack", () => {
		const out = bindRefusalMessage(new TypeError("Failed to fetch"), {
			host: "studio",
			kind: "takeover",
		});
		expect(out).toBe("Couldn't reach AgentPulse. Check your connection and try again.");
		expect(out).not.toContain("Failed to fetch");
	});
});

describe("failures from the host come verbatim from the shared words", () => {
	// The action's `error` is built by resumeFailureMessage on the server; the card prints it. These pin
	// the sentences the plan lists, so a change on either side shows up here.
	test("held_by_daemon has no copy and is not a failure kind", () => {
		expect(RESUME_FAILURE_KINDS as readonly string[]).not.toContain("held_by_daemon");
	});

	test("a card prints the action's error for each kind, takeover and recovery, with the plan's words", async () => {
		const { resumeFailureMessage } = await import("../../../shared/session-resume.js");
		const takeover = (k: (typeof RESUME_FAILURE_KINDS)[number]) =>
			resumeFailureMessage(k, "studio", "takeover");
		const recovery = (k: (typeof RESUME_FAILURE_KINDS)[number]) =>
			resumeFailureMessage(k, "studio", "recovery");
		expect(takeover("missing")).toBe(
			"studio can't find this session's history, so it wasn't taken over. It probably ran on another machine or under another account.",
		);
		expect(takeover("running")).toContain("codex app-server daemon stop");
		expect(takeover("running")).toContain("which also stops anything else running through that service");
		expect(takeover("cwd_mismatch")).toContain("so it wasn't taken over");
		expect(takeover("privileges")).toContain("required approval settings");
		expect(takeover("unsupported_codex")).toContain("Update Codex on studio");
		expect(takeover("reports_pending")).toBe(
			"studio is still sending earlier reports for this session. Try again in a few seconds.",
		);
		expect(takeover("reports_held")).toContain("~/.agentpulse/supervisor-outbox/");
		expect(takeover("project_config")).toContain(".codex/config.toml");
		expect(takeover("timeout")).toBe(
			"studio didn't answer in time, so the session wasn't taken over. Check that the machine is awake, then try again.",
		);
		expect(takeover("restart")).toBe(
			"studio restarted before it finished, so the session wasn't taken over. Try again.",
		);
		expect(takeover("rejected")).toBe(
			"studio couldn't start this session, so it wasn't taken over. Its supervisor log has the reason.",
		);
		expect(recovery("missing")).toContain("Start a new session for this work.");
		expect(recovery("timeout")).toBe(
			"studio didn't answer in time, so the session wasn't resumed. Try again.",
		);
		expect(recovery("thread_unverified")).toBe(takeover("thread_unverified"));
		expect(RESUME_REFUSED_MESSAGE.takeover("studio")).toContain("refused this session");
		expect(RESUME_REFUSED_MESSAGE.recovery("studio")).toBe(
			"studio refused to resume this session. Its supervisor log has the reason.",
		);
		for (const kind of RESUME_FAILURE_KINDS) {
			expect(takeover(kind).length).toBeGreaterThan(20);
			expect(recovery(kind).length).toBeGreaterThan(20);
		}
	});
});

describe("takeoverProgress: the words while the host works", () => {
	const started = (ms: number) => new Date(NOW - ms).toISOString();
	test("asking the host, then, after 20 seconds, that it can take a minute and a half", () => {
		expect(takeoverProgress("takeover", "studio", started(19_999), NOW)).toBe(
			"Asking studio to take over this session…",
		);
		expect(takeoverProgress("takeover", "studio", started(20_000), NOW)).toBe(TAKEOVER_STILL_WAITING("studio"));
		expect(TAKEOVER_STILL_WAITING("studio")).toBe(
			"Still no answer from studio. This can take about a minute and a half. You can leave this page.",
		);
		expect(takeoverProgress("recovery", "studio", started(1), NOW)).toBe(
			"Asking studio to resume this session…",
		);
	});

	test("a host with no name reads as 'the host'", () => {
		expect(takeoverProgress("takeover", null, started(1), NOW)).toBe(
			"Asking the host to take over this session…",
		);
	});
});

describe("takeoverCardView: which card, and with what words", () => {
	const hostsReady = (options: ReturnType<typeof bindableHosts>) => ({
		state: "ready" as const,
		...options,
	});
	const one = hostsReady({
		usable: 1,
		options: [{ id: "a", name: "a", disabled: false, reason: null, label: "a" }],
	});
	const input = (over: Record<string, unknown> = {}) => ({
		session: probe(),
		attempt: { state: "none" as const },
		canBind: true,
		team: false,
		viewerIsAdmin: true,
		hosts: one,
		now: NOW,
		formatTime: () => "10:00",
		...over,
	});

	test("hidden for a session that can't be taken over, and for a viewer who may not and isn't told", () => {
		expect(takeoverCardView(input({ session: probe({ agentType: "claude_code" }) }))).toEqual({
			kind: "hidden",
		});
		expect(
			takeoverCardView(
				input({
					canBind: false,
					team: true,
					viewerIsAdmin: false,
					session: probe({ ownerUserId: "u2" }),
				}),
			),
		).toEqual({ kind: "hidden" });
	});

	test("eligible, with the plan's sentence, and a failure above it when the last attempt failed", () => {
		expect(takeoverCardView(input())).toEqual({
			kind: "eligible",
			text: "Started outside AgentPulse. Once it has ended, a connected machine can take it over so you can send prompts here.",
			failure: null,
		});
		expect(
			takeoverCardView(input({ attempt: { state: "failed", actionId: "x", kind: "takeover", reason: "no" } })),
		).toMatchObject({ kind: "eligible", failure: "no" });
	});

	test("finished and quiet under 5 minutes, and working but quiet for a while, are sentences with no control", () => {
		expect(takeoverCardView(input({ session: probe({ lastActivityAt: ago(MIN) }) }))).toEqual({
			kind: "info",
			text: "You can take this session over here once it's been quiet for 5 minutes.",
			failure: null,
		});
		const last = ago(10 * MIN);
		expect(
			takeoverCardView(input({ session: probe({ isWorking: true, lastActivityAt: last }) })),
		).toEqual({
			kind: "info",
			text: "AgentPulse last heard from this session at 10:00. If it crashed, you can take it over about an hour after that.",
			failure: null,
		});
	});

	test("no usable machine: the setup line in solo, the host-of-your-own line in team for a member", () => {
		const none = hostsReady({ usable: 0, options: [] });
		expect(takeoverCardView(input({ hosts: none }))).toMatchObject({
			kind: "no_host",
			text: TAKEOVER_NO_HOST_SOLO,
			setupLink: true,
		});
		expect(TAKEOVER_NO_HOST_SOLO).toBe(
			"To send prompts here, this session's machine needs the AgentPulse supervisor running.",
		);
		expect(
			takeoverCardView(input({ hosts: none, team: true, viewerIsAdmin: false })),
		).toMatchObject({ kind: "no_host", text: TAKEOVER_NO_HOST_TEAM, setupLink: false });
		expect(TAKEOVER_NO_HOST_TEAM).toBe(
			"To take this over, you need a connected host of your own. An admin can use a shared one.",
		);
	});

	test("a member on an unowned session is told only an admin can; an owned session of someone else says nothing", () => {
		expect(
			takeoverCardView(
				input({
					canBind: false,
					team: true,
					viewerIsAdmin: false,
					session: probe({ ownerUserId: "u2" }),
				}),
			),
		).toEqual({ kind: "hidden" });
		expect(
			takeoverCardView(input({ canBind: false, team: true, viewerIsAdmin: false })),
		).toEqual({ kind: "info", text: TAKEOVER_NOT_ADMIN, failure: null });
		expect(
			takeoverCardView(
				input({
					canBind: false,
					team: true,
					viewerIsAdmin: false,
					session: probe({ lastActivityAt: ago(MIN) }),
				}),
			),
		).toEqual({ kind: "hidden" });
		expect(TAKEOVER_NOT_ADMIN).toBe("Only an admin can take over a session with no owner.");
	});

	test("the hosts are still loading, or failed to load: the card says so and the control waits", () => {
		expect(takeoverCardView(input({ hosts: { state: "loading" } }))).toMatchObject({
			kind: "eligible",
			hostsState: "loading",
		});
		expect(takeoverCardView(input({ hosts: { state: "error" } }))).toMatchObject({
			kind: "eligible",
			hostsState: "error",
		});
	});

	test("the plan's wording never reaches the page as 'bind'", () => {
		const views = [
			takeoverCardView(input()),
			takeoverCardView(input({ session: probe({ lastActivityAt: ago(MIN) }) })),
		];
		expect(JSON.stringify(views).toLowerCase()).not.toMatch(/\bbind/);
	});
});

describe("bottomSlot: what sits where the prompt box would", () => {
	const inFlight = (kind: ResumeKind) => ({
		state: "in_flight" as const,
		actionId: "a",
		kind,
		startedAt: new Date(NOW).toISOString(),
	});
	const none = { state: "none" as const };

	test("an observed Codex session gets the takeover card's slot, and a managed one the composer's", () => {
		expect(bottomSlot(probe(), none)).toBe("takeover");
		expect(bottomSlot(probe({ managedSession: { managedState: "managed" } as never }), none)).toBe(
			"composer",
		);
	});

	test("a takeover in flight shows its progress instead of the composer, whatever managedSession says", () => {
		for (const managedSession of [null, { managedState: "pending" }, { managedState: "managed" }]) {
			expect(bottomSlot(probe({ managedSession: managedSession as never }), inFlight("takeover"))).toBe(
				"takeover_progress",
			);
		}
	});

	test("a recovery in flight keeps the composer's slot, so a draft in it survives", () => {
		expect(
			bottomSlot(probe({ managedSession: { managedState: "degraded" } as never }), inFlight("recovery")),
		).toBe("composer");
	});

	test("the status hint (Managed Codex, a pending pill) is hidden only while a takeover is in flight", () => {
		expect(showsStatusHint(inFlight("takeover"))).toBe(false);
		expect(showsStatusHint(inFlight("recovery"))).toBe(true);
		expect(showsStatusHint(none)).toBe(true);
	});
});

describe("labels on a taken-over session", () => {
	test("keyed on the managed session's host affinity, and on nothing a launched session has", () => {
		expect(isTakenOver({ hostAffinityReason: "taken_over" })).toBe(true);
		expect(isTakenOver({ hostAffinityReason: "launched" })).toBe(false);
		expect(isTakenOver({ hostAffinityReason: null })).toBe(false);
		expect(isTakenOver(null)).toBe(false);
		expect(isTakenOver(undefined)).toBe(false);
	});

	test("Overview: 'Taken over by' reads the person who pressed the button, not the launch row's owner", () => {
		const launch = { requestedByUserId: "owner", metadata: { boundByUserId: "admin" } };
		expect(overviewOriginField(true, launch)).toEqual({ label: "Taken over by", userId: "admin" });
	});

	test("Overview: a taken-over session with no recorded person shows no field rather than the owner", () => {
		expect(overviewOriginField(true, { requestedByUserId: "owner", metadata: {} })).toBeNull();
		expect(overviewOriginField(true, { requestedByUserId: "owner", metadata: null })).toBeNull();
	});

	test("negative control: a launched session keeps 'Launched by' and its requester", () => {
		const launch = { requestedByUserId: "alice", metadata: { boundByUserId: "ignored" } };
		expect(overviewOriginField(false, launch)).toEqual({ label: "Launched by", userId: "alice" });
		expect(overviewOriginField(false, { requestedByUserId: null, metadata: null })).toBeNull();
	});

	test("Launch tab: 'Taken over · Codex' replaces the launch status; a launch keeps its own line", () => {
		expect(launchSummaryLine(true, "completed", "Managed Codex")).toBe("Taken over · Codex");
		expect(launchSummaryLine(false, "completed", "Headless task")).toBe("completed · Headless task");
	});
});
