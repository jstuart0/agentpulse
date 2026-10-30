/**
 * The text checks a Continue suggestion goes through before it is shown or
 * sent: the summary tripwire (commands the session never ran, links nobody
 * typed, pipe-to-shell, override phrases), judged against what the session
 * actually recorded in its recent events.
 */
import type { SummarySuspectReason } from "../../../shared/session-summary.js";
import type { SessionEvent } from "../../../shared/types.js";
import { checkText, collectUserPromptUrls, contextOf } from "./session-summary/tripwire.js";

const COMMAND_TOOLS = new Set(["bash", "shell", "powershell", "exec", "run_shell_command"]);

function stringField(input: Record<string, unknown> | null, key: string): string | null {
	const value = input?.[key];
	return typeof value === "string" && value !== "" ? value : null;
}

/** The tripwire's context from the events the watcher was shown: typed links, edited paths, run commands. */
export function tripwireContextFromEvents(recent: readonly SessionEvent[]) {
	const prompts: string[] = [];
	const recordedPaths: string[] = [];
	const recordedCommands: string[] = [];
	for (const e of recent) {
		if (e.category === "prompt" && e.content) prompts.push(e.content);
		if (e.category !== "tool_event") continue;
		const path =
			stringField(e.toolInput, "file_path") ??
			stringField(e.toolInput, "path") ??
			stringField(e.toolInput, "notebook_path");
		if (path) recordedPaths.push(path);
		const command = stringField(e.toolInput, "command");
		if (command && COMMAND_TOOLS.has((e.toolName ?? "").toLowerCase())) {
			recordedCommands.push(command);
		}
	}
	return contextOf(collectUserPromptUrls(prompts), { recordedPaths, recordedCommands });
}

/** Reason codes for a suggested prompt; empty when it is clean. */
export function suggestionTripwire(
	text: string,
	recent: readonly SessionEvent[],
): SummarySuspectReason[] {
	return checkText(text, tripwireContextFromEvents(recent), { checkCommands: true });
}
