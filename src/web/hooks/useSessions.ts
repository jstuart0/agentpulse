import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { api } from "../lib/api.js";
import type { Session, DashboardStats } from "../../shared/types.js";

export function useSessions() {
	const { sessions, stats, setSessions, setStats, isLoading, setLoading } = useSessionStore();

	useEffect(() => {
		async function fetchSessions() {
			setLoading(true);
			try {
				const [sessionsRes, statsRes] = await Promise.all([
					api.getSessions({ limit: 100 }),
					api.getStats(),
				]);
				setSessions(sessionsRes.sessions as Session[]);
				setStats(statsRes as DashboardStats);
			} catch (err) {
				console.error("[sessions] Failed to fetch:", err);
			} finally {
				setLoading(false);
			}
		}

		fetchSessions();

		// Refresh every 30 seconds as a fallback
		const interval = setInterval(fetchSessions, 30_000);
		return () => clearInterval(interval);
	}, [setSessions, setStats, setLoading]);

	return { sessions, stats, isLoading };
}
