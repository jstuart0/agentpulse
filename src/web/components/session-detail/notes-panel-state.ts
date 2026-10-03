/**
 * How the Notes panel presents itself. Someone else's session (a read-only
 * reason) shows its notes as text, or "No notes yet.", with the reason beside
 * the title and no way to edit; everyone else starts in the editor.
 */
export interface NotesPanelState {
	mode: "edit" | "preview";
	/** The Edit | Preview toggle: only for someone who can edit. */
	showModeToggle: boolean;
}

export function notesPanelState(input: {
	readOnlyReason: string | null | undefined;
	chosenMode: "edit" | "preview";
}): NotesPanelState {
	if (input.readOnlyReason) return { mode: "preview", showModeToggle: false };
	return { mode: input.chosenMode, showModeToggle: true };
}
