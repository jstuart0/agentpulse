/**
 * The last status of a launch or a prompt, kept in memory and retried until the server answers (AGEN-117
 * T12). It used to be one attempt, and a lost one left a headless launch `running` or a prompt holding the
 * session's lock, which with the turn guard shuts the session until a supervisor restart. Launch status is
 * never queued on disk (a late overwrite is worse than a lost update), so the retry lives in memory: if the
 * supervisor dies first, registration frees the session.
 *
 * Only a failure that says "try again" is retried: no answer, a timeout, a 5xx or a back-pressure reply. Any
 * answer, a refusal included, ends it: the server has heard. A newer report under the same key replaces a
 * pending retry, so a `cancelled` is never undone by an older `completed` still being retried.
 */
import { classifyReportFailure, sessionBackoffMs } from "./report-resilience.js";

/** Sends one final report. Resolves when the first attempt is over; later attempts run in the background. */
export type FinalReporter = (key: string, send: () => Promise<void>) => Promise<void>;

/** Without a retrier a report is one attempt, as it always was. */
export const sendOnce: FinalReporter = (_key, send) => send();

const RETRYABLE = new Set(["network", "server", "backoff"]);

export function createFinalReporter(
	options: {
		wait?: (ms: number) => Promise<void>;
		log?: (line: string) => void;
		random?: () => number;
	} = {},
): FinalReporter {
	const wait =
		options.wait ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, ms);
				timer.unref?.();
			}));
	const log = options.log ?? ((line: string) => console.log(line));
	const random = options.random ?? (() => 0.5);
	const latest = new Map<string, symbol>();

	async function attempt(send: () => Promise<void>): Promise<unknown | null> {
		try {
			await send();
			return null;
		} catch (error) {
			return error;
		}
	}

	async function retryLoop(key: string, send: () => Promise<void>, token: symbol, first: unknown) {
		let failures = 1;
		let error: unknown = first;
		while (latest.get(key) === token) {
			const failure = classifyReportFailure(error);
			if (!RETRYABLE.has(failure)) break;
			const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
			log(`[supervisor] final report ${key} not delivered (${failure}); retrying`);
			await wait(sessionBackoffMs(failures - 1, retryAfterMs, random));
			if (latest.get(key) !== token) return;
			error = await attempt(send);
			if (error === null) break;
			failures += 1;
		}
		if (latest.get(key) === token) latest.delete(key);
	}

	return async function finalReport(key, send) {
		const token = Symbol(key);
		latest.set(key, token);
		const error = await attempt(send);
		if (error === null) {
			latest.delete(key);
			return;
		}
		if (!RETRYABLE.has(classifyReportFailure(error))) {
			latest.delete(key);
			log(
				`[supervisor] final report ${key} refused (${classifyReportFailure(error)}); not retried`,
			);
			return;
		}
		void retryLoop(key, send, token, error);
	};
}
