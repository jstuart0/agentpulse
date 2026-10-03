import { AlertTriangle } from "lucide-react";
import type { SupervisorRecord } from "../../shared/types.js";
import { deriveHostExcludeNotice } from "../pages/hosts-view-state.js";
import { InlineCode } from "./InlineCode.js";

/**
 * The line a host card shows when its supervisor reported an invalid exclude
 * file, as an output element (a polite status). Words and an icon, never colour alone; the amber pair is the one the
 * rest of the app uses for a warning on a card (readable on the light and the
 * dark card).
 */
export function HostExcludeNotice({
	supervisor,
	now,
}: {
	supervisor: Pick<SupervisorRecord, "excludeRulesState" | "status" | "heartbeatLeaseExpiresAt">;
	now?: number;
}) {
	const notice = deriveHostExcludeNotice(supervisor, now);
	if (!notice) return null;
	return (
		<output className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
			<AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
			<span>
				<InlineCode text={notice.text} />
			</span>
		</output>
	);
}
