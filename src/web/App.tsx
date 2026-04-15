import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { SessionDetailPage } from "./pages/SessionDetailPage.js";
import { SetupPage } from "./pages/SetupPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { AgentsMdPage } from "./pages/AgentsMdPage.js";

export function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route path="/" element={<DashboardPage />} />
				<Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
				<Route path="/setup" element={<SetupPage />} />
				<Route path="/editor" element={<AgentsMdPage />} />
				<Route path="/settings" element={<SettingsPage />} />
			</Route>
		</Routes>
	);
}
