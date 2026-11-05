/**
 * The browser notification for a session that stopped working. It can't tell how the turn ended
 * (a failed Codex turn flips the same flag as a finished one), so the words claim only that the
 * session stopped: never "finished", never a task the agent reported.
 */
import { describe, expect, test } from "bun:test";
import { turnStoppedNotification } from "./turn-stopped-notification.js";

describe("turnStoppedNotification", () => {
	test("the title is '<name> stopped' and the body is 'In <directory>', for any agent", () => {
		for (const agentType of ["claude_code", "codex_cli", "copilot_cli"]) {
			const session = {
				sessionId: "abcdef123456",
				displayName: "quiet-otter",
				cwd: "/work/projects/api",
				agentType,
				currentTask: "Done with the migration",
			};
			expect(turnStoppedNotification(session)).toEqual({
				title: "quiet-otter stopped",
				body: "In api",
			});
		}
	});

	test("it never says finished, and ignores the agent's reported current task", () => {
		const session = {
			sessionId: "abcdef123456",
			displayName: "quiet-otter",
			cwd: "/work/api",
			currentTask: "Finished everything",
		};
		const note = turnStoppedNotification(session);
		expect(`${note.title} ${note.body ?? ""}`.toLowerCase()).not.toContain("finished");
		expect(`${note.title} ${note.body ?? ""}`).not.toContain("Finished everything");
	});

	test("a missing directory leaves the body out; a missing name falls back to the short session id", () => {
		const note = turnStoppedNotification({
			sessionId: "abcdef123456",
			displayName: null,
			cwd: null,
		});
		expect(note).toEqual({ title: "abcdef12 stopped" });
		expect("body" in note).toBe(false);
		expect(turnStoppedNotification({ sessionId: "s", displayName: "x", cwd: "" })).toEqual({
			title: "x stopped",
		});
	});

	test("a trailing slash and a Windows path still give the last directory", () => {
		expect(turnStoppedNotification({ sessionId: "s", displayName: "n", cwd: "/a/b/" }).body).toBe(
			"In b",
		);
		expect(
			turnStoppedNotification({ sessionId: "s", displayName: "n", cwd: "C:\\work\\api" }).body,
		).toBe("In api");
	});
});
