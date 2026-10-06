import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { Layout } from "./components/Layout.js";
import { ServerUnreachableNotice } from "./components/ServerUnreachableNotice.js";
import { ForcedPasswordChange } from "./components/settings/ForcedPasswordChange.js";
import { useIdentityRecheck } from "./hooks/useIdentityRecheck.js";
import { useOwnershipUi } from "./hooks/useOwnershipUi.js";
import { useNotificationPermission, useWebSocket } from "./hooks/useWebSocket.js";
import { api } from "./lib/api.js";
import { deriveAppGate } from "./lib/app-gate.js";
import { useToastPosition } from "./lib/dialog-open.js";
import { applyTheme, getStoredTheme, themeToApply } from "./lib/theme.js";
import { useAiStatusStore } from "./stores/ai-status-store.js";
import { useDbFingerprintStore } from "./stores/db-fingerprint-store.js";
import { useLabsStore } from "./stores/labs-store.js";
import { useProjectsStore } from "./stores/projects-store.js";
import { useUserStore } from "./stores/user-store.js";
import { useUsersStore } from "./stores/users-store.js";

// How often the dashboard polls GET /api/v1/health purely to sample
// instance.dbFingerprint — see db-fingerprint-watch.ts / db-fingerprint-store.ts.
const DB_FINGERPRINT_POLL_MS = 60_000;

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
const ProjectsPage = lazy(() =>
	import("./pages/ProjectsPage.js").then((module) => ({ default: module.ProjectsPage })),
);

/**
 * Decides what the shell renders: nothing but the loading state until
 * /auth/me answers, the sign-in page for a signed-out visitor, only the
 * password form for someone who must choose a new password, and the app
 * otherwise. Only routes inside the Layout shell are guarded — /login itself
 * and the login bootstrap flow stay public.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
	const loaded = useUserStore((s) => s.loaded);
	const authenticated = useUserStore((s) => s.authenticated);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const mustChangePassword = useUserStore((s) => s.mustChangePassword);
	const location = useLocation();

	const gate = deriveAppGate({ loaded, authenticated, disableAuth, mustChangePassword });
	if (gate === "loading") return <RouteFallback />;
	if (gate === "change_password") return <ForcedPasswordChange />;
	if (gate === "login") {
		return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
	}
	return <>{children}</>;
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
	const loadLabs = useLabsStore((s) => s.load);
	const loadAiStatus = useAiStatusStore((s) => s.load);
	const loadUser = useUserStore((s) => s.load);
	const loadProjects = useProjectsStore((s) => s.load);
	const loaded = useUserStore((s) => s.loaded);
	const authenticated = useUserStore((s) => s.authenticated);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const mustChangePassword = useUserStore((s) => s.mustChangePassword);
	const { themeIsPerBrowser, callDirectory } = useOwnershipUi();
	const loadDirectory = useUsersStore((s) => s.load);
	// Toasts go to the top while a bottom-sheet dialog is open on a phone, so they don't sit on its buttons.
	const toastPosition = useToastPosition();

	// Nothing but /auth/me runs until the viewer may use the app: a signed-out
	// or must-change-password viewer would only collect refusals (and a
	// reconnecting socket) behind the screen they are allowed to see.
	const appReady =
		deriveAppGate({ loaded, authenticated, disableAuth, mustChangePassword }) === "app";
	useWebSocket(appReady);
	useIdentityRecheck(appReady);

	useEffect(() => {
		void loadUser();
	}, [loadUser]);

	useEffect(() => {
		if (!appReady) return;
		void loadLabs();
		void loadAiStatus();
		void loadProjects();
	}, [appReady, loadLabs, loadAiStatus, loadProjects]);

	// Owner names, and the people a key or host can be handed to. Team mode only.
	useEffect(() => {
		if (appReady && callDirectory) void loadDirectory();
	}, [appReady, callDirectory, loadDirectory]);

	useEffect(() => {
		if (!appReady) return;
		let cancelled = false;

		async function syncTheme() {
			let server: unknown;
			try {
				server = (await api.getSettings()).theme;
			} catch {
				// Ignore settings load failure and keep local theme.
			}
			if (cancelled) return;
			const choice = themeToApply({
				perBrowser: themeIsPerBrowser,
				stored: getStoredTheme(),
				server,
			});
			if (!choice) return;
			applyTheme(choice.theme);
			if (choice.persist) window.localStorage.setItem("agentpulse-theme", choice.theme);
		}

		void syncTheme();
		return () => {
			cancelled = true;
		};
	}, [appReady, themeIsPerBrowser]);

	useEffect(() => {
		const record = useDbFingerprintStore.getState().record;

		async function pollFingerprint() {
			try {
				const health = await api.getHealth();
				if (health.instance?.dbFingerprint) {
					record(health.instance.dbFingerprint);
				}
			} catch {
				// Transient /health failures don't affect split-database detection.
			}
		}

		void pollFingerprint();
		const interval = setInterval(pollFingerprint, DB_FINGERPRINT_POLL_MS);
		return () => clearInterval(interval);
	}, []);

	return (
		<>
			<Toaster position={toastPosition} />
			<ServerUnreachableNotice />
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
						<Route path="/projects" element={<ProjectsPage />} />
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
		</>
	);
}
