import { LlmError, type LlmUsage } from "./llm/types.js";
import { addGlobalSpendCents } from "./spend-service.js";

/**
 * What a global (non-session) call costs against the daily cap, in whole cents,
 * at least one. A call whose usage was only estimated is charged the caller's
 * flat estimate. This is the formula the intent classifiers and Q&A always used.
 */
export function globalCentsForUsage(usage: LlmUsage, estimatedCents: number): number {
	return usage.estimated
		? estimatedCents
		: Math.max(1, Math.round(((usage.inputTokens + usage.outputTokens) / 1_000_000) * 100));
}

/**
 * A provider that answered with no usable text (`empty_output`) still billed
 * the tokens it produced, and a thinking model spends most of its budget on
 * exactly those calls. Charge them to the daily cap like any other call.
 * Errors that carry no usage (timeouts, 4xx, 5xx) charge nothing. Best effort.
 */
export function chargeFailedCall(err: unknown, estimatedCents: number): void {
	if (!(err instanceof LlmError) || !err.usage) return;
	void addGlobalSpendCents(globalCentsForUsage(err.usage, estimatedCents)).catch(() => {});
}
