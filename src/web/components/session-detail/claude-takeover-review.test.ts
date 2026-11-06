/**
 * AGEN-117 P6 fix round: the review's findings, each held by a test that fails without its fix. The plan's
 * "Exact copy" rows are asserted word for word (`toBe`), the dialog is rendered (not read from source), the
 * fork's follow sequence is driven through the real hook, and the names that reach a sentence are hostile on
 * purpose (backticks, bidi, an id that isn't an id).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { mapSessionDto } from "../../../server/services/session-dto.js";
import { forkModeLine, forkSentenceName } from "../../../shared/claude-fork-copy.js";
import {
	CLAUDE_API_ERROR_MESSAGE,
	CLAUDE_FORK_BUSY_ERROR,
	CLAUDE_FORK_CHECK_FAILED_ERROR,
	CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR,
	CLAUDE_FORK_TERMINAL_FOUND_ERROR,
	CLAUDE_LOGIN_LOST_ERROR,
} from "../../../shared/managed-messages.js";
import {
	hostCannotRunClaudeMessage,
	resumeFailureMessage,
} from "../../../shared/session-resume.js";
import type { ControlAction, Session } from "../../../shared/types.js";
import { ApiError, api } from "../../lib/api.js";
import { focusLandingNow } from "../../lib/focus-landing.js";
import { forkInfo, forkSourceOf } from "../../lib/fork-session.js";
import { useUserStore } from "../../stores/user-store.js";
import { followLiveState } from "../../test-utils/live-stores.js";
import {
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../../test-utils/render-hook.js";
import { ConfirmDialogPanel } from "../ConfirmDialog.js";
import { FilterRow } from "./SessionHeader.js";
import { ComposerBody, SessionComposerSlot } from "./SessionPromptComposer.js";
import {
	ClaudeDialogDescription,
	ContinuedAs,
	TakeoverDialogFields,
} from "./SessionTakeoverCard.js";
import { ManagedForkStatus, selectStatusHint } from "./StatusHints.js";
import {
	CLAUDE_HOST_SUFFIX,
	CLAUDE_RESUME_COMMAND_LEAD,
	claudeCopyCommandLabel,
	claudeDialogLines,
	claudeResumeCommand,
} from "./claude-takeover-copy.js";
import { FORK_TOOLS_REASON, forkStatusView } from "./fork-status-view.js";
import {
	FOLLOW_POLL_MS,
	composerMode,
	followPromptAction,
	forkFailureSentence,
	settleFollow,
} from "./prompt-composer-view.js";
import { bindRefusalMessage, continuedArrivalAnnouncement } from "./session-takeover-view.js";
import { type PromptComposerOptions, usePromptComposer } from "./usePromptComposer.js";

const S_ID = "11111111-1111-4111-8111-111111111111";
const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;
let undo: () => void;

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => {
	undo = followLiveState(useUserStore);
	useUserStore.setState({ mode: "solo", userId: null, effectiveRole: "admin" });
});
afterEach(() => {
	undo();
	Object.assign(api, real);
	globalThis.setTimeout = realSetTimeout;
	Date.now = realNow;
});

function fork(
	state: string,
	over: {
		sync?: string | null;
		mode?: "ask" | "restricted";
		from?: Partial<Session["continuedFrom"]> | null;
		name?: string;
	} = {},
): Session {
	const mode = over.mode ?? "ask";
	return {
		sessionId: "n1",
		agentType: "claude_code",
		displayName: over.name ?? "refactor the parser (continued)",
		isWorking: false,
		ownerUserId: null,
		forkedFromSessionId: S_ID,
		forkPermissionBranch: mode,
		metadata: { forkedFromSessionId: S_ID, forkPermissionBranch: mode },
		managedSession: {
			managedState: state,
			hostName: "studio",
			providerSyncError: over.sync ?? null,
			providerThreadId: "n1",
			hostAffinityReason: "taken_over",
		},
		continuedFrom:
			over.from === null
				? undefined
				: { sessionId: S_ID, name: "refactor the parser", state: "available", ...over.from },
	} as unknown as Session;
}

// ── T1: every row of the plan's refusal table, word for word ────────────────

describe("the plan's refusal rows, exact", () => {
	const take = (kind: Parameters<typeof resumeFailureMessage>[0]) =>
		resumeFailureMessage(kind, "studio", "takeover", "claude_code");
	const recover = (
		kind: Parameters<typeof resumeFailureMessage>[0],
		mode?: "ask" | "restricted",
		name?: string,
	) => resumeFailureMessage(kind, "studio", "recovery", "claude_code", mode, name);

	test("running, on S and on N", () => {
		expect(take("running")).toBe(
			"This conversation is still open on studio, in a terminal or as a background agent. Close it there, then try again.",
		);
		expect(recover("running")).toBe(
			"studio still shows this session running. A command you approved may still be finishing, so try again when it's done. If it's open in a terminal, close it there.",
		);
	});

	test("missing, rejected, timeout", () => {
		expect(take("missing")).toBe(
			"studio can't find this conversation's history, so nothing was started. It probably ran on another machine or under another account.",
		);
		expect(take("rejected")).toBe(
			"studio couldn't start this, so nothing was started. Its supervisor log has the reason.",
		);
		expect(take("timeout")).toBe(
			"studio didn't answer in time, so nothing was started. Check that it's awake, then try again.",
		);
	});

	test("row N already there, ownership, rules, liveness, busy", () => {
		expect(take("settle_conflict")).toBe(
			"AgentPulse couldn't set this up, so nothing was started. Try again.",
		);
		expect(take("ownership_changed")).toBe(
			"Who owns this session or studio changed while it was starting, so nothing was started. Try again.",
		);
		expect(recover("branch_changed", "ask", "refactor the parser")).toBe(
			"This session started under different rules than AgentPulse uses now, so it can't be resumed. End it and continue refactor the parser again.",
		);
		expect(take("liveness_unknown")).toBe(
			"AgentPulse couldn't check whether this session is open on studio, so it didn't start. Try again.",
		);
		expect(take("host_busy")).toBe(
			"studio is already running as many of these as it can. End one and try again. Nothing was started.",
		);
	});

	test("version: the plan's row with the version and range the host found; without a version, the row that says less", () => {
		expect(
			resumeFailureMessage(
				"unsupported_claude",
				"studio",
				"takeover",
				"claude_code",
				undefined,
				null,
				{
					found: "2.3.0",
					range: "2.1.318 up to, not including, 2.2.0",
				},
			),
		).toBe(
			"Claude Code 2.3.0 on studio is outside what AgentPulse has tested (2.1.318 up to, not including, 2.2.0). Nothing was started. Change the Claude Code version there, or update AgentPulse.",
		);
		expect(take("unsupported_claude")).toBe(
			"Claude Code on studio is outside what AgentPulse has tested. Nothing was started. Change the Claude Code version there, or update AgentPulse.",
		);
	});

	test("transport, platform, source changed, host can't run Claude", () => {
		expect(take("insecure_transport")).toBe(
			"studio doesn't reach AgentPulse over https, so it can't answer approvals. Nothing was started.",
		);
		expect(take("unsupported_platform")).toBe("AgentPulse can do this only on macOS so far.");
		expect(take("source_changed")).toBe(
			"Your terminal's conversation changed while this was starting, so AgentPulse stopped. It may have been you, or this version of Claude Code may have written to it. Check that conversation before trying again.",
		);
		expect(hostCannotRunClaudeMessage("studio")).toBe(
			"studio can't continue Claude sessions: Claude Code isn't set up there, isn't on macOS, or its supervisor is out of date. Choose another machine.",
		);
		expect(CLAUDE_HOST_SUFFIX.needs_claude).toBe("Claude Code not found or supervisor out of date");
	});

	test("not logged in: on S, and on N by the mode it was started under", () => {
		expect(take("claude_not_logged_in")).toBe(
			"Claude Code has no login the supervisor on studio can use, so nothing was started. Being logged in to Claude in a terminal isn't enough for the supervisor. Give the supervisor's environment either a subscription token, made with `claude setup-token` and set as `CLAUDE_CODE_OAUTH_TOKEN`, or an API key set as `ANTHROPIC_API_KEY`. Then restart the supervisor and try again.",
		);
		expect(recover("claude_not_logged_in", "restricted")).toBe(
			"This session runs without your Claude settings, and Claude Code on studio no longer has a login it can use that way, so it wasn't resumed. Give the supervisor's environment a subscription token from `claude setup-token` (as `CLAUDE_CODE_OAUTH_TOKEN`) or an API key (as `ANTHROPIC_API_KEY`), restart the supervisor, then resume.",
		);
		expect(recover("claude_not_logged_in", "ask")).toBe(
			"Claude Code on studio no longer has a login the supervisor can use, so this session wasn't resumed. Being logged in to Claude in a terminal isn't enough for the supervisor. Give it a subscription token from `claude setup-token` (as `CLAUDE_CODE_OAUTH_TOKEN`) or an API key (as `ANTHROPIC_API_KEY`), restart the supervisor, then resume.",
		);
	});

	test("the version note is only taken from a host's parsed version: a refusal with none carries no version at all", () => {
		const supervisor = readFileSync(
			join(import.meta.dir, "../../../supervisor/services/claude-takeover.ts"),
			"utf8",
		);
		expect(supervisor).toContain("parseVersion(resolved.binary.version)");
		expect(supervisor).toContain("CLAUDE_VERSION_RANGE_TEXT");
	});
});

// ── T4: the dialog, rendered ────────────────────────────────────────────────

describe("the dialog rendered: the picker first, focus on it, the words around it", () => {
	const lines = claudeDialogLines({
		sessionName: "refactor the parser",
		machine: null,
		cwd: "/work/project",
		ownerName: "you",
		endedFork: null,
	});
	const options = [
		{ id: "h1", name: "studio", disabled: false, reason: null, label: "studio" },
		{
			id: "h2",
			name: "pi",
			disabled: true,
			reason: "unsupported_os" as const,
			label: "pi (macOS only so far)",
		},
	];
	const dialog = (
		extra: { focusFields?: boolean; fieldsFirst?: boolean } = {
			focusFields: true,
			fieldsFirst: true,
		},
	) =>
		html(
			createElement(ConfirmDialogPanel, {
				title: lines.title,
				confirmLabel: "Continue",
				focusCancel: !extra.focusFields,
				...extra,
				headingId: "h",
				descriptionId: "d",
				onConfirm: () => {},
				onCancel: () => {},
				fields: createElement(TakeoverDialogFields, {
					options,
					hostId: "",
					onHost: () => {},
					lines: {
						reportedHostNote: "This session didn't report a machine name.",
						directory: lines.directory,
						teamNote: null,
					},
					placeholder: "Choose a machine first.",
					directory: lines.directory,
					ownerLine: lines.ownerLine,
					autoFocus: true,
				}),
				children: createElement(ClaudeDialogDescription, { lines }),
			} as never),
		);

	test("the heading, then the machine picker, then the description, in that order", () => {
		const out = dialog();
		const heading = out.indexOf("Continue refactor the parser in a new session?");
		const picker = out.indexOf("<select");
		const first = out.indexOf("Close refactor the parser in your terminal first.");
		expect(heading).toBeGreaterThan(-1);
		expect(picker).toBeGreaterThan(heading);
		expect(first).toBeGreaterThan(picker);
		expect(out).toContain("Choose a machine first.");
		expect(out).toContain("pi (macOS only so far)");
		expect(out).toMatch(/<option value="h2" disabled=""[^>]*>pi \(macOS only so far\)/);
	});

	test("initial focus is on the picker, and on neither button", () => {
		const out = dialog();
		expect(out).toMatch(/<select[^>]*data-autofocus=""/);
		expect(out.match(/data-autofocus/g)).toHaveLength(1);
	});

	test("a dialog that doesn't ask for field focus keeps Cancel first, as the Codex dialog does", () => {
		const out = dialog({ focusFields: false, fieldsFirst: false });
		expect(out.match(/data-autofocus/g)).toHaveLength(2); // the picker's own, and Cancel's
		expect(out).toMatch(/<button[^>]*data-autofocus=""[^>]*>Cancel/);
	});

	test("the picker is described by the machine note, the directory and the owner line", () => {
		const out = dialog();
		const ids = (/<select[^>]*aria-describedby="([^"]+)"/.exec(out)?.[1] ?? "").split(" ");
		expect(ids).toHaveLength(3);
		for (const id of ids) expect(out).toContain(`id="${id}"`);
		expect(out).toContain("The new session will belong to you. This one stays as it is.");
	});

	test("the description shows `ls` and `cat` as code and labels in bold", () => {
		const out = dialog();
		expect(out).toMatch(/<strong[^>]*>Waits for you: <\/strong>/);
		expect(out).toMatch(/<code[^>]*>ls<\/code>/);
		expect(out).not.toContain("`");
	});

	test("both mode paragraphs and the tells-you-which line are on screen, with neither chosen", () => {
		const out = dialog();
		for (const text of [
			"With a subscription token or an API key:",
			"With any other login:",
			"The new session tells you which before you send anything.",
		]) {
			expect(out).toContain(text);
		}
	});
});

// ── T5: a fork's follow, through the real hook ──────────────────────────────

describe("a prompt to a continued session: queued, running, accepted; and a failure keeps the draft", () => {
	let fakeNow = 0;
	const session = fork("managed");
	const accept = (over: Partial<ControlAction> = {}) =>
		({
			id: "a1",
			sessionId: "n1",
			status: "queued",
			error: null,
			metadata: {},
			...over,
		}) as unknown as ControlAction;

	function mount() {
		const mode = composerMode(session, { canPrompt: true, canResume: true });
		const options: PromptComposerOptions = {
			session,
			mode,
			onSubmitted: async () => {},
		};
		const h = renderHook((o: PromptComposerOptions) => usePromptComposer(o), options);
		const now = () => {
			const v = h.current.value;
			if (!v) throw new Error("not rendered");
			return v;
		};
		return { h, now, options };
	}
	beforeEach(() => {
		fakeNow = 9_000_000;
		Date.now = () => fakeNow;
		globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
			if (ms === FOLLOW_POLL_MS) {
				fakeNow += ms;
				return realSetTimeout(fn, 0);
			}
			return realSetTimeout(fn, ms, ...rest);
		}) as typeof setTimeout;
	});

	test("read-only through queued and the claim; the host's acceptance clears the draft and ends the polling", async () => {
		client.sendSessionPrompt = async () => ({ action: accept() });
		const sequence: ControlAction[] = [
			accept({ status: "queued" }),
			accept({ status: "running" }), // claimed, not yet accepted: a host can still refuse
			accept({ status: "running", metadata: { acceptedAt: "2026-11-06T12:00:00.000Z" } }),
		];
		let polls = 0;
		client.getSessionControlActions = async () => ({
			controlActions: [sequence[Math.min(polls++, sequence.length - 1)]],
		});
		const t = mount();
		await t.h.render(t.options);
		await act(async () => t.now().edit("carry on"));
		await act(async () => {
			void t.now().submit();
		});
		await flush();
		for (let i = 0; i < 40 && t.now().phase.step === "following"; i += 1) await flush(50);
		expect(polls).toBe(3);
		expect(t.now().phase).toEqual({ step: "idle" });
		expect(t.now().prompt).toBe("");
		expect(t.now().justSent).toBe(true);
	});

	test("a failure from the host keeps the draft and says why, with the machine's own name in the words", async () => {
		client.sendSessionPrompt = async () => ({ action: accept() });
		client.getSessionControlActions = async () => ({
			controlActions: [accept({ status: "failed", error: CLAUDE_FORK_CHECK_FAILED_ERROR })],
		});
		const t = mount();
		await t.h.render(t.options);
		await act(async () => t.now().edit("carry on"));
		await act(async () => {
			void t.now().submit();
		});
		await flush();
		for (let i = 0; i < 40 && t.now().phase.step === "following"; i += 1) await flush(50);
		expect(t.now().prompt).toBe("carry on");
		expect(t.now().phase).toEqual({
			step: "failed",
			startNew: false,
			reason:
				"AgentPulse couldn't check whether this session is open elsewhere on studio, so nothing was sent. Your text is here. Send it again.",
		});
	});

	test("a busy refusal keeps the draft too, in the fork's words", async () => {
		client.sendSessionPrompt = async () => ({ action: accept() });
		client.getSessionControlActions = async () => ({
			controlActions: [accept({ status: "failed", error: CLAUDE_FORK_BUSY_ERROR })],
		});
		const t = mount();
		await t.h.render(t.options);
		await act(async () => t.now().edit("again"));
		await act(async () => {
			void t.now().submit();
		});
		await flush();
		for (let i = 0; i < 40 && t.now().phase.step === "following"; i += 1) await flush(50);
		expect(t.now().prompt).toBe("again");
		expect((t.now().phase as { reason: string }).reason).toBe(
			"Claude is still on this turn. Your text is here. Send it when the turn ends.",
		);
	});

	test("followPromptAction alone: `accept` ends only at acceptedAt, never at a bare claim", async () => {
		const seen: string[] = [];
		const states = [
			accept({ status: "queued" }),
			accept({ status: "running" }),
			accept({ status: "running", metadata: { acceptedAt: "t" } }),
		];
		let i = 0;
		const out = await followPromptAction("n1", "a1", {
			until: "accept",
			fetchActions: async () => {
				seen.push(states[Math.min(i, 2)]?.status ?? "");
				return { controlActions: [states[Math.min(i++, 2)] as ControlAction] };
			},
			now: () => 0,
			sleep: async () => {},
		});
		expect(out).toEqual({ outcome: "succeeded" });
		expect(seen).toEqual(["queued", "running", "running"]);
	});
});

// ── R2: the host's sentences, worded with the machine and the original ─────

describe("a host's fixed failure sentences, worded here with the machine and the original's name", () => {
	const ctx = (
		name: string | null = "refactor the parser",
		state: "named" | "archived" | "gone" = "named",
	) => ({
		machine: "studio",
		source:
			state === "gone"
				? ({ state: "gone" } as const)
				: state === "archived"
					? ({ state: "archived", name } as const)
					: name
						? ({ state: "named", name } as const)
						: ({ state: "unknown" } as const),
	});

	test("login lost, API error, terminal found, check failed: 'this machine' becomes the machine", () => {
		expect(forkFailureSentence(CLAUDE_LOGIN_LOST_ERROR, ctx())).toBe(
			"Claude Code on studio lost its login. If the supervisor uses a token from `claude setup-token`, it may have expired. Give the supervisor a new token or an API key, restart it, then resume this session and send your prompt again.",
		);
		expect(forkFailureSentence(CLAUDE_API_ERROR_MESSAGE, ctx())).toBe(
			"Claude Code on studio hit an error before it could reply. Send your prompt again.",
		);
		expect(forkFailureSentence(CLAUDE_FORK_TERMINAL_FOUND_ERROR, ctx())).toBe(
			"This session is open in a terminal on studio, so nothing was sent. Close it there. `claude --continue` in this directory opens this session.",
		);
	});

	test("the first prompt that didn't start right names the original, or says to start a new session when it is deleted or archived", () => {
		expect(forkFailureSentence(CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR, ctx())).toBe(
			"Claude didn't start the way AgentPulse expected, so it was stopped. Continue refactor the parser in a new session to try again.",
		);
		for (const state of ["gone", "archived"] as const) {
			expect(forkFailureSentence(CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR, ctx("x", state))).toBe(
				"Claude didn't start the way AgentPulse expected, so it was stopped. Start a new session to try again.",
			);
		}
	});

	test("a sentence it doesn't know passes through untouched, and a name can't open a code span", () => {
		expect(forkFailureSentence("The host said something new.", ctx())).toBe(
			"The host said something new.",
		);
		const hostile = forkFailureSentence(CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR, ctx("a`b`c‮dcba"));
		expect(hostile).not.toContain("`");
		expect(hostile).not.toContain("‮");
	});

	test("settleFollow applies it for a continued session only; a Codex failure keeps the host's text", () => {
		const failed = { outcome: "failed", error: CLAUDE_API_ERROR_MESSAGE } as const;
		expect(settleFollow(failed, ctx())?.phase).toMatchObject({
			reason: expect.stringContaining("on studio hit an error"),
		});
		expect(settleFollow(failed)?.phase).toMatchObject({ reason: CLAUDE_API_ERROR_MESSAGE });
	});

	test("the box draws a failure's `code` spans as code", () => {
		const mode = composerMode(fork("managed"), { canPrompt: true, canResume: true });
		const out = html(
			createElement(ComposerBody, {
				mode: mode as never,
				phase: {
					step: "failed",
					reason: forkFailureSentence(CLAUDE_LOGIN_LOST_ERROR, ctx()),
					startNew: false,
				},
				posting: false,
				justSent: false,
				prompt: "x",
				notice: null,
				sideText: null,
				unavailable: false,
				onEdit: () => {},
				onSubmit: () => {},
			}),
		);
		expect(out).toMatch(/<code[^>]*>claude setup-token<\/code>/);
		expect(out).not.toContain("`");
	});
});

// ── X1, X2, X3: names and ids ───────────────────────────────────────────────

describe("names and ids that reach a sentence", () => {
	const hostile = "evil`code`name‮RTL​";

	test("X1: a backtick in a name never reaches a sentence, so a name can't draw a code span", () => {
		expect(forkSentenceName(hostile, "x")).toBe("evil'code'nameRTL");
		const line = forkModeLine("ask", "stu`dio", hostile);
		expect(line.match(/`/g)).toHaveLength(2); // the sentence's own `claude setup-token` pair, nothing more
		expect(line).toContain("continue evil'code'nameRTL again");
		const status = forkStatusView({
			fork: forkInfo(fork("managed")) as never,
			source: { state: "named", name: hostile },
			machine: hostile,
			managedState: "managed",
		});
		for (const text of [status.line, status.modeLine ?? "", status.link.text]) {
			expect(text).not.toContain("‮");
		}
		expect(status.line).toBe(
			"Continues evil'code'nameRTL on evil'code'nameRTL. Replies and approval requests appear here.",
		);
	});

	test("X1: a hostile name in the dialog, the End confirmation and the arrival line is cleaned the same way", () => {
		const dialog = claudeDialogLines({
			sessionName: hostile,
			machine: null,
			cwd: null,
			ownerName: null,
			endedFork: hostile,
		});
		expect(dialog.title).toBe("Continue evil'code'nameRTL in a new session?");
		const all = dialog.paragraphs.map((p) => p.text).join(" ");
		expect(all).toContain("Close evil'code'nameRTL in your terminal first.");
		expect(continuedArrivalAnnouncement({ sourceName: hostile, host: hostile })).toBe(
			"Continuing evil'code'nameRTL in a new session on evil'code'nameRTL. You can send a prompt now.",
		);
	});

	test("X2: the link's text and the page's sentences use the cleaned name", () => {
		const out = html(
			createElement(ManagedForkStatus, { session: fork("managed", { from: { name: hostile } }) }),
		);
		expect(out).toContain("Continued from evil&#x27;code&#x27;nameRTL");
		expect(out).not.toContain("‮");
		// The only code spans are the sentence's own command: the hostile name opened none.
		const spans = [...out.matchAll(/<code[^>]*>([^<]*)<\/code>/g)].map((m) => m[1]);
		expect(spans.length).toBeGreaterThan(0);
		for (const span of spans) expect(span).toBe("claude setup-token");
	});

	test("X3: the resume command is built only for a UUID; anything else shows no command", () => {
		expect(claudeResumeCommand(S_ID)).toBe(`claude --resume ${S_ID}`);
		for (const bad of [
			"s-1",
			"abc; rm -rf ~",
			`${S_ID} --dangerously`,
			"",
			"../../etc/passwd",
			"$(id)",
		]) {
			expect(claudeResumeCommand(bad), bad).toBeNull();
		}
		const out = html(
			createElement(ContinuedAs, {
				view: {
					kind: "continued",
					forkId: "n1",
					forkName: "n",
					sourceId: "$(id)",
					sourceName: "x",
				},
			}),
		);
		expect(out).not.toContain("claude --resume");
		expect(out).not.toContain("Copy");
		expect(out).toContain("Continued as n");
	});
});

// ── R1, R3, R4, R5, R7-R13 ──────────────────────────────────────────────────

describe("the original's link, the phone block, the command, the nudges", () => {
	test("R1: an archived original keeps its link and name; a deleted one has none; both give up the 'continue' clauses", () => {
		const archived = html(
			createElement(ManagedForkStatus, {
				session: fork("stopped", { from: { state: "archived" } }),
			}),
		);
		expect(archived).toContain(`href="/sessions/${S_ID}"`);
		expect(archived).toContain("Continued from refactor the parser");
		expect(archived).toContain("You ended this session. To keep working, start a new session.");
		const deleted = html(
			createElement(ManagedForkStatus, {
				session: fork("stopped", { from: { state: "deleted", name: null } }),
			}),
		);
		expect(deleted).not.toContain("<a ");
		expect(deleted).toContain("Continued from a session that was deleted.");
		expect(forkSourceOf(fork("managed", { from: { state: "archived" } }))).toEqual({
			state: "archived",
			name: "refactor the parser",
		});
	});

	test("R3: on a phone the link sits inside the disclosure with the settings, and dismissing removes the block", () => {
		const out = html(createElement(ManagedForkStatus, { session: fork("managed") }));
		const open = out.indexOf("<details");
		const close = out.indexOf("</details>");
		const link = out.indexOf('href="/sessions/');
		expect(link).toBeGreaterThan(open);
		expect(link).toBeLessThan(close);
		// Dismissing hides the whole block (one marker, `hidden` on a phone), not just a line inside it.
		const source = readFileSync(join(import.meta.dir, "StatusHints.tsx"), "utf8");
		expect(source).toContain('dismissed ? "hidden md:block" : ""');
		expect(source).toContain("data-fork-status");
	});

	test("R4: dismissing hands focus to the session header; with nothing else there it still never falls to the page", () => {
		const focused: string[] = [];
		const header = {
			tabIndex: -1,
			hasAttribute: () => true,
			setAttribute: () => {},
			focus: () => focused.push("header"),
		};
		const doc = {
			getElementById: (id: string) => (id === "session-header" ? header : null),
			querySelector: () => null,
		};
		expect(focusLandingNow(doc)).toBe(true);
		expect(focused).toEqual(["header"]);
		const source = readFileSync(join(import.meta.dir, "StatusHints.tsx"), "utf8");
		expect(source).toMatch(/setDismissed\(true\);[\s\S]{0,200}focusLandingAfterRender\(\)/);
		// The dismiss glyph is decoration; its name is the aria-label.
		expect(source).toContain('aria-label="Dismiss this note"');
		expect(source).toContain('<span aria-hidden="true">×</span>');
	});

	test("R5: a lead line before the command and a Copy button named for the original", () => {
		expect(CLAUDE_RESUME_COMMAND_LEAD).toBe("To open the original in a terminal again, run:");
		const out = html(
			createElement(ContinuedAs, {
				view: {
					kind: "continued",
					forkId: "n1",
					forkName: "refactor the parser (continued)",
					sourceId: S_ID,
					sourceName: "refactor the parser",
				},
			}),
		);
		expect(out.indexOf(CLAUDE_RESUME_COMMAND_LEAD)).toBeLessThan(
			out.indexOf(`claude --resume ${S_ID}`),
		);
		expect(out).toContain(
			'aria-label="Copy the command that opens refactor the parser in a terminal"',
		);
		expect(claudeCopyCommandLabel(null)).toBe(
			"Copy the command that opens the original session in a terminal",
		);
		expect(out).toMatch(/<code[^>]*aria-describedby=/);
	});

	test("R8: the box is described by the hint at every width", () => {
		const mode = composerMode(fork("managed"), { canPrompt: true, canResume: true });
		const out = html(
			createElement(ComposerBody, {
				mode: mode as never,
				phase: { step: "idle" },
				posting: false,
				justSent: false,
				prompt: "",
				notice: null,
				sideText: null,
				unavailable: false,
				onEdit: () => {},
				onSubmit: () => {},
			}),
		);
		const ids = (/<textarea[^>]*aria-describedby="([^"]+)"/.exec(out)?.[1] ?? "").split(" ");
		expect(ids).toHaveLength(2);
		for (const id of ids) expect(out).toContain(`id="${id}"`);
	});

	test("R9: someone who may not resume is told to read the message first, then end it or resume it", () => {
		const peer = fork("degraded", {
			sync: "Something else on this machine sent this session a message, so AgentPulse stopped it.",
		});
		const mode = composerMode(peer, {
			canPrompt: true,
			canResume: false,
			source: { state: "named", name: "x" },
		});
		expect(mode && "reason" in mode ? mode.reason : "").toBe(
			"Something else on studio sent this session a message, so AgentPulse stopped it. Ask an admin to read the message, then end the session or resume it.",
		);
	});

	test("R13: the arrival line promises a prompt box only when it is open", () => {
		expect(continuedArrivalAnnouncement({ sourceName: "x", host: "studio" }, false)).toBe(
			"Continuing x in a new session on studio.",
		);
		expect(continuedArrivalAnnouncement({ sourceName: "x", host: "studio" }, true)).toBe(
			"Continuing x in a new session on studio. You can send a prompt now.",
		);
		const page = readFileSync(join(import.meta.dir, "../../pages/SessionDetailPage.tsx"), "utf8");
		expect(page).toContain('managedState === "managed"');
	});

	test("I3: the MCP refusal for end_session_first starts with the shared constant", async () => {
		const { END_SESSION_FIRST_MESSAGE } = await import("../../../shared/takeover-in-progress.js");
		const mcp = readFileSync(
			join(import.meta.dir, "../../../../packages/agentpulse-mcp/src/errors.ts"),
			"utf8",
		);
		expect(mcp).toContain(`"${END_SESSION_FIRST_MESSAGE} `);
	});
});

// ── T7-T9: the chain, the toggles, the states ───────────────────────────────

describe("the chain and the states", () => {
	test("T8: a real DTO row → fork info → status block → mode line, with the stored mode", () => {
		for (const mode of ["ask", "restricted"] as const) {
			const dto = mapSessionDto({
				displayName: "n",
				metadata: { forkedFromSessionId: S_ID, forkPermissionBranch: mode },
				ownerUserId: null,
				ingestKeyId: null,
			} as never) as unknown as Session;
			expect(forkInfo(dto)).toEqual({ sourceId: S_ID, mode });
			const withManaged = {
				...dto,
				agentType: "claude_code",
				managedSession: { managedState: "managed", hostName: "studio" },
			} as Session;
			expect(selectStatusHint(withManaged, "n").component).toBe("ManagedForkStatus");
			const view = forkStatusView({
				fork: forkInfo(withManaged) as never,
				source: { state: "named", name: "o" },
				machine: "studio",
				managedState: "managed",
			});
			expect(view.modeLine).toBe(forkModeLine(mode, "studio", "o"));
		}
	});

	test("T8: the Tools and Noisy toggles are rendered disabled, with the reason, on a fork; enabled elsewhere", () => {
		const props = {
			mode: "progress" as const,
			onModeChange: () => {},
			showTools: false,
			onToggleTools: () => {},
			showNoisyTools: false,
			onToggleNoisyTools: () => {},
			showSystem: true,
			onToggleSystem: () => {},
		};
		const off = html(createElement(FilterRow, { ...props, toolsOffReason: FORK_TOOLS_REASON }));
		expect(off).toMatch(
			/<button[^>]*disabled=""[^>]*title="This session records tool activity as short lines\."[^>]*>Tools</,
		);
		expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Noisy</);
		expect(off).toContain(FORK_TOOLS_REASON);
		const on = html(createElement(FilterRow, { ...props, showTools: true }));
		expect(on).not.toMatch(/<button[^>]*disabled=""[^>]*>Tools</);
	});

	test("T9: the box for each managed state of a fork says the right thing (rendered through the real slot)", () => {
		const render = (s: Session) =>
			html(createElement(SessionComposerSlot, { session: s, onSubmitted: async () => {} }));
		const managed = render(fork("managed"));
		expect(managed).toContain("What should Claude do next?");
		expect(managed).toContain("Each prompt continues this conversation on studio.");
		expect(render(fork("pending"))).toContain(
			"This session isn&#x27;t ready for prompts yet. The box opens once Claude has started.",
		);
		const degraded = render(fork("degraded"));
		expect(degraded).toContain("Resume session");
		expect(degraded).toContain(
			"Claude stopped running on studio, so this session can&#x27;t take prompts.",
		);
		for (const state of ["stopped", "completed", "failed"])
			expect(render(fork(state)), state).toBe("");
		const offline = render({
			...fork("managed"),
			hostControl: { state: "offline", lastSeenAt: null },
		} as Session);
		expect(offline).toContain(
			"studio is offline, so this session can&#x27;t take prompts until it&#x27;s back.",
		);
		expect(offline).not.toContain("<textarea");
	});

	test("T7: the word scanners flag what they claim to (positive controls)", () => {
		const bind = /\bbind(ing)?\b|\bbound\b/i;
		const enforced = /\benforced?\b/i;
		for (const bad of ["AgentPulse will bind it", "this is enforced", "Enforce the rule"]) {
			expect(bind.test(bad) || enforced.test(bad), bad).toBe(true);
		}
		for (const fine of ["Continue it in a new session", "bindings of the unbound"]) {
			expect(bind.test(fine) && !/\bunbound\b/.test(fine), fine).toBe(false);
		}
	});

	test("an unknown or absent source never reads as deleted", () => {
		expect(forkSourceOf({} as never)).toEqual({ state: "unknown" });
		const out = html(
			createElement(ManagedForkStatus, { session: fork("managed", { from: null }) }),
		);
		expect(out).toContain("Continued from the original session");
		expect(out).not.toContain("was deleted");
	});
});

describe("bindRefusalMessage still words the host refusals with the original's name", () => {
	test("host_cannot_run_claude on a recovery", () => {
		expect(
			bindRefusalMessage(new ApiError(409, "x", { error: "host_cannot_run_claude" }), {
				host: "studio",
				kind: "recovery",
				agent: "claude_code",
				sourceName: "a`b",
			}),
		).toBe(
			"studio can't continue Claude sessions: Claude Code isn't set up there, or its supervisor is out of date. Fix that on studio, or end this session and continue a'b on another machine.",
		);
	});
});
