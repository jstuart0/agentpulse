import { ArrowUpCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import { deriveHostUpdateNotice } from "../pages/hosts-view-state.js";

/**
 * The line a host card shows when its supervisor is older than the server. A quiet notice, not an alarm:
 * words and an icon, no red. The host's name is a plain text node, never part of the command. The sr-only
 * output says something only when the notice changes while the page is open.
 */
export function HostUpdateNotice({
	supervisor,
	server,
	canManage,
}: {
	supervisor: Pick<SupervisorRecord, "version" | "hostName" | "enrollmentState" | "capabilities">;
	server: { current: string; state: string } | null;
	canManage: boolean;
}) {
	const notice = deriveHostUpdateNotice(supervisor, server, { canManage });
	const kind = notice?.kind ?? null;
	const previous = useRef<string | null | "initial">("initial");
	const [announcement, setAnnouncement] = useState("");
	const spoken = notice?.parts.map((part) => part.text).join("") ?? "";
	useEffect(() => {
		if (previous.current !== "initial" && previous.current !== kind && spoken) {
			setAnnouncement(spoken);
		}
		previous.current = kind;
	}, [kind, spoken]);
	if (!notice) return null;
	return (
		<div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
			<ArrowUpCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
			<span className="min-w-0">
				{notice.parts.map((part, index) =>
					part.kind === "code" ? (
						<code key={`${index}-${part.text}`} className="font-mono text-foreground">
							{part.text}
						</code>
					) : part.kind === "host" ? (
						<span key={`${index}-${part.text}`} className="font-medium text-foreground">
							{part.text}
						</span>
					) : (
						part.text
					),
				)}
			</span>
			<output className="sr-only">{announcement}</output>
		</div>
	);
}
