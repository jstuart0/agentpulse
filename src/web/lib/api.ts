import type {
	ControlAction,
	LaunchRequest,
	Session,
	SessionEvent,
	SupervisorRecord,
} from "../../shared/types.js";
import { APP_API_BASE } from "./paths.js";

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
		request<{ session: Session; events: SessionEvent[]; controlActions?: ControlAction[] }>(
			`/sessions/${sessionId}`,
		),

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

	enrollSupervisor: (body: {
		name?: string;
		expiresAt?: string | null;
		supervisorId?: string | null;
	}) =>
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

	// --- AI watcher ---
	getAiStatus: () => request<AiStatusResponse>("/ai/status"),
	updateAiStatus: (body: {
		enabled?: boolean;
		killSwitch?: boolean;
		classifierEnabled?: boolean;
		classifierAffectsRunner?: boolean;
	}) =>
		request<AiStatusResponse>("/ai/status", {
			method: "PUT",
			body: JSON.stringify(body),
		}),

	getSessionIntelligence: (sessionId: string) =>
		request<{ intelligence: SessionIntelligence }>(`/ai/sessions/${sessionId}/intelligence`),
	getIntelligenceBatch: (sessionIds: string[]) =>
		request<{ intelligence: Record<string, SessionIntelligence> }>("/ai/intelligence/batch", {
			method: "POST",
			body: JSON.stringify({ sessionIds }),
		}),

	getAiProviders: () =>
		request<{ providers: AiProvider[]; defaultProviderId: string | null }>("/ai/providers"),
	createAiProvider: (body: AiProviderCreate) =>
		request<{ provider: AiProvider }>("/ai/providers", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	updateAiProvider: (id: string, body: AiProviderUpdate) =>
		request<{ provider: AiProvider }>(`/ai/providers/${id}`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	deleteAiProvider: (id: string) =>
		request<{ ok: true }>(`/ai/providers/${id}`, { method: "DELETE" }),

	getAiWatcher: (sessionId: string) =>
		request<{ config: AiWatcherConfig | null; proposals: AiProposal[] }>(
			`/ai/sessions/${sessionId}/watcher`,
		),
	updateAiWatcher: (sessionId: string, body: AiWatcherConfigUpdate) =>
		request<{ config: AiWatcherConfig }>(`/ai/sessions/${sessionId}/watcher`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	deleteAiWatcher: (sessionId: string) =>
		request<{ ok: true }>(`/ai/sessions/${sessionId}/watcher`, { method: "DELETE" }),

	decideAiProposal: (
		id: string,
		body: { action: "approve" | "decline" | "custom"; customPrompt?: string },
	) =>
		request<{ ok: true; dispatched: boolean; prompt?: string | null }>(
			`/ai/proposals/${id}/decision`,
			{ method: "POST", body: JSON.stringify(body) },
		),

	aiRedactorDryRun: (sample: string, userRules?: string[]) =>
		request<{
			text: string;
			hits: Array<{ rule: string; position: number; originalLength: number; replacement: string }>;
		}>("/ai/redactor/dry-run", {
			method: "POST",
			body: JSON.stringify({ sample, userRules }),
		}),

	getAiSpend: () => request<{ date: string; spendCents: number }>("/ai/spend"),

	getAiInbox: (params?: {
		kinds?: InboxWorkItem["kind"][];
		sessionId?: string;
		severity?: "high" | "normal";
		limit?: number;
	}) => {
		const qs = new URLSearchParams();
		if (params?.kinds?.length) qs.set("kinds", params.kinds.join(","));
		if (params?.sessionId) qs.set("sessionId", params.sessionId);
		if (params?.severity) qs.set("severity", params.severity);
		if (params?.limit) qs.set("limit", String(params.limit));
		return request<Inbox>(`/ai/inbox${qs.toString() ? `?${qs}` : ""}`);
	},
	decideInboxHitl: (
		id: string,
		body: { action: "approve" | "decline" | "custom"; customPrompt?: string },
	) =>
		request<{ hitl: { id: string; status: string } }>(`/ai/inbox/hitl/${id}/decide`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	batchDeclineInbox: (body: { hitlIds?: string[]; sessionIds?: string[] }) =>
		request<{ closed: number }>("/ai/inbox/batch-decline", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	getDigest: (params?: { fresh?: boolean }) =>
		request<Digest>(`/ai/digest${params?.fresh ? "?fresh=1" : ""}`),
	refreshDigest: () => request<Digest>("/ai/digest/refresh", { method: "POST" }),
};

export type InboxSeverity = "normal" | "high";
export type InboxWorkItem =
	| {
			kind: "hitl";
			id: string;
			sessionId: string;
			sessionName: string | null;
			proposalId: string;
			decision: "continue" | "ask";
			prompt: string;
			why: string | null;
			openedAt: string;
			severity: InboxSeverity;
	  }
	| {
			kind: "stuck";
			id: string;
			sessionId: string;
			sessionName: string | null;
			since: string;
			reason: string;
			evidence: string[];
			severity: InboxSeverity;
	  }
	| {
			kind: "risky";
			id: string;
			sessionId: string;
			sessionName: string | null;
			reason: string;
			evidence: string[];
			severity: InboxSeverity;
	  }
	| {
			kind: "failed_proposal";
			id: string;
			sessionId: string;
			sessionName: string | null;
			errorSubType: string | null;
			errorMessage: string | null;
			at: string;
			severity: InboxSeverity;
	  };

export interface Inbox {
	items: InboxWorkItem[];
	total: number;
	byKind: Record<InboxWorkItem["kind"], number>;
}

export interface RepoDigestSession {
	sessionId: string;
	displayName: string | null;
	status: string;
	health: string | null;
	healthReason: string | null;
	lastActivityAt: string;
	totalToolUses: number;
}

export interface RepoDigest {
	repoKey: string;
	cwd: string | null;
	projectName: string;
	activeCount: number;
	blockedCount: number;
	stuckCount: number;
	completedToday: number;
	failedToday: number;
	topPlanCompletions: string[];
	notableFailures: Array<{ sessionId: string; message: string | null; at: string }>;
	sessions: RepoDigestSession[];
}

export interface Digest {
	generatedAt: string;
	windowStart: string;
	windowEnd: string;
	totals: {
		repos: number;
		sessions: number;
		active: number;
		blocked: number;
		stuck: number;
		completedToday: number;
	};
	repos: RepoDigest[];
}

export type AiProviderKind = "anthropic" | "openai" | "google" | "openrouter" | "openai_compatible";

export interface AiProvider {
	id: string;
	userId: string;
	name: string;
	kind: AiProviderKind;
	model: string;
	baseUrl: string | null;
	credentialHint: string;
	isDefault: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface AiProviderCreate {
	name: string;
	kind: AiProviderKind;
	model: string;
	baseUrl?: string;
	apiKey: string;
	isDefault?: boolean;
}

export interface AiProviderUpdate {
	name?: string;
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	isDefault?: boolean;
}

export type AiWatcherPolicy = "ask_always" | "ask_on_risk" | "auto";

export interface AiWatcherConfig {
	sessionId: string;
	enabled: boolean;
	providerId: string;
	policy: AiWatcherPolicy;
	channelId: string | null;
	maxContinuations: number;
	continuationsUsed: number;
	maxDailyCents: number | null;
	systemPrompt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface AiStatusResponse {
	build: boolean;
	runtime: boolean;
	killSwitch: boolean;
	active: boolean;
	classifierEnabled?: boolean;
	classifierAffectsRunner?: boolean;
}

export type SessionHealthState = "healthy" | "blocked" | "stuck" | "risky" | "complete_candidate";

export interface SessionIntelligence {
	health: SessionHealthState;
	reasonCode: string;
	explanation: string;
	confidence: number;
	evidence: string[];
	updatedAt: string;
}

export interface AiWatcherConfigUpdate {
	enabled?: boolean;
	providerId?: string;
	policy?: AiWatcherPolicy;
	channelId?: string | null;
	maxContinuations?: number;
	maxDailyCents?: number | null;
	systemPrompt?: string | null;
}

export interface AiProposal {
	id: string;
	sessionId: string;
	providerId: string;
	state:
		| "pending"
		| "complete"
		| "hitl_waiting"
		| "hitl_applied"
		| "hitl_declined"
		| "cancelled"
		| "failed";
	decision: "continue" | "ask" | "report" | "stop" | "wait" | null;
	nextPrompt: string | null;
	reportSummary: string | null;
	rawResponse: Record<string, unknown> | null;
	triggerEventId: string | null;
	tokensIn: number;
	tokensOut: number;
	costCents: number;
	usageEstimated: boolean;
	errorSubType: string | null;
	errorMessage: string | null;
	createdAt: string;
	updatedAt: string;
}
