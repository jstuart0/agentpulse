/**
 * AGEN-69: reads a stored tool response. The column holds text, or, for an
 * agent whose tool response is an object (Claude's Bash result), JSON text cut
 * at 2,000 characters. In that text a newline is the two characters
 * backslash-n, so every line-anchored pattern misses; `readResponse` gives the
 * real text (stdout, output, stderr, error in that order) and an exit code when
 * the response carries one (`exit_code`, `exitCode`, `metadata.exit_code`).
 * Pure; never throws.
 */

export interface ReadResponse {
	text: string;
	/** Null when the response says nothing about one. */
	exitCode: number | null;
}

const TEXT_KEYS = ["stdout", "output", "stderr", "error"] as const;
const EXIT_CODE_RE = /"(?:exit_?[cC]ode|returncode|returnCode)"\s*:\s*(-?\d+)/;
const SIMPLE_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	'"': '"',
	"\\": "\\",
	"/": "/",
};

function decodeJsonString(body: string): string {
	const whole = body.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
	try {
		return JSON.parse(`"${whole}"`) as string;
	} catch {
		return whole.replace(/\\(.)/g, (_m, c: string) => SIMPLE_ESCAPES[c] ?? c);
	}
}

/** The body of the string value of `key`, up to its closing quote or the end of a cut text. */
function stringValueOf(text: string, key: string): string | null {
	const head = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
	if (!head) return null;
	let i = head.index + head[0].length;
	const start = i;
	while (i < text.length) {
		if (text[i] === "\\") i += 2;
		else if (text[i] === '"') break;
		else i++;
	}
	return decodeJsonString(text.slice(start, Math.min(i, text.length)));
}

function exitCodeOf(parsed: unknown, text: string): number | null {
	if (parsed && typeof parsed === "object") {
		const o = parsed as Record<string, unknown>;
		const meta =
			o.metadata && typeof o.metadata === "object" ? (o.metadata as Record<string, unknown>) : {};
		for (const candidate of [o.exit_code, o.exitCode, meta.exit_code, meta.exitCode]) {
			if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
		}
		return null;
	}
	const match = EXIT_CODE_RE.exec(text);
	return match ? Number(match[1]) : null;
}

export function readResponse(stored: string | null | undefined): ReadResponse {
	if (!stored) return { text: "", exitCode: null };
	if (!stored.trimStart().startsWith("{")) return { text: stored, exitCode: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		parsed = undefined;
	}
	const exitCode = exitCodeOf(parsed, stored);
	const parts: string[] = [];
	for (const key of TEXT_KEYS) {
		const value =
			parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>)[key]
				: stringValueOf(stored, key);
		if (typeof value === "string" && value !== "") parts.push(value);
	}
	return { text: parts.length > 0 ? parts.join("\n") : stored, exitCode };
}
