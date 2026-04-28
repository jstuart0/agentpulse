import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";

// Settings keys for the scratch-workspace feature (Slice 5 of the AI
// task-initiated launches plan — see thoughts/plans/2026-04-27-ai-task-
// initiated-launches.md §10.4 / §11.3). Slice 5a stores raw values; the
// substitution and scaffolding happen in 5b.
export const WORKSPACE_DEFAULT_ROOT_KEY = "workspace.default_root";
export const WORKSPACE_TEMPLATE_CLAUDE_MD_KEY = "workspace.template_claude_md";
export const WORKSPACE_GIT_INIT_KEY = "workspace.git_init";

export const DEFAULT_WORKSPACE_ROOT = "~/agentpulse-work";
export const DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD =
	"This is a scratch workspace for {{taskSummary}}. Be cautious about side effects beyond this directory.";
export const DEFAULT_WORKSPACE_GIT_INIT = false;

// Settings keys for AI-initiated git clones (Slice 6a of the same plan
// — see §12.2 / §12.7). The values are read by the cloneRepo helper in
// Slice 6b; 6a only persists them.
export const GIT_CLONE_ALLOW_SSH_URLS_KEY = "git_clone.allow_ssh_urls";
export const GIT_CLONE_ALLOW_LOCAL_URLS_KEY = "git_clone.allow_local_urls";
export const GIT_CLONE_DEFAULT_DEPTH_KEY = "git_clone.default_depth";
export const GIT_CLONE_TIMEOUT_SECONDS_KEY = "git_clone.timeout_seconds";

export const DEFAULT_GIT_CLONE_ALLOW_SSH_URLS = false;
export const DEFAULT_GIT_CLONE_ALLOW_LOCAL_URLS = false;
export const DEFAULT_GIT_CLONE_DEFAULT_DEPTH: number | null = null;
export const DEFAULT_GIT_CLONE_TIMEOUT_SECONDS = 300;

// Service-level bounds for the clone timeout. The supervisor will clamp
// further if it has to (the plan keeps the supervisor's upper bound at
// 1800), but the surface UI accepts up to one hour so we don't reject
// what's saved if the supervisor later raises its own ceiling.
export const GIT_CLONE_TIMEOUT_MIN_SECONDS = 30;
export const GIT_CLONE_TIMEOUT_MAX_SECONDS = 3600;

export interface WorkspaceSettings {
	defaultRoot: string;
	templateClaudeMd: string;
	gitInit: boolean;
}

export interface GitCloneSettings {
	allowSshUrls: boolean;
	allowLocalUrls: boolean;
	defaultDepth: number | null;
	timeoutSeconds: number;
}

export interface WorkspaceSettingsUpdate {
	defaultRoot?: string;
	templateClaudeMd?: string;
	gitInit?: boolean;
	gitClone?: GitCloneSettingsUpdate;
}

export interface GitCloneSettingsUpdate {
	allowSshUrls?: boolean;
	allowLocalUrls?: boolean;
	defaultDepth?: number | null;
	timeoutSeconds?: number;
}

/**
 * Validate a workspace root path. The supervisor expands `~` against
 * its own home, so we accept either an absolute path (`/...`) or a
 * tilde-rooted path (`~/...`). Anything else (relative, bare `~`, blank,
 * or whitespace-only) is rejected.
 */
export function validateWorkspaceRoot(value: unknown): {
	ok: boolean;
	error?: string;
} {
	if (typeof value !== "string") {
		return { ok: false, error: "default_root must be a string" };
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return { ok: false, error: "default_root must not be empty" };
	}
	if (!(trimmed.startsWith("/") || trimmed.startsWith("~/"))) {
		return { ok: false, error: "default_root must start with / or ~/" };
	}
	return { ok: true };
}

/** Read all workspace + git-clone settings, falling back to defaults. */
export async function getWorkspaceSettings(): Promise<{
	workspace: WorkspaceSettings;
	gitClone: GitCloneSettings;
}> {
	const rows = await db
		.select()
		.from(settings)
		.where(
			inArray(settings.key, [
				WORKSPACE_DEFAULT_ROOT_KEY,
				WORKSPACE_TEMPLATE_CLAUDE_MD_KEY,
				WORKSPACE_GIT_INIT_KEY,
				GIT_CLONE_ALLOW_SSH_URLS_KEY,
				GIT_CLONE_ALLOW_LOCAL_URLS_KEY,
				GIT_CLONE_DEFAULT_DEPTH_KEY,
				GIT_CLONE_TIMEOUT_SECONDS_KEY,
			]),
		);
	const map = new Map<string, unknown>();
	for (const row of rows) map.set(row.key, row.value);

	const root = map.get(WORKSPACE_DEFAULT_ROOT_KEY);
	const tmpl = map.get(WORKSPACE_TEMPLATE_CLAUDE_MD_KEY);
	const gitInit = map.get(WORKSPACE_GIT_INIT_KEY);

	const allowSsh = map.get(GIT_CLONE_ALLOW_SSH_URLS_KEY);
	const allowLocal = map.get(GIT_CLONE_ALLOW_LOCAL_URLS_KEY);
	const defaultDepth = map.get(GIT_CLONE_DEFAULT_DEPTH_KEY);
	const timeoutSeconds = map.get(GIT_CLONE_TIMEOUT_SECONDS_KEY);

	return {
		workspace: {
			defaultRoot: typeof root === "string" ? root : DEFAULT_WORKSPACE_ROOT,
			templateClaudeMd: typeof tmpl === "string" ? tmpl : DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD,
			gitInit: typeof gitInit === "boolean" ? gitInit : DEFAULT_WORKSPACE_GIT_INIT,
		},
		gitClone: {
			allowSshUrls: typeof allowSsh === "boolean" ? allowSsh : DEFAULT_GIT_CLONE_ALLOW_SSH_URLS,
			allowLocalUrls:
				typeof allowLocal === "boolean" ? allowLocal : DEFAULT_GIT_CLONE_ALLOW_LOCAL_URLS,
			defaultDepth: isStoredDepth(defaultDepth) ? defaultDepth : DEFAULT_GIT_CLONE_DEFAULT_DEPTH,
			timeoutSeconds:
				typeof timeoutSeconds === "number" && Number.isInteger(timeoutSeconds)
					? timeoutSeconds
					: DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
		},
	};
}

function isStoredDepth(value: unknown): value is number | null {
	if (value === null) return true;
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Upsert the subset of workspace + git-clone settings the caller provided.
 * Validation happens here so the route handler stays thin and the same
 * rules cover any other future caller (e.g. the cloneRepo helper in
 * Slice 6b).
 */
export async function setWorkspaceSettings(update: WorkspaceSettingsUpdate): Promise<{
	workspace: WorkspaceSettings;
	gitClone: GitCloneSettings;
}> {
	const now = new Date().toISOString();

	const upsert = async (key: string, value: unknown) => {
		await db
			.insert(settings)
			.values({ key, value, updatedAt: now })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value, updatedAt: now },
			});
	};

	if (update.defaultRoot !== undefined) {
		const v = validateWorkspaceRoot(update.defaultRoot);
		if (!v.ok) {
			throw new WorkspaceValidationError(v.error ?? "invalid default_root");
		}
		await upsert(WORKSPACE_DEFAULT_ROOT_KEY, update.defaultRoot.trim());
	}
	if (update.templateClaudeMd !== undefined) {
		if (typeof update.templateClaudeMd !== "string") {
			throw new WorkspaceValidationError("template_claude_md must be a string");
		}
		await upsert(WORKSPACE_TEMPLATE_CLAUDE_MD_KEY, update.templateClaudeMd);
	}
	if (update.gitInit !== undefined) {
		if (typeof update.gitInit !== "boolean") {
			throw new WorkspaceValidationError("git_init must be a boolean");
		}
		await upsert(WORKSPACE_GIT_INIT_KEY, update.gitInit);
	}

	if (update.gitClone !== undefined) {
		const gc = update.gitClone;
		if (gc.allowSshUrls !== undefined) {
			if (typeof gc.allowSshUrls !== "boolean") {
				throw new WorkspaceValidationError("git_clone.allow_ssh_urls must be a boolean");
			}
			await upsert(GIT_CLONE_ALLOW_SSH_URLS_KEY, gc.allowSshUrls);
		}
		if (gc.allowLocalUrls !== undefined) {
			if (typeof gc.allowLocalUrls !== "boolean") {
				throw new WorkspaceValidationError("git_clone.allow_local_urls must be a boolean");
			}
			await upsert(GIT_CLONE_ALLOW_LOCAL_URLS_KEY, gc.allowLocalUrls);
		}
		if (gc.defaultDepth !== undefined) {
			if (gc.defaultDepth !== null) {
				if (
					typeof gc.defaultDepth !== "number" ||
					!Number.isInteger(gc.defaultDepth) ||
					gc.defaultDepth <= 0
				) {
					throw new WorkspaceValidationError(
						"git_clone.default_depth must be null or a positive integer",
					);
				}
				await upsert(GIT_CLONE_DEFAULT_DEPTH_KEY, gc.defaultDepth);
			} else {
				// Persisting JSON null in the settings table fails the NOT NULL
				// constraint. The "no row" state is the canonical "full clone"
				// representation — getWorkspaceSettings() falls back to the
				// DEFAULT_GIT_CLONE_DEFAULT_DEPTH (null) when the key is absent.
				await db.delete(settings).where(eq(settings.key, GIT_CLONE_DEFAULT_DEPTH_KEY)).execute();
			}
		}
		if (gc.timeoutSeconds !== undefined) {
			if (
				typeof gc.timeoutSeconds !== "number" ||
				!Number.isInteger(gc.timeoutSeconds) ||
				gc.timeoutSeconds < GIT_CLONE_TIMEOUT_MIN_SECONDS ||
				gc.timeoutSeconds > GIT_CLONE_TIMEOUT_MAX_SECONDS
			) {
				throw new WorkspaceValidationError(
					`git_clone.timeout_seconds must be an integer between ${GIT_CLONE_TIMEOUT_MIN_SECONDS} and ${GIT_CLONE_TIMEOUT_MAX_SECONDS}`,
				);
			}
			await upsert(GIT_CLONE_TIMEOUT_SECONDS_KEY, gc.timeoutSeconds);
		}
	}

	return getWorkspaceSettings();
}

/** Thrown by setWorkspaceSettings when the caller passes invalid input. */
export class WorkspaceValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceValidationError";
	}
}
