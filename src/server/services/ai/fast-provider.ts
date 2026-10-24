import { getFastProviderId } from "./feature.js";
import { getAdapter } from "./llm/registry.js";
import { type LlmAdapter, LlmError } from "./llm/types.js";
import { getProvider, getProviderApiKey } from "./providers-service.js";
import { chargeFailedCall } from "./usage-cost.js";

/**
 * The "fast provider" (AGEN-79): an optional second provider for the small,
 * latency-sensitive calls (the Ask intent classifiers, query expansion, the
 * alert-rule yes/no check). A model busy with a long call, such as a session
 * summary, answers nothing else until it finishes, so on one server these
 * calls queue behind it and time out. Pointing them at a small model on its
 * own server keeps them quick. Answers and summaries never use it.
 *
 * Unset means the default provider, as before. If the fast provider fails or
 * times out, the call is made again, once, on the default provider, and the
 * fast provider is left alone for `FAST_PROVIDER_COOLDOWN_MS` so a fast host
 * that is down costs one failed call per window, not one per call.
 */

export const FAST_PROVIDER_COOLDOWN_MS = 60_000;
/** The flat charge for a failed fast attempt whose usage was only estimated. */
const FAST_FAILED_CALL_ESTIMATE_CENTS = 1;

let fastOpenUntilMs = 0;
let clock: () => number = Date.now;

/** Test-only: forget a failure so the fast provider is tried again, and optionally swap the clock. */
export function __resetFastProviderForTests(now: () => number = Date.now): void {
	fastOpenUntilMs = 0;
	clock = now;
}

export interface SmallCallTarget {
	adapter: LlmAdapter;
	/** The model the caller should name. The adapter substitutes the right one for whichever provider answers. */
	model: string;
}

/**
 * Wraps the default provider's target with the fast provider in front of it.
 * Returns `base` untouched when no fast provider is set, it is the default
 * itself, it was deleted, its credentials are unreadable, or it is cooling down.
 */
export async function withFastProvider(
	base: SmallCallTarget & { providerId: string },
): Promise<SmallCallTarget> {
	const fastId = await getFastProviderId();
	if (!fastId || fastId === base.providerId || clock() < fastOpenUntilMs) return base;
	const fast = await getProvider(fastId);
	if (!fast) return base;
	const apiKey = await getProviderApiKey(fastId);
	if (apiKey === null) return base;
	const fastAdapter = getAdapter({
		kind: fast.kind,
		apiKey,
		baseUrl: fast.baseUrl ?? undefined,
	});

	return {
		model: fast.model,
		adapter: {
			kind: fastAdapter.kind,
			async complete(request) {
				if (clock() >= fastOpenUntilMs) {
					try {
						return await fastAdapter.complete({ ...request, model: fast.model });
					} catch (err) {
						// The caller giving up is not the fast provider failing.
						if (request.signal?.aborted) throw err;
						// An empty reply was still billed; the retry is charged by the caller.
						chargeFailedCall(err, FAST_FAILED_CALL_ESTIMATE_CENTS);
						fastOpenUntilMs = clock() + FAST_PROVIDER_COOLDOWN_MS;
						console.warn(
							JSON.stringify({
								kind: "ai_fast_provider_fallback",
								level: "warn",
								fastProviderId: fastId,
								subType: err instanceof LlmError ? err.subType : "unknown",
								cooldownMs: FAST_PROVIDER_COOLDOWN_MS,
							}),
						);
					}
				}
				return base.adapter.complete({ ...request, model: base.model });
			},
		},
	};
}
