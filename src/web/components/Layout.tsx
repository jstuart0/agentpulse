import { NavLink, Outlet } from "react-router-dom";
import { cn } from "../lib/utils.js";

const navItems = [
	{ to: "/", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
	{ to: "/sessions", label: "Sessions", icon: "M4 6h16M4 10h16M4 14h16M4 18h16" },
	{ to: "/setup", label: "Setup", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
];

export function Layout() {
	return (
		<div className="flex h-screen bg-background">
			{/* Sidebar */}
			<aside className="w-56 flex-shrink-0 border-r border-border bg-card flex flex-col">
				{/* Logo */}
				<div className="px-4 py-5 border-b border-border">
					<div className="flex items-center gap-2">
						<div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
							<svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
							</svg>
						</div>
						<div>
							<span className="text-sm font-bold text-foreground">AgentPulse</span>
							<span className="block text-[10px] text-muted-foreground leading-none">v0.1.0</span>
						</div>
					</div>
				</div>

				{/* Nav */}
				<nav className="flex-1 px-2 py-3 space-y-0.5">
					{navItems.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							end={item.to === "/"}
							className={({ isActive }) =>
								cn(
									"flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
									isActive
										? "bg-primary/10 text-primary"
										: "text-muted-foreground hover:text-foreground hover:bg-accent",
								)
							}
						>
							<svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} />
							</svg>
							{item.label}
						</NavLink>
					))}
				</nav>

				{/* Footer */}
				<div className="px-4 py-3 border-t border-border">
					<p className="text-[10px] text-muted-foreground">
						Open Source - MIT License
					</p>
				</div>
			</aside>

			{/* Main content */}
			<main className="flex-1 overflow-auto">
				<Outlet />
			</main>
		</div>
	);
}
