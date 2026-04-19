import { APP_API_BASE } from "./paths.js";
import type { LaunchRequest, Session, SessionEvent, SupervisorRecord, ControlAction } from "../../shared/types.js";

const BASE_URL = APP_API_BASE;

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
		return request<{ sessions: Session[]; total: number }>(`/sessions${qs ? `?${qs}` : ""}`);
	},

	getSession: (sessionId: string) =>
		request<{ session: Session; events: SessionEvent[]; controlActions?: ControlAction[] }>(`/sessions/${sessionId}`),

	getTimeline: (sessionId: string, limit = 50, offset = 0) =>
		request<{ events: SessionEvent[] }>(
			`/sessions/${sessionId}/timeline?limit=${limit}&offset=${offset}`,
		),

	getStats: () => request<unknown>("/sessions/stats"),

	getSessionControlActions: (sessionId: string) =>
		request<{ controlActions: ControlAction[] }>(`/sessions/${sessionId}/control-actions`),

	renameSession: (sessionId: string, name: string) =>
		request<{ ok: true }>(`/sessions/${sessionId}/rename`, {
			method: "PUT",
			body: JSON.stringify({ name }),
		}),

	updateSessionPin: (sessionId: string, pinned: boolean) =>
		request<{ ok: true }>(`/sessions/${sessionId}/pin`, {
			method: "PUT",
			body: JSON.stringify({ pinned }),
		}),

	archiveSession: (sessionId: string) =>
		request<{ ok: true }>(`/sessions/${sessionId}/archive`, {
			method: "PUT",
		}),

	deleteSession: (sessionId: string) =>
		request<{ ok: true }>(`/sessions/${sessionId}`, {
			method: "DELETE",
		}),

	saveSessionNotes: (sessionId: string, notes: string) =>
		request<{ ok: true }>(`/sessions/${sessionId}/notes`, {
			method: "PUT",
			body: JSON.stringify({ notes }),
		}),

	getSessionInstructions: (sessionId: string) =>
		request<{ content?: string; path?: string }>(`/sessions/${sessionId}/claude-md`),

	saveSessionInstructions: (sessionId: string, body: { content: string; path: string }) =>
		request<{ ok: true }>(`/sessions/${sessionId}/claude-md`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),

	stopSession: (sessionId: string) =>
		request<unknown>(`/sessions/${sessionId}/stop`, {
			method: "POST",
		}),

	sendSessionPrompt: (sessionId: string, prompt: string) =>
		request<unknown>(`/sessions/${sessionId}/prompt`, {
			method: "POST",
			body: JSON.stringify({ prompt }),
		}),

	retrySession: (sessionId: string) =>
		request<unknown>(`/sessions/${sessionId}/retry`, {
			method: "POST",
		}),

	getTemplates: (params?: { agent_type?: string }) => {
		const query = new URLSearchParams();
		if (params?.agent_type) query.set("agent_type", params.agent_type);
		const qs = query.toString();
		return request<{ templates: unknown[]; total: number }>(`/templates${qs ? `?${qs}` : ""}`);
	},

	getTemplate: (id: string) => request<{ template: unknown }>(`/templates/${id}`),

	createTemplate: (body: unknown) =>
		request<{ template: unknown }>("/templates", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	updateTemplate: (id: string, body: unknown) =>
		request<{ template: unknown }>(`/templates/${id}`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),

	deleteTemplate: (id: string) =>
		request<{ ok: true }>(`/templates/${id}`, {
			method: "DELETE",
		}),

	duplicateTemplate: (id: string) =>
		request<{ template: unknown }>(`/templates/${id}/duplicate`, {
			method: "POST",
		}),

	previewTemplate: (body: unknown) =>
		request<unknown>("/templates/preview", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	getSupervisors: () => request<{ supervisors: SupervisorRecord[]; total: number }>("/supervisors"),

	getSupervisor: (id: string) => request<{ supervisor: SupervisorRecord }>(`/supervisors/${id}`),

	enrollSupervisor: (body: { name?: string; expiresAt?: string | null; supervisorId?: string | null }) =>
		request<{
			token: string;
			info: {
				id: string;
				name: string;
				supervisorId?: string | null;
				tokenPrefix: string;
				isActive: boolean;
				expiresAt: string | null;
				createdAt: string;
				usedAt: string | null;
				revokedAt: string | null;
			};
		}>("/supervisors/enroll", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	rotateSupervisor: (id: string, body?: { expiresAt?: string | null }) =>
		request<{
			token: string;
			info: {
				id: string;
				name: string;
				supervisorId?: string | null;
				tokenPrefix: string;
				isActive: boolean;
				expiresAt: string | null;
				createdAt: string;
				usedAt: string | null;
				revokedAt: string | null;
			};
		}>(`/supervisors/${id}/rotate`, {
			method: "POST",
			body: JSON.stringify(body ?? {}),
		}),

	registerSupervisor: (body: unknown) =>
		request<unknown>("/supervisors/register", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	revokeSupervisor: (id: string) =>
		request<{ ok: true }>(`/supervisors/${id}/revoke`, {
			method: "POST",
		}),

	heartbeatSupervisor: (id: string) =>
		request<unknown>(`/supervisors/${id}/heartbeat`, {
			method: "POST",
		}),

	getLaunches: () => request<{ launches: LaunchRequest[]; total: number }>("/launches"),

	getLaunch: (id: string) => request<{ launchRequest: LaunchRequest }>(`/launches/${id}`),

	createLaunch: (body: unknown) =>
		request<unknown>("/launches", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	getSettings: () => request<Record<string, unknown>>("/settings"),

	saveSetting: (key: string, value: unknown) =>
		request<{ ok: true }>("/settings", {
			method: "PUT",
			body: JSON.stringify({ key, value }),
		}),

	getApiKeys: () =>
		request<{
			keys: Array<{
				id: string;
				name: string;
				keyPrefix: string;
				isActive: boolean;
				createdAt: string;
				lastUsedAt: string | null;
			}>;
		}>("/api-keys"),

	createApiKey: (name: string) =>
		request<{ id: string; key: string; name: string; message: string }>("/api-keys", {
			method: "POST",
			body: JSON.stringify({ name }),
		}),

	revokeApiKey: (id: string) =>
		request<{ ok: true }>(`/api-keys/${id}`, {
			method: "DELETE",
		}),

	getHealth: () => request<{ status: string }>("/health"),
};
