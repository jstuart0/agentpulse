import { useConnectionStore } from "../stores/connection-store.js";

/**
 * WS connection-state chip (U-H1).
 *
 * Three states:
 *   connected   — green dot + "Live"
 *   reconnecting — amber dot + "Reconnecting…" (pulsing when reduced-motion
 *                 is not requested — the animation is gated by a CSS @media
 *                 query so the JS layer never needs to read the media state)
 *   paused      — muted/red dot + "Live updates paused — using polling"
 *                 (NOT "Disconnected": polling still delivers updates)
 *
 * A tooltip surfaces the exact technical state for power users.
 */
export function WsStatusChip() {
	const wsState = useConnectionStore((s) => s.wsState);
	const lastConnectedAt = useConnectionStore((s) => s.lastConnectedAt);

	const tooltipText = buildTooltip(wsState, lastConnectedAt);

	if (wsState === "connected") {
		return (
			<span
				title={tooltipText}
				className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 select-none"
			>
				<span
					className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"
					aria-hidden="true"
				/>
				Live
			</span>
		);
	}

	if (wsState === "reconnecting") {
		return (
			<span
				title={tooltipText}
				className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400 select-none"
			>
				{/*
				 * ws-reconnect-pulse is defined in index.css and is only active
				 * under @media (prefers-reduced-motion: no-preference) so the
				 * animation is silently skipped for users with the OS setting on.
				 */}
				<span
					className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0 ws-reconnect-pulse"
					aria-hidden="true"
				/>
				Reconnecting…
			</span>
		);
	}

	// paused
	return (
		<span
			title={tooltipText}
			className="inline-flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/8 px-2 py-0.5 text-[11px] font-medium text-red-400/80 select-none"
		>
			<span className="w-1.5 h-1.5 rounded-full bg-red-400/70 flex-shrink-0" aria-hidden="true" />
			Live updates paused — using polling
		</span>
	);
}

function buildTooltip(
	state: "connected" | "reconnecting" | "paused",
	lastAt: number | null,
): string {
	const age = lastAt ? Math.round((Date.now() - lastAt) / 1000) : null;
	switch (state) {
		case "connected":
			return "WebSocket connected — receiving live updates";
		case "reconnecting":
			return age !== null
				? `WebSocket reconnecting; last successful connection ${age}s ago`
				: "WebSocket reconnecting";
		case "paused":
			return age !== null
				? `WebSocket unavailable (last connected ${age}s ago); dashboard refreshes every 30 s via polling`
				: "WebSocket unavailable; dashboard refreshes every 30 s via polling";
	}
}
