export interface Budget {
	chunk: string;
	/** Largest gzipped size, in bytes. */
	maxGzip: number;
}
export interface Finding {
	chunk: string;
	gzip: number | null;
	max: number;
	ok: boolean;
}

export const BUDGETS: Budget[] = [];

export function checkBudget(
	_sizes: Record<string, number>,
	_budgets: Budget[],
	_scale = 1,
): Finding[] {
	return [];
}
