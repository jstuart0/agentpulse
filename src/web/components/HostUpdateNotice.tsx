import { ArrowUpCircle } from "lucide-react";
import type { SupervisorRecord } from "../../shared/types.js";
import { useAnnouncement } from "../hooks/useAnnouncement.js";
import { UPDATE_HOST_COPY } from "../lib/update-outcome-copy.js";
import { deriveHostUpdateNotice } from "../pages/hosts-view-state.js";
import { CopyCommandButton } from "./CopyCommandButton.js";

/**
 * The line a host card shows when its supervisor is older than the server. A quiet notice, not an alarm:
 * words and an icon, no red, leading with the two versions. The host's name is a plain text node, never part
 * of the command. The sr-only output is always on the page and says something only when the notice changes
 * while the page is open.
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
	const spoken = notice?.parts.map((part) => part.text).join("") ?? null;
	const announcement = useAnnouncement(notice?.kind ?? "none", spoken);
	return (
		<>
			<output className="sr-only">{announcement}</output>
			{notice && (
				<div className="mt-3 flex flex-wrap items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					<ArrowUpCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
					<span className="min-w-0 flex-1">
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
					{notice.parts
						.filter((part) => part.kind === "code")
						.map((part) => (
							<CopyCommandButton
								key={part.text}
								command={part.text}
								label={UPDATE_HOST_COPY.copy(supervisor.hostName)}
								copiedText={UPDATE_HOST_COPY.copied}
								failedText={UPDATE_HOST_COPY.copyFailed}
							/>
						))}
				</div>
			)}
		</>
	);
}
