import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManagedState, Session } from "../../../shared/types.js";
import { useUserStore } from "../../stores/user-store.js";
import { followLiveState } from "../../test-utils/live-stores.js";
import { SessionComposerSlot } from "./SessionPromptComposer.js";

let undo: () => void;
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
		metadata: null,
		managedSession: managedState ? { managedState, hostName: "studio" } : null,
		...over,
	} as unknown as Session;
}
const render = (s: Session) =>
	renderToStaticMarkup(
		createElement(SessionComposerSlot, { session: s, onSubmitted: async () => {} }),
	);

describe("SessionComposerSlot", () => {
	test("Codex managed has the textarea, the hint and the Send button", () => {
		const html = render(session("codex_cli", "managed"));
		expect(html).toContain("<textarea");
		expect(html).toContain("This starts a new turn in the same Codex thread");
		expect(html).toContain("What should Codex do next?");
		expect(html).toContain("Send prompt");
		expect(html).not.toMatch(/<textarea[^>]*readonly/i);
	});

	test("Codex degraded keeps the textarea, read-only, with the reason", () => {
		const html = render(session("codex_cli", "degraded"));
		expect(html).toContain("<textarea");
		expect(html).toMatch(/<textarea[^>]*readonly/i);
		expect(html).toContain("This session&#x27;s connection to Codex isn&#x27;t healthy");
	});

	test("completed Codex and observed sessions render nothing", () => {
		expect(render(session("codex_cli", "completed"))).toBe("");
		expect(render(session("codex_cli", null))).toBe("");
		expect(render(session("claude_code", null))).toBe("");
	});

	test("a Claude viewer who isn't the owner sees why they can't send", () => {
		useUserStore.setState({ mode: "team", userId: "viewer", effectiveRole: "member" });
		const html = render(session("claude_code", "headless", { ownerUserId: "someone-else" }));
		expect(html).toContain("Only the owner or an admin can send prompts to this session.");
		expect(html).toMatch(/<textarea[^>]*readonly/i);
	});

	test("the owner can send", () => {
		useUserStore.setState({ mode: "team", userId: "me", effectiveRole: "member" });
		const html = render(session("claude_code", "headless", { ownerUserId: "me" }));
		expect(html).not.toMatch(/<textarea[^>]*readonly/i);
	});

	test("the textarea has a label and is described by the hint", () => {
		const html = render(session("codex_cli", "managed"));
		expect(html).toMatch(/<label[^>]*for="([^"]+)"/);
		const id = /<label[^>]*for="([^"]+)"/.exec(html)?.[1] ?? "";
		expect(html).toContain(`id="${id}"`);
		expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]+"/);
	});

	test("a running turn shows the notice and leaves the box editable", () => {
		const html = render(session("codex_cli", "managed", { isWorking: true }));
		expect(html).toContain("The current turn hasn&#x27;t ended.");
		expect(html).not.toMatch(/<textarea[^>]*readonly/i);
	});

	test("the composer is keyed by session, so a draft can't land in another session's box", () => {
		const source = readFileSync(join(import.meta.dir, "SessionPromptComposer.tsx"), "utf8");
		expect(source).toContain("key={session.sessionId}");
	});
});
