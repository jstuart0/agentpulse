/**
 * The order in which answers to overlapping requests may be applied.
 *
 * A success applies unless an answer that started later was already applied, or a local write (or a
 * change of subject) was made after the request began. A failure is reported only if nothing later
 * has been applied, and it is never recorded: a newer failure can't block an older success.
 *
 * Applied order, not start order: a slow poll that outlasts its interval still gets its answer applied
 * as long as no newer answer has landed first.
 */
export interface RequestTicket {
	/** True when this answer may be applied. True records it, and the same ticket may claim again. */
	claim(): boolean;
	/** The same test as `claim`, recording nothing. For reporting a failure. */
	peek(): boolean;
}

export interface RequestOrder {
	begin(): RequestTicket;
	/** Every ticket begun before this call fails `claim` and `peek`; later tickets are unaffected. */
	markApplied(): void;
}

export function createRequestOrder(): RequestOrder {
	let started = 0;
	let appliedSeq = 0;
	let barrier = 0;

	return {
		begin() {
			const seq = ++started;
			const allowed = () => seq > barrier && seq >= appliedSeq;
			return {
				claim() {
					if (!allowed()) return false;
					appliedSeq = seq;
					return true;
				},
				peek: allowed,
			};
		},
		markApplied() {
			barrier = started;
		},
	};
}
