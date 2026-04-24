import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { useNotificationPermission, useWebSocket } from "./hooks/useWebSocket.js";
import { api } from "./lib/api.js";
import { applyTheme, getStoredTheme } from "./lib/theme.js";
import { useLabsStore } from "./stores/labs-store.js";
import { useUserStore } from "./stores/user-store.js";

const DashboardPage = lazy(() =>
	import("./pages/DashboardPage.js").then((module) => ({ default: module.DashboardPage })),
);
const SessionDetailPage = lazy(() =>
	import("./pages/SessionDetailPage.js").then((module) => ({ default: module.SessionDetailPage })),
);
const SetupPage = lazy(() =>
	import("./pages/SetupPage.js").then((module) => ({ default: module.SetupPage })),
);
const SettingsPage = lazy(() =>
	import("./pages/SettingsPage.js").then((module) => ({ default: module.SettingsPage })),
);
const TemplatesPage = lazy(() =>
	import("./pages/TemplatesPage.js").then((module) => ({ default: module.TemplatesPage })),
);
const HostsPage = lazy(() =>
	import("./pages/HostsPage.js").then((module) => ({ default: module.HostsPage })),
);
const LaunchDetailPage = lazy(() =>
	import("./pages/LaunchDetailPage.js").then((module) => ({ default: module.LaunchDetailPage })),
);
const InboxPage = lazy(() =>
	import("./pages/InboxPage.js").then((module) => ({ default: module.InboxPage })),
);
const DigestPage = lazy(() =>
	import("./pages/DigestPage.js").then((module) => ({ default: module.DigestPage })),
);
const AskPage = lazy(() =>
	import("./pages/AskPage.js").then((module) => ({ default: module.AskPage })),
);
const SearchPage = lazy(() =>
	import("./pages/SearchPage.js").then((module) => ({ default: module.SearchPage })),
);
const LoginPage = lazy(() =>
	import("./pages/LoginPage.js").then((module) => ({ default: module.LoginPage })),
);

/**
 * Redirects unauthenticated users to /login. Only guards routes inside
 * the Layout shell — /login itself and the login bootstrap flow stay
 * public. While auth state is still loading we show the route fallback
 * rather than a flash of login.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
	const loaded = useUserStore((s) => s.loaded);
	const authenticated = useUserStore((s) => s.authenticated);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const location = useLocation();

	if (!loaded) return <RouteFallback />;
	if (disableAuth || authenticated) return <>{children}</>;
	return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
}

function RouteFallback() {
	return (
		<div className="p-6">
			<div className="mx-auto max-w-5xl space-y-3">
				<div className="h-7 w-40 animate-pulse rounded bg-muted" />
				<div className="h-4 w-72 animate-pulse rounded bg-muted/80" />
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					<div className="h-40 animate-pulse rounded-lg border border-border bg-card" />
					<div className="h-40 animate-pulse rounded-lg border border-border bg-card" />
					<div className="h-40 animate-pulse rounded-lg border border-border bg-card" />
				</div>
			</div>
		</div>
	);
}

export function App() {
	useNotificationPermission();
	useWebSocket();
	const loadLabs = useLabsStore((s) => s.load);
	const loadUser = useUserStore((s) => s.load);

	useEffect(() => {
		void loadLabs();
		void loadUser();
	}, [loadLabs, loadUser]);

	useEffect(() => {
		let cancelled = false;

		async function syncTheme() {
			try {
				const settings = await api.getSettings();
				const savedTheme = settings.theme;
				if (!cancelled && (savedTheme === "dark" || savedTheme === "light")) {
					applyTheme(savedTheme);
					window.localStorage.setItem("agentpulse-theme", savedTheme);
					return;
				}
			} catch {
				// Ignore settings load failure and keep local theme.
			}

			if (!cancelled) {
				const stored = getStoredTheme();
				if (stored) applyTheme(stored);
			}
		}

		void syncTheme();
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<Suspense fallback={<RouteFallback />}>
			<Routes>
				<Route path="/login" element={<LoginPage />} />
				<Route
					element={
						<AuthGate>
							<Layout />
						</AuthGate>
					}
				>
					<Route path="/" element={<DashboardPage />} />
					<Route path="/sessions" element={<DashboardPage />} />
					<Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
					<Route path="/templates" element={<TemplatesPage />} />
					<Route path="/launches/:launchId" element={<LaunchDetailPage />} />
					<Route path="/inbox" element={<InboxPage />} />
					<Route path="/digest" element={<DigestPage />} />
					<Route path="/ask" element={<AskPage />} />
					<Route path="/search" element={<SearchPage />} />
					<Route path="/hosts" element={<HostsPage />} />
					<Route path="/setup" element={<SetupPage />} />
					<Route path="/settings" element={<SettingsPage />} />
				</Route>
			</Routes>
		</Suspense>
	);
}
