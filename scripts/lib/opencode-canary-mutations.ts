/**
 * The breaks the OpenCode canary applies to the filled plugin text (AGEN-141, plan step 20/31) to prove its own
 * scenarios can fail. Each break is a list of exact-text replacements per line; every anchor must occur exactly
 * once in the text it is applied to (scripts/opencode-canary-anchors.test.ts holds that and that the mutated text
 * still loads). Each break names the ONE expectation of one scenario that must then fail.
 */
import type { MutationTarget } from "./canary-verdict.ts";

export type Line = "v1" | "v2";
export interface Replacement {
	anchor: string;
	replace: string;
}

const AWAIT_POST =
	'return apFetch()(AP_CONFIG.baseUrl + "/api/v1/hooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2000) }).catch(() => {});';

export const MUTATIONS: Record<string, Record<Line, Replacement[]>> = {
	// The tool hook returns a promise that settles when a slow POST does: OpenCode waits for it.
	"await-post": {
		v1: [
			{
				anchor: '{ key: tuid + "|before" },\n\t\t\t\t);',
				replace: `{ key: tuid + "|before" },\n\t\t\t\t);\n\t\t\t\t${AWAIT_POST}`,
			},
		],
		v2: [
			{
				anchor: '{ key: tuid + "|before" },\n\t\t\t);\n\t\t}',
				replace: `{ key: tuid + "|before" },\n\t\t\t);\n\t\t\t${AWAIT_POST}\n\t\t}`,
			},
			{ anchor: "toolBefore(event);", replace: "return toolBefore(event);" },
		],
	},
	// The tool hook throws: OpenCode fails the call.
	"throw-in-tool-hook": {
		v1: [
			{
				anchor: '"tool.execute.before": (input, output) => {\n\t\t\ttry {',
				replace:
					'"tool.execute.before": (input, output) => {\n\t\t\tthrow new Error("mutation: a tool hook that throws");\n\t\t\ttry {',
			},
		],
		v2: [
			{
				anchor:
					"try {\n\t\t\t\t\ttoolBefore(event);\n\t\t\t\t} catch {\n\t\t\t\t\tswallow(rec);\n\t\t\t\t}",
				replace: 'throw new Error("mutation: a tool hook that throws");',
			},
		],
	},
};

/** Which expectation of which scenario each break must make fail. */
export const MUTATION_TARGETS: Record<string, MutationTarget[]> = {
	"await-post": [{ scenario: "stall", expectation: "the tool hook does not wait for the server" }],
	"throw-in-tool-hook": [
		{ scenario: "tool", expectation: "the tool call succeeds and is reported once" },
	],
};

export function applyMutation(name: string, line: Line, text: string): string {
	const entry = MUTATIONS[name];
	if (!entry) throw new Error(`unknown mutation ${name}`);
	let out = text;
	for (const { anchor, replace } of entry[line]) {
		const count = out.split(anchor).length - 1;
		if (count !== 1)
			throw new Error(`mutation ${name} (${line}): anchor occurs ${count} times: ${anchor}`);
		out = out.replace(anchor, () => replace);
	}
	return out;
}
