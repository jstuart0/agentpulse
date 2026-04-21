import type { Session, SessionEvent } from "../../../shared/types.js";

/**
 * Build a Markdown export of a session's timeline for copy/paste. Pure
 * function — lives with the other session-detail helpers so the page
 * component stays focused on orchestration.
 */
export function buildExportMarkdown(
	displayName: string,
	session: Session,
	allEvents: SessionEvent[],
): string {
	const transcript = allEvents
		.map((event) => {
			if (event.category === "prompt" && event.content) {
				return `## Prompt\n\n${event.content}`;
			}
			if (event.category === "assistant_message" && event.content) {
				return `## Response\n\n${event.content}`;
			}
			if (
				(event.category === "progress_update" ||
					event.category === "plan_update" ||
					event.category === "status_update") &&
				event.content
			) {
				return `## Progress\n\n${event.content}`;
			}
			return null;
		})
		.filter(Boolean)
		.join("\n\n");

	return `# ${displayName}

**Project:** ${session.cwd}
**Agent:** ${session.agentType}
**Started:** ${session.startedAt}
**Tools:** ${session.totalToolUses}
${session.gitBranch ? `**Branch:** ${session.gitBranch}\n` : ""}${
	session.notes
		? `## Notes

${session.notes}

`
		: ""
}${
	transcript
		? `## Timeline

${transcript}
`
		: ""
}`;
}
