import type { PrelaunchAction } from "../../../shared/types.js";
import type { WorkspaceSettings } from "./feature.js";

export interface ScaffoldWorkAreaInput {
	taskSlug: string;
	taskSummary?: string;
	workspaceSettings: WorkspaceSettings;
	collidingPaths?: Set<string>;
	// Slice 5d: when the user types a custom path in the workspace
	// confirmation step, the disambiguation handler re-invokes scaffoldWorkArea
	// with the explicit path. The default-root composition is bypassed but the
	// CLAUDE.md template, sha256, and gitInit flag still come from settings —
	// the user is overriding *where*, not *what*.
	//
	// Validation: must be absolute (starts with `/` or `~/`) and must not
	// contain `..` segments. Callers should pre-validate; this helper performs
	// the same checks defensively and throws on violation.
	explicitPath?: string;
}

export type WorkspacePathValidationCode =
	| "path_not_absolute"
	| "path_traversal_rejected"
	// Slice 6b: clone-URL policy codes. Reused on the supervisor side
	// (PrelaunchErrorCode) once 6c lands; defining them here keeps the
	// server-side helper's error surface in one place.
	| "clone_url_invalid"
	| "clone_scheme_disallowed"
	| "clone_credentials_in_url";

export class WorkspacePathValidationError extends Error {
	constructor(
		public readonly code: WorkspacePathValidationCode,
		message: string,
	) {
		super(message);
		this.name = "WorkspacePathValidationError";
	}
}

export type ScaffoldPrelaunchAction = Extract<PrelaunchAction, { kind: "scaffold_workarea" }>;

export interface ScaffoldWorkAreaResult {
	resolvedPath: string;
	prelaunchActions: ScaffoldPrelaunchAction[];
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
export function applyTemplateTokens(template: string, tokens: Record<string, string>): string {
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
	const { taskSlug, taskSummary, workspaceSettings, collidingPaths, explicitPath } = input;
	const colliding = collidingPaths ?? new Set<string>();

	let resolvedPath: string;
	if (explicitPath !== undefined) {
		const trimmed = explicitPath.trim();
		if (!(trimmed.startsWith("/") || trimmed.startsWith("~/"))) {
			throw new WorkspacePathValidationError(
				"path_not_absolute",
				"Path must be absolute (start with / or ~/).",
			);
		}
		if (trimmed.split("/").some((seg) => seg === "..")) {
			throw new WorkspacePathValidationError(
				"path_traversal_rejected",
				"Path can't contain `..` segments.",
			);
		}
		// Trim trailing slashes for stable equality comparisons against
		// project rows. (We don't normalize beyond that — the supervisor
		// owns expansion and realpath resolution.)
		resolvedPath = trimmed.replace(/\/+$/, "");
	} else {
		const base = joinRootAndSlug(workspaceSettings.defaultRoot, taskSlug);
		resolvedPath = base;
		let attempt = 1;
		while (colliding.has(resolvedPath)) {
			attempt += 1;
			if (attempt > MAX_SUFFIX_ATTEMPTS) {
				throw new WorkspaceCollisionExhaustedError(base);
			}
			resolvedPath = `${base}-${attempt}`;
		}
	}

	const tokens: Record<string, string> = {
		taskSlug,
		taskSummary: taskSummary ?? "",
	};

	const renderedTemplate = applyTemplateTokens(workspaceSettings.templateClaudeMd, tokens);
	const contentSha = await sha256(renderedTemplate);

	const action: ScaffoldPrelaunchAction = {
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
