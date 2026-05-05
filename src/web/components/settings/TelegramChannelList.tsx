import type { ChannelStats, NotificationChannelRecord } from "../../lib/api.js";
import { formatTimeAgo } from "../../lib/utils.js";

/**
 * List of enrolled Telegram channels with per-channel stats, test-send,
 * ask-toggle, and delete-with-usage-warning.
 */
export function ChannelList({
	channels,
	stats,
	onTest,
	onDelete,
	onAskToggle,
}: {
	channels: NotificationChannelRecord[];
	stats: Record<string, ChannelStats>;
	onTest: (id: string) => void;
	onDelete: (id: string) => void;
	onAskToggle: (id: string, askEnabled: boolean) => void;
}) {
	if (channels.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
				No channels yet. Create one above and link it via Telegram to receive HITL requests on your
				phone.
			</div>
		);
	}

	return (
		<ul className="space-y-2">
			{channels.map((ch) => {
				const s = stats[ch.id];
				return (
					<li
						key={ch.id}
						className="rounded-md border border-border bg-card px-3 py-2.5 text-xs space-y-2"
					>
						<div className="flex items-start justify-between gap-2">
							<div className="min-w-0">
								<div className="text-foreground font-medium">{ch.label}</div>
								<div className="text-[10px] text-muted-foreground mt-0.5">
									{ch.kind} ·{" "}
									<span className={ch.verifiedAt ? "text-emerald-300" : "text-amber-300"}>
										{ch.verifiedAt ? "verified" : "pending enrollment"}
									</span>
									{!ch.isActive && " · inactive"}
								</div>
							</div>
							<div className="flex flex-shrink-0 gap-1">
								{ch.verifiedAt && (
									<button
										type="button"
										onClick={() => onTest(ch.id)}
										className="text-[11px] px-2 py-1 rounded border border-border text-foreground hover:bg-muted"
									>
										Test
									</button>
								)}
								<button
									type="button"
									onClick={() => onDelete(ch.id)}
									className="text-[11px] px-2 py-1 rounded border border-border text-red-300 hover:bg-red-500/10"
								>
									Delete
								</button>
							</div>
						</div>
						{ch.verifiedAt && (
							<label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
								<input
									type="checkbox"
									checked={
										!(ch.config && (ch.config as Record<string, unknown>).askEnabled === false)
									}
									onChange={(e) => onAskToggle(ch.id, e.target.checked)}
									className="h-3.5 w-3.5"
								/>
								<span>
									Answer free-form DMs via the Ask assistant
									<span className="ml-1 text-muted-foreground/70">
										(requires Labs → Ask assistant)
									</span>
								</span>
							</label>
						)}
						{s && (
							<div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
								<span>
									Assigned sessions:{" "}
									<span className="text-foreground">{s.assignedSessionCount}</span>
								</span>
								<span>
									HITL delivered: <span className="text-foreground">{s.hitlTotal}</span>
								</span>
								<span>
									Open:{" "}
									<span className={s.hitlOpen > 0 ? "text-amber-300" : "text-foreground"}>
										{s.hitlOpen}
									</span>
								</span>
								<span>
									Resolved: <span className="text-foreground">{s.hitlResolved}</span>
								</span>
								{s.lastHitlAt && (
									<span>
										Last: <span className="text-foreground">{formatTimeAgo(s.lastHitlAt)}</span>
									</span>
								)}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
