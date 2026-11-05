import { describe, expect, test } from "bun:test";
import { privilegeCliArgs } from "./launch-privileges.js";
import {
	RESUMES_SESSIONS,
	RESUME_FAILURE_KINDS,
	RESUME_REFUSAL_CODES,
	RESUME_REFUSED_MESSAGE,
	type ResumeFailureKind,
	type ResumeKind,
	TAKEOVER_IN_PROGRESS_MESSAGE,
	TAKEOVER_PRIVILEGES,
	hostCannotRunCodexMessage,
	isResumableSessionId,
	resumeFailureMessage,
} from "./session-resume.js";

const HOST = "build-box";
const COMMAND_TAIL =
	"Exit it there. If its window is closed, run `codex app-server daemon stop` on build-box, which also stops anything else running through that service, and try again.";

describe("isResumableSessionId", () => {
	test("accepts a lowercase UUID of any version Codex or randomUUID mints", () => {
		expect(isResumableSessionId("0199c7a4-5b3e-7c2d-8f10-a1b2c3d4e5f6")).toBe(true);
		expect(isResumableSessionId("2f1b6c1e-8d3a-4a57-9c0e-5b7f3a9d1e42")).toBe(true);
	});

	test.each([
		["empty", ""],
		["a leading dash", "-x"],
		["a traversal", "../a"],
		["uppercase", "2F1B6C1E-8D3A-4A57-9C0E-5B7F3A9D1E42"],
		["a trailing newline", "2f1b6c1e-8d3a-4a57-9c0e-5b7f3a9d1e42\n"],
		["a leading space", " 2f1b6c1e-8d3a-4a57-9c0e-5b7f3a9d1e42"],
		["a missing group", "2f1b6c1e-8d3a-4a57-9c0e5b7f3a9d1e42"],
		["a non-hex digit", "2f1b6c1e-8d3a-4a57-9c0e-5b7f3a9d1e4g"],
		["version 0", "2f1b6c1e-8d3a-0a57-9c0e-5b7f3a9d1e42"],
		["version 9", "2f1b6c1e-8d3a-9a57-9c0e-5b7f3a9d1e42"],
		["a bad variant", "2f1b6c1e-8d3a-4a57-ec0e-5b7f3a9d1e42"],
		["a path suffix", "2f1b6c1e-8d3a-4a57-9c0e-5b7f3a9d1e42/../x"],
	])("refuses %s", (_name, id) => {
		expect(isResumableSessionId(id)).toBe(false);
	});
});

describe("TAKEOVER_PRIVILEGES", () => {
	test("is untrusted + workspace-write, and maps to the Codex flags a takeover is checked against", () => {
		expect(TAKEOVER_PRIVILEGES).toEqual({
			approvalPolicy: "untrusted",
			sandboxMode: "workspace-write",
		});
		expect(
			privilegeCliArgs(
				"codex_cli",
				TAKEOVER_PRIVILEGES.approvalPolicy,
				TAKEOVER_PRIVILEGES.sandboxMode,
			),
		).toEqual(["--sandbox", "workspace-write", "--ask-for-approval", "untrusted"]);
	});
});

test("the feature name is the one the plan names", () => {
	expect(RESUMES_SESSIONS).toBe("resumes_sessions");
});

test("the refusal-code union is exactly the plan's list, so a code without copy can't slip in", () => {
	expect([...(RESUME_REFUSAL_CODES as readonly string[])].sort()).toEqual(
		[
			"agent_not_supported",
			"already_managed",
			"cwd_not_trusted",
			"cwd_unknown",
			"host_cannot_run_codex",
			"host_gone",
			"host_not_allowed",
			"host_offline",
			"host_owner_mismatch",
			"host_upgrade_required",
			"human_required",
			"not_owner",
			"not_resumable",
			"rate_limited",
			"retry_not_available",
			"session_active",
			"session_id_unsupported",
			"session_key_mismatch",
			"session_not_found",
			"takeover_in_progress",
		].sort(),
	);
	expect(RESUME_REFUSAL_CODES.some((code) => (code as string) === "held_by_daemon")).toBe(false);
});

describe("resumeFailureMessage, takeover", () => {
	const takeover: Record<string, string> = {
		missing:
			"build-box can't find this session's history, so it wasn't taken over. It probably ran on another machine or under another account.",
		running: `Codex on build-box still holds this session, so it wasn't taken over. ${COMMAND_TAIL}`,
		cwd_mismatch:
			"This session's recorded directory doesn't match build-box's, so it wasn't taken over. It may have run on another machine.",
		privileges:
			"build-box wouldn't run this session under the required approval settings, so it wasn't taken over.",
		unsupported_codex:
			"build-box's Codex version isn't one AgentPulse can answer approvals for, so the session wasn't taken over. Update Codex on build-box.",
		reports_pending:
			"build-box is still sending earlier reports for this session. Try again in a few seconds.",
		reports_held:
			"build-box has earlier reports for this session that it can't send, so nothing was started. Its supervisor log names the folder under `~/.agentpulse/supervisor-outbox/`.",
		project_config:
			"This session's directory has its own Codex settings (a .codex/config.toml file), which Codex would apply, so it wasn't taken over. Remove that file on build-box, then try again.",
		timeout:
			"build-box didn't answer in time, so the session wasn't taken over. Check that the machine is awake, then try again.",
		restart: "build-box restarted before it finished, so the session wasn't taken over. Try again.",
		rejected:
			"build-box couldn't start this session, so it wasn't taken over. Its supervisor log has the reason.",
		host_upgrade_required:
			"build-box is running an older supervisor that can't take over sessions. Update it, then try again.",
	};
	for (const [kind, sentence] of Object.entries(takeover)) {
		test(`${kind}`, () => {
			expect(resumeFailureMessage(kind as ResumeFailureKind, HOST, "takeover")).toBe(sentence);
		});
	}
});

describe("resumeFailureMessage, recovery", () => {
	const recovery: Record<string, string> = {
		restart: "build-box restarted before it finished, so the session wasn't resumed. Try again.",
		timeout: "build-box didn't answer in time, so the session wasn't resumed. Try again.",
		missing:
			"build-box no longer has this session's history, so it can't be resumed. Start a new session for this work.",
		running: `Codex on build-box still holds this session, so it wasn't resumed. ${COMMAND_TAIL}`,
		cwd_mismatch:
			"This session's directory on build-box has changed, so it wasn't resumed. Start a new session for this work.",
		privileges:
			"build-box wouldn't run this session under its approval settings, so it wasn't resumed.",
		thread_unverified:
			"AgentPulse can't confirm this session can be resumed on build-box. Start a new session for this work.",
		rejected:
			"build-box couldn't start this session, so it wasn't resumed. Its supervisor log has the reason.",
		host_upgrade_required:
			"build-box is running an older supervisor that can't resume sessions. Update it, then try again.",
		reports_pending:
			"build-box is still sending earlier reports for this session. Try again in a few seconds.",
		reports_held:
			"build-box has earlier reports for this session that it can't send, so nothing was started. Its supervisor log names the folder under `~/.agentpulse/supervisor-outbox/`.",
	};
	for (const [kind, sentence] of Object.entries(recovery)) {
		test(`${kind}`, () => {
			expect(resumeFailureMessage(kind as ResumeFailureKind, HOST, "recovery")).toBe(sentence);
		});
	}

	test("reports_held reads the same for both kinds", () => {
		expect(resumeFailureMessage("reports_held", HOST, "takeover")).toBe(
			resumeFailureMessage("reports_held", HOST, "recovery"),
		);
	});

	test("a Codex the approvals can't be answered on only fails a takeover, so a recovery reads as a refused resume", () => {
		expect(resumeFailureMessage("unsupported_codex", HOST, "recovery")).toBe(
			resumeFailureMessage("rejected", HOST, "recovery"),
		);
	});

	test("project_config applies to a recovery too, in resumed words", () => {
		expect(resumeFailureMessage("project_config", HOST, "recovery")).toBe(
			"This session's directory has its own Codex settings (a .codex/config.toml file), which Codex would apply, so it wasn't resumed. Remove that file on build-box, then try again.",
		);
	});
});

describe("RESUME_REFUSED_MESSAGE", () => {
	test("one sentence per resume kind, built from the host's name alone", () => {
		expect(RESUME_REFUSED_MESSAGE.takeover(HOST)).toBe(
			"build-box refused this session, so it wasn't taken over. Check that it's the machine the session ran on and that the session has ended there. Its supervisor log has the reason.",
		);
		expect(RESUME_REFUSED_MESSAGE.recovery(HOST)).toBe(
			"build-box refused to resume this session. Its supervisor log has the reason.",
		);
		expect(RESUME_REFUSED_MESSAGE.takeover.length).toBe(1);
		expect(RESUME_REFUSED_MESSAGE.recovery.length).toBe(1);
	});
});

test("every failure kind has words for both resume kinds, and none says 'held by daemon'", () => {
	const kinds: ResumeKind[] = ["takeover", "recovery"];
	for (const kind of RESUME_FAILURE_KINDS) {
		for (const resumeKind of kinds) {
			const text = resumeFailureMessage(kind, HOST, resumeKind);
			expect(text.length).toBeGreaterThan(10);
			expect(text).toContain(HOST);
		}
	}
	expect((RESUME_FAILURE_KINDS as readonly string[]).includes("held_by_daemon")).toBe(false);
});

test("the words for a host that can't run Codex, and for delete during a takeover", () => {
	expect(hostCannotRunCodexMessage(HOST)).toBe(
		"build-box can't run Codex sessions: Codex isn't set up there, or it doesn't support managed Codex sessions. Choose another machine.",
	);
	expect(TAKEOVER_IN_PROGRESS_MESSAGE).toBe(
		"This session is being taken over. Try again when that's finished.",
	);
});
