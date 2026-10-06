import type {
	ActionRequestDecision,
	AgentType,
	ApiKeyInfo,
	AskMessageRole,
	AskThreadOrigin,
	AuthMeResponse,
	ControlAction,
	DashboardStats,
	DecisionKind,
	HitlReplyKind,
	HostStatsResponse,
	Inbox,
	InboxFilter,
	InboxSeverity,
	InboxWorkItem,
	LaunchRequest,
	NotificationChannelKind,
	OwnerStatsResponse,
	Project,
	ProjectInput,
	ProviderKind,
	ResolvedProjectData,
	Session,
	SessionEvent,
	SessionTemplate,
	LabsFlag as SharedLabsFlag,
	LabsFlags as SharedLabsFlags,
	SupervisorRecord,
	WatcherPolicy,
} from "../../shared/types.js";

import {
	SUMMARY_REFUSAL_CODES,
	type SessionSummaryStartBody,
	type SessionSummaryView,
	type SummaryRefusalCode,
} from "../../shared/session-summary-view.js";

export type {
	SessionSummaryRefusalBody,
	SessionSummaryStartBody,
	SessionSummaryView,
	SummaryRefusalCode,
} from "../../shared/session-summary-view.js";

export type {
	ActionRequestDecision,
	AskThreadOrigin,
	NotificationChannelKind,
} from "../../shared/types.js";

// Re-export inbox types so existing client consumers keep their import path
// (`import { Inbox, InboxWorkItem } from "../lib/api.js"`).
export type { Inbox, InboxFilter, InboxSeverity, InboxWorkItem };

// Backward-compat aliases — call sites historically used `AiProviderKind`
// and `AiWatcherPolicy`. Keep the alias so we don't churn imports while
// still pointing at the canonical shared union.
export type AiProviderKind = ProviderKind;
export type AiWatcherPolicy = WatcherPolicy;
export type { AskMessageRole, DecisionKind, HitlReplyKind } from "../../shared/types.js";
import {
	decideFetchFailure,
	isOutageResponse,
	parseRetryAfter,
	readLastBounce,
	recordBounce,
} from "./network-retry.js";
import { OWNER_ME, type ScopeQuery } from "./owner-scope.js";
import { APP_API_BASE } from "./paths.js";
import { type ScopedQuery, type SessionFilters, assertScopedQuery } from "./scoped-query.js";

const BASE_URL = APP_API_BASE;

/**
 * When Traefik's forwardauth provider sees an expired session it
 * 302s our API fetches to the upstream IdP's login page, which the
 * browser then blocks as a cross-origin redirect (CORS). With the
 * default `fetch` redirect policy the user just sees
 * `TypeError: Failed to fetch` every time they touch the app.
 *
 * We set `redirect: "manual"` so cross-origin redirects surface as
 * an `opaqueredirect` response (type = "opaqueredirect", status = 0)
 * instead of being followed. When that happens we can tell the
 * browser to do a top-level navigation reload — which DOES follow
 * the forwardauth redirect, lets the user reauth via the configured
 * IdP (e.g. Authentik, Authelia, oauth2-proxy), and returns them to
 * the app with a fresh cookie. Net effect: expired sessions heal
 * themselves silently instead of surfacing as cryptic errors.
 *
 * The same check fires on `TypeError: Failed to fetch` — that's what
 * browsers throw when some older paths still auto-follow the redirect
 * and then hit CORS.
 */
let authBounceInFlight = false;

/** The browser's session storage, reached lazily: even touching it can throw. */
const bounceStorage = {
	getItem: (key: string) => window.sessionStorage.getItem(key),
	setItem: (key: string, value: string) => window.sessionStorage.setItem(key, value),
};

export function triggerAuthReload(reason: string): void {
	if (authBounceInFlight) return;
	if (typeof window === "undefined") return;
	if (!recordBounce(bounceStorage, Date.now())) {
		console.warn(`[api] ${reason} — not reloading: this browser can't remember that it did`);
		networkHandler?.failed();
		return;
	}
	authBounceInFlight = true;
	console.warn(`[api] ${reason} — reloading to reacquire auth`);
	// Defer a tick so any error logs get flushed before the nav.
	setTimeout(() => {
		window.location.reload();
	}, 50);
}

/** Tells whoever shows connectivity whether requests are getting answered. */
interface NetworkHandler {
	failed: () => void;
	/** The path that was answered, so a listener can tell the identity check from any other call. */
	ok: (path: string) => void;
}
let networkHandler: NetworkHandler | null = null;

export function setNetworkHandler(handler: NetworkHandler | null): void {
	networkHandler = handler;
}

/**
 * A request that got no answer. The first one in a minute may be an expired
 * sign-in, so it reloads once; every later one is an outage, reported for the
 * visible "can't reach the server" state (which paces its own retries).
 */
function handleFetchFailure(reason: string): void {
	const decision = decideFetchFailure({
		lastBounceAt: readLastBounce(bounceStorage),
		now: Date.now(),
	});
	if (decision.action === "reload") triggerAuthReload(reason);
	else networkHandler?.failed();
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

/**
 * Thrown by `request()` for any non-2xx HTTP response. Carries the status,
 * the server's error code (the `{error}` string of a JSON body, e.g.
 * "not_owner") and the parsed body itself, so callers can branch on a refusal
 * (and read what came with it, like the keys of a 409) instead of
 * re-parsing a formatted message. `message` is the server's `{message}` or
 * `{error}` text when present, else `res.statusText`.
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string | null;
	readonly body: unknown;
	/** Whole seconds the server asked the caller to wait (the Retry-After header), when it sent one. */
	readonly retryAfterSeconds: number | null;

	constructor(
		status: number,
		message: string,
		body: unknown = null,
		retryAfterSeconds: number | null = null,
	) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
		this.retryAfterSeconds = retryAfterSeconds;
		const code = (body as { error?: unknown } | null)?.error;
		this.code = typeof code === "string" ? code : null;
	}
}

/** What a refused call looked like, for whoever wants to react to the standing of the viewer changing. */
export interface RequestFailure {
	status: number;
	code: string | null;
	path: string;
}

let requestFailureHandler: ((failure: RequestFailure) => void) | null = null;
let requestSuccessHandler: ((path: string) => void) | null = null;

/** One listener for every request that came back 2xx. */
export function setRequestSuccessHandler(handler: ((path: string) => void) | null): void {
	requestSuccessHandler = handler;
}

/** One listener, set by the user store: it decides whether a failure means "look at who I am again". */
export function setRequestFailureHandler(
	handler: ((failure: RequestFailure) => void) | null,
): void {
	requestFailureHandler = handler;
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
			handleFetchFailure(`fetch threw (${err.message})`);
		}
		throw err;
	}

	if (looksLikeAuthBounce(res)) {
		handleFetchFailure(`auth-bounce on ${path}`);
		// Throw so callers don't try to JSON-parse the opaque response.
		throw new Error("Session expired; reloading to reauthenticate.");
	}

	if (!res.ok) {
		// Try to surface the server-side `{error: string}` body so callers
		// get something actionable instead of a generic "502 Bad Gateway".
		let detail: string | null = null;
		let parsed: unknown = null;
		try {
			parsed = await res.clone().json();
			const body = parsed as { error?: string; message?: string } | null;
			if (body?.message) detail = body.message;
			else if (body?.error) detail = body.error;
		} catch {
			parsed = null;
			try {
				const text = await res.clone().text();
				if (text?.trim()) detail = text.trim().slice(0, 500);
			} catch {
				// ignore — we'll fall back to statusText
			}
		}
		const failure = new ApiError(
			res.status,
			detail ?? res.statusText,
			parsed,
			parseRetryAfter(res.headers.get("Retry-After"), Date.now()),
		);
		if (isOutageResponse(res.status, failure.code, path)) networkHandler?.failed();
		else networkHandler?.ok(path);
		requestFailureHandler?.({ status: res.status, code: failure.code, path });
		throw failure;
	}

	networkHandler?.ok(path);
	requestSuccessHandler?.(path);
	return res.json();
}

function statsQuery(params?: ScopeQuery, extra?: string): string {
	const query = new URLSearchParams(extra);
	if (params?.excludeScratch) query.set("excludeScratch", "true");
	if (params?.owner) query.set("owner", params.owner);
	if (params?.host) query.set("host", params.host);
	const qs = query.toString();
	return qs ? `?${qs}` : "";
}

function sessionsQueryString(params: SessionFilters & ScopeQuery): string {
	const query = new URLSearchParams();
	if (params.status) query.set("status", params.status);
	if (params.agent_type) query.set("agent_type", params.agent_type);
	if (params.projectId) query.set("projectId", params.projectId);
	if (params.operational) query.set("operational", params.operational);
	if (params.tab) query.set("tab", params.tab);
	if (params.q) query.set("q", params.q);
	if (params.excludeScratch) query.set("excludeScratch", "true");
	if (params.owner) query.set("owner", params.owner);
	if (params.host) query.set("host", params.host);
	if (params.limit) query.set("limit", String(params.limit));
	if (params.offset) query.set("offset", String(params.offset));
	const qs = query.toString();
	return qs ? `?${qs}` : "";
}

/**
 * Runs a scoped call only for a query scopedQuery() made. In a production
 * build the refusal is a rejected promise (callers already handle those); in
 * development and tests it throws on the spot so the mistake can't hide.
 */
function whenScoped<T>(query: ScopedQuery, run: () => Promise<T>): Promise<T> {
	try {
		assertScopedQuery(query);
	} catch (err) {
		if (import.meta.env?.PROD) return Promise.reject(err);
		throw err;
	}
	return run();
}

type SessionsResponse = {
	sessions: Session[];
	total: number;
	ownerScope?: unknown;
	hostFilter?: unknown;
};

export const api = {
	search: (filters: {
		q: string;
		sessionId?: string;
		cwd?: string;
		agentType?: AgentType;
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
				/** Whose session the hit belongs to, when the server says (team mode). */
				ownerUserId?: string | null;
				ownerKind?: "user" | "service" | "unassigned";
			}>;
			total: number;
			backend: string;
		}>(`/search?${qs.toString()}`);
	},

	rebuildSearchIndex: () =>
		request<{ ok: true; sessionsIndexed: number; eventsIndexed: number }>("/search/rebuild", {
			method: "POST",
		}),

	/** The dashboard's list. The query is built from the live scope by scopedQuery(), the only way to make one. */
	getSessions: (query: ScopedQuery) =>
		whenScoped(query, () => request<SessionsResponse>(`/sessions${sessionsQueryString(query)}`)),

	/**
	 * The newest Codex session, for the Setup page's "has Codex reported yet"
	 * check. Solo asks about the whole instance (deliberately not the
	 * dashboard's scope); team mode asks about the viewer's own sessions.
	 */
	getCodexProbeSessions: (ownOnly: boolean) =>
		request<SessionsResponse>(
			`/sessions${sessionsQueryString({
				agent_type: "codex_cli",
				limit: 1,
				...(ownOnly ? { owner: OWNER_ME } : {}),
			})}`,
		),

	getSession: (sessionId: string) =>
		request<{ session: Session; events: SessionEvent[]; controlActions?: ControlAction[] }>(
			`/sessions/${sessionId}`,
		),

	getTimeline: (sessionId: string, limit = 50, offset = 0) =>
		request<{ events: SessionEvent[] }>(
			`/sessions/${sessionId}/timeline?limit=${limit}&offset=${offset}`,
		),

	/** Counts for the dashboard's scope; same one-function rule as getSessions. */
	getStats: (query: ScopedQuery) =>
		whenScoped(query, () =>
			request<DashboardStats & { ownerScope?: unknown; hostFilter?: unknown }>(
				`/sessions/stats${statsQuery(query)}`,
			),
		),

	/** Counts for everyone, following only the scratch toggle and the machine: the other half of "N more active across the team" under Mine, so both halves describe the same machines. Deliberately not the dashboard's owner scope. */
	getEveryoneStats: (excludeScratch: boolean, host?: string) =>
		request<DashboardStats & { ownerScope?: unknown; hostFilter?: unknown }>(
			`/sessions/stats${statsQuery({ excludeScratch, host })}`,
		),

	/** Per-owner counts for the same scope (the dashboard's Group by User headers). */
	getStatsByOwner: (query: ScopedQuery) =>
		whenScoped(query, () =>
			request<OwnerStatsResponse & { ownerScope?: unknown }>(
				`/sessions/stats${statsQuery(query, "group_by=owner")}`,
			),
		),

	/** Per-machine counts for the same scope (the machine filter's options and the Group by Machine headers). */
	getStatsByHost: (query: ScopedQuery) =>
		whenScoped(query, () =>
			request<HostStatsResponse & { ownerScope?: unknown }>(
				`/sessions/stats${statsQuery(query, "group_by=host")}`,
			),
		),

	getSessionControlActions: (sessionId: string) =>
		request<{ controlActions: ControlAction[] }>(`/sessions/${sessionId}/control-actions`),

	renameSession: (sessionId: string, name: string) =>
		// source: "user" (F5 / Decision 6) — the dashboard is always a manual
		// rename; explicit "user" stamps sessions.metadata.renameSource so a
		// later Claude native-name pull can't clobber it. Safe to hardcode:
		// the web client is always same-version as the server it talks to.
		request<{ ok: true }>(`/sessions/${sessionId}/rename`, {
			method: "PUT",
			body: JSON.stringify({ name, source: "user" }),
		}),

	resetSessionName: (sessionId: string) =>
		// D14: clears the manual-rename pin (metadata.renameSource) and, if an
		// agent-reported native name has ever been observed, applies it
		// immediately server-side.
		request<{ ok: true }>(`/sessions/${sessionId}/rename`, {
			method: "PUT",
			body: JSON.stringify({ source: "reset" }),
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

	// AGEN: dashboard "mark as seen". `acknowledged: false` means the caller
	// doesn't own the session (another user's WAITING) -- not an error, so
	// callers should check the flag rather than only catching a thrown error.
	// `source` labels the resulting timeline row — "dismiss-error" for the
	// explicit Dismiss-error action, default "dashboard" otherwise.
	acknowledgeSession: (sessionId: string, source?: string) =>
		request<{ acknowledged: boolean; reason?: "not_owner" }>(`/sessions/${sessionId}/acknowledge`, {
			method: "POST",
			body: JSON.stringify(source ? { source } : {}),
		}),

	// AGEN: dashboard "mark as unseen" — the inverse of acknowledgeSession.
	unacknowledgeSession: (sessionId: string, source?: string) =>
		request<{ unacknowledged: boolean; reason?: "not_owner" }>(
			`/sessions/${sessionId}/acknowledge`,
			{ method: "DELETE", body: JSON.stringify(source ? { source } : {}) },
		),

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

	getSupervisors: () =>
		request<{ supervisors: SupervisorRecord[]; total: number }>("/admin/supervisors"),

	getSupervisor: (id: string) =>
		request<{ supervisor: SupervisorRecord }>(`/admin/supervisors/${id}`),

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
		}>("/admin/supervisors/enroll", {
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
		}>(`/admin/supervisors/${id}/rotate`, {
			method: "POST",
			body: JSON.stringify(body ?? {}),
		}),

	registerSupervisor: (body: unknown) =>
		request<unknown>("/supervisors/register", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	revokeSupervisor: (id: string) =>
		request<{ ok: true }>(`/admin/supervisors/${id}/revoke`, {
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

	getWorkspaceSettings: () =>
		request<{
			workspace: { defaultRoot: string; templateClaudeMd: string; gitInit: boolean };
			gitClone: {
				allowSshUrls: boolean;
				allowLocalUrls: boolean;
				defaultDepth: number | null;
				timeoutSeconds: number;
			};
		}>("/settings/workspace"),

	saveWorkspaceSettings: (update: {
		workspace?: {
			defaultRoot?: string;
			templateClaudeMd?: string;
			gitInit?: boolean;
		};
		gitClone?: {
			allowSshUrls?: boolean;
			allowLocalUrls?: boolean;
			defaultDepth?: number | null;
			timeoutSeconds?: number;
		};
	}) =>
		request<{
			workspace: { defaultRoot: string; templateClaudeMd: string; gitInit: boolean };
			gitClone: {
				allowSshUrls: boolean;
				allowLocalUrls: boolean;
				defaultDepth: number | null;
				timeoutSeconds: number;
			};
		}>("/settings/workspace", {
			method: "PUT",
			body: JSON.stringify(update),
		}),

	getApiKeys: () => request<{ keys: ApiKeyRow[] }>("/api-keys"),

	getApiKey: (id: string) =>
		request<{ key: ApiKeyRow; serviceSessionCount: number }>(`/api-keys/${id}`),

	/** `service: true` (admins, team mode) mints a key that belongs to no one. */
	createApiKey: (name: string, scopes?: string[], options?: { service?: boolean }) =>
		request<{ id: string; key: string; name: string; scopes: string[]; message: string }>(
			"/api-keys",
			{
				method: "POST",
				body: JSON.stringify({
					name,
					...(scopes !== undefined ? { scopes } : {}),
					...(options?.service ? { service: true } : {}),
				}),
			},
		),

	/** An admin's change to a key: hand it to a user (optionally with the sessions it reported), or keep/unkeep it as an admin service key. */
	patchApiKey: (
		id: string,
		body: {
			ownerUserId?: string | null;
			attributeSessions?: boolean;
			adminService?: boolean;
			/** Record an ownerless key as a plain service key (admins; 409 key_has_owner for an owned key). */
			serviceKey?: boolean;
		},
	) =>
		request<{ ok: true; attributedSessions: number }>(`/api-keys/${id}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),

	revokeApiKey: (id: string) =>
		request<{ ok: true }>(`/api-keys/${id}`, {
			method: "DELETE",
		}),

	// --- Instance mode, people, ownership ---
	getInstance: () =>
		request<{ mode: "solo" | "team"; modeLockedByEnv: boolean; counts: InstanceCounts }>(
			"/instance",
		),

	/** An admin hands a session to a person, or clears its owner. */
	setSessionOwner: (sessionId: string, ownerUserId: string | null) =>
		request<{ ok: true; session: Session | null }>(`/sessions/${sessionId}/owner`, {
			method: "PATCH",
			body: JSON.stringify({ ownerUserId }),
		}),

	setInstanceMode: (mode: "solo" | "team", serviceKeyDecisions: ServiceKeyDecision[]) =>
		request<{ mode: "solo" | "team"; changed: boolean }>("/instance/mode", {
			method: "PUT",
			body: JSON.stringify({ mode, serviceKeyDecisions }),
		}),

	claimUnassignedSessions: (userId: string) =>
		request<{ claimed: number }>("/instance/claim-unassigned", {
			method: "POST",
			body: JSON.stringify({ userId }),
		}),

	getUserDirectory: () => request<{ users: DirectoryUser[] }>("/users/directory"),

	getUsers: () => request<{ users: AdminUserRow[] }>("/users"),

	createUser: (body: { username: string; role: "user" | "admin" }) =>
		request<{ user: { id: string; username: string; role: "user" | "admin" }; password: string }>(
			"/users",
			{ method: "POST", body: JSON.stringify(body) },
		),

	setUserRole: (id: string, role: "user" | "admin") =>
		request<{ user: { id: string; role: "user" | "admin" } }>(`/users/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ role }),
		}),

	disableUser: (id: string, body: { revokeHosts: boolean }) =>
		request<{ ok: true }>(`/users/${id}/disable`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

	enableUser: (id: string) => request<{ ok: true }>(`/users/${id}/enable`, { method: "POST" }),

	resetUserPassword: (id: string) =>
		request<{ password: string }>(`/users/${id}/reset-password`, { method: "POST" }),

	setSupervisorOwner: (id: string, ownerUserId: string | null) =>
		request<{ ok: true; ownerUserId: string | null }>(`/admin/supervisors/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ ownerUserId }),
		}),

	changePassword: (body: { currentPassword: string; newPassword: string }) =>
		request<{ ok: true }>("/auth/change-password", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	getHealth: () =>
		request<{
			status: string;
			version?: string;
			instance?: { dbFingerprint: string; dialect: "sqlite" | "postgres" };
		}>("/health"),

	getAuthMe: () => request<AuthMeResponse>("/auth/me"),

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
		autoEnableWatcherForAsk?: boolean;
	}) =>
		request<AiStatusResponse>("/ai/status", {
			method: "PUT",
			body: JSON.stringify(body),
		}),

	// --- Session summary (AGEN-69) ---
	/** `poll` asks the server to leave the stored summary out of the answer (it answers `storedOmitted`). */
	getSessionSummary: (sessionId: string, options: { poll?: boolean } = {}) =>
		request<SessionSummaryView>(
			`/ai/sessions/${encodeURIComponent(sessionId)}/summary${options.poll ? "?poll=1" : ""}`,
		),
	generateSessionSummary: async (sessionId: string): Promise<GenerateSummaryResult> => {
		try {
			const body = await request<SessionSummaryStartBody>(
				`/ai/sessions/${encodeURIComponent(sessionId)}/summary`,
				{ method: "POST" },
			);
			return { ok: true, body };
		} catch (err) {
			if (err instanceof ApiError) return { ok: false, refusal: toSummaryRefusal(err) };
			throw err;
		}
	},

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

	decideAiProposal: (id: string, body: { action: HitlReplyKind; customPrompt?: string }) =>
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
	decideInboxHitl: (id: string, body: { action: HitlReplyKind; customPrompt?: string }) =>
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

	decideActionRequest: (id: string, body: { decision: ActionRequestDecision }) =>
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
	cleanupWorkarea: (id: string) =>
		request<{
			queued: true;
			sessionCount: number;
			targetSupervisorId: string;
			action: { id: string; actionType: string; status: string };
		}>(`/projects/${id}/cleanup-workarea`, {
			method: "POST",
		}),
};

/** One entry of GET /users/directory: everyone who can own something, for labels and pickers. */
export interface DirectoryUser {
	id: string;
	/** A local account's login name, or an SSO account's display name (null when the IdP sent none). */
	displayName: string | null;
	/** How the account signs in ("local" or the SSO provider), when the server says; lets a label tell a real "admin" login from an impostor's display name. */
	authSource?: string | null;
	disabled: boolean;
}

/** One row of GET /users (admins only). */
export interface AdminUserRow {
	id: string;
	username: string;
	displayName: string | null;
	role: "user" | "admin";
	disabled: boolean;
	authSource: string;
	provider: string | null;
	/** How the identity was matched: a stable uid, a username (re-usable by the IdP), or not yet known. */
	subjectSource: "uid" | "username" | null;
	lastLoginAt: string | null;
	roleLockedByEnv: boolean;
	mustChangePassword: boolean;
	keyCount: number;
	hostCount: number;
}

export interface InstanceCounts {
	/** Sessions nobody owns and no key is recorded for. */
	unassignedSessions: number;
	/** Active API keys with no owner. */
	serviceKeys: number;
	/** Active ownerless manage keys that aren't kept as admin service keys. */
	undecidedManageServiceKeys: number;
	/**
	 * Active ownerless keys that are neither admin-minted service keys, kept
	 * admin keys, nor marked as service keys. Absent on a server that doesn't
	 * record the decision.
	 */
	undecidedServiceKeys?: number;
}

/** A key row as the list returns it: `serviceKey` is the server's record of "this ownerless key is meant to have no owner" (absent on an older server). */
export type ApiKeyRow = ApiKeyInfo & { serviceKey?: boolean };

/** What an admin decides for each ownerless manage/wildcard key when turning team mode on. */
export type ServiceKeyDecision =
	| { keyId: string; decision: "keep" }
	| { keyId: string; decision: "revoke" }
	| { keyId: string; decision: "assign"; userId: string };

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

// LabsFlag / LabsFlags are canonically defined in `src/shared/types.ts`
// (Slice TYPE-2d). Re-export here so existing call sites that import
// from `lib/api.js` keep working without churn.
export type LabsFlag = SharedLabsFlag;
export type LabsFlags = SharedLabsFlags;

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
	origin: AskThreadOrigin;
	telegramChatId: string | null;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
}

export interface AskMessage {
	id: string;
	threadId: string;
	role: AskMessageRole;
	content: string;
	contextSessionIds: string[] | null;
	tokensIn: number | null;
	tokensOut: number | null;
	errorMessage: string | null;
	createdAt: string;
}

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

/** A refused `POST /ai/sessions/:id/summary` as the web sees it (AGEN-69). `code` is null for a body the contract doesn't list. */
export interface SummaryRefusal {
	status: number;
	code: SummaryRefusalCode | null;
	retryAfterSeconds: number | null;
}

export type GenerateSummaryResult =
	| { ok: true; body: SessionSummaryStartBody }
	| { ok: false; refusal: SummaryRefusal };

const KNOWN_SUMMARY_REFUSALS: ReadonlySet<string> = new Set(SUMMARY_REFUSAL_CODES);

/** The body's `retryAfterSeconds` wins; the `Retry-After` header (already parsed onto the error) is the fallback. */
function toSummaryRefusal(err: ApiError): SummaryRefusal {
	const body = err.body as { retryAfterSeconds?: unknown } | null;
	const fromBody =
		typeof body?.retryAfterSeconds === "number" &&
		Number.isFinite(body.retryAfterSeconds) &&
		body.retryAfterSeconds >= 0
			? Math.ceil(body.retryAfterSeconds)
			: null;
	return {
		status: err.status,
		code:
			err.code !== null && KNOWN_SUMMARY_REFUSALS.has(err.code)
				? (err.code as SummaryRefusalCode)
				: null,
		retryAfterSeconds: fromBody ?? err.retryAfterSeconds,
	};
}

export interface AiStatusResponse {
	build: boolean;
	runtime: boolean;
	killSwitch: boolean;
	active: boolean;
	classifierEnabled?: boolean;
	classifierAffectsRunner?: boolean;
	autoEnableWatcherForAsk?: boolean;
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
	decision: DecisionKind | null;
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
