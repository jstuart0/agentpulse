/**
 * The breaks the OpenCode canary applies to the filled plugin text (AGEN-141, plan step 20/31) to prove its own
 * scenarios can fail. Each break is a list of exact-text replacements per line; every anchor must occur exactly
 * once in the text it is applied to (scripts/opencode-canary-anchors.test.ts holds that and that the mutated text
 * still loads). Each break names the ONE expectation of one scenario that must then fail.
 */
import type { MutationTarget } from "./canary-verdict.ts";

export type Line = "v1" | "v2";

/** Files, in the place's HOME, that two breaks write so a scenario can show the break had something to break. */
export const SEEN_LOG = "ap-mutation-seen.log";
export const QUEUE_LOG = "ap-mutation-queue.log";
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
	// The seen-set: one `evt_` id reaches every instance of a V2 service, and each forwards what it can't place.
	"no-seen-set": {
		v1: [],
		v2: [
			{
				anchor:
					"if (item.evt !== undefined && claimEvent(rec, item.evt)) {\n\t\trec.counters.droppedSeen += 1;\n\t\treturn;\n\t}\n\tlet delivered = false;",
				// The set still records, and a hit is written to a file instead of dropping the item: that file is the
				// scenario's proof that two instances really forwarded one event (its precondition).
				replace: `if (item.evt !== undefined && claimEvent(rec, item.evt)) {\n\t\ttry {\n\t\t\tfs.appendFileSync(path.join(homeDir() || "/", "${SEEN_LOG}"), item.sid + " " + item.evt + "\\n");\n\t\t} catch {}\n\t}\n\tlet delivered = false;`,
			},
		],
	},
	// One chain per instance instead of one per session: two instances forwarding one session no longer queue behind each other.
	"per-instance-queue": {
		v1: [],
		v2: [
			{
				anchor: "rec.instances += 1;\n\t\thookExit(rec);\n\n\t\tfunction emit",
				replace:
					"rec.instances += 1;\n\t\thookExit(rec);\n\t\tconst instRec = Object.assign(Object.create(rec), { sessions: new Map() });\n\t\tconst instId = Math.random().toString(36).slice(2);\n\n\t\tfunction emit",
			},
			{
				anchor: "enqueue(rec, stateOf(rec, root), env, {",
				// Which instance forwarded which session goes to a file: the scenario's proof that two chains served one session.
				replace: `try {\n\t\t\t\tfs.appendFileSync(path.join(homeDir() || "/", "${QUEUE_LOG}"), sid + " " + instId + "\\n");\n\t\t\t} catch {}\n\t\t\tenqueue(rec, stateOf(instRec, root), env, {`,
			},
		],
	},
	// No claimant check: a session's first instance no longer decides who forwards it.
	"no-claim": {
		v1: [],
		v2: [
			{
				anchor:
					'const claimant = rec.claims.get(sid);\n\t\t\tif (claimant !== undefined) return claimant === myDir ? "yes" : "no";',
				replace: "",
			},
		],
	},
	// The instance's own directory stands in for the directory the bus event names.
	"ctx-dir-for-bus": {
		v1: [],
		v2: [
			{
				anchor: "const evDir = plainText(ev.location && ev.location.directory, 4096);",
				replace: "const evDir = myDir;",
			},
			{
				anchor:
					"const dir = plainText(\n\t\t\t\t\t\t(data.location && data.location.directory) || (ev.location && ev.location.directory),\n\t\t\t\t\t\t4096,\n\t\t\t\t\t);",
				replace: "const dir = myDir;",
			},
		],
	},
	// The exclude gate is skipped in the send chain.
	"no-gate": {
		v1: [{ anchor: "const send = await judge(rec, item.dirs[i]);", replace: "const send = true;" }],
		v2: [{ anchor: "const send = await judge(rec, item.dirs[i]);", replace: "const send = true;" }],
	},
	// 1.x: the after hook emits at once instead of holding its data until the part settles.
	"no-terminal-hold": {
		v1: [
			{
				anchor:
					'entry.pending = data;\n\t\t\t\tif (entry.partStatus === "completed") {\n\t\t\t\t\tfinishCall(sid, callID, entry, "completed");\n\t\t\t\t\treturn;\n\t\t\t\t}',
				replace:
					'entry.pending = data;\n\t\t\t\tfinishCall(sid, callID, entry, "completed");\n\t\t\t\treturn;',
			},
		],
		v2: [],
	},
	// A reply carries its own id instead of the ask's tool-use id.
	"no-perm-link": {
		v1: [
			{
				anchor: 'const tuid = st.perms.get(per) || "perm:" + per;\n\t\t\t\tconst reply',
				replace: 'const tuid = "perm:" + per;\n\t\t\t\tconst reply',
			},
		],
		v2: [
			{
				anchor: 'tool_use_id: st.perms.get(per) || "perm:" + per, reply: reply',
				replace: 'tool_use_id: "perm:" + per, reply: reply',
			},
		],
	},
};

/** The lines a break applies to (the others have nothing to break); absent means both. */
export const MUTATION_LINES: Record<string, Line[]> = {
	"no-seen-set": ["v2"],
	"per-instance-queue": ["v2"],
	"no-claim": ["v2"],
	"ctx-dir-for-bus": ["v2"],
	"no-terminal-hold": ["v1"],
	"no-sdk-check": ["v1"],
};

/** Edits to the scratch copy of `setup-hooks.sh`, not to a plugin: the installer's SDK predicate forced true. */
export const SETUP_MUTATIONS: Record<string, Replacement[]> = {
	"no-sdk-check": [
		{
			anchor: 'ap_oc_foreign_plugin_present "$plugins" && foreign=1\n',
			replace: 'ap_oc_foreign_plugin_present "$plugins" && foreign=1\n\tsdk=1\n',
		},
	],
};

/** Which expectation of which scenario each break must make fail. */
export const MUTATION_TARGETS: Record<string, MutationTarget[]> = {
	"await-post": [{ scenario: "stall", expectation: "the tool hook does not wait for the server" }],
	"throw-in-tool-hook": [
		{ scenario: "tool", expectation: "the tool call succeeds and is reported once" },
	],
	"no-seen-set": [
		{ scenario: "multi-project", expectation: "one raw POST reaches the proxy per delivery id" },
	],
	"per-instance-queue": [
		{ scenario: "multi-project", expectation: "each session's events arrive in event order" },
	],
	"no-claim": [
		{
			scenario: "multi-project",
			expectation: "every POST of a project's session carries that project's directory",
		},
	],
	"ctx-dir-for-bus": [
		{
			scenario: "multi-project",
			expectation: "an excluded project sends nothing and the included one does",
		},
	],
	"no-gate": [{ scenario: "exclude", expectation: "an excluded directory sends nothing" }],
	"no-terminal-hold": [
		{ scenario: "tool-fail", expectation: "exactly one terminal row per failed call" },
	],
	"no-perm-link": [
		{ scenario: "permission", expectation: "a rejected ask is cleared by the reply" },
	],
	"no-sdk-check": [
		{ scenario: "v1-cold-skip", expectation: "the installer printed the skip message" },
	],
};

export function applySetupMutation(name: string, text: string): string {
	const entry = SETUP_MUTATIONS[name];
	if (!entry) throw new Error(`unknown setup mutation ${name}`);
	let out = text;
	for (const { anchor, replace } of entry) {
		const count = out.split(anchor).length - 1;
		if (count !== 1)
			throw new Error(`setup mutation ${name}: anchor occurs ${count} times: ${anchor}`);
		out = out.replace(anchor, () => replace);
	}
	return out;
}

export function applyMutation(name: string, line: Line, text: string): string {
	const entry = MUTATIONS[name];
	if (!entry) throw new Error(`unknown mutation ${name}`);
	if (entry[line].length === 0) return text;
	let out = text;
	for (const { anchor, replace } of entry[line]) {
		const count = out.split(anchor).length - 1;
		if (count !== 1)
			throw new Error(`mutation ${name} (${line}): anchor occurs ${count} times: ${anchor}`);
		out = out.replace(anchor, () => replace);
	}
	return out;
}
