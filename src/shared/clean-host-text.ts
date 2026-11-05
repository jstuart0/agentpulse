/**
 * Text a host (an authenticated machine, but still another process) hands us to show a person, such as the
 * `error` of a failed control action. Control, bidirectional and other format characters are removed, white
 * space is collapsed, and the length is capped, so it can't reorder or hide what's around it. The server
 * cleans it when it is stored and the web cleans it again when it shows it.
 */
export const HOST_TEXT_MAX_CHARS = 500;

export function cleanHostText(value: unknown, max = HOST_TEXT_MAX_CHARS): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\p{Cf}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned === "") return null;
	const points = Array.from(cleaned);
	return points.length <= max ? cleaned : `${points.slice(0, max).join("").trimEnd()}…`;
}
