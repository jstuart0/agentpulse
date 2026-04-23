import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useUserStore } from "../stores/user-store.js";

/**
 * Persistent top bar. Desktop: right-aligned Admin + User dropdowns
 * (side nav carries workflow-focused links only). Mobile users still
 * see the hamburger top bar from Layout; this bar renders *below* it
 * and shows the same Admin + User chips compactly so phone users can
 * still reach Setup / Settings / Sign out without opening the drawer.
 */
export function TopBar() {
	const user = useUserStore((s) => s.user);
	const signOutUrl = useUserStore((s) => s.signOutUrl);
	const disableAuth = useUserStore((s) => s.disableAuth);

	return (
		<div className="hidden md:flex items-center justify-end gap-2 px-6 py-2 border-b border-border bg-background/90 backdrop-blur-sm flex-shrink-0">
			<AdminMenu />
			<UserMenu user={user} signOutUrl={signOutUrl} disableAuth={disableAuth} />
		</div>
	);
}

function AdminMenu() {
	const [open, setOpen] = useState(false);
	const ref = useDropdownClose(() => setOpen(false));
	return (
		<div className="relative" ref={ref}>
			<button
				type="button"
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen((v) => !v)}
				className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
			>
				<svg
					className="w-3.5 h-3.5"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
					/>
				</svg>
				Admin
				<svg
					className="w-3 h-3 opacity-70"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</button>
			{open && (
				<MenuPanel onClose={() => setOpen(false)}>
					<MenuLink to="/setup" label="Setup" onClick={() => setOpen(false)} />
					<MenuLink to="/hosts" label="Hosts" onClick={() => setOpen(false)} />
				</MenuPanel>
			)}
		</div>
	);
}

function UserMenu({
	user,
	signOutUrl,
	disableAuth,
}: {
	user: { name: string; source: "authentik" | "api_key" } | null;
	signOutUrl: string | null;
	disableAuth: boolean;
}) {
	const [open, setOpen] = useState(false);
	const ref = useDropdownClose(() => setOpen(false));
	const label = user?.name ?? (disableAuth ? "anonymous" : "signed out");
	const initial = label.charAt(0).toUpperCase();

	return (
		<div className="relative" ref={ref}>
			<button
				type="button"
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen((v) => !v)}
				className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
				title={user ? `${user.name} (${user.source})` : undefined}
			>
				<span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-bold">
					{initial}
				</span>
				<span className="max-w-[10rem] truncate">{label}</span>
				<svg
					className="w-3 h-3 opacity-70"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</button>
			{open && (
				<MenuPanel onClose={() => setOpen(false)} align="right">
					{user && (
						<div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							Signed in · {user.source === "authentik" ? "Authentik" : "API key"}
						</div>
					)}
					<MenuLink to="/settings" label="Settings" onClick={() => setOpen(false)} />
					{signOutUrl && (
						<a
							href={signOutUrl}
							className="block px-3 py-2 text-xs text-red-300 hover:bg-red-500/10"
						>
							Sign out
						</a>
					)}
					{disableAuth && (
						<div className="px-3 py-2 text-[10px] text-muted-foreground">
							DISABLE_AUTH is on — no sign-out applies.
						</div>
					)}
				</MenuPanel>
			)}
		</div>
	);
}

function MenuPanel({
	children,
	onClose,
	align = "right",
}: {
	children: React.ReactNode;
	onClose: () => void;
	align?: "left" | "right";
}) {
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div
			role="menu"
			className={`absolute top-full mt-1 z-30 min-w-[12rem] rounded-md border border-border bg-card shadow-lg py-1 ${
				align === "right" ? "right-0" : "left-0"
			}`}
		>
			{children}
		</div>
	);
}

function MenuLink({
	to,
	label,
	onClick,
}: {
	to: string;
	label: string;
	onClick: () => void;
}) {
	return (
		<NavLink
			to={to}
			onClick={onClick}
			className={({ isActive }) =>
				`block px-3 py-2 text-xs hover:bg-muted ${
					isActive ? "text-primary font-medium" : "text-foreground"
				}`
			}
		>
			{label}
		</NavLink>
	);
}

function useDropdownClose(onClose: () => void) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (!ref.current?.contains(e.target as Node)) onClose();
		}
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [onClose]);
	return ref;
}
