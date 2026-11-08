/**
 * What the dashboard says about continuing an observed Claude Code session in a new one (AGEN-117 phase 6):
 * every row of the plan's "Exact copy" that the web owns, per mode where a sentence follows the mode, and the
 * rules that put each sentence where it belongs. Pure functions and static markup: no browser.
 *
 * The sentences the server or the host writes (the failure words stored on an action, the first timeline row)
 * are held where they are written (`shared/session-resume.test.ts`, `session-detail-fork.test.ts`); this
 * file reads them the way a person does, through the same functions the page calls.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
	FORK_FIRST_ROW_LEAD,
	TURN_REFUSED_PREFIX,
	TURN_UNASKED_PREFIX,
	forkFirstRowContent,
	forkModeLine,
	isForkTurnSummary,
} from "../../../shared/claude-fork-copy.js";
import {
	CLAUDE_FORK_BUSY_ERROR,
	CLAUDE_FORK_CHANGED_SYNC_ERROR,
	CLAUDE_FORK_PEER_SYNC_ERROR,
	CLAUDE_FORK_SLASH_MESSAGE,
	CLAUDE_FORK_UNSTOPPABLE_SYNC_ERROR,
} from "../../../shared/managed-messages.js";
import {
	CLAUDE_TAKEOVER,
	RESUMES_SESSIONS,
	RESUME_FAILURE_KINDS,
	RESUME_REFUSAL_CODES,
	resumeFailureMessage,
} from "../../../shared/session-resume.js";
import type { ControlAction, Session, SupervisorRecord } from "../../../shared/types.js";
import { ApiError } from "../../lib/api.js";
import { forkInfo, forkSourceOf } from "../../lib/fork-session.js";
import { claimOnlyCopy } from "../../lib/session-summary-view.js";
import { installDomStubs, removeDomStubs } from "../../test-utils/render-hook.js";
import { ComposerBody, LockedDraft } from "./SessionPromptComposer.js";
import { TAKEOVER_SLOT_ID, TakeoverCardBody } from "./SessionTakeoverCard.js";
import { ManagedForkStatus, selectStatusHint } from "./StatusHints.js";
import { getVisibleEvents, isTurnSummaryRow } from "./TimelineView.js";
import {
	CLAUDE_CARD_ELIGIBLE,
	CLAUDE_ENTRY_BUTTON,
	CLAUDE_HOST_SUFFIX,
	CLAUDE_NO_HOST_SOLO,
	CLAUDE_NO_HOST_TEAM,
	CLAUDE_QUIET_WAIT,
	FORK_OPTIONS_CLOSING,
	FORK_OPTIONS_LEGEND,
	FORK_OPTION_CONTROLS,
	claudeConfirmLabel,
	claudeContinuedAs,
	claudeDialogLines,
	claudeProgress,
	claudeResumeCommand,
	claudeStaleWorking,
	notInSessionLine,
	toolDetailLine,
} from "./claude-takeover-copy.js";
import {
	FORK_CLAUDE_MD_NOT_LOADED,
	FORK_TOOLS_REASON,
	forkStatusView,
} from "./fork-status-view.js";
import { controlBlockedReason, hostControlHint } from "./host-control-view.js";
import {
	COMPOSER_BLOCKED_NOT_READY_CLAUDE,
	END_SESSION_BUTTON,
	RESUME_ANYWAY_BUTTON,
	RESUME_ANYWAY_NOTE,
	WHAT_WAITS_SUMMARY,
	boxState,
	composerMode,
	composerNotice,
	describeResumeFailure,
	describeSendFailure,
	followModeOf,
	followsAction,
	lockedNotice,
} from "./prompt-composer-view.js";
import {
	attemptAnnouncement,
	bindRefusalMessage,
	bottomSlot,
	continuedArrivalAnnouncement,
	continuedNavigation,
	takeoverAttempt,
} from "./session-takeover-view.js";
import { canStopSession, stopConfirmCopy, stopControlLabel } from "./stop-view.js";
import {
	bindableHosts,
	takeoverCardView,
	takeoverEligibility,
	takeoverProgress,
} from "./takeover-card-view.js";
import { FORK_AI_LINE as _unused } from "./watcher-panel-model.js";
import { FORK_AI_LINE } from "./watcher-panel-model.js";

void _unused;

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const MODES = ["ask", "restricted"] as const;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const MIN = 60_000;

// ── fixtures ────────────────────────────────────────────────────────────────

function fork(
	mode: "ask" | "restricted" | null,
	managedState: string,
	extra: {
		syncError?: string | null;
		host?: "live" | "offline" | "gone";
		owner?: string | null;
	} = {},
): Session {
	return {
		sessionId: "n-1",
		agentType: "claude_code",
		displayName: "refactor the parser (continued)",
		isWorking: false,
		ownerUserId: extra.owner ?? null,
		forkedFromSessionId: "11111111-1111-4111-8111-111111111111",
		...(mode ? { forkPermissionBranch: mode } : {}),
		metadata: {
			forkedFromSessionId: "11111111-1111-4111-8111-111111111111",
			...(mode ? { forkPermissionBranch: mode } : {}),
		},
		managedSession: {
			managedState,
			hostName: "studio",
			providerSyncError: extra.syncError ?? null,
			providerThreadId: "n-1",
			launchRequestId: "l-1",
			hostAffinityReason: "taken_over",
		},
		hostControl: extra.host ? { state: extra.host, lastSeenAt: null } : undefined,
		continuedFrom: {
			sessionId: "11111111-1111-4111-8111-111111111111",
			name: "refactor the parser",
			state: "available",
		},
	} as unknown as Session;
}

function observed(extra: Partial<Session> = {}): Session {
	return {
		sessionId: "11111111-1111-4111-8111-111111111111",
		agentType: "claude_code",
		displayName: "refactor the parser",
		isWorking: false,
		isArchived: false,
		lastActivityAt: new Date(NOW - 10 * MIN).toISOString().replace("T", " ").slice(0, 19),
		metadata: {},
		ownerUserId: null,
		...extra,
	} as unknown as Session;
}

const ACCESS = { canPrompt: true, canResume: true } as const;
const NAMED = { state: "named", name: "refactor the parser" } as const;

const action = (
	over: Partial<ControlAction> & { metadata?: Record<string, unknown> },
): ControlAction =>
	({
		id: "a-1",
		sessionId: "11111111-1111-4111-8111-111111111111",
		actionType: "resume",
		status: "queued",
		error: null,
		createdAt: new Date(NOW).toISOString(),
		updatedAt: new Date(NOW).toISOString(),
		metadata: {},
		...over,
	}) as unknown as ControlAction;

function host(over: Partial<SupervisorRecord> = {}): SupervisorRecord {
	return {
		id: "h-1",
		hostName: "studio",
		platform: "darwin",
		enrollmentState: "active",
		heartbeatLeaseExpiresAt: new Date(NOW + 60 * MIN).toISOString(),
		trustedRoots: ["/work"],
		capabilities: { version: 1, features: [CLAUDE_TAKEOVER] },
		...over,
	} as unknown as SupervisorRecord;
}

// ── the dialog ──────────────────────────────────────────────────────────────

describe("the dialog: one text for both modes, committing to neither", () => {
	const lines = claudeDialogLines({
		sessionName: "refactor the parser",
		machine: null,
		cwd: "/work/project",
		ownerName: null,
		endedFork: null,
	});
	const text = lines.paragraphs.map((p) => `${p.label ?? ""} ${p.text}`.trim());
	const all = text.join("\n");

	test("the title, the directory and the owner line", () => {
		expect(lines.title).toBe("Continue refactor the parser in a new session?");
		expect(lines.directory).toBe("Directory: /work/project");
		expect(lines.ownerLine).toBeNull();
		expect(
			claudeDialogLines({
				sessionName: "x",
				machine: null,
				cwd: null,
				ownerName: "Sam",
				endedFork: null,
			}).ownerLine,
		).toBe("The new session will belong to Sam. This one stays as it is.");
		expect(
			claudeDialogLines({
				sessionName: "x",
				machine: null,
				cwd: null,
				ownerName: null,
				endedFork: null,
			}).directory,
		).toBe("Directory: not reported");
	});

	test("close the terminal first, and AgentPulse checks (it says what happens if it sees it open)", () => {
		expect(all).toContain(
			"Close refactor the parser in your terminal first. AgentPulse checks and won't start if it sees it open.",
		);
	});

	test("the conversation is copied except what subagents read, and the two diverge on the same files", () => {
		expect(all).toContain(
			"A new session starts here with the conversation so far, except what subagents read. After that the two conversations are separate, but both change the same files.",
		);
	});

	test("what waits for the person is qualified, never an unqualified 'commands wait'", () => {
		expect(all).toContain(
			"Waits for you: file changes, web fetches and commands, except ones Claude treats as read-only, like `ls` and `cat`.",
		);
	});

	test("both logins' consequences are stated and the new session is said to tell which, before anything is sent", () => {
		expect(all).toContain(
			"What else applies depends on how Claude Code logs in for the supervisor on the machine you choose. The new session tells you which before you send anything.",
		);
		expect(all).toContain(
			"With an API key: your Claude settings aren't used. That includes your own CLAUDE.md and any hooks you rely on as safety checks.",
		);
		expect(all).toContain(
			"With a subscription token, an apiKeyHelper or any other login: your Claude settings still apply, so commands they allow, and anything a hook there answers, run without waiting for you.",
		);
	});

	test("it names neither mode as the one chosen", () => {
		for (const wrong of [
			/\brestricted\b/i,
			/\bask mode\b/i,
			/will run (with|without)/i,
			/this session (runs|uses)/i,
		]) {
			expect(all, String(wrong)).not.toMatch(wrong);
		}
		// With a machine chosen the sentence names it and still commits to nothing.
		const chosen = claudeDialogLines({
			sessionName: "x",
			machine: "studio",
			cwd: null,
			ownerName: null,
			endedFork: null,
		});
		expect(chosen.paragraphs.map((p) => p.label).join("\n")).toContain("the supervisor on studio.");
	});

	test("the D7 list: what the new session leaves out", () => {
		const out = lines.paragraphs.find((p) => p.label === "Not in this session:")?.text ?? "";
		for (const item of [
			"your project's CLAUDE.md, hooks and MCP servers",
			"your own MCP servers",
			"subagents",
			"slash commands",
			"saving memories",
		]) {
			expect(out, item).toContain(item);
		}
	});

	test("the terminal's conversation is unchanged, and `claude --continue` now means the new session", () => {
		expect(all).toContain(
			"Your terminal's conversation isn't changed. Don't open the new session in a terminal. Afterwards, `claude --continue` here can open the new session instead, so use the command this page gives you to get back.",
		);
	});

	test("API keys: true in both modes, because an ask-mode fork needs a person to prompt it", () => {
		expect(all).toContain(
			"API keys you've issued can send prompts to it too, unless it runs under your own Claude settings: then only a signed-in person can.",
		);
	});

	test("an ended fork adds that nothing carries over", () => {
		const out = claudeDialogLines({
			sessionName: "x",
			machine: null,
			cwd: null,
			ownerName: null,
			endedFork: "refactor the parser (continued)",
		});
		expect(out.paragraphs.at(-1)?.text).toBe(
			"This starts from your terminal's conversation. Nothing from refactor the parser (continued) carries over.",
		);
		expect(lines.paragraphs.some((p) => p.text.includes("carries over"))).toBe(false);
	});

	test("the confirm button, the busy word and the entry button", () => {
		expect(claudeConfirmLabel(null)).toBe("Continue");
		expect(claudeConfirmLabel("studio")).toBe("Continue on studio");
		expect(CLAUDE_ENTRY_BUTTON).toBe("Continue in a new session");
	});
});

describe("the dialog's source: the picker comes first, and a refusal on a phone stays reachable", () => {
	test("ConfirmDialog places `fields` before the description when asked, and the Claude dialog asks", async () => {
		const { readFileSync } = await import("node:fs");
		const dialog = readFileSync(new URL("../ConfirmDialog.tsx", import.meta.url), "utf8");
		expect(dialog).toContain("fieldsFirst");
		expect(dialog.indexOf("fields && fieldsFirst")).toBeLessThan(
			dialog.indexOf("id={descriptionId}"),
		);
		expect(dialog.indexOf("fields && !fieldsFirst")).toBeGreaterThan(
			dialog.indexOf("id={descriptionId}"),
		);
		const card = readFileSync(new URL("./SessionTakeoverCard.tsx", import.meta.url), "utf8");
		expect(card).toContain("fieldsFirst={claude}");
		expect(card).toContain("CLAUDE_PICK_MACHINE_FIRST");
	});

	test("the bind answer's launchRequestId is never read: the carrier exists only after settle, and never after a failure", async () => {
		const { readFileSync } = await import("node:fs");
		const card = readFileSync(new URL("./SessionTakeoverCard.tsx", import.meta.url), "utf8");
		const page = readFileSync(
			new URL("../../pages/SessionDetailPage.tsx", import.meta.url),
			"utf8",
		);
		expect(card).not.toMatch(/launchRequestId/);
		// The page never reads a launch row for a takeover that is still in flight.
		expect(page).not.toMatch(/bindSession/);
		expect(card).toMatch(/await api\.bindSession\(/);
		expect(card).not.toMatch(/=\s*await api\.bindSession\(/);
	});
});

// ── the card, the machines ──────────────────────────────────────────────────

describe("the card on an observed Claude session", () => {
	const input = (over: Record<string, unknown> = {}) => ({
		session: observed(),
		attempt: { state: "none" } as const,
		canBind: true,
		team: false,
		viewerIsAdmin: true,
		hosts: {
			state: "ready",
			usable: 1,
			options: [{ id: "h", name: "studio", disabled: false, reason: null, label: "studio" }],
		} as never,
		now: NOW,
		formatTime: () => "10:00",
		...over,
	});

	test("eligible: the plan's sentence and the entry button's words", () => {
		expect(CLAUDE_CARD_ELIGIBLE).toBe(
			"Started outside AgentPulse. You can continue it here in a new session once it's closed.",
		);
		expect(takeoverCardView(input())).toMatchObject({
			kind: "eligible",
			text: CLAUDE_CARD_ELIGIBLE,
			entryLabel: "Continue in a new session",
		});
	});

	test("quiet for under 5 minutes, and a crashed-looking one: their own sentences, no 'take over'", () => {
		expect(CLAUDE_QUIET_WAIT).toBe(
			"You can continue this in a new session once it's been quiet for 5 minutes.",
		);
		const quiet = takeoverCardView(
			input({ session: observed({ lastActivityAt: new Date(NOW - MIN).toISOString() }) }),
		);
		expect(quiet).toMatchObject({ kind: "info", text: CLAUDE_QUIET_WAIT });
		const stale = takeoverCardView(
			input({
				session: observed({
					isWorking: true,
					lastActivityAt: new Date(NOW - 10 * MIN).toISOString(),
				}),
			}),
		);
		expect(stale).toMatchObject({ kind: "info", text: claudeStaleWorking("10:00") });
		expect(claudeStaleWorking("10:00")).not.toMatch(/take it over/i);
	});

	test("no usable machine: the setup line in solo and the host-of-your-own line for a member", () => {
		const none = { state: "ready", usable: 0, options: [] } as never;
		expect(takeoverCardView(input({ hosts: none }))).toMatchObject({
			kind: "no_host",
			text: CLAUDE_NO_HOST_SOLO,
			setupLink: true,
		});
		expect(
			takeoverCardView(input({ hosts: none, team: true, viewerIsAdmin: false })),
		).toMatchObject({
			kind: "no_host",
			text: CLAUDE_NO_HOST_TEAM,
			setupLink: false,
		});
	});

	test("it is offered to a Claude session like to a Codex one, and still not to Copilot", () => {
		expect(
			takeoverEligibility(observed({ lastActivityAt: new Date(NOW - 10 * MIN).toISOString() }), NOW)
				.kind,
		).toBe("eligible");
		expect(takeoverEligibility(observed({ agentType: "copilot_cli" }), NOW).kind).toBe(
			"unavailable",
		);
	});

	test("while a fork is live S shows 'Continued as {N}' with the command that opens S, and Copy beside it", () => {
		const view = takeoverCardView(
			input({
				session: observed({
					continuedIn: { sessionId: "n-1", name: "refactor the parser (continued)", live: true },
				}),
			}),
		);
		expect(view).toEqual({
			kind: "continued",
			forkId: "n-1",
			forkName: "refactor the parser (continued)",
			sourceId: "11111111-1111-4111-8111-111111111111",
			sourceName: "refactor the parser",
		});
		const out = html(createElement(TakeoverCardBody, { view, onOpen: () => {} }));
		expect(out).toContain(`id="${TAKEOVER_SLOT_ID}"`);
		expect(out).toContain("Continued as refactor the parser (continued)");
		expect(out).toContain('href="/sessions/n-1"');
		// The command sits in the same block as the link, with Copy after it.
		const link = out.indexOf("Continued as");
		const command = out.indexOf("claude --resume 11111111-1111-4111-8111-111111111111");
		const copy = out.indexOf(">Copy<");
		expect(link).toBeGreaterThan(-1);
		expect(command).toBeGreaterThan(link);
		expect(copy).toBeGreaterThan(command);
		expect(claudeResumeCommand("11111111-1111-4111-8111-111111111111")).toBe(
			"claude --resume 11111111-1111-4111-8111-111111111111",
		);
		expect(claudeContinuedAs(null)).toBe("Continued as a new session");
	});

	test("once the fork has ended S offers the button again; an archived S shows nothing either way", () => {
		const ended = takeoverCardView(
			input({
				session: observed({
					continuedIn: { sessionId: "n-1", name: "n", live: false },
					lastActivityAt: new Date(NOW - 10 * MIN).toISOString(),
				}),
			}),
		);
		expect(ended.kind).toBe("eligible");
		const archived = takeoverCardView(
			input({
				session: observed({
					isArchived: true,
					continuedIn: { sessionId: "n-1", name: "n", live: true },
				}),
			}),
		);
		expect(archived.kind).toBe("hidden");
	});

	test("a Codex session never gets 'Continued as'", () => {
		const view = takeoverCardView(
			input({
				session: observed({
					agentType: "codex_cli",
					continuedIn: { sessionId: "n-1", name: "n", live: true },
				}),
			}),
		);
		expect(view.kind).not.toBe("continued");
	});

	test("progress: 'Starting Claude on {machine}…', then the still-waiting line; a Codex takeover keeps its words", () => {
		expect(claudeProgress("studio", false)).toBe("Starting Claude on studio…");
		expect(claudeProgress("studio", true)).toBe(
			"Still no answer from studio. This can take about a minute and a half. You can leave this page.",
		);
		const started = new Date(NOW).toISOString();
		expect(takeoverProgress("takeover", "studio", started, NOW + 1_000, "claude_code")).toBe(
			"Starting Claude on studio…",
		);
		expect(takeoverProgress("takeover", "studio", started, NOW + 30_000, "claude_code")).toBe(
			claudeProgress("studio", true),
		);
		expect(takeoverProgress("takeover", "studio", started, NOW + 1_000)).toBe(
			"Asking studio to take over this session…",
		);
		// A recovery of a continued session resumes it: not "Starting".
		expect(takeoverProgress("recovery", "studio", started, NOW + 1_000, "claude_code")).toBe(
			"Asking studio to resume this session…",
		);
	});
});

describe("the machine list for a Claude session", () => {
	const ctx = {
		ui: { showHostOwner: false },
		viewerUserId: null,
		isAdmin: true,
		session: { ownerUserId: null, cwd: "/work/project" },
		now: NOW,
		agent: "claude_code",
	} as const;

	test("a macOS host that advertises the feature is usable", () => {
		const { options, usable } = bindableHosts([host()], ctx);
		expect(usable).toBe(1);
		expect(options[0]).toMatchObject({ disabled: false, label: "studio" });
	});

	test("a host that isn't macOS says so; a macOS host without the feature says Claude or the supervisor is missing", () => {
		const linux = bindableHosts([host({ platform: "linux" })], ctx).options[0];
		expect(linux).toMatchObject({
			disabled: true,
			reason: "unsupported_os",
			label: "studio (macOS only so far)",
		});
		const noClaude = bindableHosts(
			[host({ capabilities: { version: 1, features: [] } as never })],
			ctx,
		).options[0];
		expect(noClaude).toMatchObject({
			disabled: true,
			reason: "needs_claude",
			label: "studio (Claude Code not found or supervisor out of date)",
		});
		expect(CLAUDE_HOST_SUFFIX).toEqual({
			unsupported_os: "macOS only so far",
			needs_claude: "Claude Code not found or supervisor out of date",
		});
	});

	test("the Codex feature does not make a host usable for Claude, and the Claude one does not for Codex", () => {
		const codexOnly = host({ capabilities: { version: 1, features: [RESUMES_SESSIONS] } as never });
		expect(bindableHosts([codexOnly], ctx).usable).toBe(0);
		expect(bindableHosts([host()], { ...ctx, agent: "codex_cli" }).usable).toBe(0);
	});

	test("offline and directory reasons still come first and last", () => {
		expect(
			bindableHosts([host({ heartbeatLeaseExpiresAt: new Date(NOW - 1).toISOString() })], ctx)
				.options[0]?.reason,
		).toBe("offline");
		expect(bindableHosts([host({ trustedRoots: ["/elsewhere"] })], ctx).options[0]?.reason).toBe(
			"directory",
		);
	});
});

// ── the attempt: words, announcement, moving to the new session ─────────────

describe("an attempt on a Claude session", () => {
	test("is read from the action: its agent and the machine it names", () => {
		const attempt = takeoverAttempt([
			action({
				metadata: { resumeKind: "takeover", agentType: "claude_code", hostName: "studio" },
			}),
		]);
		expect(attempt).toMatchObject({
			state: "in_flight",
			kind: "takeover",
			agent: "claude_code",
			hostName: "studio",
		});
		expect(takeoverAttempt([action({ metadata: { resumeKind: "takeover" } })])).toMatchObject({
			agent: "codex_cli",
			hostName: null,
		});
	});

	test("a failed Claude takeover shows the stored sentence, which says nothing was started", () => {
		const reason = resumeFailureMessage("running", "studio", "takeover", "claude_code");
		const attempt = takeoverAttempt([
			action({
				status: "failed",
				error: reason,
				metadata: { resumeKind: "takeover", agentType: "claude_code" },
			}),
		]);
		expect(attempt).toMatchObject({ state: "failed", agent: "claude_code", reason });
		expect(reason).toBe(
			"This conversation is still open on studio, in a terminal or as a background agent. Close it there, then try again.",
		);
	});

	test("success on S is not announced as 'took over' (the page moves to the new session and says so there)", () => {
		const flight = takeoverAttempt([
			action({
				metadata: { resumeKind: "takeover", agentType: "claude_code", hostName: "studio" },
			}),
		]);
		expect(attemptAnnouncement(flight, { state: "none" }, "studio")).toBeNull();
		// A failure is still announced, and a Codex takeover keeps its sentence.
		const failed = {
			state: "failed",
			actionId: "a",
			kind: "takeover",
			agent: "claude_code",
			reason: "No.",
		} as const;
		expect(attemptAnnouncement(flight, failed, null)).toBe("No.");
		const codex = takeoverAttempt([
			action({ metadata: { resumeKind: "takeover", agentType: "codex_cli" } }),
		]);
		expect(attemptAnnouncement(codex, { state: "none" }, "studio")).toBe(
			"studio took over this session. You can send a prompt now.",
		);
	});

	test("the page moves to the fork only when an attempt that was in flight ended and S names a live fork", () => {
		const flight = takeoverAttempt([
			action({
				metadata: { resumeKind: "takeover", agentType: "claude_code", hostName: "studio" },
			}),
		]);
		const none = { state: "none" } as const;
		const live = {
			sessionId: "11111111-1111-4111-8111-111111111111",
			displayName: "refactor the parser",
			continuedIn: { sessionId: "n-1", name: "n", live: true },
		};
		expect(continuedNavigation(flight, none, live)).toEqual({
			to: "/sessions/n-1",
			arrival: { sourceName: "refactor the parser", host: "studio" },
		});
		// Not on a plain load, not on a failure, not with no live fork, not for a Codex takeover or a recovery.
		expect(continuedNavigation(none, none, live)).toBeNull();
		expect(
			continuedNavigation(
				flight,
				{ state: "failed", actionId: "a", kind: "takeover", agent: "claude_code", reason: "x" },
				live,
			),
		).toBeNull();
		expect(
			continuedNavigation(flight, none, { sessionId: "11111111-1111-4111-8111-111111111111" }),
		).toBeNull();
		expect(
			continuedNavigation(flight, none, {
				...live,
				continuedIn: { sessionId: "n-1", name: "n", live: false },
			}),
		).toBeNull();
		expect(continuedNavigation(flight, none, null)).toBeNull();
		const codex = takeoverAttempt([
			action({ metadata: { resumeKind: "takeover", agentType: "codex_cli" } }),
		]);
		expect(continuedNavigation(codex, none, live)).toBeNull();
		const recovery = takeoverAttempt([
			action({ metadata: { resumeKind: "recovery", agentType: "claude_code" } }),
		]);
		expect(continuedNavigation(recovery, none, live)).toBeNull();
	});

	test("the arrival announcement names the original and the machine, once the person is on the new session", () => {
		expect(
			continuedArrivalAnnouncement({ sourceName: "refactor the parser", host: "studio" }),
		).toBe("Continuing refactor the parser in a new session on studio. You can send a prompt now.");
		expect(continuedArrivalAnnouncement({ sourceName: null, host: null })).toBe(
			"Continuing the session in a new session. You can send a prompt now.",
		);
	});

	test("a Claude takeover in flight takes the bottom slot like any takeover", () => {
		const flight = takeoverAttempt([
			action({ metadata: { resumeKind: "takeover", agentType: "claude_code" } }),
		]);
		expect(bottomSlot({ managedSession: null }, flight)).toBe("takeover_progress");
		expect(bottomSlot({ managedSession: null }, { state: "none" })).toBe("takeover");
	});
});

describe("refusals for a Claude session", () => {
	const refuse = (code: string, over: Record<string, unknown> = {}) =>
		bindRefusalMessage(new ApiError(409, code, { error: code }), {
			host: "studio",
			kind: "takeover",
			agent: "claude_code",
			...over,
		});

	test("the two sentences that were stand-ins: the agent line and the delete refusal", () => {
		expect(refuse("agent_not_supported")).toBe(
			"AgentPulse can take over Codex and Claude Code sessions, but not sessions from other tools.",
		);
		expect(refuse("agent_not_supported")).not.toMatch(/only/i);
		expect(refuse("end_session_first")).toBe("End this session first.");
		expect(refuse("host_cannot_run_claude")).toBe(
			"studio can't continue Claude sessions: Claude Code isn't set up there, isn't on macOS, or its supervisor is out of date. Choose another machine.",
		);
	});

	test("a recovery's host_cannot_run_claude names the original by name, or neutrally when unknown", () => {
		expect(
			refuse("host_cannot_run_claude", { kind: "recovery", sourceName: "refactor the parser" }),
		).toBe(
			"studio can't continue Claude sessions: Claude Code isn't set up there, or its supervisor is out of date. Fix that on studio, or end this session and continue refactor the parser on another machine.",
		);
		expect(refuse("host_cannot_run_claude", { kind: "recovery" })).toContain(
			"continue the original session on another machine",
		);
	});

	test("the sentences that name the action say 'continue', not 'take over'", () => {
		for (const code of [
			"session_active",
			"already_managed",
			"session_id_unsupported",
			"cwd_unknown",
			"not_owner",
			"human_required",
		]) {
			expect(refuse(code), code).not.toMatch(/take[nr]? over|taking over/i);
		}
		expect(refuse("human_required")).toBe(
			"Continuing a session needs a signed-in person, not an API key.",
		);
		// Codex keeps its own.
		expect(
			bindRefusalMessage(new ApiError(409, "human_required", { error: "human_required" }), {
				host: "s",
				kind: "takeover",
			}),
		).toBe("Taking over a session needs a signed-in person, not an API key.");
	});

	test("every code and every host-failure kind has words for a Claude takeover and a recovery", () => {
		const unknown = bindRefusalMessage(new ApiError(500, "x", { error: "zzz" }), {
			host: "studio",
			kind: "takeover",
			agent: "claude_code",
		});
		for (const kind of ["takeover", "recovery"] as const) {
			for (const code of RESUME_REFUSAL_CODES) {
				const out = refuse(code, { kind });
				expect(out.length, code).toBeGreaterThan(10);
				expect(out, code).not.toBe(unknown);
			}
			for (const failure of RESUME_FAILURE_KINDS) {
				expect(
					resumeFailureMessage(failure, "studio", kind, "claude_code", "ask").length,
					failure,
				).toBeGreaterThan(10);
			}
		}
	});

	test("branch_changed points at the original by NAME, and never contains its id", () => {
		const named = resumeFailureMessage(
			"branch_changed",
			"studio",
			"recovery",
			"claude_code",
			"ask",
			"refactor the parser",
		);
		expect(named).toBe(
			"This session started under different rules than AgentPulse uses now, so it can't be resumed. End it and continue refactor the parser again.",
		);
		expect(resumeFailureMessage("branch_changed", "studio", "recovery", "claude_code")).toContain(
			"continue the original session again",
		);
		// A name is cleaned and capped like any host text.
		const long = resumeFailureMessage(
			"branch_changed",
			"studio",
			"recovery",
			"claude_code",
			"ask",
			`x‮${"y".repeat(200)}`,
		);
		expect(long).not.toContain("‮");
		expect(long.length).toBeLessThan(260);
	});

	test("claude_not_logged_in: S and N's two variants name both ways to give the supervisor a login and say a terminal login isn't enough", () => {
		const onS = resumeFailureMessage("claude_not_logged_in", "studio", "takeover", "claude_code");
		const onNRestricted = resumeFailureMessage(
			"claude_not_logged_in",
			"studio",
			"recovery",
			"claude_code",
			"restricted",
		);
		const onNAsk = resumeFailureMessage(
			"claude_not_logged_in",
			"studio",
			"recovery",
			"claude_code",
			"ask",
		);
		for (const [name, sentence] of Object.entries({ onS, onNAsk })) {
			expect(sentence, name).toContain("claude setup-token");
			expect(sentence, name).toContain("ANTHROPIC_API_KEY");
			expect(sentence, name).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		}
		// A fork that runs without the person's settings needs a login the table maps to `restricted` (V-5):
		// today that is an API key only, so a token is not offered as the way back.
		expect(onNRestricted).toContain("ANTHROPIC_API_KEY");
		expect(onNRestricted).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(onS).toContain(
			"Being logged in to Claude in a terminal isn't enough for the supervisor.",
		);
		expect(onNAsk).toContain(
			"Being logged in to Claude in a terminal isn't enough for the supervisor.",
		);
		expect(onNRestricted).toContain("runs without your Claude settings");
		expect(onNAsk).not.toContain("runs without your Claude settings");
		// AgentPulse never holds the credential, and the words must not suggest it does. "store" is the named member.
		for (const sentence of [onS, onNRestricted, onNAsk]) {
			expect(sentence).not.toMatch(/\bstor(e|es|ed|ing)\b/i);
			expect(sentence).not.toMatch(/\bsaved?\b/i);
			expect(sentence).not.toMatch(/AgentPulse keeps/i);
		}
		expect(/\bstore\b/i.test("AgentPulse will store your token")).toBe(true);
	});
});

// ── the new session's page: status, mode line, first row ────────────────────

describe("the mode line follows the stored mode, before any prompt", () => {
	const view = (mode: "ask" | "restricted") =>
		forkStatusView({
			fork: forkInfo(fork(mode, "managed")) as never,
			source: NAMED,
			machine: "studio",
			managedState: "managed",
		});

	test("a restricted session and an ask session, side by side, each get their own", () => {
		const restricted = view("restricted");
		const ask = view("ask");
		expect(restricted.modeLine).toBe(
			"Your Claude settings on studio aren't used in this session, because the supervisor's Claude Code logs in with an API key. That includes your own CLAUDE.md and your hooks.",
		);
		expect(ask.modeLine).toBe(
			"Your Claude settings on studio still apply in this session, because the supervisor's Claude Code logs in a way that needs them. Commands your settings allow, and anything a hook there answers, run without asking you. To have them ignored instead, give the supervisor an API key, then end this session and continue refactor the parser again.",
		);
		expect(restricted.modeLine).not.toBe(ask.modeLine);
		expect(ask.modeLine).toBe(forkModeLine("ask", "studio", "refactor the parser"));
	});

	test("the ask line says what answers before the person does (allow rules and hooks) and never 'enforced'", () => {
		const line = view("ask").modeLine ?? "";
		expect(line).toContain("Commands your settings allow");
		expect(line).toContain("hook");
		expect(line).not.toMatch(/enforced/i);
		expect(view("restricted").modeLine).not.toMatch(/enforced/i);
	});

	test("a fork that doesn't say its mode shows no mode line rather than a guess", () => {
		expect(
			forkStatusView({
				fork: forkInfo(fork(null, "managed")) as never,
				source: NAMED,
				machine: "studio",
				managedState: "managed",
			}).modeLine,
		).toBeNull();
	});

	test("the status line, the heading and the link", () => {
		const v = view("ask");
		expect(v.heading).toBe("Continued session");
		expect(v.line).toBe(
			"Continues refactor the parser on studio. Replies and approval requests appear here.",
		);
		expect(v.link).toEqual({
			kind: "link",
			sourceId: "11111111-1111-4111-8111-111111111111",
			text: "Continued from refactor the parser",
		});
	});

	test("the first row is the same sentence plus the mode line, from the same function the server writes it with", () => {
		for (const mode of MODES) {
			expect(forkFirstRowContent(mode, "studio", "refactor the parser")).toBe(
				`${FORK_FIRST_ROW_LEAD} ${forkModeLine(mode, "studio", "refactor the parser")}`,
			);
		}
		expect(FORK_FIRST_ROW_LEAD).toBe(
			"Continued from an earlier session. Claude remembers that conversation, but its history stays there. Send a prompt to carry on.",
		);
	});

	test("{Sname} is a name and never an id: with the original gone every 'continue {Sname}' clause is replaced", () => {
		const gone = forkStatusView({
			fork: forkInfo(fork("ask", "stopped")) as never,
			source: { state: "gone" },
			machine: "studio",
			managedState: "stopped",
		});
		expect(gone.link).toEqual({ kind: "text", text: "Continued from a session that was deleted." });
		expect(gone.endedLine).toBe(
			"You ended this session. To keep working, start a new session. What happened here stays in this session's timeline.",
		);
		expect(gone.modeLine).toContain("then end this session and start a new session.");
		expect(gone.modeLine).not.toContain("continue");
		const named = forkStatusView({
			fork: forkInfo(fork("ask", "stopped")) as never,
			source: NAMED,
			machine: "studio",
			managedState: "stopped",
		});
		expect(named.endedLine).toBe(
			"You ended this session. To keep working, continue refactor the parser in a new session again.",
		);
		// Never the observed session's id in any sentence.
		for (const text of [named.line, named.modeLine, named.endedLine, named.link.text])
			expect(text ?? "").not.toContain("11111111-1111-4111-8111-111111111111");
		// An unknown source (an older server) reads neutrally, never as deleted.
		const unknown = forkStatusView({
			fork: forkInfo(fork("ask", "stopped")) as never,
			source: { state: "unknown" },
			machine: "studio",
			managedState: "stopped",
		});
		expect(unknown.link).toMatchObject({
			kind: "link",
			text: "Continued from the original session",
		});
		expect(forkSourceOf({} as never)).toEqual({ state: "unknown" });
		expect(
			forkSourceOf({ continuedFrom: { sessionId: "s", name: "x", state: "deleted" } } as never),
		).toEqual({ state: "gone" });
		expect(
			forkSourceOf({ continuedFrom: { sessionId: "s", name: "x", state: "archived" } } as never),
		).toEqual({ state: "archived", name: "x" });
	});

	test("the status block is one dismissible line that opens to the settings on a phone, the full block on a desktop, no pill and no Host clause", () => {
		const out = html(createElement(ManagedForkStatus, { session: fork("ask", "managed") }));
		expect(out).toContain("Dismiss this note");
		// The collapsed phone block is the summary line alone; the mode line and the link sit inside the disclosure.
		expect(out).toMatch(
			/<summary[^>]*><span[^>]*>Continues refactor the parser on studio\. Replies and approval requests appear here\.<\/span><\/summary>/,
		);
		expect(out.indexOf("</summary>")).toBeLessThan(out.indexOf("still apply in this session"));
		// The link back to the original is inside the disclosure on a phone, with the settings.
		const phoneLink = out.indexOf("Continued from refactor the parser");
		expect(phoneLink).toBeGreaterThan(out.indexOf("</summary>"));
		expect(phoneLink).toBeLessThan(out.indexOf("</details>"));
		expect(out.match(/Continued from refactor the parser/g)).toHaveLength(2);
		expect(out).toContain("Continued session");
		expect(out).toContain("md:hidden");
		expect(out).toContain("hidden md:block");
		expect(out).not.toMatch(/Host <span|rounded-full border px-2 py-1/);
		expect(out).not.toContain(">managed<");
		// Both the phone and the desktop block carry the mode line, so it is on screen at either width.
		expect(out.split("still apply in this session").length - 1).toBe(2);
	});

	test("the status block selected for a fork, not the launched-Claude one", () => {
		expect(selectStatusHint(fork("ask", "managed"), "n").component).toBe("ManagedForkStatus");
		const launched = {
			agentType: "claude_code",
			managedSession: { managedState: "headless" },
			metadata: {},
		} as never;
		expect(selectStatusHint(launched, "n").component).toBe("ManagedClaudeStatus");
	});
});

// ── the prompt box ──────────────────────────────────────────────────────────

describe("the composer on a continued session", () => {
	const mode = (s: Session, access: Partial<Parameters<typeof composerMode>[1]> = {}) =>
		composerMode(s, { ...ACCESS, source: NAMED, ...access });

	test("managed: its own kind, copy by mode, and the Codex-style 'accept' follow", () => {
		const ask = mode(fork("ask", "managed"));
		expect(ask).toMatchObject({
			kind: "claude_taken_over",
			placeholder: "What should Claude do next?",
			button: "Send prompt",
			side: "Replies and approval requests appear in this session.",
		});
		expect(ask && "hint" in ask ? ask.hint : "").toBe(
			"Each prompt continues this conversation on studio. File changes and most commands wait for your approval here, unless your own Claude settings answer first. You can end this session from here; it can't be continued afterwards.",
		);
		const restricted = mode(fork("restricted", "managed"));
		expect(restricted && "hint" in restricted ? restricted.hint : "").toBe(
			"Each prompt continues this conversation on studio. File changes and commands wait for your approval here, except read-only commands. You can end this session from here; it can't be continued afterwards.",
		);
		// A fork whose mode is unknown gets the wording that promises less.
		const unknown = mode(fork(null, "managed"));
		expect(unknown && "hint" in unknown ? unknown.hint : "").toContain(
			"unless your own Claude settings answer first",
		);
	});

	test("follow behaviour: read-only until the host accepts; running clears the draft; failed keeps it and says why", () => {
		const ask = mode(fork("ask", "managed"));
		expect(followModeOf(ask)).toBe("accept");
		expect(followsAction(ask)).toBe(true);
		const state = (phase: Parameters<typeof boxState>[1]) =>
			boxState(ask as never, phase, { posting: false });
		expect(state({ step: "following" })).toMatchObject({
			readOnly: true,
			sendDisabled: true,
			buttonText: "Sending…",
		});
		expect(state({ step: "idle" })).toMatchObject({
			readOnly: false,
			sendDisabled: false,
			buttonText: "Send prompt",
		});
		const failed = state({ step: "failed", reason: CLAUDE_FORK_BUSY_ERROR, startNew: false });
		expect(failed.alert).toBe(
			"Claude is still on this turn. Your text is here. Send it when the turn ends.",
		);
		expect(failed.readOnly).toBe(false);
	});

	test("a busy refusal from the server reads as the fork's own sentence; a launched Claude keeps hers", () => {
		const busy = new ApiError(400, "x", { error: "x", reason: "control_busy" });
		expect(describeSendFailure(busy, fork("ask", "managed")).reason).toBe(
			"Claude is still on this turn. Your text is here. Send it when the turn ends.",
		);
		expect(
			describeSendFailure(busy, {
				agentType: "claude_code",
				managedSession: null,
				metadata: {},
			} as never).reason,
		).toBe("Claude is still working on this session. Your text is here. Send it when it finishes.");
	});

	test("a slash line refused by the server reads as the plan's words in the box, with the text kept (the AI tab's error table isn't loaded on this page)", () => {
		const refused = new ApiError(400, "prompt_unsafe", {
			error: "prompt_unsafe",
			reason: "slash_command",
			message: "x",
		});
		expect(describeSendFailure(refused, fork("ask", "managed"))).toEqual({
			reason:
				"Messages starting with / don't work in this session. Reword it so it starts with something else.",
			startNew: false,
		});
		// Any other unsafe prompt keeps the generic failure line: it isn't about a slash.
		const other = new ApiError(400, "prompt_unsafe", {
			error: "prompt_unsafe",
			reason: "control_chars",
		});
		expect(describeSendFailure(other, fork("ask", "managed")).reason).not.toContain("start with");
	});

	test("a slash line is refused with the plan's words (server and host share the constant)", () => {
		expect(CLAUDE_FORK_SLASH_MESSAGE).toBe(
			"Messages starting with / don't work in this session. Reword it so it starts with something else.",
		);
	});

	test("pending is not ready; stopped, completed and failed hide the box; a non-owner is told", () => {
		expect(mode(fork("ask", "pending"))).toMatchObject({
			kind: "blocked",
			reason: COMPOSER_BLOCKED_NOT_READY_CLAUDE,
		});
		for (const state of ["stopped", "completed", "failed"])
			expect(mode(fork("ask", state)), state).toBeNull();
		expect(mode(fork("ask", "managed"), { canPrompt: false })).toMatchObject({
			kind: "blocked",
			reason: "Only the owner or an admin can send prompts to this session.",
		});
	});

	test("an offline or removed host says so, in the words every agent shares", () => {
		expect(mode(fork("ask", "managed", { host: "offline" }))).toMatchObject({
			kind: "blocked",
			reason: "studio is offline, so this session can't take prompts until it's back.",
		});
		expect(mode(fork("ask", "managed", { host: "gone" }))).toMatchObject({
			kind: "blocked",
			reason:
				"This session's host was removed from AgentPulse, so it can't take prompts. You can archive it.",
		});
	});

	test("degraded: Resume is offered, with what didn't happen", () => {
		const m = mode(fork("ask", "degraded", { syncError: "Claude stopped running on studio." }));
		expect(m).toEqual({
			kind: "blocked",
			startNew: false,
			resume: { state: "available" },
			reason:
				"Claude stopped running on studio, so this session can't take prompts. Resume it to keep going. A running turn didn't finish, and a request that was waiting didn't run. A command you'd already approved may still be finishing there.",
		});
	});

	test("degraded because Claude changed how it was running: its own sentence", () => {
		const m = mode(fork("ask", "degraded", { syncError: CLAUDE_FORK_CHANGED_SYNC_ERROR }));
		expect(m).toMatchObject({
			kind: "blocked",
			resume: { state: "available" },
			reason:
				"Claude Code on studio changed how it was running, so AgentPulse stopped it. Its last turn may not all be here. Resume it to keep going.",
		});
	});

	test("degraded because the host could not confirm the process ended: no Resume, and the way out is said (CX2-1)", () => {
		const m = mode(fork("ask", "degraded", { syncError: CLAUDE_FORK_UNSTOPPABLE_SYNC_ERROR }));
		expect(m).toMatchObject({ kind: "blocked", resume: { state: "disabled" } });
		expect(m && "reason" in m ? m.reason : "").toBe(
			"AgentPulse couldn't confirm that Claude stopped on studio, so this session can't take prompts or be resumed yet. End it again, or stop the Claude process yourself.",
		);
	});

	test("degraded after a message something else sent: End and continue the original first, Resume anyway second; others see only the first sentence", () => {
		const owner = mode(fork("ask", "degraded", { syncError: CLAUDE_FORK_PEER_SYNC_ERROR }));
		expect(owner).toEqual({
			kind: "blocked",
			startNew: false,
			resume: { state: "available", afterPeerMessage: true },
			reason:
				"AgentPulse stopped this session because something else on studio sent it a message. To leave it behind, end this session and continue refactor the parser in a new session again.",
		});
		const other = mode(fork("ask", "degraded", { syncError: CLAUDE_FORK_PEER_SYNC_ERROR }), {
			canResume: false,
		});
		expect(other).toMatchObject({ kind: "blocked" });
		expect(other && "reason" in other ? other.reason : "").toBe(
			"Something else on studio sent this session a message, so AgentPulse stopped it. Ask an admin to read the message, then end the session or resume it.",
		);
		// The original is gone: the clause is replaced by starting a new session.
		const gone = mode(fork("ask", "degraded", { syncError: CLAUDE_FORK_PEER_SYNC_ERROR }), {
			source: { state: "gone" },
		});
		expect(gone && "reason" in gone ? gone.reason : "").toBe(
			"AgentPulse stopped this session because something else on studio sent it a message. To leave it behind, end this session and start a new session.",
		);
	});

	test("the locked notice renders End before Resume anyway, with the note about remembering the message", () => {
		const owner = mode(fork("ask", "degraded", { syncError: CLAUDE_FORK_PEER_SYNC_ERROR }));
		const notice = lockedNotice(owner, false);
		expect(notice?.resume).toEqual({ state: "available", afterPeerMessage: true });
		const out = html(
			createElement(LockedDraft, {
				reason: notice?.reason ?? "",
				showDraft: false,
				draft: "",
				startNew: false,
				resume: {
					offer: notice?.resume as never,
					posting: false,
					onResume: () => {},
					onEnd: () => {},
					alert: null,
				},
			}),
		);
		expect(END_SESSION_BUTTON).toBe("End session");
		expect(RESUME_ANYWAY_BUTTON).toBe("Resume anyway");
		expect(RESUME_ANYWAY_NOTE).toBe("If you resume, Claude will remember that message.");
		expect(out.indexOf(">End session<")).toBeGreaterThan(-1);
		expect(out.indexOf(">Resume anyway<")).toBeGreaterThan(out.indexOf(">End session<"));
		expect(out).toContain(RESUME_ANYWAY_NOTE);
		// Without the End handler (a viewer who may not end it) the plain Resume shows.
		const plain = html(
			createElement(LockedDraft, {
				reason: "r",
				showDraft: false,
				draft: "",
				startNew: false,
				resume: { offer: { state: "available" }, posting: false, onResume: () => {}, alert: null },
			}),
		);
		expect(plain).toContain(">Resume session<");
		expect(plain).not.toContain("End session");
	});

	test("a resume that is in flight shows its progress; an offline host disables Resume and says when it can be done", () => {
		expect(mode(fork("ask", "degraded"), { resumeInFlight: true })).toMatchObject({
			resume: { state: "in_flight" },
			reason: "Asking studio to resume this session…",
		});
		expect(mode(fork("ask", "degraded", { host: "offline" }))).toMatchObject({
			resume: { state: "disabled" },
			reason: "studio is offline. You can resume this session when it's back.",
		});
	});

	test("a failed resume of a fork is worded for a Claude session, naming the original", () => {
		const out = describeResumeFailure(
			new ApiError(409, "host_cannot_run_claude", { error: "host_cannot_run_claude" }),
			fork("ask", "degraded"),
			{
				sourceName: "refactor the parser",
			},
		);
		expect(out.reason).toContain("continue refactor the parser on another machine");
		expect(
			describeResumeFailure(
				new ApiError(409, "not_resumable", { error: "not_resumable" }),
				fork("ask", "degraded"),
			).reason,
		).not.toBe("");
	});

	test("the notice above the box: an approval first, a running turn", () => {
		expect(composerNotice({ isWorking: true, metadata: {} })).toContain(
			"The current turn hasn't ended.",
		);
	});

	test("on a phone the hint sits behind 'What waits for you' and the side text is hidden; both stay on a desktop", () => {
		const m = mode(fork("restricted", "managed")) as Parameters<typeof ComposerBody>[0]["mode"];
		const out = html(
			createElement(ComposerBody, {
				mode: m,
				phase: { step: "idle" },
				posting: false,
				justSent: false,
				prompt: "",
				notice: null,
				sideText: m.side,
				unavailable: false,
				onEdit: () => {},
				onSubmit: () => {},
			}),
		);
		expect(WHAT_WAITS_SUMMARY).toBe("What waits for you");
		expect(out).toContain("<details");
		expect(out).toContain(`>${WHAT_WAITS_SUMMARY}<`);
		expect(out).toMatch(/hidden md:block[^>]*>Each prompt continues/);
		expect(out).toMatch(
			/hidden md:block[^>]*>Replies and approval requests appear in this session\./,
		);
		// A 44px target for the disclosure and the button.
		expect(out).toContain("min-h-[44px]");
	});
});

// ── Stop is End on a continued session ──────────────────────────────────────

describe("ending a continued session", () => {
	test("the control is offered while it is managed and while it is degraded, and not once it is over", () => {
		for (const state of ["managed", "degraded"])
			expect(canStopSession(fork("ask", state)), state).toBe(true);
		for (const state of ["pending", "stopped", "completed", "failed"])
			expect(canStopSession(fork("ask", state)), state).toBe(false);
		// A launched Claude session keeps its states: degraded isn't one.
		expect(
			canStopSession({
				agentType: "claude_code",
				managedSession: { managedState: "degraded" },
				metadata: {},
			} as never),
		).toBe(false);
		expect(
			canStopSession({
				agentType: "claude_code",
				managedSession: { managedState: "headless" },
				metadata: {},
			} as never),
		).toBe(true);
	});

	test("the labels: End session on a fork; Stop turn on a launched Claude; Stop session on Codex", () => {
		expect(stopControlLabel(fork("ask", "managed"))).toBe("End session");
		expect(stopControlLabel({ agentType: "claude_code", metadata: {} } as never)).toBe("Stop turn");
		expect(stopControlLabel({ agentType: "codex_cli" } as never)).toBe("Stop session");
	});

	test("the confirmation names the session, says it can't be continued, and points at the original by name", () => {
		const copy = stopConfirmCopy(fork("ask", "managed"), {
			name: "refactor the parser (continued)",
			source: NAMED,
		});
		expect(copy).toEqual({
			title: "End refactor the parser (continued)?",
			confirmLabel: "End session",
			body: "Claude stops now and this session can't be continued. Anything it left running in the background may keep running. Files already changed stay changed. To keep working, continue refactor the parser in a new session; that starts from your terminal's conversation and won't include what happened here.",
		});
		const gone = stopConfirmCopy(fork("ask", "managed"), { name: "n", source: { state: "gone" } });
		expect(
			gone.body.endsWith(
				"To keep working, start a new session. What happened here stays in this session's timeline.",
			),
		).toBe(true);
		expect(gone.body).not.toContain("terminal's conversation");
		// The launched Claude's wording is untouched.
		expect(
			stopConfirmCopy({ agentType: "claude_code", isWorking: true, metadata: {} } as never)
				.confirmLabel,
		).toBe("Stop turn");
	});

	test("an offline host's continued session doesn't point at Archive (it would be refused until the session is ended)", () => {
		const offline = hostControlHint({ ...fork("ask", "managed", { host: "offline" }) });
		expect(offline).not.toContain("archive");
		const gone = hostControlHint({ ...fork("ask", "managed", { host: "gone" }) });
		expect(gone).toContain("You can archive it.");
		const launched = hostControlHint({
			managedSession: { hostName: "studio" },
			hostControl: { state: "offline", lastSeenAt: null },
			metadata: {},
		} as never);
		expect(launched).toContain("You can archive it.");
		expect(controlBlockedReason(fork("ask", "managed", { host: "offline" }))).toBe(
			"studio is offline, so this session can't be controlled right now. Nothing was sent.",
		);
	});
});

// ── the rest of the page ────────────────────────────────────────────────────

describe("the rest of a continued session's page", () => {
	test("the Tools and Noisy toggles say why they're off, the claim help says tool results aren't recorded, the instructions tab says nothing was loaded", () => {
		expect(FORK_TOOLS_REASON).toBe("This session records tool activity as short lines.");
		expect(claimOnlyCopy("claude_code", true).extra).toBe(
			"This session doesn't record tool results, so its commands can't confirm a claim.",
		);
		expect(claimOnlyCopy("claude_code").extra).toBeNull();
		expect(claimOnlyCopy("codex_cli", true).extra).toContain("Codex often records no result");
		expect(FORK_CLAUDE_MD_NOT_LOADED).toBe("Not loaded in this session.");
	});

	test("the AI tab says a person sends the prompts, and the source disables `auto` on a fork", async () => {
		expect(FORK_AI_LINE).toBe(
			"AgentPulse can suggest prompts here. A person sends them, so automatic sending isn't available.",
		);
		const { readFileSync } = await import("node:fs");
		const panel = readFileSync(new URL("./AiPanel.tsx", import.meta.url), "utf8");
		expect(panel).toMatch(/<option value="auto" disabled=\{fork\}/);
		expect(panel).toContain("{fork && ");
	});

	test("the per-turn lines show in Conversation, never in Prompts; per-call lines stay in Progress", () => {
		const summary = {
			eventType: "HeadlessStatus",
			category: "progress_update",
			isNoise: false,
			content: `${TURN_UNASKED_PREFIX} Read (4), Bash (2). Claude treated these as read-only.`,
		};
		const refused = { ...summary, content: `${TURN_REFUSED_PREFIX} Write (1).` };
		const perCall = { ...summary, content: "Bash: ran, you approved it" };
		const events = [summary, refused, perCall];
		const visible = (m: Parameters<typeof getVisibleEvents>[1]) =>
			getVisibleEvents(events as never, m, false, false, true).map((e) => e.content);
		expect(visible("conversation")).toEqual([summary.content, refused.content]);
		expect(visible("prompts")).toEqual([]);
		expect(visible("progress")).toHaveLength(3);
		expect(isTurnSummaryRow(summary)).toBe(true);
		expect(isTurnSummaryRow(perCall)).toBe(false);
		// Only the supervisor's own event type carries it: other rows that happen to start that way don't.
		expect(isTurnSummaryRow({ eventType: "AssistantMessage", content: summary.content })).toBe(
			false,
		);
		expect(isForkTurnSummary(null)).toBe(false);
	});

	test("the per-turn lines are worded per mode and name only what the mode can say", async () => {
		const { unaskedTurnText, refusedTurnText } = await import(
			"../../../supervisor/providers/claude-turn-rows.js"
		);
		const call = (name: string, over: Record<string, unknown> = {}) =>
			({
				toolUseId: name,
				name,
				requested: false,
				answer: null,
				decidedElsewhere: false,
				declinedLocally: false,
				resulted: true,
				isError: false,
				nonExecutionKind: null,
				decisionSource: null,
				...over,
			}) as never;
		const calls = [call("Read"), call("Read"), call("Bash")];
		expect(unaskedTurnText(calls, "ask")).toBe(
			"Ran without asking you this turn: Read (2), Bash (1). These were read-only, or your Claude settings allowed them.",
		);
		expect(unaskedTurnText(calls, "restricted")).toBe(
			"Ran without asking you this turn: Read (2), Bash (1). Claude treated these as read-only.",
		);
		expect(
			refusedTurnText([
				call("Write", { nonExecutionKind: "permission-rule", decisionSource: "config" }),
			]),
		).toBe("Claude tried this and was refused: Write (1).");
		expect(isForkTurnSummary(unaskedTurnText(calls, "ask"))).toBe(true);
	});
});

// ── the words, scanned ──────────────────────────────────────────────────────

/** Every sentence a person can read on the Claude side of this feature, from the functions that produce them. */
function corpus(): string[] {
	const out: string[] = [];
	const dialog = claudeDialogLines({
		sessionName: "n",
		machine: "studio",
		cwd: "/w",
		ownerName: "you",
		endedFork: "e",
	});
	out.push(
		dialog.title,
		dialog.directory,
		dialog.ownerLine ?? "",
		...dialog.paragraphs.map((p) => `${p.label ?? ""} ${p.text}`),
	);
	out.push(
		CLAUDE_CARD_ELIGIBLE,
		CLAUDE_QUIET_WAIT,
		CLAUDE_NO_HOST_SOLO,
		CLAUDE_NO_HOST_TEAM,
		claudeStaleWorking("t"),
		claudeProgress("h", false),
		claudeProgress("h", true),
	);
	for (const mode of MODES)
		out.push(forkModeLine(mode, "studio", "n"), forkFirstRowContent(mode, "studio", "n"));
	for (const code of RESUME_REFUSAL_CODES) {
		for (const kind of ["takeover", "recovery"] as const) {
			out.push(
				bindRefusalMessage(new ApiError(409, code, {}), {
					host: "studio",
					kind,
					agent: "claude_code",
					sourceName: "n",
				}),
			);
		}
	}
	for (const failure of RESUME_FAILURE_KINDS) {
		for (const kind of ["takeover", "recovery"] as const) {
			for (const mode of MODES)
				out.push(resumeFailureMessage(failure, "studio", kind, "claude_code", mode, "n"));
		}
	}
	for (const mode of MODES) {
		for (const state of ["managed", "degraded", "pending"]) {
			const m = composerMode(fork(mode, state, { syncError: CLAUDE_FORK_PEER_SYNC_ERROR }), {
				...ACCESS,
				source: NAMED,
			});
			if (m && "hint" in m) out.push(m.hint, m.side, m.placeholder);
			if (m && "reason" in m) out.push(m.reason);
		}
		const status = forkStatusView({
			fork: forkInfo(fork(mode, "stopped")) as never,
			source: NAMED,
			machine: "studio",
			managedState: "stopped",
		});
		out.push(status.line, status.modeLine ?? "", status.endedLine ?? "", status.link.text);
	}
	const end = stopConfirmCopy(fork("ask", "managed"), { name: "n", source: NAMED });
	out.push(
		end.title,
		end.body,
		end.confirmLabel,
		FORK_TOOLS_REASON,
		FORK_AI_LINE,
		FORK_CLAUDE_MD_NOT_LOADED,
	);
	return out.filter((s) => s !== "");
}

/** Sentences that promise commands wait, with no "except" or "unless" to qualify them. */
function unqualifiedCommandsWait(text: string): boolean {
	return text
		.split(/(?<=[.!?])\s+/)
		.some(
			(sentence) =>
				/\bcommands?\b[^.]*\bwaits?\b/i.test(sentence) && !/\b(except|unless)\b/i.test(sentence),
		);
}

describe("the words, scanned across the whole Claude side", () => {
	test("the corpus is not empty and covers the dialog, both modes, every refusal and every failure kind", () => {
		const all = corpus();
		expect(all.length).toBeGreaterThan(150);
		expect(all.some((s) => s.includes("Continue ") && s.includes("in a new session?"))).toBe(true);
		expect(all.some((s) => s.includes("aren't used in this session"))).toBe(true);
		expect(all.some((s) => s.includes("still apply in this session"))).toBe(true);
	});

	test("'bind' and 'enforced' appear nowhere", () => {
		for (const sentence of corpus()) {
			expect(sentence).not.toMatch(/\bbind(ing)?\b|\bbound\b/i);
			expect(sentence).not.toMatch(/\benforced?\b/i);
		}
	});

	test("no sentence says commands wait without saying which (the scanner's named member: an unqualified one)", () => {
		expect(unqualifiedCommandsWait("File changes and commands wait for you.")).toBe(true);
		expect(
			unqualifiedCommandsWait("Commands wait for your approval here, except read-only commands."),
		).toBe(false);
		for (const sentence of corpus())
			expect(unqualifiedCommandsWait(sentence), sentence).toBe(false);
	});

	test("no sentence shows a raw refusal code, and none uses 'take over' for a Claude session's own action", () => {
		for (const sentence of corpus()) {
			for (const code of [
				"claude_not_logged_in",
				"host_busy",
				"source_changed",
				"branch_changed",
				"end_session_first",
			]) {
				expect(sentence).not.toContain(code);
			}
		}
		const dialog = claudeDialogLines({
			sessionName: "n",
			machine: "studio",
			cwd: "/w",
			ownerName: null,
			endedFork: null,
		});
		expect(dialog.paragraphs.map((p) => p.text).join(" ")).not.toMatch(/take[ns]? over/i);
	});
});

describe("copy structure for the fork options (AGEN-119..123 Track 0)", () => {
	const base = {
		sessionName: "n",
		machine: "studio",
		cwd: "/w",
		ownerName: null,
		endedFork: null,
	};

	test("with no option the 'Not in this session' sentence is word for word what it was", () => {
		expect(notInSessionLine()).toBe(
			"your project's CLAUDE.md, hooks and MCP servers, your own MCP servers, subagents, slash commands and saving memories.",
		);
		expect(notInSessionLine({})).toBe(notInSessionLine());
		expect(notInSessionLine({ mcp: false, subagents: false })).toBe(notInSessionLine());
		const out = claudeDialogLines(base).paragraphs.find((p) => p.label === "Not in this session:");
		expect(out?.text).toBe(notInSessionLine());
	});

	test("an option that is turned on is no longer listed as missing", () => {
		expect(notInSessionLine({ mcp: true })).not.toContain("your own MCP servers");
		expect(notInSessionLine({ mcp: true })).toContain("subagents");
		expect(notInSessionLine({ subagents: true })).not.toContain("subagents");
		expect(notInSessionLine({ mcp: true, subagents: true })).toBe(
			"your project's CLAUDE.md, hooks and MCP servers, slash commands and saving memories.",
		);
		// The project's own MCP servers stay out whatever is chosen.
		expect(notInSessionLine({ mcp: true, subagents: true })).toContain("hooks and MCP servers");
	});

	test("the 'Not in this session' line says only what is absent; what tool detail there is has its own paragraph", () => {
		expect(notInSessionLine()).not.toMatch(/details?|timeline/i);
		expect(toolDetailLine("solo", null)).toBe("You can open what each tool call ran, for 7 days.");
		expect(toolDetailLine("team", "you")).toBe(
			"You and admins can open what each tool call ran, for 7 days, when signed in. Others see only the tool's name and outcome.",
		);
		expect(toolDetailLine("team", "Ana")).toMatch(/^Ana and admins can open /);
		expect(toolDetailLine("team", null)).toBe(
			"Admins can open what each tool call ran, for 7 days, when signed in. Others see only the tool's name and outcome.",
		);
		const solo = claudeDialogLines(base).paragraphs.find((p) => p.label === "Tool details:");
		expect(solo?.text).toBe(toolDetailLine("solo", null) as string);
		const team = claudeDialogLines({ ...base, ownerName: "you" }).paragraphs.find(
			(p) => p.label === "Tool details:",
		);
		expect(team?.text).toBe(toolDetailLine("team", "you") as string);
		// No option control exists yet.
		expect(FORK_OPTION_CONTROLS).toEqual([]);
		expect(FORK_OPTIONS_LEGEND).toBe("Options for this session (off by default)");
		expect(FORK_OPTIONS_CLOSING).toBe(
			"These stay as chosen for this session. To change them, continue again.",
		);
	});
});
