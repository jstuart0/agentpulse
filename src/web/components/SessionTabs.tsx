import { useLocation, useNavigate } from "react-router-dom";
import { useTabsStore } from "../stores/tabs-store.js";
import { getSessionMode } from "../lib/utils.js";

export function SessionTabs() {
	const tabs = useTabsStore((s) => s.tabs);
	const close = useTabsStore((s) => s.close);
	const location = useLocation();
	const navigate = useNavigate();

	if (tabs.length === 0) return null;

	const currentSessionId = location.pathname.startsWith("/sessions/")
		? decodeURIComponent(location.pathname.slice("/sessions/".length).split("/")[0] ?? "")
		: null;

	function handleClose(sessionId: string) {
		const closingIndex = tabs.findIndex((t) => t.sessionId === sessionId);
		const wasActive = sessionId === currentSessionId;
		close(sessionId);
		if (wasActive) {
			const remaining = tabs.filter((t) => t.sessionId !== sessionId);
			if (remaining.length === 0) {
				navigate("/");
			} else {
				const nextTab = remaining[closingIndex] ?? remaining[closingIndex - 1] ?? remaining[0];
				navigate(`/sessions/${nextTab.sessionId}`);
			}
		}
	}

	return (
		<div className="sticky top-0 z-10 surface-glass border-b border-border">
			<div
				className="flex items-stretch overflow-x-auto px-1 md:px-2"
				style={{ scrollbarWidth: "thin" }}
			>
				{tabs.map((tab) => {
					const modeStyle = getSessionMode({
						managedSession: tab.managedState ? { managedState: tab.managedState } : null,
					});
					const active = tab.sessionId === currentSessionId;
					return (
						<div
							key={tab.sessionId}
							onClick={() => navigate(`/sessions/${tab.sessionId}`)}
							onMouseDown={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									handleClose(tab.sessionId);
								}
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									navigate(`/sessions/${tab.sessionId}`);
								}
							}}
							role="tab"
							aria-selected={active}
							tabIndex={0}
							title={tab.displayName}
							className={`group relative flex items-center gap-2 pl-3 pr-1.5 py-2 flex-shrink-0 cursor-pointer transition-colors border-r border-border/60 focus:outline-none focus:ring-1 focus:ring-primary/50 ${
								active
									? "bg-background text-foreground"
									: "bg-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground"
							}`}
						>
							<span className={`absolute left-0 top-0 bottom-0 w-[3px] ${modeStyle.barClass}`} aria-hidden="true" />
							<span
								aria-hidden="true"
								className={`absolute left-0 right-0 bottom-0 h-[2px] transition-opacity ${active ? "bg-primary opacity-100" : "bg-transparent opacity-0"}`}
							/>
							<span className={`text-xs font-mono max-w-[9rem] md:max-w-[11rem] truncate ${active ? "font-semibold" : ""}`}>
								{tab.displayName}
							</span>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									handleClose(tab.sessionId);
								}}
								aria-label={`Close ${tab.displayName}`}
								className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 opacity-60 group-hover:opacity-100 transition-opacity"
							>
								<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
									<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
