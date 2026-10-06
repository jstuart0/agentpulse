/**
 * A scripted stand-in for the LLM adapter that tells the three kinds of call
 * an Ask turn makes apart: the intent classifiers, the semantic term expander
 * (its transcript prompt starts `/no_think\nQuestion:`), and the free-form
 * answer (its system prompt is ASK_SYSTEM_PROMPT). Every call is recorded.
 */
import { ASK_SYSTEM_PROMPT } from "../services/ask/context-builder.js";

export type LlmCallKind = "classifier" | "expander" | "answer";

export interface RecordedLlmCall {
	kind: LlmCallKind;
	systemPrompt: string;
	transcriptPrompt: string;
}

export const llmCalls: RecordedLlmCall[] = [];

let hold: Promise<void> | null = null;

/** Classifier replies keyed by a substring of the classifier's system prompt. */
let classifierReplies: Array<[string, string]> = [];
let answerText = "ANSWER";

export function resetScriptedLlm(): void {
	hold = null;
	llmCalls.length = 0;
	classifierReplies = [];
	answerText = "ANSWER";
}

export function scriptClassifier(promptSubstring: string, reply: unknown): void {
	classifierReplies.push([
		promptSubstring,
		typeof reply === "string" ? reply : JSON.stringify(reply),
	]);
}

export function setAnswerText(text: string): void {
	answerText = text;
}

export function callsOfKind(kind: LlmCallKind): RecordedLlmCall[] {
	return llmCalls.filter((c) => c.kind === kind);
}

function kindOf(req: { systemPrompt: string; transcriptPrompt: string }): LlmCallKind {
	if (req.transcriptPrompt.startsWith("/no_think\nQuestion:")) return "expander";
	if (req.systemPrompt === ASK_SYSTEM_PROMPT) return "answer";
	return "classifier";
}

export const scriptedAdapter = {
	complete: async (req: { systemPrompt: string; transcriptPrompt: string }) => {
		const kind = kindOf(req);
		llmCalls.push({ kind, systemPrompt: req.systemPrompt, transcriptPrompt: req.transcriptPrompt });
		if (hold) await hold;
		let text = "";
		if (kind === "answer") text = answerText;
		else if (kind === "classifier") {
			const hit = classifierReplies.find(([needle]) => req.systemPrompt.includes(needle));
			text = hit ? hit[1] : '{"intent":"none"}';
		}
		return { text, usage: { estimated: true, inputTokens: 1, outputTokens: 1 } };
	},
};

/** Makes every LLM call wait until the returned function is called. */
export function holdLlmCalls(): () => void {
	let release = () => {};
	hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	return () => {
		hold = null;
		release();
	};
}
