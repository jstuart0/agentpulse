/**
 * The watcher's refusal sentences live in their own module so the main bundle
 * doesn't carry them. Importing it registers them; each screen that can show
 * one imports it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeApiError } from "./api-errors.js";
import { ApiError } from "./api.js";
import "./watcher-api-errors.js";

const CODES = [
	"prompt_not_deliverable",
	"dispatch_blocked",
	"prompt_unsafe",
	"stale_proposal",
	"expired",
	"prompt_changed",
	"not_approvable",
	"already_resolved",
	"ai_paused",
	"empty_prompt",
	"prompt_too_long",
	"human_required",
	"detail_full_needs_private_chat",
	"invalid_provider",
	"invalid_channel",
	"session_missing",
	"launch_missing",
	"dispatch_failed",
];

describe("registered watcher messages", () => {
	test("every watcher refusal has its own sentence once the module is loaded", () => {
		for (const code of CODES) {
			const text = describeApiError(new ApiError(409, "x", { error: code }), "FALLBACK");
			expect({ code, text: text === "FALLBACK" ? "missing" : "ok" }).toEqual({ code, text: "ok" });
		}
	});

	test("the card path: a prompt_not_deliverable carrying host_upgrade_required reads the upgrade copy, and any other reason keeps the copy-the-prompt sentence", () => {
		const refusal = (reason: unknown) =>
			new ApiError(409, "x", { error: "prompt_not_deliverable", reason });
		expect(describeApiError(refusal("host_upgrade_required"), "FALLBACK")).toBe(
			"This session's host is running an older supervisor that can't send prompts to Codex. Update it, then start a new session for this work. Updating ends the sessions running there.",
		);
		expect(describeApiError(refusal("managed_state"), "FALLBACK")).toBe(
			"This session's process ended when its host restarted, so it can't take more prompts. Start a new session for this work.",
		);
		const generic =
			"AgentPulse can't type into this session right now. Copy the prompt from the dashboard instead.";
		for (const reason of ["control_busy", "constructor", 7, undefined, null]) {
			expect(describeApiError(refusal(reason), "FALLBACK")).toBe(generic);
		}
		expect(
			describeApiError(new ApiError(409, "x", { error: "prompt_not_deliverable" }), "FALLBACK"),
		).toBe(generic);
	});

	test("an unknown code still gets the caller's fallback", () => {
		expect(describeApiError(new ApiError(409, "x", { error: "no_such_code" }), "FALLBACK")).toBe(
			"FALLBACK",
		);
	});

	test("the main bundle's table does not carry them", () => {
		const main = readFileSync(join(import.meta.dir, "api-errors.ts"), "utf8");
		for (const code of CODES) expect(main).not.toContain(`${code}:`);
	});

	test("every screen that can show one imports the module", () => {
		const web = join(import.meta.dir, "..");
		for (const file of [
			"components/session-detail/AiPanel.tsx",
			"components/session-detail/WatcherHitlCard.tsx",
			"components/settings/AiSettingsPanel.tsx",
			"components/settings/TelegramChannelPanel.tsx",
			"pages/InboxPage.tsx",
		]) {
			expect(readFileSync(join(web, file), "utf8"), file).toMatch(
				/import "\.\.?(?:\/\.\.)?\/(?:lib\/)?watcher-api-errors\.js"/,
			);
		}
	});

	test("the AI tab is a lazy chunk, not part of the session page", () => {
		const page = readFileSync(join(import.meta.dir, "../pages/SessionDetailPage.tsx"), "utf8");
		expect(page).not.toMatch(/^import \{ AiPanel \}/m);
		expect(page).toContain('import("../components/session-detail/AiPanel.js")');
	});
});
