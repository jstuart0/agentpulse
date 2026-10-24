/**
 * The Notify answer: one JSON object `{verdict, why, evidence}`, parsed and
 * validated. Nothing the model wrote reaches a log or an error: a failure
 * carries only a fixed code.
 */
import { z } from "zod";
import { extractJsonObject, stripCodeFence, stripThinkTag } from "../parser.js";
import { removeNonce } from "../session-summary/output-schema.js";
import { stripInvisibleKeepNewlines } from "../untrusted-text.js";

export const NOTIFY_VERDICTS = ["finished", "stuck", "needs_you"] as const;
export type NotifyVerdict = (typeof NOTIFY_VERDICTS)[number];

export const NOTIFY_WHY_MAX_CHARS = 240;
export const NOTIFY_WHY_MAX_LINES = 2;
export const NOTIFY_EVIDENCE_MAX = 3;
/** An answer is a few hundred characters; reading more than this is reading something else. */
const MAX_ANSWER_CHARS = 20_000;

export type NotifyParseCode = "parse" | "citation";

export type NotifyParseResult =
	| { ok: true; verdict: NotifyVerdict; why: string; evidence: string[] }
	| { ok: false; code: NotifyParseCode };

const answerSchema = z.object({
	verdict: z.enum(NOTIFY_VERDICTS),
	why: z.string(),
	evidence: z
		.array(z.string().regex(/^E\d+$/))
		.min(1)
		.max(NOTIFY_EVIDENCE_MAX),
});

function readObject(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		const extracted = extractJsonObject(text);
		if (extracted === null) return undefined;
		try {
			return JSON.parse(extracted);
		} catch {
			return undefined;
		}
	}
}

/**
 * `why` as the reader will see it: invisible and bidi characters gone, each
 * line trimmed, empty lines dropped. Null when it is empty, longer than the
 * limit or runs past two lines: the contract is strict, and nothing is cut to fit.
 */
export function cleanWhy(raw: string): string | null {
	const lines = stripInvisibleKeepNewlines(raw)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length === 0 || lines.length > NOTIFY_WHY_MAX_LINES) return null;
	const why = lines.join("\n");
	return why.length > NOTIFY_WHY_MAX_CHARS ? null : why;
}

/**
 * @param raw the model's text
 * @param nonce the fence nonce, scrubbed from the answer before anything is read
 * @param ledgerIds the ids the ledger printed (`E123`); a cited id must be one of them
 */
export function parseNotifyAnswer(
	raw: string,
	nonce: string,
	ledgerIds: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): NotifyParseResult {
	try {
		if (typeof raw !== "string") return { ok: false, code: "parse" };
		const text = stripCodeFence(
			stripThinkTag(removeNonce(raw.slice(0, MAX_ANSWER_CHARS), nonce)).trim(),
		);
		const checked = answerSchema.safeParse(readObject(text));
		if (!checked.success) return { ok: false, code: "parse" };
		const why = cleanWhy(checked.data.why);
		if (why === null) return { ok: false, code: "parse" };
		const evidence = [...new Set(checked.data.evidence)];
		if (!evidence.every((id) => ledgerIds.has(id))) return { ok: false, code: "citation" };
		return { ok: true, verdict: checked.data.verdict, why, evidence };
	} catch {
		return { ok: false, code: "parse" };
	}
}
