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
let answerHold: Promise<void> | null = null;

/** Classifier replies keyed by a substring of the classifier's system prompt. */
let classifierReplies: Array<[string, string]> = [];
let answerText = "ANSWER";
/** Thrown by the next answer calls (until reset), to drive the failure copy. */
let answerError: Error | null = null;
/** Thrown by a classifier whose system prompt contains the key. */
let classifierErrors: Array<[string, Error]> = [];

export function resetScriptedLlm(): void {
	hold = null;
	answerHold = null;
	llmCalls.length = 0;
	classifierReplies = [];
	answerText = "ANSWER";
	answerError = null;
	classifierErrors = [];
}

export function scriptClassifier(promptSubstring: string, reply: unknown): void {
	classifierReplies.push([
		promptSubstring,
		typeof reply === "string" ? reply : JSON.stringify(reply),
	]);
}

export function setAnswerError(error: Error | null): void {
	answerError = error;
}

export function scriptClassifierError(promptSubstring: string, error: Error): void {
	classifierErrors.push([promptSubstring, error]);
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
		if (kind === "answer" && answerHold) await answerHold;
		if (kind === "answer" && answerError) throw answerError;
		if (kind === "classifier") {
			const failing = classifierErrors.find(([needle]) => req.systemPrompt.includes(needle));
			if (failing) throw failing[1];
		}
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

/** Makes only the free-form answer wait (classifiers and the expander run), so a turn reaches its `start` first. */
export function holdAnswerCalls(): () => void {
	let release = () => {};
	answerHold = new Promise<void>((resolve) => {
		release = resolve;
	});
	return () => {
		answerHold = null;
		release();
	};
}
