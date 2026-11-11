import type { SessionEvent } from "../../../shared/types.js";
import { checkText, collectUserPromptUrls, contextOf } from "./session-summary/tripwire.js";

/** Stored in place of model text that failed the text check; the person's inbox entry keeps the text itself. */
export const HELD_BACK_REPORT_TEXT =
	"The watcher's report was held back: it contained text AgentPulse could not check.";

/**
 * Event rows the watcher writes are read back by Ask and by the next watcher run, so model text
 * that carries a link or a command nothing recorded (the check Notify's note passes) is replaced
 * there by fixed text. A run with no ledger has nothing recorded: the URLs the person typed in
 * the rows the run read are the only ones that pass.
 */
export function textForTranscript(text: string, recent: SessionEvent[]): string {
	const typedUrls = collectUserPromptUrls(
		recent.filter((e) => e.category === "prompt").map((e) => e.content ?? ""),
	);
	const suspect = checkText(
		text,
		contextOf(typedUrls, { recordedPaths: [], recordedCommands: [] }),
		{
			checkCommands: false,
		},
	);
	return suspect.length > 0 ? HELD_BACK_REPORT_TEXT : text;
}
