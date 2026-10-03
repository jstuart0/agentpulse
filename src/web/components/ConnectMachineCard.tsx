import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ApiKeyInfo } from "../../shared/types.js";
import { useOwnSessionCount } from "../hooks/useOwnSessionCount.js";
import { useOwnershipUi } from "../hooks/useOwnershipUi.js";
import { api } from "../lib/api.js";
import { addToIdSet, browserStorage, readIdSet } from "../lib/id-set-storage.js";
import { connectCardDismissKey, shouldShowConnectCard } from "../pages/dashboard-view-state.js";
import { useUserStore } from "../stores/user-store.js";

const DISMISSED_FLAG = "dismissed";

/**
 * In team mode, a person with no key of their own and no session of their own
 * gets a compact prompt above the status cards. It doesn't replace the
 * dashboard (it is full of other people's sessions); it points at Setup.
 * "Not now" is remembered for this person in this browser.
 */
export function ConnectMachineCard({ suppress = false }: { suppress?: boolean }) {
	const ui = useOwnershipUi();
	// Asked of the server, not counted from the newest page: on a busy team the
	// newest hundred sessions may not include any of theirs. Until it answers,
	// assume some.
	const ownSessions = useOwnSessionCount(ui.showTeamCopy);
	const userId = useUserStore((s) => s.userId);
	const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
	const storage = browserStorage();
	const [dismissed, setDismissed] = useState(() =>
		readIdSet(connectCardDismissKey(userId), storage).has(DISMISSED_FLAG),
	);

	useEffect(() => {
		if (!ui.showTeamCopy) return;
		let cancelled = false;
		api
			.getApiKeys()
			.then((res) => {
				if (!cancelled) setKeys(res.keys);
			})
			.catch(() => {
				// No key list, no card: better than guessing the person has none.
			});
		return () => {
			cancelled = true;
		};
	}, [ui.showTeamCopy]);

	const show = shouldShowConnectCard({
		showTeamCopy: ui.showTeamCopy,
		keysLoaded: keys !== null,
		ownActiveKeys: (keys ?? []).filter((key) => key.isActive && key.ownerUserId === userId).length,
		ownSessions: ownSessions ?? 1,
		dismissed,
	});
	if (!show || suppress) return null;

	return (
		<section
			aria-labelledby="connect-machine-heading"
			className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between md:mb-6"
		>
			<div>
				<h2 id="connect-machine-heading" className="text-sm font-semibold text-foreground">
					Connect your machine
				</h2>
				<p className="mt-0.5 text-xs text-hint">
					Sessions show up under your name once your agents report with your own key.
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Link
					to="/setup"
					className="inline-flex min-h-[44px] items-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 text-sm font-medium transition-colors md:min-h-0"
				>
					Set up my machine
				</Link>
				<button
					type="button"
					onClick={() => {
						addToIdSet(connectCardDismissKey(userId), [DISMISSED_FLAG], storage);
						setDismissed(true);
					}}
					className="min-h-[44px] rounded-md px-3 py-2 text-sm text-hint transition-colors hover:text-foreground md:min-h-0"
				>
					Not now
				</button>
			</div>
		</section>
	);
}
