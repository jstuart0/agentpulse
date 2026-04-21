import { Suspense, lazy, useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { useNotificationPermission, useWebSocket } from "./hooks/useWebSocket.js";
import { api } from "./lib/api.js";
import { applyTheme, getStoredTheme } from "./lib/theme.js";
import { useLabsStore } from "./stores/labs-store.js";

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

	useEffect(() => {
		void loadLabs();
	}, [loadLabs]);

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
				<Route element={<Layout />}>
					<Route path="/" element={<DashboardPage />} />
					<Route path="/sessions" element={<DashboardPage />} />
					<Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
					<Route path="/templates" element={<TemplatesPage />} />
					<Route path="/launches/:launchId" element={<LaunchDetailPage />} />
					<Route path="/inbox" element={<InboxPage />} />
					<Route path="/digest" element={<DigestPage />} />
					<Route path="/hosts" element={<HostsPage />} />
					<Route path="/setup" element={<SetupPage />} />
					<Route path="/settings" element={<SettingsPage />} />
				</Route>
			</Routes>
		</Suspense>
	);
}
