const BASE_URL = "/api/v1";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: {
			"Content-Type": "application/json",
			...options?.headers,
		},
		...options,
	});

	if (!res.ok) {
		throw new Error(`API error: ${res.status} ${res.statusText}`);
	}

	return res.json();
}

export const api = {
	getSessions: (params?: { status?: string; agent_type?: string; limit?: number }) => {
		const query = new URLSearchParams();
		if (params?.status) query.set("status", params.status);
		if (params?.agent_type) query.set("agent_type", params.agent_type);
		if (params?.limit) query.set("limit", String(params.limit));
		const qs = query.toString();
		return request<{ sessions: unknown[]; total: number }>(`/sessions${qs ? `?${qs}` : ""}`);
	},

	getSession: (sessionId: string) =>
		request<{ session: unknown; events: unknown[] }>(`/sessions/${sessionId}`),

	getTimeline: (sessionId: string, limit = 50, offset = 0) =>
		request<{ events: unknown[] }>(
			`/sessions/${sessionId}/timeline?limit=${limit}&offset=${offset}`,
		),

	getStats: () => request<unknown>("/sessions/stats"),

	getHealth: () => request<{ status: string }>("/health"),
};
