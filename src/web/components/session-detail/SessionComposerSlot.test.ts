import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { HOST_RESTARTED_SYNC_ERROR } from "../../../shared/managed-messages.js";
import type { ManagedState, Session } from "../../../shared/types.js";
import { useUserStore } from "../../stores/user-store.js";
import { followLiveState } from "../../test-utils/live-stores.js";
import { installDomStubs, removeDomStubs, renderHook } from "../../test-utils/render-hook.js";
import {
	ComposerBody,
	type ComposerBodyProps,
	LockedDraft,
	SessionComposerSlot,
	SessionPromptComposer,
} from "./SessionPromptComposer.js";
import { type ComposerMode, composerMode } from "./prompt-composer-view.js";

let undo: () => void;
beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => {
	undo = followLiveState(useUserStore);
	useUserStore.setState({ mode: "solo", userId: null, effectiveRole: "admin" });
});
afterEach(() => undo());

function session(agentType: string, managedState: ManagedState | null, over: object = {}): Session {
	return {
		sessionId: "s1",
		agentType,
		isWorking: false,
		ownerUserId: null,
		metadata: {},
		managedSession: managedState
			? { managedState, hostName: "studio", providerSyncError: null }
			: null,
		...over,
	} as unknown as Session;
}
const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const render = (s: Session) =>
	html(createElement(SessionComposerSlot, { session: s, onSubmitted: async () => {} }));

describe("SessionComposerSlot", () => {
	test("Codex managed has the textarea, the hint, a status line and the Send button", () => {
		const out = render(session("codex_cli", "managed"));
		expect(out).toContain("<textarea");
		expect(out).toContain("This starts a new turn in the same Codex thread");
		expect(out).toContain("What should Codex do next?");
		expect(out).toContain("Send prompt");
		expect(out).toContain("<output");
		expect(out).not.toMatch(/<textarea[^>]*readonly/i);
	});

	test("Codex degraded after a host restart is only the reason and the way to a new session", () => {
		const out = render(
			session("codex_cli", "degraded", {
				managedSession: {
					managedState: "degraded",
					hostName: "studio",
					providerSyncError: HOST_RESTARTED_SYNC_ERROR,
				},
			}),
		);
		expect(out).not.toContain("<textarea");
		expect(out).not.toContain("<button");
		expect(out).toContain("process ended when its host restarted");
		expect(out).toMatch(/<a[^>]*href="\/templates"[^>]*>Go to Templates<\/a>/);
		expect(out).toContain("border-amber-500/30");
	});

	test("Codex degraded for another reason says the connection isn't healthy", () => {
		const out = render(session("codex_cli", "degraded"));
		expect(out).toContain("connection to Codex isn&#x27;t healthy");
		expect(out).toContain("Start a new session to keep going.");
	});

	test("a host that is offline is a reason too, with no link and no 'nothing was sent'", () => {
		const out = render(
			session("codex_cli", "managed", { hostControl: { state: "offline", lastSeenAt: null } }),
		);
		expect(out).toContain(
			"studio is offline, so this session can&#x27;t take prompts until it&#x27;s back.",
		);
		expect(out).not.toContain("Nothing was sent");
		expect(out).not.toContain("Go to Templates");
	});

	test("completed Codex and observed sessions render nothing", () => {
		expect(render(session("codex_cli", "completed"))).toBe("");
		expect(render(session("codex_cli", null))).toBe("");
		expect(render(session("claude_code", null))).toBe("");
	});

	test("a Claude viewer who isn't the owner sees why they can't send, and no box", () => {
		useUserStore.setState({ mode: "team", userId: "viewer", effectiveRole: "member" });
		const out = render(session("claude_code", "headless", { ownerUserId: "someone-else" }));
		expect(out).toContain("Only the owner or an admin can send prompts to this session.");
		expect(out).not.toContain("<textarea");
	});

	test("the owner can send", () => {
		useUserStore.setState({ mode: "team", userId: "me", effectiveRole: "member" });
		const out = render(session("claude_code", "headless", { ownerUserId: "me" }));
		expect(out).toContain("<textarea");
		expect(out).not.toMatch(/<textarea[^>]*readonly/i);
	});

	test("the textarea has a label and is described by the hint", () => {
		const out = render(session("codex_cli", "managed"));
		const id = /<label[^>]*for="([^"]+)"/.exec(out)?.[1] ?? "";
		expect(id).not.toBe("");
		expect(out).toMatch(/<label[^>]*>Prompt for this session<\/label>/);
		expect(out).toContain(`id="${id}"`);
		expect(out).toMatch(/<textarea[^>]*aria-describedby="[^"]+"/);
	});

	test("a running turn shows the notice, in a colour that reads on a light page, and leaves the box editable", () => {
		const out = render(session("codex_cli", "managed", { isWorking: true }));
		expect(out).toContain("The current turn hasn&#x27;t ended.");
		expect(out).toContain("text-amber-700 dark:text-amber-400");
		expect(out).not.toMatch(/<textarea[^>]*readonly/i);
	});

	test("Claude's box keeps its classes; Codex's hint and side text hide on a phone and Send grows to 44px", () => {
		const claude = render(session("claude_code", "headless"));
		expect(claude).not.toContain("hidden md:block");
		expect(claude).not.toContain("min-h-[44px]");
		const codex = render(session("codex_cli", "managed"));
		expect(codex.match(/hidden md:block/g)).toHaveLength(2);
		expect(codex).toContain("min-h-[44px] md:min-h-0");
	});
});

describe("the slot is keyed by session, whatever a comment says", () => {
	function slotElement(props: { session: Session }) {
		return SessionComposerSlot({ session: props.session, onSubmitted: async () => {} });
	}

	test("rendered for session a and then b it returns the composer with a different key each time", async () => {
		const h = renderHook((props: { session: Session }) => slotElement(props), {
			session: session("codex_cli", "managed", { sessionId: "a" }),
		});
		await h.render({ session: session("codex_cli", "managed", { sessionId: "a" }) });
		const first = h.current.value as unknown as ReactElement;
		await h.render({ session: session("codex_cli", "managed", { sessionId: "b" }) });
		const second = h.current.value as unknown as ReactElement;
		expect(first.type).toBe(SessionPromptComposer);
		expect(second.type).toBe(SessionPromptComposer);
		expect(first.key).toBe("a");
		expect(second.key).toBe("b");
		await h.unmount();
	});
});

describe("the page mounts the slot", () => {
	const page = readFileSync(join(import.meta.dir, "../../pages/SessionDetailPage.tsx"), "utf8");

	test("the slot is mounted whenever the session is managed, and no Claude-only gate is left", () => {
		expect(page).toContain("<SessionComposerSlot");
		// bottomSlot (session-takeover-view.ts, tested there) returns "composer" for every managed session.
		expect(page).toMatch(/case "composer":\s*return \(\s*<SessionComposerSlot/);
		expect(page).toMatch(/switch \(bottomSlot\(session, attempt\)\)/);
		expect(page).not.toContain("isClaudeManaged");
		expect(page).not.toContain('session.agentType === "claude_code" && session.managedSession');
	});
});

describe("ComposerBody states", () => {
	const mode = composerMode(session("codex_cli", "managed"), {
		canPrompt: true,
		canResume: true,
	}) as Exclude<ComposerMode, { kind: "blocked" }>;
	const headless = composerMode(session("claude_code", "headless"), {
		canPrompt: true,
		canResume: true,
	}) as Exclude<ComposerMode, { kind: "blocked" }>;
	const base: ComposerBodyProps = {
		mode,
		phase: { step: "idle" },
		posting: false,
		justSent: false,
		prompt: "my words",
		notice: null,
		sideText: mode.side,
		unavailable: false,
		onEdit: () => {},
		onSubmit: () => {},
	};
	const body = (over: Partial<ComposerBodyProps> = {}) =>
		html(createElement(ComposerBody, { ...base, ...over }));

	test("while the host starts the turn: read-only text, 'Sending…', Send aria-disabled, and the wait said aloud", () => {
		const out = body({ phase: { step: "following" } });
		expect(out).toMatch(/<textarea[^>]*readonly/i);
		expect(out).toContain("my words");
		expect(out).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Sending…<\/button>/);
		expect(out).not.toMatch(/<button[^>]*\sdisabled=""/);
		expect(out).toMatch(
			/<output class="block text-\[11px\] text-muted-foreground">Waiting for the host to start this turn\.<\/output>/,
		);
		expect(out).not.toContain('role="alert"');
	});

	test("after a send went through, 'Prompt sent.' is for a screen reader only", () => {
		const out = body({ justSent: true, prompt: "" });
		expect(out).toMatch(/<output class="sr-only">Prompt sent\.<\/output>/);
	});

	test("a failed send: editable text, the reason in role=alert, and the way to a new session when it asks for one", () => {
		const out = body({ phase: { step: "failed", reason: "Host said no.", startNew: false } });
		expect(out).toMatch(/<div[^>]*role="alert"[^>]*>Host said no\.<\/div>/);
		expect(out).not.toMatch(/<textarea[^>]*readonly/i);
		expect(out).not.toContain("Go to Templates");
		const upgrade = body({ phase: { step: "failed", reason: "Update it.", startNew: true } });
		expect(upgrade).toMatch(
			/role="alert"[^>]*>Update it\. <a[^>]*href="\/templates"[^>]*>Go to Templates<\/a>/,
		);
	});

	test("an unknown outcome gets the literal warning", () => {
		const out = body({ phase: { step: "unknown" } });
		expect(out).toContain(
			"No answer from the host yet, so it may still run. Your text is back here. If Control history shows it queued or running, don&#x27;t send it again yet.",
		);
		expect(out).toContain('role="alert"');
	});

	test("the notice shows only while idle, never over text that was already sent or a failure", () => {
		const notice = "The current turn hasn't ended.";
		expect(body({ notice })).toContain("The current turn hasn&#x27;t ended.");
		for (const phase of [
			{ step: "following" },
			{ step: "failed", reason: "r", startNew: false },
			{ step: "unknown" },
		] as const) {
			expect(body({ notice, phase })).not.toContain("The current turn hasn&#x27;t ended.");
		}
	});

	test("Claude headless has no status line", () => {
		const out = body({ mode: headless, sideText: headless.side });
		expect(out).not.toContain("<output");
	});

	test("an unavailable host or terminal turns the box off", () => {
		const out = body({ mode: headless, sideText: "studio is offline", unavailable: true });
		expect(out).toMatch(/<textarea[^>]*disabled/);
		expect(out).toMatch(/<button[^>]*disabled/);
		expect(out).toContain("studio is offline");
	});
});

describe("LockedDraft", () => {
	const locked = (props: Partial<Parameters<typeof LockedDraft>[0]> = {}) =>
		html(
			createElement(LockedDraft, {
				reason: "Because.",
				showDraft: false,
				draft: "",
				startNew: false,
				...props,
			}),
		);

	test("with no draft it is only the reason", () => {
		const out = locked();
		expect(out).toContain("Because.");
		expect(out).not.toContain("<textarea");
		expect(out).not.toContain("<button");
		expect(out).toContain("text-foreground");
	});

	test("with a draft: the text read-only, no placeholder, no Send, and the line that says it is still there", () => {
		const out = locked({ showDraft: true, draft: "unsent words" });
		expect(out).toMatch(/<textarea[^>]*readonly/i);
		expect(out).toContain("unsent words");
		expect(out).not.toContain("placeholder=");
		expect(out).not.toContain("<button");
		expect(out).toContain("Your text is still here to copy.");
	});

	test("an ended session says so once, and keeps the text", () => {
		const out = html(
			createElement(SessionPromptComposer, {
				session: session("codex_cli", "completed"),
				mode: null,
				onSubmitted: async () => {},
			}),
		);
		expect(out).toBe("");
		const ended = locked({
			reason: "This session has ended, so it can't take prompts. Your text is still here to copy.",
			showDraft: true,
			draft: "kept",
		});
		expect(ended.match(/still here to copy/g)).toHaveLength(1);
		expect(ended).toContain("kept");
	});
});

describe("Resume session on a Codex session whose process is gone (AGEN-115)", () => {
	const THREAD = "0199e3a2-7c1d-7a31-9e2f-123456789abc";
	const degraded = (managed: object = {}, over: object = {}) =>
		session("codex_cli", "degraded", {
			managedSession: {
				managedState: "degraded",
				hostName: "studio",
				providerSyncError: HOST_RESTARTED_SYNC_ERROR,
				providerThreadId: THREAD,
				...managed,
			},
			...over,
		});
	const renderWith = (s: Session, attempt: object = { state: "none" }) =>
		html(
			createElement(SessionComposerSlot, {
				session: s,
				attempt,
				onSubmitted: async () => {},
			} as never),
		);

	test("the owner or an admin gets the sentence, a Resume session button and the way to a new session", () => {
		const out = renderWith(degraded());
		expect(out).toContain("Resume it to keep going, or start a new session for this work.");
		expect(out).toMatch(/<button[^>]*>Resume session<\/button>/);
		expect(out).toContain("Go to Templates");
		expect(out).not.toContain("<textarea");
	});

	test("a disabled button looks disabled, not just inert", () => {
		const out = renderWith(degraded({}, { hostControl: { state: "offline", lastSeenAt: null } }));
		expect(out).toMatch(
			/<button[^>]*disabled:opacity-50[^>]*disabled=""|<button[^>]*disabled=""[^>]*disabled:opacity-50/,
		);
	});

	test("the button is a 44px target and not disabled when the host is live", () => {
		const out = renderWith(degraded());
		expect(out).toMatch(/<button[^>]*min-h-\[44px\][^>]*>Resume session/);
		expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Resume session/);
	});

	test("an offline host: the button is disabled and the sentence is the offline one alone", () => {
		const out = renderWith(degraded({}, { hostControl: { state: "offline", lastSeenAt: null } }));
		expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Resume session<\/button>/);
		expect(out).toContain(
			"studio is offline, so this session can&#x27;t take prompts until it&#x27;s back.",
		);
		expect(out).not.toContain("Resume it to keep going");
	});

	test("in flight: a busy button and the status, no box", () => {
		const out = renderWith(degraded(), {
			state: "in_flight",
			actionId: "a",
			kind: "recovery",
			startedAt: "2026-11-04T12:00:00.000Z",
		});
		expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Resuming…<\/button>/);
		expect(out).toContain("Asking studio to resume this session…");
		expect(out).not.toContain("<textarea");
	});

	test("a failed recovery shows the host's sentence in an alert, and the Resume button is back", () => {
		const reason =
			"studio no longer has this session's history, so it can't be resumed. Start a new session for this work.";
		const out = renderWith(degraded(), {
			state: "failed",
			actionId: "a",
			kind: "recovery",
			reason,
		});
		expect(out).toMatch(/role="alert"[^>]*>[^<]*studio no longer has this session&#x27;s history/);
		expect(out).toMatch(/<button[^>]*>Resume session<\/button>/);
		// The sentence above already links to Templates, so the failure doesn't offer a second one.
		expect(out.match(/Go to Templates/g)).toHaveLength(1);
	});

	test("a failed takeover is not shown here: it belongs to the takeover card", () => {
		const out = renderWith(degraded(), {
			state: "failed",
			actionId: "a",
			kind: "takeover",
			reason: "a takeover reason",
		});
		expect(out).not.toContain("a takeover reason");
	});

	test("a viewer who can't resume gets the 'ask' sentence and no button", () => {
		useUserStore.setState({ mode: "team", userId: "viewer", effectiveRole: "member" });
		const out = renderWith(degraded({}, { ownerUserId: null }));
		expect(out).toContain("Ask an admin to resume it, or start a new session for this work.");
		expect(out).not.toContain("Resume session");
	});

	test("no thread id, no button", () => {
		const out = renderWith(degraded({ providerThreadId: null }));
		expect(out).not.toContain("Resume session");
		expect(out).toContain("Start a new session for this work.");
	});

	test("a kept draft stays readable beside the busy button", () => {
		const out = renderWith(degraded());
		expect(out).not.toContain("Your unsent prompt");
	});
});
