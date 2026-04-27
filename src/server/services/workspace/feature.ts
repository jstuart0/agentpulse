import { inArray } from "drizzle-orm";
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

export interface WorkspaceSettings {
	defaultRoot: string;
	templateClaudeMd: string;
	gitInit: boolean;
}

export interface WorkspaceSettingsUpdate {
	defaultRoot?: string;
	templateClaudeMd?: string;
	gitInit?: boolean;
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

/** Read all three workspace settings, falling back to defaults. */
export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
	const rows = await db
		.select()
		.from(settings)
		.where(
			inArray(settings.key, [
				WORKSPACE_DEFAULT_ROOT_KEY,
				WORKSPACE_TEMPLATE_CLAUDE_MD_KEY,
				WORKSPACE_GIT_INIT_KEY,
			]),
		);
	const map = new Map<string, unknown>();
	for (const row of rows) map.set(row.key, row.value);

	const root = map.get(WORKSPACE_DEFAULT_ROOT_KEY);
	const tmpl = map.get(WORKSPACE_TEMPLATE_CLAUDE_MD_KEY);
	const gitInit = map.get(WORKSPACE_GIT_INIT_KEY);

	return {
		defaultRoot: typeof root === "string" ? root : DEFAULT_WORKSPACE_ROOT,
		templateClaudeMd: typeof tmpl === "string" ? tmpl : DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD,
		gitInit: typeof gitInit === "boolean" ? gitInit : DEFAULT_WORKSPACE_GIT_INIT,
	};
}

/**
 * Upsert the subset of workspace settings that the caller provided.
 * Validation happens here so the route handler stays thin and the same
 * rules cover any other future caller (e.g. config import).
 */
export async function setWorkspaceSettings(
	update: WorkspaceSettingsUpdate,
): Promise<WorkspaceSettings> {
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

	return getWorkspaceSettings();
}

/** Thrown by setWorkspaceSettings when the caller passes invalid input. */
export class WorkspaceValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceValidationError";
	}
}
