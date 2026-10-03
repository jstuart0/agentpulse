/**
 * Shared assertion for the Claude Code HTTP hooks an installer wrote: every
 * event's hook carries the skip header with its value left as the literal
 * text `$AGENTPULSE_SKIP` (Claude Code expands it when the hook fires; an
 * installer that expanded it at install time would freeze one value into the
 * file), and `allowedEnvVars` lists exactly the variables the headers use.
 */
import { expect } from "bun:test";

interface HttpHook {
	type?: string;
	url?: string;
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
}

export const CLAUDE_EVENT_COUNT = 16;

export function expectClaudeHooksCarrySkip(
	settings: { hooks?: Record<string, { hooks?: HttpHook[] }[]> },
	expected: { allowedEnvVars: string[]; authorization?: string },
): void {
	const events = Object.entries(settings.hooks ?? {});
	expect(events.length, "every Claude event is wired").toBe(CLAUDE_EVENT_COUNT);
	for (const [event, entries] of events) {
		const hook = entries[0]?.hooks?.[0];
		expect(hook?.type, `${event}: an HTTP hook`).toBe("http");
		expect(
			hook?.headers?.["X-AgentPulse-Skip"],
			`${event}: the header value is the literal variable`,
		).toBe("$AGENTPULSE_SKIP");
		expect(hook?.allowedEnvVars, `${event}: allowedEnvVars`).toEqual(expected.allowedEnvVars);
		expect(hook?.headers?.["X-Agent-Type"], `${event}: agent type`).toBe("claude_code");
		if (expected.authorization !== undefined) {
			expect(hook?.headers?.Authorization, `${event}: authorization`).toBe(expected.authorization);
		}
	}
}
