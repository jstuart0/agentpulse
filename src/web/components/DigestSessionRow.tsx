import { Link } from "react-router-dom";
import type { RepoDigest } from "../lib/api.js";
import { formatTimeAgo } from "../lib/utils.js";
import { SummaryLink } from "./SummaryLink.js";

type DigestSession = RepoDigest["sessions"][number];

function Chip({ label }: { label: string }) {
	return (
		<span className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] border-border text-muted-foreground bg-background/40">
			{label}
		</span>
	);
}

/** One session in a Digest repository: its name, status, health, a Summary link while available, and when it was last active. */
export function DigestSessionRow({ session: s }: { session: DigestSession }) {
	return (
		<li className="flex items-center gap-2 text-xs">
			<Link to={`/sessions/${s.sessionId}`} className="text-primary hover:underline font-mono">
				{s.displayName ?? s.sessionId.slice(0, 8)}
			</Link>
			<Chip label={s.status} />
			{s.health && <Chip label={s.health} />}
			<SummaryLink sessionId={s.sessionId} variant="text" />
			<span className="text-muted-foreground ml-auto">{formatTimeAgo(s.lastActivityAt)}</span>
		</li>
	);
}
