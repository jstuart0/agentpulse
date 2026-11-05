/**
 * Where a refusal can say "Resume" (AGEN-115, phase 5, Pattern 3). Three sites change because a Resume button
 * exists there or the host can say so; the others keep "start a new session", which stays true for them (they
 * move with AGEN-114). Source reads: a dropped site, or an edited one of the rest, fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

const CHANGED = [
	"src/supervisor/providers/codex-managed.ts",
	"src/web/components/session-detail/host-control-view.ts",
	"src/web/components/session-detail/prompt-composer-view.ts",
];
const UNCHANGED = [
	"src/server/services/control-actions.ts",
	"src/server/services/ai/continue-decision.ts",
	"src/server/routes/channels.ts",
	"src/web/lib/watcher-api-errors.ts",
	"packages/agentpulse-mcp/src/errors.ts",
];

describe("the three sites that offer the way back", () => {
	test("each says 'Resume it', and the count is three (the plan's population check)", () => {
		for (const file of CHANGED) expect(read(file), file).toContain("Resume it");
		expect(CHANGED.filter((file) => read(file).includes("Resume it"))).toHaveLength(3);
	});

	test("the host's no-runtime sentence points at the dashboard; its stopping sentence keeps the old words", () => {
		const managed = read("src/supervisor/providers/codex-managed.ts");
		expect(managed).toContain(
			"This session's Codex process isn't running on its host any more. Resume it from its page in the web dashboard, or start a new session for this work.",
		);
		expect(managed).toContain(
			"stopping:\n\t\t\"This session's Codex process isn't running on its host any more. Start a new session for this work.\",",
		);
	});

	test("the refused-prompt sentence for a restarted host offers Resume; the composer's own no-thread sentence does not", () => {
		expect(read("src/web/components/session-detail/host-control-view.ts")).toContain(
			"This session's process ended when its host restarted. Resume it to keep going, or start a new session for this work.",
		);
		const composer = read("src/web/components/session-detail/prompt-composer-view.ts");
		expect(composer).toContain("Resume it to keep going, or start a new session for this work.");
		expect(composer).toContain("Resume it to reconnect, or start a new session to keep going.");
	});
});

describe("the sites that stay as they are", () => {
	test("each still offers a new session and never says 'Resume it'", () => {
		for (const file of UNCHANGED) {
			const text = read(file);
			expect(/start a new session/i.test(text), file).toBe(true);
			expect(text, file).not.toContain("Resume it");
		}
	});
});
