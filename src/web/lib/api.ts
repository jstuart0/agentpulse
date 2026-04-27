import type {
	ControlAction,
	LaunchRequest,
	Project,
	ProjectInput,
	ResolvedProjectData,
	Session,
	SessionEvent,
	SessionTemplate,
	SupervisorRecord,
} from "../../shared/types.js";
import { APP_API_BASE } from "./paths.js";

const BASE_URL = APP_API_BASE;

/**
 * When Traefik's Authentik forwardauth sees an expired session it
 * 302s our API fetches to `auth.xmojo.net`, which the browser then
 * blocks as a cross-origin redirect (CORS). With the default `fetch`
 * redirect policy the user just sees `TypeError: Failed to fetch`
 * every time they touch the app.
 *
 * We set `redirect: "manual"` so cross-origin redirects surface as
 * an `opaqueredirect` response (type = "opaqueredirect", status = 0)
 * instead of being followed. When that happens we can tell the
 * browser to do a top-level navigation reload — which DOES follow
 * Authentik's redirect, lets the user reauth, and returns them to
 * the app with a fresh cookie. Net effect: expired sessions heal
 * themselves silently instead of surfacing as cryptic errors.
 *
 * The same check fires on `TypeError: Failed to fetch` — that's what
 * browsers throw when some older paths still auto-follow the redirect
 * and then hit CORS.
 */
let authBounceInFlight = false;

export function triggerAuthReload(reason: string): void {
	if (authBounceInFlight) return;
	if (typeof window === "undefined") return;
	authBounceInFlight = true;
	console.warn(`[api] ${reason} — reloading to reacquire auth`);
	// Defer a tick so any error logs get flushed before the nav.
	setTimeout(() => {
		window.location.reload();
	}, 50);
}

export function looksLikeAuthBounce(res: Response): boolean {
	// Cross-origin 3xx that the browser refused to follow.
	if (res.type === "opaqueredirect") return true;
	// Some proxies return 401/403 with a Location header; we don't have
	// access to the header when the response is opaque, so fall back
	// to blank-status detection (status 0 happens on some error paths).
	if (res.status === 0) return true;
	return false;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${BASE_URL}${path}`, {
			redirect: "manual",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
			...options,
		});
	} catch (err) {
		// Failed to fetch = cross-origin redirect blocked by CORS OR
		// network error. Either way, reload — the worst case is one
		// extra full-page refresh.
		if (err instanceof TypeError) {
			triggerAuthReload(`fetch threw (${err.message})`);
		}
		throw err;
	}

	if (looksLikeAuthBounce(res)) {
		triggerAuthReload(`auth-bounce on ${path}`);
		// Throw so callers don't try to JSON-parse the opaque response.
		throw new Error("Session expired; reloading to reauthenticate.");
	}

	if (!res.ok) {
		// Try to surface the server-side `{error: string}` body so callers
		// get something actionable instead of a generic "502 Bad Gateway".
		let detail: string | null = null;
		try {
			const body = (await res.clone().json()) as { error?: string; message?: string };
			if (body?.message) detail = body.message;
			else if (body?.error) detail = body.error;
		} catch {
			try {
				const text = await res.clone().text();
				if (text?.trim()) detail = text.trim().slice(0, 500);
			} catch {
				// ignore — we'll fall back to statusText
			}
		}
		throw new Error(detail ?? `API error: ${res.status} ${res.statusText}`);
	}

	return res.json();
}

export const api = {
	search: (filters: {
		q: string;
		sessionId?: string;
		cwd?: string;
		agentType?: "claude_code" | "codex_cli";
		sessionStatus?: "active" | "idle" | "completed" | "archived";
		eventType?: string;
		since?: string;
		until?: string;
		kinds?: Array<"session" | "event">;
		limit?: number;
		offset?: number;
	}) => {
		const qs = new URLSearchParams();
		qs.set("q", filters.q);
		if (filters.sessionId) qs.set("sessionId", filters.sessionId);
		if (filters.cwd) qs.set("cwd", filters.cwd);
		if (filters.agentType) qs.set("agentType", filters.agentType);
		if (filters.sessionStatus) qs.set("sessionStatus", filters.sessionStatus);
		if (filters.eventType) qs.set("eventType", filters.eventType);
		if (filters.since) qs.set("since", filters.since);
		if (filters.until) qs.set("until", filters.until);
		if (filters.kinds?.length) qs.set("kinds", filters.kinds.join(","));
		if (filters.limit) qs.set("limit", String(filters.limit));
		if (filters.offset) qs.set("offset", String(filters.offset));
		return request<{
			hits: Array<{
				kind: "session" | "event";
				sessionId: string;
				eventId: number | null;
				eventType: string | null;
				snippet: string;
				score: number;
				timestamp: string;
				sessionDisplayName: string | null;
				sessionCwd: string | null;
			}>;
			total: number;
			backend: string;
		}>(`/search?${qs.toString()}`);
	},

	rebuildSearchIndex: () =>
		request<{ ok: true; sessionsIndexed: number; eventsIndexed: number }>("/search/rebuild", {
			method: "POST",
		}),

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

	getTemplate: (id: string) =>
		request<{ template: SessionTemplate; resolvedProject: ResolvedProjectData | null }>(
			`/templates/${id}`,
		),

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

	getAuthMe: () =>
		request<{
			authenticated: boolean;
			user: {
				name: string;
				source: "authentik" | "api_key" | "local";
				id: string | null;
				role: "user" | "admin" | null;
			} | null;
			signOutUrl: string | null;
			disableAuth: boolean;
			allowSignup: boolean;
		}>("/auth/me"),

	// --- Notification channels (Telegram, etc.) ---
	getChannels: () =>
		request<{
			channels: NotificationChannelRecord[];
			bot: { configured: boolean; webhookSecretConfigured: boolean };
		}>("/channels"),
	createChannel: (body: { kind: "telegram"; label?: string }) =>
		request<{
			channel: NotificationChannelRecord;
			enrollmentCode: string;
			instructions: string;
		}>("/channels", { method: "POST", body: JSON.stringify(body) }),
	getChannel: (id: string) => request<{ channel: NotificationChannelRecord }>(`/channels/${id}`),
	deleteChannel: (id: string) => request<{ ok: true }>(`/channels/${id}`, { method: "DELETE" }),
	setupTelegramWebhook: (publicUrl?: string) =>
		request<{ ok: true; webhookUrl: string }>("/channels/telegram/setup-webhook", {
			method: "POST",
			body: JSON.stringify({ publicUrl }),
		}),
	teardownTelegramWebhook: () =>
		request<{ ok: true }>("/channels/telegram/teardown-webhook", {
			method: "POST",
		}),
	getTelegramBotInfo: () => request<{ bot: TelegramBotInfo }>("/channels/telegram/bot-info"),
	getTelegramWebhookInfo: (publicUrl?: string) => {
		const qs = publicUrl ? `?publicUrl=${encodeURIComponent(publicUrl)}` : "";
		return request<{
			webhook: TelegramWebhookInfo;
			expectedUrl: string | null;
			matchesExpected: boolean | null;
		}>(`/channels/telegram/webhook-info${qs}`);
	},

	// --- In-app credential management ---
	getTelegramCredentials: () =>
		request<{
			configured: boolean;
			webhookSecretConfigured: boolean;
			source: "db" | "env" | "missing";
			botTokenHint: string | null;
			deliveryMode: "webhook" | "polling";
			polling: {
				running: boolean;
				lastPollAt: string | null;
				updatesReceived: number;
				lastError: string | null;
			} | null;
		}>("/channels/telegram/credentials"),
	saveTelegramCredentials: (body: {
		botToken?: string;
		webhookSecret?: string;
		rotateWebhookSecret?: boolean;
		publicUrl?: string;
		deliveryMode?: "webhook" | "polling";
	}) =>
		request<{
			ok: true;
			source: "db" | "env" | "missing";
			botTokenHint: string | null;
			webhookSecretConfigured: boolean;
			deliveryMode: "webhook" | "polling";
			bot: TelegramBotInfo | null;
			webhook: { ok: boolean; url?: string; error?: string };
			polling: {
				running: boolean;
				lastPollAt: string | null;
				updatesReceived: number;
				lastError: string | null;
			} | null;
		}>("/channels/telegram/credentials", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	clearTelegramCredentials: () =>
		request<{
			ok: true;
			source: "db" | "env" | "missing";
			botTokenHint: string | null;
		}>("/channels/telegram/credentials", { method: "DELETE" }),
	updateChannelConfig: (id: string, body: { askEnabled?: boolean }) =>
		request<{ channel: NotificationChannelRecord }>(`/channels/${id}/config`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),

	testChannel: (id: string) =>
		request<{ ok: true; externalMessageId?: string }>(`/channels/${id}/test`, {
			method: "POST",
		}),
	getChannelStats: (id: string) => request<{ stats: ChannelStats }>(`/channels/${id}/stats`),

	// --- Labs flags ---
	getLabsFlags: () => request<{ flags: LabsFlags; registry: LabsFlagDefinition[] }>("/labs/flags"),
	setLabsFlag: (flag: LabsFlag, enabled: boolean) =>
		request<{ flags: LabsFlags }>(`/labs/flags/${flag}`, {
			method: "PUT",
			body: JSON.stringify({ enabled }),
		}),

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

	// --- Vector search ---
	getVectorSearchStatus: () =>
		request<{
			build: boolean;
			active: boolean;
			enabled: boolean;
			model: string;
			providerId: string | null;
			progress: {
				total: number;
				embedded: number;
				pending: number;
				model: string | null;
				running: boolean;
				startedAt: string | null;
				finishedAt: string | null;
				error: string | null;
			} | null;
		}>("/ai/vector-search/status"),
	updateVectorSearchStatus: (body: {
		enabled?: boolean;
		model?: string | null;
		providerId?: string | null;
	}) =>
		request<{
			build: boolean;
			active: boolean;
			progress: unknown;
		}>("/ai/vector-search/status", {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	rebuildVectorIndex: () =>
		request<{ ok: boolean; started: boolean }>("/ai/vector-search/rebuild", {
			method: "POST",
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

	// --- Ask (global chat) ---
	getAskThreads: () => request<{ threads: AskThread[] }>("/ai/ask/threads"),
	getAskThread: (id: string) =>
		request<{ thread: AskThread; messages: AskMessage[] }>(`/ai/ask/threads/${id}`),
	deleteAskThread: (id: string) =>
		request<{ ok: true }>(`/ai/ask/threads/${id}`, { method: "DELETE" }),
	sendAskMessage: (body: { threadId?: string | null; message: string; sessionIds?: string[] }) =>
		request<{
			thread: AskThread;
			userMessage: AskMessage;
			assistantMessage: AskMessage;
			includedSessionIds: string[];
		}>("/ai/ask", { method: "POST", body: JSON.stringify(body) }),

	probeAiProviderModels: (body: {
		kind: AiProviderKind;
		baseUrl?: string;
		apiKey?: string;
	}) =>
		request<{ models: Array<{ id: string; description?: string }> }>("/ai/providers/probe-models", {
			method: "POST",
			body: JSON.stringify(body),
		}),

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

	listInboxSnoozes: () => request<{ snoozes: InboxSnooze[] }>("/ai/inbox/snoozes"),
	snoozeInboxItem: (body: {
		kind: InboxWorkItem["kind"];
		targetId: string;
		durationMs: number;
		reason?: string | null;
	}) =>
		request<{ snooze: InboxSnooze }>("/ai/inbox/snooze", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	unsnoozeInboxItem: (id: string) =>
		request<{ ok: true }>(`/ai/inbox/snooze/${id}`, {
			method: "DELETE",
		}),

	listOpenActionRequests: () => request<{ actionRequests: InboxWorkItem[] }>("/ai/action-requests"),

	decideActionRequest: (id: string, body: { decision: "applied" | "declined" }) =>
		request<{ actionRequest: Record<string, unknown> }>(`/ai/action-requests/${id}/decide`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

	getDigest: (params?: { fresh?: boolean }) =>
		request<Digest>(`/ai/digest${params?.fresh ? "?fresh=1" : ""}`),
	refreshDigest: () => request<Digest>("/ai/digest/refresh", { method: "POST" }),

	getLaunchRecommendation: (body: {
		template: Record<string, unknown>;
		preferredSupervisorId?: string | null;
	}) =>
		request<{ recommendation: LaunchRecommendation }>("/launches/recommendation", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	distillTemplate: (body: {
		sessionId: string;
		baseTemplateId?: string | null;
		providerId?: string | null;
		model?: string | null;
	}) =>
		request<{
			draft: TemplateDraftResponse;
			provenance: Record<string, unknown>;
		}>("/ai/templates/distill", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	// --- Event context (for deep-link scroll to older events) ---
	getEventContext: (sessionId: string, eventId: number, around = 20) =>
		request<{ events: SessionEvent[]; target: { id: number } }>(
			`/sessions/${sessionId}/events/${eventId}/context?around=${around}`,
		),

	// --- Projects ---
	listProjects: () => request<{ projects: Project[]; total: number }>("/projects"),
	getProject: (id: string) => request<{ project: Project }>(`/projects/${id}`),
	createProject: (body: ProjectInput) =>
		request<{ project: Project }>("/projects", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	updateProject: (id: string, body: Partial<ProjectInput>) =>
		request<{ project: Project }>(`/projects/${id}`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	deleteProject: (id: string) =>
		request<{ ok: true }>(`/projects/${id}`, {
			method: "DELETE",
		}),
	getProjectSessions: (id: string) =>
		request<{ sessions: Session[]; total: number }>(`/projects/${id}/sessions`),
};

export interface TelegramBotInfo {
	id: number;
	username: string | null;
	firstName: string | null;
	canJoinGroups: boolean;
	supportsInlineQueries: boolean;
}

export interface TelegramWebhookInfo {
	url: string;
	hasCustomCertificate: boolean;
	pendingUpdateCount: number;
	lastErrorDate: number | null;
	lastErrorMessage: string | null;
	maxConnections: number | null;
	allowedUpdates: string[];
}

export interface ChannelStats {
	assignedSessionCount: number;
	hitlTotal: number;
	hitlOpen: number;
	hitlResolved: number;
	lastHitlAt: string | null;
}

export type NotificationChannelKind = "telegram" | "webhook" | "email";

export interface NotificationChannelRecord {
	id: string;
	userId: string;
	kind: NotificationChannelKind;
	label: string;
	config: Record<string, unknown> | null;
	isActive: boolean;
	verifiedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type LabsFlag =
	| "inbox"
	| "digest"
	| "aiSessionTab"
	| "intelligenceBadges"
	| "aiSettingsPanel"
	| "templateDistillation"
	| "launchRecommendation"
	| "riskClasses"
	| "telegramChannel"
	| "askAssistant";

export type LabsFlags = Record<LabsFlag, boolean>;

export interface LabsFlagDefinition {
	key: LabsFlag;
	label: string;
	description: string;
	defaultEnabled: boolean;
}

export interface LaunchRecommendation {
	agentType: string;
	model: string | null;
	launchMode: string;
	suggestedSupervisorId: string | null;
	suggestedSupervisorHost: string | null;
	rationale: string[];
	warnings: string[];
	alternatives: Array<{
		agentType?: string;
		model?: string | null;
		launchMode?: string;
		reason: string;
	}>;
	confidence: number;
}

export interface TemplateDraftResponse {
	source: {
		fromSessionIds: string[];
		generatedAt: string;
		providerId?: string | null;
		model?: string | null;
	};
	draft: Record<string, unknown>;
	notes: string[];
}

export type InboxSeverity = "normal" | "high" | "info";
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
	  }
	| {
			kind: "action_launch";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectId: string;
			projectName: string;
			template: Record<string, unknown>;
			launchSpec: Record<string, unknown>;
			requestedLaunchMode: string;
			origin: "web" | "telegram";
			parentSessionId: string | null;
			parentSessionName: string | null;
	  }
	| {
			kind: "action_add_project";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectName: string;
			projectCwd: string;
			defaultAgentType: string | null;
			defaultModel: string | null;
			defaultLaunchMode: string | null;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_stop";
			id: string;
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_archive";
			id: string;
			sessionId: string;
			sessionName: string | null;
			severity: "normal";
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_delete";
			id: string;
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_edit_project";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "normal";
			projectId: string;
			projectName: string;
			fields: Record<string, unknown>;
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_delete_project";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "high";
			projectId: string;
			projectName: string;
			affectedTemplates: number;
			affectedSessions: number;
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_edit_template";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "normal";
			templateId: string;
			templateName: string;
			fields: Record<string, unknown>;
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_delete_template";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "high";
			templateId: string;
			templateName: string;
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_add_channel";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "info";
			channelKind: "telegram" | "webhook" | "email";
			channelLabel: string;
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_create_alert_rule";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectName: string;
			ruleType: string;
			thresholdMinutes: number | null;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_bulk_session";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "high" | "normal";
			createdAt: string;
			action: "stop" | "archive" | "delete";
			sessionCount: number;
			sessionNames: string[];
			hasMore: boolean;
			exclusionCount: number;
			origin: "web" | "telegram";
	  };

export interface Inbox {
	items: InboxWorkItem[];
	total: number;
	byKind: Record<InboxWorkItem["kind"], number>;
}

export interface InboxSnooze {
	id: string;
	kind: InboxWorkItem["kind"];
	targetId: string;
	snoozedUntil: string;
	reason: string | null;
	createdAt: string;
	updatedAt: string;
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

export interface AskThread {
	id: string;
	title: string | null;
	origin: "web" | "telegram";
	telegramChatId: string | null;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
}

export interface AskMessage {
	id: string;
	threadId: string;
	role: "user" | "assistant" | "system";
	content: string;
	contextSessionIds: string[] | null;
	tokensIn: number | null;
	tokensOut: number | null;
	errorMessage: string | null;
	createdAt: string;
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
