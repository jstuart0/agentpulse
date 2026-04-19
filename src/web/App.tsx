import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { SessionDetailPage } from "./pages/SessionDetailPage.js";
import { SetupPage } from "./pages/SetupPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { TemplatesPage } from "./pages/TemplatesPage.js";
import { useNotificationPermission, useWebSocket } from "./hooks/useWebSocket.js";

export function App() {
	useNotificationPermission();
	useWebSocket();
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route path="/" element={<DashboardPage />} />
				<Route path="/sessions" element={<DashboardPage />} />
				<Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
				<Route path="/templates" element={<TemplatesPage />} />
				<Route path="/setup" element={<SetupPage />} />
				<Route path="/settings" element={<SettingsPage />} />
			</Route>
		</Routes>
	);
}
