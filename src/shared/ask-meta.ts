// Shared discriminated union and parser/encoder for the `ask-message-meta`
// fenced sentinel embedded in assistant message content. Previously defined
// as three separate encode/extract pairs on the server and three separate
// parse functions on the frontend — all sharing the same regex and JSON
// shape. One shared module keeps the parse contract in a single place.

/** Choice snapshot — structural twin of ProjectChoiceSnapshot in src/server/db/schema.ts */
export interface AskMetaProjectChoice {
	id: string;
	name: string;
	cwd: string;
}

export interface AskMetaScaffoldAction {
	kind: string;
	path: string;
	gitInit?: boolean;
	seedClaudeMdPath?: string;
	seedClaudeMdBytes?: number;
}

export interface AskMetaError {
	code: string;
	message: string;
	path?: string;
}

export type AskMessageMeta =
	| {
			kind: "project_picker";
			draftId: string;
			choices: AskMetaProjectChoice[];
			taskHint?: string;
			taskBriefSummary?: string;
			telegramOrigin: boolean;
			// Server always emits this; client defensive handling (meta.canScaffold && …)
			// is harmless if a very old stored message predates the field.
			canScaffold: boolean;
	  }
	| {
			kind: "workspace_scaffold";
			draftId: string;
			resolvedPath: string;
			taskSlug: string;
			actions: AskMetaScaffoldAction[];
			canScaffold: boolean;
			suggestedHost?: string;
			telegramOrigin: boolean;
			error?: AskMetaError;
	  }
	| {
			kind: "workspace_clone";
			draftId: string;
			url: string;
			resolvedPath: string;
			branch?: string;
			depth?: number;
			timeoutSeconds: number;
			canClone: boolean;
			suggestedHost?: string;
			telegramOrigin: boolean;
			error?: AskMetaError;
	  };

const ASK_META_FENCE_TAG = "ask-message-meta";
// Canonical regex — matches all three existing per-kind implementations
// byte-for-byte. The \n* prefix handles a fence at start-of-string or
// preceded by visible text; [\s\S]*? is non-greedy any-char-including-newline.
const ASK_META_FENCE_RE = new RegExp(`\\n*\`\`\`${ASK_META_FENCE_TAG}\\n([\\s\\S]*?)\\n\`\`\``);

/**
 * Parse the `ask-message-meta` fenced sentinel embedded in an assistant
 * message. Returns `{ meta, visibleText }` on success, `null` on any
 * failure (no fence, malformed JSON, unknown kind, or per-kind shape
 * check fails). Callers should switch on `meta.kind`.
 *
 * Strict per-kind validation matches the union of all existing per-side
 * checks so behavior is parity with the three old parsers it replaces.
 */
export function parseAskMeta(
	content: string,
): { meta: AskMessageMeta; visibleText: string } | null {
	const match = content.match(ASK_META_FENCE_RE);
	if (!match) return null;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(match[1]);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed.kind !== "string") return null;

	const visibleText = content.replace(ASK_META_FENCE_RE, "").trim();

	if (parsed.kind === "project_picker") {
		// Mirrors extractPickerMeta: kind + Array.isArray(choices)
		if (!Array.isArray(parsed.choices)) return null;
		return { meta: parsed as AskMessageMeta, visibleText };
	}
	if (parsed.kind === "workspace_scaffold") {
		// Adopts the stricter web-side check (resolvedPath + actions) over
		// the server-side check (actions only) — superset of both.
		if (typeof parsed.resolvedPath !== "string" || !Array.isArray(parsed.actions)) return null;
		return { meta: parsed as AskMessageMeta, visibleText };
	}
	if (parsed.kind === "workspace_clone") {
		// Mirrors extractWorkspaceCloneMeta / parseClonerMeta: url + resolvedPath
		if (typeof parsed.url !== "string" || typeof parsed.resolvedPath !== "string") return null;
		return { meta: parsed as AskMessageMeta, visibleText };
	}

	return null;
}

/**
 * Encode an `AskMessageMeta` value as a fenced sentinel block to embed
 * at the end of an assistant message. Output is byte-identical to the
 * three old per-kind encoders it replaces.
 */
export function encodeAskMeta(meta: AskMessageMeta): string {
	return `\n\n\`\`\`${ASK_META_FENCE_TAG}\n${JSON.stringify(meta)}\n\`\`\``;
}
