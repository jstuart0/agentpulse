import { AlertTriangle, Check, Clock, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import {
	type HostOutboxNotice as Notice,
	deriveHostOutboxNotice,
	outboxAnnouncement,
} from "../pages/hosts-view-state.js";

type NoticeSupervisor = Pick<
	SupervisorRecord,
	"id" | "outbox" | "status" | "heartbeatLeaseExpiresAt" | "enrollmentState" | "capabilities"
>;

const ICONS = { "catching-up": RefreshCw, recovered: Check, offline: Clock } as const;

/**
 * What a host card says about its offline outbox: catching up after an outage, back online (and what that
 * moved), or keeping events while it is offline. Words and an icon, never colour alone; amber only when
 * events were lost. A visually hidden status element is always mounted, so a change of branch is read out
 * by screen readers (a count changing is not), and the previous branch is remembered per host.
 */
export function HostOutboxNotice({
	supervisor,
	now,
}: { supervisor: NoticeSupervisor; now?: number }) {
	const notice = deriveHostOutboxNotice(supervisor, now);
	const [announcement, setAnnouncement] = useState("");
	const previous = useRef<{ id: string; notice: Notice | null } | null>(null);

	useEffect(() => {
		const before = previous.current?.id === supervisor.id ? previous.current.notice : undefined;
		previous.current = { id: supervisor.id, notice };
		if (before === undefined) return; // the first look at a host announces nothing
		const said = outboxAnnouncement(before, notice);
		if (said) setAnnouncement(said);
	}, [supervisor.id, notice]);

	const Icon = notice ? (notice.lost > 0 ? AlertTriangle : ICONS[notice.kind]) : null;
	return (
		<>
			{notice && Icon ? (
				<div
					className={
						notice.lost > 0
							? "mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
							: "mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
					}
				>
					<Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
					<span>{notice.text}</span>
				</div>
			) : null}
			<output className="sr-only">{announcement}</output>
		</>
	);
}
