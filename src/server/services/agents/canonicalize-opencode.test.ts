/**
 * AGEN-141 phase 1: the OpenCode canonicalizer and the wire parser, driven by
 * the hand-written fixtures under __fixtures__/opencode/{envelopes,canonical}.
 * The fixtures are the contract the phase 2 plugins must produce: they were
 * written from the phase 0 captures, and no code writes them (a test below
 * fails on any writer).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { parseOpenCodeEnvelope } from "../../../shared/opencode-wire.js";
import { OPENCODE_EVENT_TO_HOOK_EVENT } from "../../../shared/types.js";
import type { HookEventPayload } from "../../../shared/types.js";
import { sha256Hex } from "../util/hash.js";
import {
	HOOK_PAYLOAD_CANONICALIZERS,
	canonicalizeHookPayload,
	createOpenCodeCanonicalizer,
} from "./canonicalize.js";

const FIXTURES = new URL("./__fixtures__/opencode/", import.meta.url).pathname;
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const DROP = { session_id: "", hook_event_name: "" };

type Line = "v1" | "v2";
type Raw = Record<string, unknown>;
interface EnvelopeFile {
	line: Line;
	name: string;
	envelopes: Raw[];
}
interface CanonicalFile {
	line: Line;
	name: string;
	outputs: Array<{ expected: Raw; semantic: Raw }>;
}
interface ManifestEnvelope {
	line: Line;
	name: string;
	status: "captured" | "synthetic";
	capture?: string;
	waiver?: string;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) as T;
}

function scenarioNames(dir: "envelopes" | "canonical", line: Line): string[] {
	return readdirSync(join(FIXTURES, dir, line))
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -".json".length))
		.sort();
}

const manifest = readJson<{ envelopes: ManifestEnvelope[] }>("manifest.json");
const scenarios: Array<{ line: Line; name: string; env: EnvelopeFile; can: CanonicalFile }> = [];
for (const line of ["v1", "v2"] as const) {
	for (const name of scenarioNames("envelopes", line)) {
		scenarios.push({
			line,
			name,
			env: readJson<EnvelopeFile>(`envelopes/${line}/${name}.json`),
			can: readJson<CanonicalFile>(`canonical/${line}/${name}.json`),
		});
	}
}

/** The server's view: through the registry, as ingest calls it, round-tripped through JSON. */
function canonicalize(body: unknown): Raw {
	const out = canonicalizeHookPayload("opencode", body as HookEventPayload);
	return JSON.parse(JSON.stringify(out)) as Raw;
}

describe("fixtures: every envelope is canonicalized to its hand-written expected payload", () => {
	test("the fixture set exists in both lines, envelopes and canonical outputs pair up", () => {
		expect(scenarios.length).toBeGreaterThanOrEqual(20);
		for (const line of ["v1", "v2"] as const) {
			expect(scenarioNames("envelopes", line)).toEqual(scenarioNames("canonical", line));
		}
	});

	for (const { line, name, env, can } of scenarios) {
		test(`${line}/${name}: output equals the expected payload and the semantic assertions hold`, () => {
			expect(can.outputs.length).toBe(env.envelopes.length);
			env.envelopes.forEach((envelope, i) => {
				const out = canonicalize(envelope);
				const want = can.outputs[i] as { expected: Raw; semantic: Raw };
				expect(out, `${line}/${name}[${i}]`).toEqual(want.expected);
				const semantic = want.semantic;
				expect(out.hook_event_name === "" ? "drop" : out.hook_event_name).toBe(semantic.event);
				if (semantic.tool_use_id !== undefined) expect(out.tool_use_id).toBe(semantic.tool_use_id);
				if (semantic.agentId !== undefined) expect(out.agent_id).toBe(semantic.agentId);
				if (semantic.errorMessage !== undefined) {
					expect(out.error_message).toBe(semantic.errorMessage);
				}
			});
		});
	}

	test("Pre and Post of one call carry the same tool_use_id in every scenario", () => {
		for (const { line, name, can } of scenarios) {
			const pre = new Set<string>();
			const post = new Set<string>();
			for (const { expected } of can.outputs) {
				if (expected.hook_event_name === "PreToolUse") pre.add(expected.tool_use_id as string);
				if (expected.hook_event_name === "PostToolUse") post.add(expected.tool_use_id as string);
				if (expected.hook_event_name === "PostToolUseFailure") {
					post.add(expected.tool_use_id as string);
				}
			}
			for (const id of post) expect(pre.has(id), `${line}/${name} post ${id} has a pre`).toBe(true);
		}
	});
});

describe("the floor, derived from OPENCODE_EVENT_TO_HOOK_EVENT", () => {
	const seen: Record<Line, Set<string>> = { v1: new Set(), v2: new Set() };
	for (const { line, env } of scenarios) {
		for (const e of env.envelopes) seen[line].add(e.hook_event_name as string);
	}

	test("both tables have the keys the plan lists", () => {
		expect(Object.keys(OPENCODE_EVENT_TO_HOOK_EVENT[1]).length).toBe(8);
		expect(Object.keys(OPENCODE_EVENT_TO_HOOK_EVENT[2]).length).toBe(10);
	});

	test("an envelope exists for every forwarded name on every line", () => {
		for (const [line, key] of [
			["v1", 1],
			["v2", 2],
		] as const) {
			const missing = Object.keys(OPENCODE_EVENT_TO_HOOK_EVENT[key]).filter(
				(n) => !seen[line].has(n),
			);
			expect(missing, `${line} has no envelope fixture for ${missing.join(", ")}`).toEqual([]);
		}
	});

	test("every fixture event name is in its line's table (no stale name)", () => {
		for (const [line, key] of [
			["v1", 1],
			["v2", 2],
		] as const) {
			for (const n of seen[line]) {
				expect(Object.hasOwn(OPENCODE_EVENT_TO_HOOK_EVENT[key], n), `${line} ${n}`).toBe(true);
			}
		}
	});

	test("the branches the plan names are covered by an expected output", () => {
		const events = (line: Line) =>
			scenarios.filter((s) => s.line === line).flatMap((s) => s.can.outputs.map((o) => o.expected));
		for (const line of ["v1", "v2"] as const) {
			const all = events(line);
			const has = (pred: (e: Raw) => boolean) => all.some(pred);
			expect(has((e) => e.hook_event_name === "PostToolUse")).toBe(true);
			expect(has((e) => e.hook_event_name === "PostToolUseFailure")).toBe(true);
			expect(has((e) => e.hook_event_name === "PermissionDenied")).toBe(true);
			expect(has((e) => e.hook_event_name === "PermissionRequest")).toBe(true);
			// An accepted ask: PermissionRequest followed by the call's Post on the same id, no denial between.
			expect(
				has((e) => e.hook_event_name === "SubagentStart" && typeof e.agent_id === "string"),
			).toBe(true);
			expect(has((e) => e.hook_event_name === "Interrupt")).toBe(true);
		}
		const childAsk = events("v1").find(
			(e) => e.hook_event_name === "PermissionRequest" && e.agent_id !== undefined,
		);
		expect(childAsk?.tool_use_id).toBe("ses_child0000000000000000000001:call_stub_perm_1#2");
	});

	test("v2/session.execution.failed maps to Stop", () => {
		const forced = scenarios.find((s) => s.line === "v2" && s.name === "forced-400");
		const index = forced?.env.envelopes.findIndex(
			(e) => e.hook_event_name === "session.execution.failed",
		) as number;
		expect(index).toBeGreaterThan(-1);
		expect(canonicalize(forced?.env.envelopes[index]).hook_event_name).toBe("Stop");
		expect(OPENCODE_EVENT_TO_HOOK_EVENT[2]["session.execution.failed"]).toBe("Stop");
	});
});

describe("the manifest accounts for every envelope fixture", () => {
	test("each scenario is in the manifest; captured names an existing capture, synthetic cites a gate", () => {
		const entries = manifest.envelopes;
		for (const { line, name } of scenarios) {
			const entry = entries.find((e) => e.line === line && e.name === name);
			expect(entry, `${line}/${name} is not in manifest.json`).toBeDefined();
			if (entry?.status === "captured") {
				expect(existsSync(join(FIXTURES, entry.capture as string)), `${line}/${name}`).toBe(true);
				expect(entry.capture).toContain(`captures/${line}/`);
			} else {
				expect(entry?.status).toBe("synthetic");
				expect(entry?.waiver ?? "").toMatch(/\bG(1[0-5]|[1-9])\b/);
			}
		}
		for (const entry of entries) {
			expect(
				scenarios.some((s) => s.line === entry.line && s.name === entry.name),
				`manifest entry ${entry.line}/${entry.name} has no fixture`,
			).toBe(true);
		}
	});

	test("a synthetic entry without a waiver would fail the rule (negative control)", () => {
		const ok = (e: { status: string; waiver?: string }) =>
			e.status === "captured" || /\bG(1[0-5]|[1-9])\b/.test(e.waiver ?? "");
		expect(ok({ status: "synthetic" })).toBe(false);
		expect(ok({ status: "synthetic", waiver: "no capture" })).toBe(false);
		expect(ok({ status: "synthetic", waiver: "G7: none" })).toBe(true);
	});
});

describe("malformed envelopes give the drop payload", () => {
	const base = (): Raw => ({
		session_id: "ses_abc",
		hook_event_name: "tool.execute.before",
		opencode: { line: 1, protocol: 1 },
		cwd: "/scratch/p",
		data: { tool: "bash", tool_use_id: "call_1", input: { command: "ls" } },
	});
	const withData = (patch: Raw) => (b: Raw) => {
		b.data = { ...(b.data as Raw), ...patch };
	};
	const big = "x".repeat(64 * 1024 + 1);
	const cases: Array<[string, (b: Raw) => void]> = [
		["opencode missing", (b) => Reflect.deleteProperty(b, "opencode")],
		["opencode not an object", (b) => Object.assign(b, { opencode: "1" })],
		["protocol 2", (b) => Object.assign(b, { opencode: { line: 1, protocol: 2 } })],
		["protocol missing", (b) => Object.assign(b, { opencode: { line: 1 } })],
		["line 3", (b) => Object.assign(b, { opencode: { line: 3, protocol: 1 } })],
		["line is a string", (b) => Object.assign(b, { opencode: { line: "1", protocol: 1 } })],
		["a 2.x event name on line 1", (b) => Object.assign(b, { hook_event_name: "tool.before" })],
		["an unknown event name", (b) => Object.assign(b, { hook_event_name: "session.updated" })],
		["an inherited name", (b) => Object.assign(b, { hook_event_name: "constructor" })],
		["event name not a string", (b) => Object.assign(b, { hook_event_name: 7 })],
		["session_id missing", (b) => Reflect.deleteProperty(b, "session_id")],
		["session_id ../x", (b) => Object.assign(b, { session_id: "../x" })],
		["session_id 129 chars", (b) => Object.assign(b, { session_id: "a".repeat(129) })],
		["session_id not a string", (b) => Object.assign(b, { session_id: 5 })],
		[
			"parent_session_id with a bad character",
			(b) => Object.assign(b, { parent_session_id: "p p" }),
		],
		[
			"parent_session_id equals session_id",
			(b) => Object.assign(b, { parent_session_id: "ses_abc" }),
		],
		["cwd with a newline", (b) => Object.assign(b, { cwd: "/a\nb" })],
		["cwd over 4096", (b) => Object.assign(b, { cwd: `/${"a".repeat(4096)}` })],
		["data missing", (b) => Reflect.deleteProperty(b, "data")],
		["data is an array", (b) => Object.assign(b, { data: [] })],
		["data of the wrong event (empty for a tool event)", (b) => Object.assign(b, { data: {} })],
		["tool_use_id with a newline", withData({ tool_use_id: "call\n1" })],
		["tool_use_id with NUL", withData({ tool_use_id: "call\u00001" })],
		["tool_use_id 201 chars", withData({ tool_use_id: "c".repeat(201) })],
		["tool_use_id empty", withData({ tool_use_id: "" })],
		["tool name 129 chars", withData({ tool: "t".repeat(129) })],
		["input is an array", withData({ input: [] })],
		["input string over 64 KiB", withData({ input: { command: big } })],
		[
			"input nested 13 deep",
			withData({ input: JSON.parse(`${'{"a":'.repeat(13)}1${"}".repeat(13)}`) }),
		],
		[
			"last_assistant_message over 64 KiB",
			(b) => Object.assign(b, { last_assistant_message: big }),
		],
		[
			"__proto__ at the top level",
			(b) => Object.defineProperty(b, "__proto__", { value: { x: 1 }, enumerable: true }),
		],
		[
			"__proto__ in data",
			(b) => Object.defineProperty(b.data, "__proto__", { value: { x: 1 }, enumerable: true }),
		],
		[
			"__proto__ nested in input",
			(b) =>
				Object.defineProperty((b.data as Raw).input, "__proto__", {
					value: { x: 1 },
					enumerable: true,
				}),
		],
	];

	test("positive control: the unmutated base is accepted", () => {
		const out = canonicalize(base());
		expect(out.hook_event_name).toBe("PreToolUse");
		expect(out.tool_use_id).toBe("call_1");
		expect(parseOpenCodeEnvelope(base())).not.toBeNull();
	});

	test("the table has at least 20 rows", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});

	for (const [what, mutate] of cases) {
		test(`drops: ${what}`, () => {
			const b = base();
			mutate(b);
			expect(canonicalize(b)).toEqual(DROP);
			expect(parseOpenCodeEnvelope(b)).toBeNull();
		});
	}

	test("a body that is not an object at all is dropped", () => {
		for (const body of ["x", 3, null, [], [base()], true]) {
			expect(canonicalize(body)).toEqual(DROP);
		}
	});

	test("a __proto__ key from JSON.parse (an own property) is dropped", () => {
		const body = JSON.parse(
			'{"session_id":"s","hook_event_name":"session.idle","opencode":{"line":1,"protocol":1},"data":{},"__proto__":{"polluted":true}}',
		);
		expect(canonicalize(body)).toEqual(DROP);
		expect(({} as Raw).polluted).toBeUndefined();
	});
});

describe("tool_use_id: permissive accepted, hostile dropped", () => {
	const post = (toolUseId: string): Raw => ({
		session_id: "ses_abc",
		hook_event_name: "tool.execute.before",
		opencode: { line: 1, protocol: 1 },
		data: { tool: "bash", tool_use_id: toolUseId, input: {} },
	});

	test("provider-chosen punctuation is accepted as it is", () => {
		expect(canonicalize(post("call:abc.1|x#2")).tool_use_id).toBe("call:abc.1|x#2");
		expect(canonicalize(post("c".repeat(200))).tool_use_id).toBe("c".repeat(200));
	});

	test("control characters and over-length ids are dropped", () => {
		for (const id of ["a\nb", "a\u0000b", "a\u007fb", "a\u001bb", "c".repeat(201)]) {
			expect(canonicalize(post(id)), JSON.stringify(id)).toEqual(DROP);
		}
	});

	test("a root approval: id is still the server's to drop; the canonicalizer passes it through unchanged", () => {
		expect(canonicalize(post("approval:x")).tool_use_id).toBe("approval:x");
	});

	test("a child's id is prefixed, and hashed to c:<24 hex> when the composition passes 64 characters", () => {
		const child = "ses_".padEnd(128, "k");
		const parent = "ses_parent";
		const short = canonicalize({
			...post("call_1"),
			session_id: "ses_child",
			parent_session_id: parent,
		});
		expect(short.tool_use_id).toBe("ses_child:call_1");
		const long = canonicalize({ ...post("call_1"), session_id: child, parent_session_id: parent });
		expect(long.tool_use_id).toBe(`c:${sha256Hex(`${child}:call_1`).slice(0, 24)}`);
		expect((long.tool_use_id as string).length).toBe(26);
		expect(long.agent_id).toBe(child);
		expect(long.session_id).toBe(parent);
	});
});

describe("error rows carry a name and a status, never OpenCode's text", () => {
	test("session.error stores no responseHeaders, response body or message, whatever the sender added", () => {
		const out = canonicalize({
			session_id: "ses_abc",
			hook_event_name: "session.error",
			opencode: { line: 1, protocol: 1 },
			data: {
				error: {
					name: "APIError",
					status: 400,
					message: "secret provider text",
					responseHeaders: { "keep-alive": "timeout=5" },
					responseBody: '{"error":"leak"}',
				},
				message: "also secret",
			},
			message: "top-level secret",
			responseHeaders: { "keep-alive": "x" },
		});
		const text = JSON.stringify(out);
		expect(text).not.toContain("responseHeaders");
		expect(text).not.toContain("keep-alive");
		expect(text).not.toContain("secret");
		expect(text).not.toContain("leak");
		expect(Object.keys(out)).not.toContain("message");
		expect(Object.keys(out)).not.toContain("response");
		expect(out.error_message).toBe("APIError (HTTP 400)");
	});

	test("error_message is exactly the name, or the name and an HTTP status", () => {
		const err = (error: Raw): Raw => ({
			session_id: "ses_abc",
			hook_event_name: "session.step.failed",
			opencode: { line: 2, protocol: 1 },
			data: { error },
		});
		expect(canonicalize(err({ name: "provider.invalid-request" })).error_message).toBe(
			"provider.invalid-request",
		);
		expect(canonicalize(err({ name: "X", status: 503 })).error_message).toBe("X (HTTP 503)");
		// A name that isn't a plain identifier arrives as "Error"; a status outside 100..599 is left out.
		expect(canonicalize(err({ name: "bad name\nwith text", status: 99999 })).error_message).toBe(
			"Error",
		);
		expect(canonicalize(err({ name: "A".repeat(65) })).error_message).toBe("Error");
	});

	test("an error with no detail is still an error row", () => {
		const out = canonicalize({
			session_id: "ses_abc",
			hook_event_name: "session.error",
			opencode: { line: 1, protocol: 1 },
			data: {},
		});
		expect(out.hook_event_name).toBe("ErrorOccurred");
		expect(out.error_message).toBeUndefined();
	});

	test("a failed tool call keeps only the error name", () => {
		const out = canonicalize({
			session_id: "ses_abc",
			hook_event_name: "tool.after",
			opencode: { line: 2, protocol: 1 },
			data: {
				tool: "read",
				tool_use_id: "c1",
				input: {},
				status: "error",
				error: { name: "Tool.Error", message: "File not found: /x" },
			},
		});
		expect(out.hook_event_name).toBe("PostToolUseFailure");
		expect(out.error_message).toBe("Tool.Error");
		expect(JSON.stringify(out)).not.toContain("File not found");
	});
});

describe("abort, failure and prompt rules", () => {
	const v1 = (name: string, data: Raw, extra: Raw = {}): Raw => ({
		session_id: "ses_abc",
		hook_event_name: name,
		opencode: { line: 1, protocol: 1 },
		data,
		...extra,
	});

	test("a V1 MessageAbortedError is an Interrupt on a root and an error row on a child", () => {
		const abort = { error: { name: "MessageAbortedError" } };
		expect(canonicalize(v1("session.error", abort)).hook_event_name).toBe("Interrupt");
		expect(
			canonicalize(v1("session.error", abort, { parent_session_id: "ses_parent" })).hook_event_name,
		).toBe("ErrorOccurred");
		expect(canonicalize(v1("session.error", { error: { name: "APIError" } })).hook_event_name).toBe(
			"ErrorOccurred",
		);
	});

	test("a V2 aborted step is dropped (the interrupt row carries it) and a child's interrupt is dropped", () => {
		const v2 = (name: string, data: Raw, extra: Raw = {}): Raw => ({
			session_id: "ses_abc",
			hook_event_name: name,
			opencode: { line: 2, protocol: 1 },
			data,
			...extra,
		});
		expect(canonicalize(v2("session.step.failed", { error: { name: "aborted" } }))).toEqual(DROP);
		expect(
			canonicalize(v2("session.step.failed", { error: { name: "other" } })).hook_event_name,
		).toBe("ErrorOccurred");
		expect(canonicalize(v2("session.execution.interrupted", {})).hook_event_name).toBe("Interrupt");
		expect(
			canonicalize(v2("session.execution.interrupted", {}, { parent_session_id: "ses_parent" })),
		).toEqual(DROP);
	});

	test("a non-zero exit with a completed status is a failure; zero and absent are not", () => {
		const toolEnd = (extra: Raw): Raw =>
			v1("tool.execute.after", {
				tool: "bash",
				tool_use_id: "c",
				input: {},
				status: "completed",
				...extra,
			});
		expect(canonicalize(toolEnd({ exit_code: 3 })).hook_event_name).toBe("PostToolUseFailure");
		expect(canonicalize(toolEnd({ exit_code: 0 })).hook_event_name).toBe("PostToolUse");
		expect(canonicalize(toolEnd({})).hook_event_name).toBe("PostToolUse");
		expect(canonicalize(toolEnd({ exit_code: null })).hook_event_name).toBe("PostToolUse");
		expect(canonicalize(toolEnd({ status: "error" })).hook_event_name).toBe("PostToolUseFailure");
	});

	test("only a reject is a signal on permission.replied", () => {
		const replied = (reply: string): Raw =>
			v1("permission.replied", { request_id: "per_1", tool_use_id: "c", reply });
		expect(canonicalize(replied("reject")).hook_event_name).toBe("PermissionDenied");
		expect(canonicalize(replied("once"))).toEqual(DROP);
		expect(canonicalize(replied("always"))).toEqual(DROP);
	});

	test("a child's prompt and an empty prompt are dropped; last_assistant_message rides only on a turn end", () => {
		expect(
			canonicalize(v1("chat.message", { text: "do it" }, { parent_session_id: "ses_parent" })),
		).toEqual(DROP);
		expect(canonicalize(v1("chat.message", { text: "" }))).toEqual(DROP);
		const prompt = canonicalize(
			v1("chat.message", { text: "hi" }, { last_assistant_message: "late" }),
		);
		expect(prompt.last_assistant_message).toBeUndefined();
		const stop = canonicalize(v1("session.idle", {}, { last_assistant_message: "done" }));
		expect(stop.last_assistant_message).toBe("done");
	});

	test("nothing the sender adds beyond the contract is stored", () => {
		const out = canonicalize(
			v1(
				"session.idle",
				{ extra: "x" },
				{
					transcript_path: "/etc/passwd",
					agentpulse_oversize: true,
					tool_name: "evil",
					prompt: "p",
				},
			),
		);
		expect(Object.keys(out).sort()).toEqual(
			["hook_event_name", "opencode", "provider_event_name", "session_id"].sort(),
		);
	});

	test("oversize tool output is held to 64 KiB by the cap helpers", () => {
		const out = canonicalize(
			v1("tool.execute.after", {
				tool: "bash",
				tool_use_id: "c",
				input: {},
				status: "completed",
				output: "y".repeat(64 * 1024),
			}),
		);
		expect((out.tool_response as string).length).toBeLessThanOrEqual(64 * 1024);
	});
});

describe("a canonicalizer that throws never stores the raw body", () => {
	const body = {
		session_id: "ses_abc",
		hook_event_name: "tool.execute.before",
		opencode: { line: 1, protocol: 1 },
		data: { tool: "bash", tool_use_id: "c", input: { command: "ls" } },
		secret_extra: "must-not-be-stored",
	};

	test("a throwing cap helper makes the canonicalizer throw (positive control)", () => {
		const boom = createOpenCodeCanonicalizer({
			capToolInput: () => {
				throw new Error("boom");
			},
			capToolResponse: (v) => v,
		});
		expect(() => boom(body as unknown as HookEventPayload)).toThrow("boom");
	});

	test("canonicalizeHookPayload answers the drop payload for opencode and the raw body for the others", () => {
		const original = HOOK_PAYLOAD_CANONICALIZERS.opencode;
		const original2 = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli;
		const boom = createOpenCodeCanonicalizer({
			capToolInput: () => {
				throw new Error("boom");
			},
			capToolResponse: (v) => v,
		});
		try {
			HOOK_PAYLOAD_CANONICALIZERS.opencode = boom;
			const out = canonicalizeHookPayload("opencode", body as unknown as HookEventPayload);
			expect(JSON.parse(JSON.stringify(out))).toEqual(DROP);
			expect(JSON.stringify(out)).not.toContain("must-not-be-stored");

			HOOK_PAYLOAD_CANONICALIZERS.copilot_cli = boom;
			const raw = canonicalizeHookPayload("copilot_cli", body as unknown as HookEventPayload);
			expect(raw).toBe(body as unknown as HookEventPayload);
		} finally {
			HOOK_PAYLOAD_CANONICALIZERS.opencode = original;
			HOOK_PAYLOAD_CANONICALIZERS.copilot_cli = original2;
		}
	});
});

describe("fixture hygiene and the no-writer rule", () => {
	function walk(dir: string, out: string[] = []): string[] {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name === "node_modules" || name === ".git") continue;
				walk(full, out);
			} else out.push(full);
		}
		return out;
	}

	const patterns = (): Array<[string, RegExp]> => {
		const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return [
			["the real home directory", new RegExp(escapeRe(homedir()))],
			["the account name as a path part", new RegExp(`/${escapeRe(userInfo().username)}(/|\\b)`)],
			["the host name", new RegExp(escapeRe(hostname().split(".")[0] as string), "i")],
			["an sk- key", /\bsk-[A-Za-z0-9_-]{8,}/],
			["an ap_ key", /\bap_[A-Za-z0-9_-]{16,}/],
			["a /Users or /home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
		];
	};

	test("positive control: each pattern catches what it names", () => {
		const samples: Record<string, string> = {
			"the real home directory": homedir(),
			"the account name as a path part": `/${userInfo().username}/x`,
			"the host name": hostname().split(".")[0] as string,
			"an sk- key": "sk-abcdefghijkl",
			"an ap_ key": "ap_abcdefghijklmnop1234",
			"a /Users or /home path": "/Users/someone/dev",
		};
		for (const [what, re] of patterns()) {
			expect(re.test(samples[what] as string), what).toBe(true);
		}
	});

	test("no envelope or canonical file names a real home, the user, the host or a key", () => {
		const files = [...walk(join(FIXTURES, "envelopes")), ...walk(join(FIXTURES, "canonical"))];
		expect(files.length).toBeGreaterThanOrEqual(40);
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			for (const [what, re] of patterns()) {
				const m = re.exec(text);
				expect(m, `${file.slice(FIXTURES.length)} contains ${what}: ${m?.[0]}`).toBeNull();
			}
		}
	});

	const FIXTURE_DIR_RE = /opencode\/(?:envelopes|canonical)\b/;
	const WRITER_RE =
		/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|Bun\.write|\.write\()/;
	const writesIntoFixtures = (text: string): boolean =>
		FIXTURE_DIR_RE.test(text) && WRITER_RE.test(text);

	test("the detector flags a writer and passes a reader (positive and negative control)", () => {
		expect(
			writesIntoFixtures('writeFileSync("src/x/__fixtures__/opencode/envelopes/v1/a.json", s)'),
		).toBe(true);
		expect(
			writesIntoFixtures("Bun.write(`${dir}/__fixtures__/opencode/canonical/v2/b.json`, s)"),
		).toBe(true);
		expect(writesIntoFixtures('readFileSync("__fixtures__/opencode/envelopes/v1/a.json")')).toBe(
			false,
		);
	});

	test("no file under scripts/ or src/ writes into the envelope or canonical fixtures", () => {
		const files = [...walk(join(REPO_ROOT, "scripts")), ...walk(join(REPO_ROOT, "src"))].filter(
			(f) => /\.(?:ts|tsx|js|mjs|sh|ps1)$/.test(f) && !f.endsWith("canonicalize-opencode.test.ts"),
		);
		expect(files.length).toBeGreaterThan(200);
		const offenders = files.filter((f) => writesIntoFixtures(readFileSync(f, "utf8")));
		expect(offenders.map((f) => f.slice(REPO_ROOT.length))).toEqual([]);
	});

	test("there is no --update flag for the fixtures", () => {
		const files = [...walk(join(REPO_ROOT, "scripts"))].filter((f) => /\.(?:ts|js|sh)$/.test(f));
		const offenders = files.filter((f) => {
			const text = readFileSync(f, "utf8");
			return FIXTURE_DIR_RE.test(text) && /--update\b/.test(text);
		});
		expect(offenders).toEqual([]);
	});
});
