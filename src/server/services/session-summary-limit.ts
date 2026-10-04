/**
 * Red-commit stub (AGEN-69 phase 6): the real per-caller limiter replaces this.
 */
export const SUMMARY_REQUEST_LIMIT_PER_MINUTE = 6;

export function tryConsumeSummaryRequest(_subject: string): boolean {
	return true;
}

export function summaryRetryAfterSeconds(_subject: string): number {
	return 1;
}

export function _resetSummaryLimitForTest(): void {}

export function _setSummaryLimitClockForTest(_clock: (() => number) | null): void {}
