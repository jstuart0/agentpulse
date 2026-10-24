/**
 * What may leave for Telegram. Telegram is a third-party service, so every
 * text a watcher puts in a message (a report, a HITL prompt, an echo) goes
 * through here first: secrets redacted, the home directory shown as `~` and the
 * session's working directory as `<repo>`, invisible characters removed.
 */
import { redact } from "../ai/redactor.js";
import { stripInvisibleKeepNewlines } from "../ai/untrusted-text.js";

/** Home directories on the machines agents run on: macOS, Linux and Windows. */
const HOME_PATH_RES: readonly RegExp[] = [
	/\/Users\/[^/\s]+/g,
	/\/home\/[^/\s]+/g,
	/[A-Za-z]:\\Users\\[^\\\s]+/g,
];

export interface TelegramTextContext {
	/** The session's working directory, shown as `<repo>`. */
	cwd?: string | null;
}

/** Redacted, path-normalised, invisible-character-free text. */
export function redactForTelegram(text: string, ctx: TelegramTextContext = {}): string {
	let out = stripInvisibleKeepNewlines(redact(text).text);
	// The working directory first: it usually lives under the home directory.
	if (ctx.cwd && ctx.cwd.length > 1) out = out.split(ctx.cwd).join("<repo>");
	for (const re of HOME_PATH_RES) out = out.replace(re, "~");
	return out;
}
