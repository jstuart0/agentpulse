import { describe, expect, test } from "bun:test";
import { notesPanelState } from "./notes-panel-state.js";

describe("notesPanelState", () => {
	test("someone else's session shows the notes as text with no way to edit, whatever mode was chosen", () => {
		for (const chosenMode of ["edit", "preview"] as const) {
			expect(
				notesPanelState({ readOnlyReason: "Only the owner or an admin can edit.", chosenMode }),
			).toEqual({ mode: "preview", showModeToggle: false });
		}
	});

	test("your own session keeps the editor and the toggle", () => {
		expect(notesPanelState({ readOnlyReason: null, chosenMode: "edit" })).toEqual({
			mode: "edit",
			showModeToggle: true,
		});
		expect(notesPanelState({ readOnlyReason: undefined, chosenMode: "preview" })).toEqual({
			mode: "preview",
			showModeToggle: true,
		});
	});
});

describe("the Notes panel uses it", () => {
	test("Panels.tsx derives its mode and toggle from notesPanelState", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const source = readFileSync(join(import.meta.dir, "Panels.tsx"), "utf8");
		expect(source).toContain("notesPanelState(");
		expect(source).toContain("showModeToggle");
	});
});
