import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import brandIcon from "../assets/agentpulse-icon.svg";
import { cn } from "../lib/utils.js";
import { SessionTabs } from "./SessionTabs.js";

const SIDEBAR_STORAGE_KEY = "agentpulse.sidebarCollapsed";

function loadSidebarCollapsed(): boolean {
	if (typeof localStorage === "undefined") return false;
	return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
}

const navItems = [
	{
		to: "/",
		label: "Dashboard",
		icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
	},
	{ to: "/sessions", label: "Sessions", icon: "M4 6h16M4 10h16M4 14h16M4 18h16" },
	{
		to: "/inbox",
		label: "Inbox",
		icon: "M3 8l9 6 9-6m-18 0v10a2 2 0 002 2h14a2 2 0 002-2V8m-18 0V6a2 2 0 012-2h14a2 2 0 012 2v2",
	},
	{
		to: "/digest",
		label: "Digest",
		icon: "M9 17v-6h13v6M9 17a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2h2a2 2 0 012 2v6zm3-4l2 2 4-4",
	},
	{
		to: "/templates",
		label: "Templates",
		icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586A2 2 0 0114 3.586l3.414 3.414A2 2 0 0118 8.414V19a2 2 0 01-2 2z",
	},
	{ to: "/hosts", label: "Hosts", icon: "M3 7h18M6 11h12M8 15h8M5 19h14" },
	{
		to: "/setup",
		label: "Setup",
		icon: "M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4",
	},
	{
		to: "/settings",
		label: "Settings",
		icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
	},
];

export function Layout() {
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);

	useEffect(() => {
		try {
			localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
		} catch {
			// storage unavailable — ignore
		}
	}, [sidebarCollapsed]);

	return (
		<div className="flex h-dvh bg-background">
			{/* Mobile top bar */}
			<div className="md:hidden fixed top-0 left-0 right-0 z-20 surface-glass border-b border-border px-3 py-2.5 flex items-center justify-between">
				<div className="flex items-center gap-2.5 min-w-0">
					<div className="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden glow-primary-sm">
						<img src={brandIcon} alt="" className="w-8 h-8" />
					</div>
					<div className="flex items-center gap-1.5">
						<span className="text-sm font-semibold tracking-tight text-foreground truncate">
							AgentPulse
						</span>
						<span className="text-[9px] font-mono text-primary/60 bg-primary/8 px-1 py-0.5 rounded">
							CMD
						</span>
					</div>
				</div>
				<button
					onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
					className="text-muted-foreground p-1.5 hover:text-foreground transition-colors"
				>
					<svg
						className="w-5 h-5"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={1.5}
					>
						{mobileMenuOpen ? (
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						) : (
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
							/>
						)}
					</svg>
				</button>
			</div>

			{/* Mobile menu overlay */}
			{mobileMenuOpen && (
				<div
					className="md:hidden fixed inset-0 z-10 bg-black/60 backdrop-blur-sm animate-fade"
					onClick={() => setMobileMenuOpen(false)}
				>
					<nav
						className="absolute top-14 left-0 right-0 surface-glass border-b border-border p-2 space-y-0.5 animate-in"
						onClick={(e) => e.stopPropagation()}
					>
						{navItems.map((item) => (
							<NavLink
								key={item.to}
								to={item.to}
								end={item.to === "/"}
								onClick={() => setMobileMenuOpen(false)}
								className={({ isActive }) =>
									cn(
										"flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all",
										isActive
											? "bg-primary/10 text-primary glow-primary-sm"
											: "text-muted-foreground hover:text-foreground hover:bg-accent/50",
									)
								}
							>
								<svg
									className="w-4 h-4 flex-shrink-0"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
									strokeWidth={1.5}
								>
									<path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
								</svg>
								{item.label}
							</NavLink>
						))}
					</nav>
				</div>
			)}

			{/* Desktop sidebar */}
			<aside
				className={cn(
					"hidden md:flex flex-shrink-0 border-r border-border bg-card/50 flex-col transition-[width] duration-200",
					sidebarCollapsed ? "w-[56px]" : "w-[220px]",
				)}
			>
				{/* Brand + collapse toggle */}
				<div
					className={cn(
						"border-b border-border flex items-center",
						sidebarCollapsed ? "px-2 py-4 justify-center" : "px-4 py-5 justify-between gap-2",
					)}
				>
					<div className={cn("flex items-center min-w-0", sidebarCollapsed ? "" : "gap-2.5")}>
						<div
							className={cn(
								"rounded-xl flex items-center justify-center overflow-hidden glow-primary-sm flex-shrink-0",
								sidebarCollapsed ? "w-8 h-8" : "w-9 h-9",
							)}
						>
							<img
								src={brandIcon}
								alt=""
								className={cn(sidebarCollapsed ? "w-8 h-8" : "w-9 h-9")}
							/>
						</div>
						{!sidebarCollapsed && (
							<div className="min-w-0">
								<span className="text-[13px] font-bold tracking-tight text-foreground">
									AgentPulse
								</span>
								<div className="flex items-center gap-1 mt-0.5">
									<span className="text-[9px] font-mono text-primary/70 bg-primary/8 px-1 py-0.5 rounded leading-none">
										CMD CENTER
									</span>
								</div>
							</div>
						)}
					</div>
					{!sidebarCollapsed && (
						<button
							type="button"
							onClick={() => setSidebarCollapsed(true)}
							title="Collapse sidebar"
							aria-label="Collapse sidebar"
							className="text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded p-1 flex-shrink-0 transition-colors"
						>
							<svg
								className="w-4 h-4"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth={1.5}
							>
								<path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
							</svg>
						</button>
					)}
				</div>

				{sidebarCollapsed && (
					<button
						type="button"
						onClick={() => setSidebarCollapsed(false)}
						title="Expand sidebar"
						aria-label="Expand sidebar"
						className="mx-2 mt-2 text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded p-1.5 flex items-center justify-center transition-colors"
					>
						<svg
							className="w-4 h-4"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth={1.5}
						>
							<path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
						</svg>
					</button>
				)}

				{/* Navigation */}
				<nav className={cn("flex-1 py-3 space-y-0.5", sidebarCollapsed ? "px-2" : "px-2")}>
					{navItems.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							end={item.to === "/"}
							title={sidebarCollapsed ? item.label : undefined}
							className={({ isActive }) =>
								cn(
									"group flex items-center rounded-lg text-[13px] font-medium transition-all duration-200",
									sidebarCollapsed ? "justify-center p-2" : "gap-3 px-3 py-2",
									isActive
										? "bg-primary/10 text-primary border border-primary/15"
										: "text-muted-foreground hover:text-foreground hover:bg-accent/50 border border-transparent",
								)
							}
						>
							<svg
								className="w-[15px] h-[15px] flex-shrink-0 transition-colors"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth={1.5}
							>
								<path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
							</svg>
							{!sidebarCollapsed && item.label}
						</NavLink>
					))}
				</nav>

				{/* Footer */}
				{!sidebarCollapsed && (
					<div className="px-4 py-3 border-t border-border">
						<p className="text-[10px] font-mono text-muted-foreground/60 tracking-wide uppercase">
							Open Source &middot; MIT
						</p>
					</div>
				)}
			</aside>

			{/* Main column: tabs strip + scrollable content */}
			<div className="flex flex-col flex-1 min-w-0 mt-14 md:mt-0">
				<SessionTabs />
				<main className="flex-1 overflow-x-hidden overflow-y-auto bg-dots">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
