import type { PrelaunchAction } from "../../../shared/types.js";
import type { WorkspaceSettings } from "./feature.js";

export interface ScaffoldWorkAreaInput {
	taskSlug: string;
	taskSummary?: string;
	workspaceSettings: WorkspaceSettings;
	collidingPaths?: Set<string>;
}

export interface ScaffoldWorkAreaResult {
	resolvedPath: string;
	prelaunchActions: PrelaunchAction[];
}

const MAX_SUFFIX_ATTEMPTS = 10;

/** Thrown by scaffoldWorkArea when collision suffixing exhausts the cap. */
export class WorkspaceCollisionExhaustedError extends Error {
	constructor(public readonly base: string) {
		super(
			`Could not pick a unique workspace path within ${MAX_SUFFIX_ATTEMPTS} attempts (base: ${base}).`,
		);
		this.name = "WorkspaceCollisionExhaustedError";
	}
}

/**
 * Plain `{{key}}` substitution. Unknown tokens are left as-is so users can
 * write literal `{{foo}}` in templates without escaping. Strict by design —
 * no defaults, no helpers, no nested expressions.
 */
export function applyTemplateTokens(
	template: string,
	tokens: Record<string, string>,
): string {
	return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
		return Object.hasOwn(tokens, key) ? tokens[key] : match;
	});
}

/** Lowercase hex SHA-256 of the supplied UTF-8 string. */
export async function sha256(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function joinRootAndSlug(root: string, slug: string): string {
	return root.endsWith("/") ? `${root}${slug}` : `${root}/${slug}`;
}

/**
 * Pure: compute the resolved scratch-workspace path and the prelaunchActions
 * the supervisor must execute to bring it into existence. Does NOT touch the
 * filesystem and does NOT expand `~` — different machines have different
 * homes, and the supervisor expands tilde paths at execute time (bob §10.4).
 *
 * Collision suffixing uses the projects-table snapshot supplied by the
 * caller. The supervisor's own `path_not_empty` check is the safety net for
 * filesystem state the server cannot see.
 */
export async function scaffoldWorkArea(
	input: ScaffoldWorkAreaInput,
): Promise<ScaffoldWorkAreaResult> {
	const { taskSlug, taskSummary, workspaceSettings, collidingPaths } = input;
	const colliding = collidingPaths ?? new Set<string>();

	const base = joinRootAndSlug(workspaceSettings.defaultRoot, taskSlug);
	let resolvedPath = base;
	let attempt = 1;
	while (colliding.has(resolvedPath)) {
		attempt += 1;
		if (attempt > MAX_SUFFIX_ATTEMPTS) {
			throw new WorkspaceCollisionExhaustedError(base);
		}
		resolvedPath = `${base}-${attempt}`;
	}

	const tokens: Record<string, string> = {
		taskSlug,
		taskSummary: taskSummary ?? "",
	};

	const renderedTemplate = applyTemplateTokens(workspaceSettings.templateClaudeMd, tokens);
	const contentSha = await sha256(renderedTemplate);

	const action: PrelaunchAction = {
		kind: "scaffold_workarea",
		path: resolvedPath,
		gitInit: workspaceSettings.gitInit,
		seedClaudeMd: {
			content: renderedTemplate,
			path: "CLAUDE.md",
			sha256: contentSha,
		},
	};

	return {
		resolvedPath,
		prelaunchActions: [action],
	};
}
