import { useEffect } from "react";
import { api } from "../lib/api.js";
import { retryDelayMs } from "../lib/network-retry.js";
import { runRetryProbe } from "../lib/retry-probe.js";
import { useReachabilityStore } from "../stores/reachability-store.js";
import { useUserStore } from "../stores/user-store.js";

/**
 * What the notice says, or null for nothing. "Can't reach the server" waits for a probe to fail (about a
 * second into a real outage): a request that failed on its own, while the server answers its probe, would
 * only flash it. The retry timer runs from the first failure either way. The sign-in notice is shown at once.
 */
export function noticeMessage(state: {
	unreachable: boolean;
	attempt: number;
	unconfirmed: boolean;
}): string | null {
	if (state.unconfirmed) return "Can't confirm you're still signed in. Retrying…";
	if (state.unreachable && state.attempt >= 1) return "Can't reach the server. Retrying…";
	return null;
}

/**
 * Shown while the server can't be reached. It owns the retry: one cheap probe
 * after a wait that doubles up to 30 s, so a down server costs a request every
 * half minute at most, not a reload loop. When the probe is answered the
 * viewer's standing is asked again if the first ask never got through, or if
 * polls keep being refused while it can't be confirmed.
 */
export function ServerUnreachableNotice() {
	const unreachable = useReachabilityStore((s) => s.unreachable);
	const attempt = useReachabilityStore((s) => s.attempt);
	const authLoaded = useUserStore((s) => s.loaded);
	const loadUser = useUserStore((s) => s.load);
	const unconfirmed = useUserStore((s) => s.sessionUnconfirmed);
	const reportProbeFailure = useReachabilityStore((s) => s.reportProbeFailure);

	useEffect(() => {
		if (!unreachable && !unconfirmed) return;
		const timer = setTimeout(
			() => {
				void runRetryProbe({
					identityPending: !authLoaded || unconfirmed,
					loadIdentity: loadUser,
					identityConfirmed: () => {
						const { loaded, sessionUnconfirmed } = useUserStore.getState();
						return loaded && !sessionUnconfirmed;
					},
					health: () => api.getHealth(),
					onFail: reportProbeFailure,
				});
			},
			retryDelayMs(attempt + 1),
		);
		return () => clearTimeout(timer);
	}, [unreachable, unconfirmed, attempt, authLoaded, loadUser, reportProbeFailure]);

	const message = noticeMessage({ unreachable, attempt, unconfirmed });
	if (message === null) return null;
	return (
		<output className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-2">
			<span className="rounded-md border border-amber-500/40 bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg">
				{message}
			</span>
		</output>
	);
}
