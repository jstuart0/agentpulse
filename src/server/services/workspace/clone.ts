import type { PrelaunchAction } from "../../../shared/types.js";
import { slugifyTaskName } from "../name-generator.js";
import type { GitCloneSettings, WorkspaceSettings } from "./feature.js";
import { WorkspaceCollisionExhaustedError, WorkspacePathValidationError } from "./scaffold.js";

export type CloneRepoPrelaunchAction = Extract<PrelaunchAction, { kind: "clone_repo" }>;

export interface CloneRepoInput {
	url: string;
	branch?: string;
	taskSlug?: string;
	taskSummary?: string;
	workspaceSettings: WorkspaceSettings & { gitClone: GitCloneSettings };
	collidingPaths?: Set<string>;
	explicitPath?: string;
}

export interface CloneRepoResult {
	resolvedPath: string;
	prelaunchActions: CloneRepoPrelaunchAction[];
}

const MAX_SUFFIX_ATTEMPTS = 10;
// Org-prefixing threshold: only the very-short basenames (`x`, `ai`) get
// the org prefix, where the basename alone reads ambiguously. Three-char
// names (`bar`, `git`) are kept as-is.
const SHORT_REPO_BASENAME_THRESHOLD = 2;
const SCP_LIKE = /^[\w.-]+@[\w.-]+:[\w./~-]+$/;

function joinRootAndSlug(root: string, slug: string): string {
	return root.endsWith("/") ? `${root}${slug}` : `${root}/${slug}`;
}

/**
 * Server-side URL policy (plan §12.2 / §12.6). Pure: throws on violation,
 * does no I/O. The supervisor revalidates at execute time — this is the
 * single point of policy enforcement; the supervisor sees only allowed
 * schemes by construction.
 *
 * Error messages must NOT echo the URL when credentials are embedded —
 * the password would leak into logs / DB rows / telemetry. The plan
 * mandates a sanitized message and a dedicated leak-prevention test
 * (§12.2 / §12.11).
 */
export function validateCloneUrlPolicy(url: unknown, settings: GitCloneSettings): void {
	if (typeof url !== "string" || url.trim().length === 0) {
		throw new WorkspacePathValidationError("clone_url_invalid", "Clone URL is empty.");
	}
	const trimmed = url.trim();

	if (SCP_LIKE.test(trimmed)) {
		if (!settings.allowSshUrls) {
			throw new WorkspacePathValidationError(
				"clone_scheme_disallowed",
				"SSH-style URLs (git@host:path) are disabled. Enable git_clone.allow_ssh_urls in Settings to permit them.",
			);
		}
		return;
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new WorkspacePathValidationError(
			"clone_url_invalid",
			"That URL doesn't parse as a git repository URL.",
		);
	}

	const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();

	if (scheme === "https" || scheme === "http") {
		// Reject URLs with embedded credentials — and never echo the URL
		// (would leak the password into the error and any downstream log).
		// SSH URLs carry usernames as a transport convention (`ssh://git@…`)
		// not as auth tokens, so we don't apply this check there.
		if (parsed.username !== "" || parsed.password !== "") {
			throw new WorkspacePathValidationError(
				"clone_credentials_in_url",
				"That URL contains embedded credentials. Use SSH (after enabling allow_ssh_urls) or configure a git credential helper on the supervisor host.",
			);
		}
		return;
	}

	if (scheme === "ssh") {
		if (!settings.allowSshUrls) {
			throw new WorkspacePathValidationError(
				"clone_scheme_disallowed",
				"SSH URLs are disabled. Enable git_clone.allow_ssh_urls in Settings to permit them.",
			);
		}
		return;
	}

	if (scheme === "file") {
		if (!settings.allowLocalUrls) {
			throw new WorkspacePathValidationError(
				"clone_scheme_disallowed",
				"file:// URLs are disabled. Enable git_clone.allow_local_urls in Settings to permit them.",
			);
		}
		return;
	}

	throw new WorkspacePathValidationError(
		"clone_scheme_disallowed",
		`Scheme "${scheme}" is not a supported git transport.`,
	);
}

/**
 * Canonicalize a clone URL for emission into the prelaunch action.
 * Strips trailing slashes and lowercases the host. The path component
 * keeps its case (some git hosts are path-case-sensitive). For SCP-style
 * (`git@host:path`) we don't reshape — those don't have URL semantics
 * we can rely on parsing without ambiguity (plan §12.11).
 *
 * Note: `.git` suffix is intentionally NOT stripped here. That's the
 * supervisor's idempotency check at step 8 (§12.5) — the canonical clone
 * command should run with whatever the user provided.
 */
function canonicalizeUrl(url: string): string {
	const trimmed = url.trim();
	if (SCP_LIKE.test(trimmed)) return trimmed;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return trimmed;
	}
	parsed.hostname = parsed.hostname.toLowerCase();
	let serialized = parsed.toString();
	// URL.toString() preserves a single trailing slash on bare-host URLs;
	// strip a trailing slash on the *path* component so the equality
	// comparison treats `https://host/foo/bar/` and `https://host/foo/bar`
	// as equal. Don't strip when the path itself is just `/` — that's the
	// canonical bare-host form.
	if (parsed.pathname !== "/" && serialized.endsWith("/")) {
		serialized = serialized.replace(/\/+$/, "");
	}
	return serialized;
}

/**
 * Pull the repo basename out of the URL. `https://github.com/foo/bar.git`
 * → `bar`. For SCP-style (`git@host:owner/repo.git`) we look at everything
 * after the colon. Falls back to "" for inputs we can't make sense of.
 */
function repoBasenameFromUrl(url: string): { basename: string; owner: string } {
	const trimmed = url.trim();
	let pathPart = "";
	if (SCP_LIKE.test(trimmed)) {
		const colon = trimmed.indexOf(":");
		pathPart = trimmed.slice(colon + 1);
	} else {
		try {
			pathPart = new URL(trimmed).pathname;
		} catch {
			return { basename: "", owner: "" };
		}
	}
	const segs = pathPart.split("/").filter((s) => s.length > 0);
	if (segs.length === 0) return { basename: "", owner: "" };
	const last = segs[segs.length - 1].replace(/\.git$/i, "");
	const owner = segs.length >= 2 ? segs[segs.length - 2] : "";
	return { basename: last, owner };
}

/**
 * Pure: compute the resolved clone path and the prelaunchActions the
 * supervisor must execute to bring it into existence. Mirrors
 * scaffoldWorkArea — no fs, no `~` expansion, no I/O.
 *
 * URL validation runs server-side (this helper); the supervisor
 * revalidates per §12.4. Collision suffixing uses the projects-table
 * snapshot supplied by the caller; the supervisor's idempotency check
 * (§12.5 step 8) is the safety net for filesystem state we can't see.
 */
export async function cloneRepo(input: CloneRepoInput): Promise<CloneRepoResult> {
	const { workspaceSettings, collidingPaths, explicitPath } = input;
	const gitClone = workspaceSettings.gitClone;

	validateCloneUrlPolicy(input.url, gitClone);
	const canonicalUrl = canonicalizeUrl(input.url);

	const slug = deriveTaskSlug(input);

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
		resolvedPath = trimmed.replace(/\/+$/, "");
	} else {
		const colliding = collidingPaths ?? new Set<string>();
		const base = joinRootAndSlug(workspaceSettings.defaultRoot, slug);
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

	// Conservative: don't seed a CLAUDE.md into a clone in v1. Most repos
	// ship their own; the plan calls overwriting "anti-guest" (§12.1).
	// When 6c lands, the supervisor's skip-if-exists check is the second
	// line of defence, but we don't want to ask the supervisor to write a
	// file the repo will already provide.
	const action: CloneRepoPrelaunchAction = {
		kind: "clone_repo",
		url: canonicalUrl,
		intoPath: resolvedPath,
		// `--depth` is meaningful only when fetching a single tip. When the
		// caller explicitly asked for a branch they almost always need full
		// history of that branch, so we suppress the default-depth in that
		// case (plan §12.6 step 4).
		...(input.branch !== undefined ? { branch: input.branch } : {}),
		...(input.branch === undefined && gitClone.defaultDepth != null
			? { depth: gitClone.defaultDepth }
			: {}),
		timeoutSeconds: gitClone.timeoutSeconds,
	};

	return {
		resolvedPath,
		prelaunchActions: [action],
	};
}

function deriveTaskSlug(input: CloneRepoInput): string {
	if (input.taskSlug && input.taskSlug.trim().length > 0) return input.taskSlug.trim();
	const { basename, owner } = repoBasenameFromUrl(input.url);
	if (basename.length === 0) return slugifyTaskName(input.taskSummary ?? "") || "clone";
	const prefixed =
		basename.length <= SHORT_REPO_BASENAME_THRESHOLD && owner.length > 0
			? `${owner}-${basename}`
			: basename;
	const slug = slugifyTaskName(prefixed);
	return slug.length > 0 ? slug : "clone";
}
