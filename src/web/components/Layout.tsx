import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import brandIcon from "../assets/agentpulse-icon.svg";
import { type InboxWorkItem, type LabsFlag, api } from "../lib/api.js";
import { cn } from "../lib/utils.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useUserStore } from "../stores/user-store.js";
import { LabsBadge } from "./LabsBadge.js";
import { SessionTabs } from "./SessionTabs.js";
import { TopBar } from "./TopBar.js";

const ADMIN_DRAWER_LINKS = [
	{ to: "/setup", label: "Setup" },
	{ to: "/hosts", label: "Hosts" },
	{ to: "/settings", label: "Settings" },
];

const SIDEBAR_STORAGE_KEY = "agentpulse.sidebarCollapsed";
const INBOX_VIEWED_AT_STORAGE_KEY = "agentpulse.inboxLastViewedAt";
const INBOX_VIEWED_TOTAL_STORAGE_KEY = "agentpulse.inboxLastViewedTotal";

function loadSidebarCollapsed(): boolean {
	if (typeof localStorage === "undefined") return false;
	return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
}

type NavItem = {
	to: string;
	label: string;
	icon: string;
	labsFlag?: LabsFlag;
};

const navItems: NavItem[] = [
	{
		to: "/",
		label: "Dashboard",
		icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
	},
	{ to: "/sessions", label: "Sessions", icon: "M4 6h16M4 10h16M4 14h16M4 18h16" },
	{
		to: "/search",
		label: "Search",
		icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
	},
	{
		to: "/inbox",
		label: "Inbox",
		icon: "M3 8l9 6 9-6m-18 0v10a2 2 0 002 2h14a2 2 0 002-2V8m-18 0V6a2 2 0 012-2h14a2 2 0 012 2v2",
		labsFlag: "inbox",
	},
	{
		to: "/digest",
		label: "Digest",
		icon: "M9 17v-6h13v6M9 17a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2h2a2 2 0 012 2v6zm3-4l2 2 4-4",
		labsFlag: "digest",
	},
	{
		to: "/ask",
		label: "Ask",
		icon: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z",
		labsFlag: "askAssistant",
	},
	{
		to: "/projects",
		label: "Projects",
		icon: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z",
	},
	{
		to: "/templates",
		label: "Templates",
		icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586A2 2 0 0114 3.586l3.414 3.414A2 2 0 0118 8.414V19a2 2 0 01-2 2z",
	},
	// Setup / Hosts / Settings used to live here. They moved into the
	// top-bar Admin / User dropdowns so the side nav stays focused on
	// content/workflow destinations.
];

export function Layout() {
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
	const labsFlags = useLabsStore((s) => s.flags);
	const user = useUserStore((s) => s.user);
	const signOutUrl = useUserStore((s) => s.signOutUrl);
	const reloadUser = useUserStore((s) => s.load);
	const navigate = useNavigate();
	const location = useLocation();
	const inboxIndicator = useInboxIndicator(
		labsFlags === null || labsFlags.inbox !== false,
		location.pathname === "/inbox",
	);

	async function handleSignOut() {
		setMobileMenuOpen(false);
		if (signOutUrl?.startsWith("/api/")) {
			// Local session: POST to our logout endpoint and bounce to /login.
			await fetch(signOutUrl, { method: "POST", credentials: "same-origin" }).catch(() => {});
			await reloadUser();
			navigate("/login", { replace: true });
		} else if (signOutUrl) {
			// Authentik (or external): hard-navigate so the outpost handles it.
			window.location.assign(signOutUrl);
		}
	}
	// Hide nav items whose labs flag is explicitly disabled. When flags
	// haven't loaded yet, show everything (flags === null).
	const visibleNavItems = navItems.filter(
		(item) => !item.labsFlag || labsFlags === null || labsFlags[item.labsFlag] !== false,
	);

	useEffect(() => {
		try {
			localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
		} catch {
			// storage unavailable — ignore
		}
	}, [sidebarCollapsed]);

	return (
		<div className="flex h-dvh bg-background">
			{/* Mobile top bar (z-40: stays above the menu overlay and any
			    sticky page chrome at z-10/z-20 so the hamburger-close
			    button is always reachable). */}
			<div className="md:hidden fixed top-0 left-0 right-0 z-40 surface-glass border-b border-border px-3 py-2.5 flex items-center justify-between">
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

			{/* Mobile menu overlay — rendered via portal to <body> so it
			    escapes the Layout stacking context. iOS Safari has a
			    known bug where `sticky` children of an inner scroll
			    container can paint above `fixed` elements from an outer
			    ancestor regardless of z-index; the portal avoids that
			    class of issues entirely. */}
			{mobileMenuOpen &&
				createPortal(
					<div
						className="md:hidden fixed inset-0 z-30 bg-black/60 backdrop-blur-sm animate-fade"
						onClick={() => setMobileMenuOpen(false)}
					>
						<nav
							className="absolute top-14 left-0 right-0 surface-glass border-b border-border p-2 space-y-0.5 animate-in max-h-[calc(100vh-3.5rem)] overflow-y-auto"
							onClick={(e) => e.stopPropagation()}
						>
							{user && (
								<div className="flex items-center gap-2 px-3 py-2 mb-1 border-b border-border/70">
									<span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary/15 text-primary text-xs font-bold">
										{user.name.charAt(0).toUpperCase()}
									</span>
									<div className="min-w-0 flex-1">
										<div className="text-sm text-foreground truncate">{user.name}</div>
										<div className="text-[10px] uppercase tracking-wider text-muted-foreground">
											{user.source === "authentik"
												? "Authentik"
												: user.source === "local"
													? "Local account"
													: "API key"}
										</div>
									</div>
								</div>
							)}

							{visibleNavItems.map((item) => (
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
									<span className="flex-1">{item.label}</span>
									{item.to === "/inbox" && inboxIndicator && (
										<InboxNavPills total={inboxIndicator.total} hasNew={inboxIndicator.hasNew} />
									)}
									{item.labsFlag && <LabsBadge />}
								</NavLink>
							))}

							<div className="mt-2 pt-2 border-t border-border/70 space-y-0.5">
								<div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
									Admin
								</div>
								{ADMIN_DRAWER_LINKS.map((item) => (
									<NavLink
										key={item.to}
										to={item.to}
										onClick={() => setMobileMenuOpen(false)}
										className={({ isActive }) =>
											cn(
												"block rounded-lg px-3 py-2 text-sm transition-all",
												isActive
													? "bg-primary/10 text-primary"
													: "text-muted-foreground hover:text-foreground hover:bg-accent/50",
											)
										}
									>
										{item.label}
									</NavLink>
								))}
								{signOutUrl && (
									<button
										type="button"
										onClick={handleSignOut}
										className="block w-full text-left rounded-lg px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
									>
										Sign out
									</button>
								)}
							</div>
						</nav>
					</div>,
					document.body,
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
					{visibleNavItems.map((item) => (
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
							{!sidebarCollapsed && (
								<>
									<span className="flex-1">{item.label}</span>
									{item.to === "/inbox" && inboxIndicator && (
										<InboxNavPills total={inboxIndicator.total} hasNew={inboxIndicator.hasNew} />
									)}
									{item.labsFlag && <LabsBadge />}
								</>
							)}
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

			{/* Main column: top bar (Admin + User) + tabs strip + scrollable content */}
			<div className="flex flex-col flex-1 min-w-0 mt-14 md:mt-0">
				<TopBar />
				<SessionTabs />
				<main className="flex-1 overflow-x-hidden overflow-y-auto bg-dots">
					<Outlet />
				</main>
			</div>
		</div>
	);
}

function InboxNavPills({ total, hasNew }: { total: number; hasNew: boolean }) {
	if (total <= 0 && !hasNew) return null;

	return (
		<span className="flex items-center gap-1">
			{total > 0 && (
				<span className="inline-flex min-w-5 items-center justify-center rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono leading-none text-foreground">
					{total > 99 ? "99+" : total}
				</span>
			)}
			{hasNew && (
				<span className="inline-flex items-center justify-center rounded-full border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-primary">
					New
				</span>
			)}
		</span>
	);
}

function loadInboxViewedAt(): number {
	if (typeof localStorage === "undefined") return 0;
	const raw = localStorage.getItem(INBOX_VIEWED_AT_STORAGE_KEY);
	if (!raw) return 0;
	const value = Number(raw);
	return Number.isFinite(value) ? value : 0;
}

function loadInboxViewedTotal(): number {
	if (typeof localStorage === "undefined") return 0;
	const raw = localStorage.getItem(INBOX_VIEWED_TOTAL_STORAGE_KEY);
	if (!raw) return 0;
	const value = Number(raw);
	return Number.isFinite(value) ? value : 0;
}

function timestampForInboxItem(item: InboxWorkItem): number {
	switch (item.kind) {
		case "hitl":
			return Date.parse(item.openedAt);
		case "stuck":
			return Date.parse(item.since);
		case "failed_proposal":
			return Date.parse(item.at);
		case "risky":
			return 0;
		default:
			return 0;
	}
}

function useInboxIndicator(enabled: boolean, viewingInbox: boolean) {
	const [total, setTotal] = useState(0);
	const [latestItemAt, setLatestItemAt] = useState(0);
	const [lastViewedAt, setLastViewedAt] = useState(loadInboxViewedAt);
	const [lastViewedTotal, setLastViewedTotal] = useState(loadInboxViewedTotal);

	useEffect(() => {
		if (!enabled) {
			setTotal(0);
			setLatestItemAt(0);
			return;
		}

		let cancelled = false;

		async function load() {
			try {
				const inbox = await api.getAiInbox({ limit: 1 });
				if (cancelled) return;
				setTotal(inbox.total);
				setLatestItemAt(inbox.items[0] ? timestampForInboxItem(inbox.items[0]) : 0);
			} catch {
				if (cancelled) return;
			}
		}

		void load();
		const interval = setInterval(load, 15_000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [enabled]);

	useEffect(() => {
		if (!enabled || !viewingInbox) return;
		const nextViewedAt = Math.max(Date.now(), latestItemAt);
		try {
			localStorage.setItem(INBOX_VIEWED_AT_STORAGE_KEY, String(nextViewedAt));
			localStorage.setItem(INBOX_VIEWED_TOTAL_STORAGE_KEY, String(total));
		} catch {
			// ignore storage failures
		}
		setLastViewedAt(nextViewedAt);
		setLastViewedTotal(total);
	}, [enabled, viewingInbox, latestItemAt, total]);

	return useMemo(
		() => ({
			total,
			hasNew: total > 0 && (latestItemAt > lastViewedAt || total > lastViewedTotal),
		}),
		[total, latestItemAt, lastViewedAt, lastViewedTotal],
	);
}
