/**
 * Schema-orphan interface types (Decision 29 / librarian Item 3).
 *
 * These are pure TypeScript interfaces consumed via .$type<…>() in column
 * definitions. They are not table definitions and are not dialect-specific.
 * Moved here from src/server/db/schema.ts:649-771 in Phase 2a.
 */

// ProjectDraftFields — partial record collected turn-by-turn during
// AI-driven "add project" flows. Required fields: name, cwd.
export interface ProjectDraftFields {
	name?: string;
	cwd?: string;
	defaultAgentType?: string | null;
	defaultModel?: string | null;
	defaultLaunchMode?: string | null;
	githubRepoUrl?: string | null;
}

// NextQuestion — which field we're currently collecting and how many
// failed parse attempts have occurred (max 3 before draft expires).
export interface NextQuestion {
	field: keyof ProjectDraftFields;
	prompt: string;
	retryCount: number;
}

// ProjectChoiceSnapshot — a resolved project option shown during launch
// disambiguation (one entry per candidate project).
export interface ProjectChoiceSnapshot {
	id: string;
	name: string;
	cwd: string;
}

// Workspace-scaffold pending state — populated when the user types `new`
// and we've computed the proposed path + prelaunchActions but the user
// hasn't yet confirmed. Slice 5d of the AI task-initiated launches plan.
export interface PendingWorkspaceScaffold {
	taskSlug: string;
	resolvedPath: string;
	// JSON-stringified PrelaunchAction[] would force consumers to re-parse;
	// store the array directly. The values match shared/types.ts PrelaunchAction.
	actions: Array<{
		kind: "scaffold_workarea";
		path: string;
		gitInit?: boolean;
		seedClaudeMd?: { content: string; path: string; sha256: string };
	}>;
	// Optional supervisor host name for "I'll create on macbook" attribution.
	suggestedHost?: string;
}

// Workspace-clone pending state — populated when the classifier emitted a
// `cloneSpec` and we've computed the proposed path + prelaunchActions but
// the user hasn't yet confirmed. Slice 6d of the AI task-initiated
// launches plan. Mutually exclusive with `pendingScaffold` (a draft has
// at most one of either).
export interface PendingWorkspaceClone {
	taskSlug: string;
	resolvedPath: string;
	url: string;
	branch?: string;
	depth?: number;
	timeoutSeconds: number;
	actions: Array<{
		kind: "clone_repo";
		url: string;
		intoPath: string;
		branch?: string;
		depth?: number;
		timeoutSeconds?: number;
		seedClaudeMd?: { content: string; path: string; sha256: string };
	}>;
	suggestedHost?: string;
}

// LaunchDisambiguationDraftFields — fields stashed when Ask receives a
// launch-flavored message that didn't carry a project name. We keep the
// classifier's full carry-forward state so reconstructing a LaunchIntent
// after the user picks a project doesn't require re-running detection.
export interface LaunchDisambiguationDraftFields {
	originalMessage: string;
	taskHint?: string;
	taskBrief?: { summary: string; outputPath?: string; format?: string };
	displayName?: string;
	agentType?: string;
	mode?: string;
	proposedProjectChoices: ProjectChoiceSnapshot[];
	// Slice 5d: when the user has typed `new` and we've shown the
	// confirmation card, the resolved path + actions are stored here while
	// the draft awaits a confirm/cancel/custom-path reply.
	pendingScaffold?: PendingWorkspaceScaffold;
	// Slice 6d: when the classifier emitted a cloneSpec and we've shown
	// the cloner card, the resolved URL/path/actions are stored here while
	// the draft awaits a confirm/cancel/custom-path/edit-options reply.
	pendingClone?: PendingWorkspaceClone;
}
