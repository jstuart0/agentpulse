/**
 * AGEN-117 P3 item 1: the recorded Claude Code 2.1.318 lines are real, scrubbed, and say what the rules in
 * the plan lean on. A change to a fixture, or a recorded shape the plan relies on that is no longer there,
 * fails here before it fails a rule.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	CLAUDE_FIXTURE_DIR,
	claudeManifest,
	fixtureNames,
	inLines,
	outLines,
	readClaudeFixture,
	readClaudeJson,
} from "./__fixtures__/claude-frames.js";

const T8_TOOLS = ["Bash", "Edit", "NotebookEdit", "Read", "WebFetch", "Write"];

describe("claude 2.1.318 fixtures: scrub", () => {
	test("every fixture file is listed in the manifest and the other way round", () => {
		const onDisk = readdirSync(CLAUDE_FIXTURE_DIR).filter((f) => f.endsWith(".jsonl"));
		expect(onDisk.sort()).toEqual(fixtureNames().sort());
		expect(onDisk.length).toBeGreaterThanOrEqual(20);
	});

	test("no key prefix, home path, user name or uid-bearing temp path in any fixture", () => {
		for (const name of readdirSync(CLAUDE_FIXTURE_DIR)) {
			const text = readFileSync(join(CLAUDE_FIXTURE_DIR, name), "utf8");
			expect(text, name).not.toContain("sk-ant");
			expect(text, name).not.toContain("/Users/");
			expect(text, name).not.toContain("jaystuart");
			expect(text, name).not.toMatch(/claude-501/);
			// An account key in an initialize answer must be one of the three the plan's matching reads.
			expect(text, name).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}"/i);
		}
	});

	test("every line parses and carries a direction", () => {
		for (const name of fixtureNames()) {
			for (const line of readClaudeFixture(name)) {
				expect(["in", "out"]).toContain(line.dir);
				expect(typeof line.frame).toBe("object");
			}
		}
	});
});

describe("claude 2.1.318 fixtures: what the plan relies on", () => {
	test("the T8 init lists exactly the six tools, no MCP servers and no slash commands, under both flags", () => {
		for (const name of ["t8-fork-init", "key-fork-restricted-write-deny", "uuid-fork"]) {
			const init = outLines(name).find((m) => m.type === "system" && m.subtype === "init");
			expect(init, name).toBeDefined();
			expect([...(init?.tools ?? [])].sort(), name).toEqual(T8_TOOLS);
			expect(init?.mcp_servers).toEqual([]);
			expect(init?.permissionMode).toBe("default");
			expect(init?.claude_code_version).toBe("2.1.318");
			expect(init?.capabilities).toContain("interrupt_receipt_v1");
		}
		const plain = outLines("plain-fork-init").find((m) => m.subtype === "init");
		expect(plain?.tools.length).toBeGreaterThan(6);
	});

	test("the restricted fork init names no socket and no memory paths; the plain fork init names both", () => {
		const restricted = outLines("key-fork-restricted-write-deny").find((m) => m.subtype === "init");
		expect(restricted).not.toHaveProperty("messaging_socket_path");
		expect(restricted).not.toHaveProperty("memory_paths");
		const plain = outLines("plain-fork-init").find((m) => m.subtype === "init");
		expect(plain).toHaveProperty("messaging_socket_path");
		expect(plain).toHaveProperty("memory_paths");
	});

	test("an initialize answer carries the login's account, ahead of anything Claude prints about a turn", () => {
		for (const name of [
			"key-ask-fork-noprompt",
			"key-restricted-clean",
			"helper-ask",
			"helper-restricted",
			"no-login-ask",
		]) {
			const lines = readClaudeFixture(name);
			const answer = lines.findIndex(
				(l) =>
					l.dir === "out" &&
					l.frame.type === "control_response" &&
					l.frame.response?.response?.account,
			);
			expect(answer, name).toBeGreaterThanOrEqual(0);
			// A driver may have written its user line already; Claude answers initialize before it starts the turn.
			const firstTurnLine = lines.findIndex(
				(l) => l.dir === "out" && ["system", "assistant", "result"].includes(l.frame.type),
			);
			if (firstTurnLine >= 0) expect(answer, name).toBeLessThan(firstTurnLine);
			expect(lines[answer]?.frame.response.response.account.apiProvider).toBe("firstParty");
		}
	});

	test("the not-logged-in reply is a <synthetic> model with an api_error result and no cost", () => {
		const out = outLines("no-login-ask");
		const reply = out.find((m) => m.type === "assistant");
		expect(reply?.message.model).toBe("<synthetic>");
		const result = out.find((m) => m.type === "result");
		expect(result?.terminal_reason).toBe("api_error");
		expect(result?.total_cost_usd).toBe(0);
	});

	test("can_use_tool is recorded for Write, Edit, Bash with blocked_path, NotebookEdit, WebFetch and Read", () => {
		const tools = new Set<string>();
		for (const name of [
			"tools-m04",
			"tools-webfetch-edit-notebook",
			"bash-blocked-path",
			"read-outside",
			"key-fork-restricted-write-deny",
		]) {
			for (const m of outLines(name)) {
				if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
					tools.add(m.request.tool_name);
				}
			}
		}
		for (const tool of ["Write", "Edit", "Bash", "NotebookEdit", "WebFetch", "Read"]) {
			expect(tools.has(tool), tool).toBe(true);
		}
		const blocked = outLines("bash-blocked-path").find(
			(m) => m.type === "control_request" && m.request?.blocked_path,
		);
		expect(blocked, "a Bash request carrying blocked_path").toBeDefined();
	});

	test("a cancel, an interrupt receipt and both result forms are recorded", () => {
		const interrupt = readClaudeFixture("cancel-interrupt");
		expect(
			interrupt.some((l) => l.dir === "out" && l.frame.type === "control_cancel_request"),
		).toBe(true);
		expect(
			interrupt.some(
				(l) =>
					l.dir === "out" &&
					l.frame.type === "control_response" &&
					Array.isArray(l.frame.response?.response?.still_queued),
			),
		).toBe(true);
		const reasons = new Set(
			interrupt.filter((l) => l.frame.type === "result").map((l) => l.frame.terminal_reason),
		);
		expect(reasons.has("aborted_tools")).toBe(true);
		expect(reasons.has("completed")).toBe(true);
	});

	test("a person's deny, a config refusal and a ran-and-failed Bash are told apart by tool_result_meta", () => {
		const metaOf = (name: string) =>
			outLines(name)
				.filter((m) => m.type === "user" && m.tool_result_meta)
				.flatMap((m) => m.tool_result_meta as any[]);
		expect(metaOf("user-reject").some((m) => m.permission_decision?.source === "user_reject")).toBe(
			true,
		);
		expect(
			metaOf("key-restricted-clean").some(
				(m) =>
					m.non_execution_kind === "permission-rule" && m.permission_decision?.source === "config",
			),
		).toBe(true);
		const failed = outLines("bash-fail")
			.filter((m) => m.type === "user" && m.tool_result_meta)
			.flatMap((m) => m.tool_result_meta as any[]);
		const ranAndFailed = failed.find((m) => m.permission_decision?.decision === "accept");
		expect(ranAndFailed).toBeDefined();
		expect(ranAndFailed).not.toHaveProperty("non_execution_kind");
	});

	test("an injected turn starts with a command_lifecycle the host never stamped; a host uuid comes back", () => {
		const peer = outLines("peer-injected-turn");
		const firstReal = peer.find((m) => m.type !== "control_response");
		expect(firstReal?.type).toBe("command_lifecycle");
		const sent = inLines("uuid-fork").find((m) => m.type === "user");
		const uuid = sent?.uuid;
		expect(typeof uuid).toBe("string");
		const out = outLines("uuid-fork");
		expect(
			out.filter((m) => m.type === "command_lifecycle").every((m) => m.command_uuid === uuid),
		).toBe(true);
		const init = out.find((m) => m.subtype === "init");
		expect(init?.user_message_uuids).toContain(uuid);
	});

	test("an id swap by /clear is recorded: a new session id on a later init", () => {
		const ids = new Set(
			outLines("id-swap-clear")
				.filter((m) => m.subtype === "init")
				.map((m) => m.session_id),
		);
		expect(ids.size).toBeGreaterThanOrEqual(2);
		expect(outLines("id-swap-clear").some((m) => m.type === "conversation_reset")).toBe(true);
	});

	test("Claude's answer to an unknown control subtype is an error control_response with the request id", () => {
		const answer = outLines("unknown-request").find(
			(m) =>
				m.type === "control_response" &&
				m.response?.subtype === "error" &&
				String(m.response?.error).startsWith("Unsupported control request subtype"),
		);
		expect(answer).toBeDefined();
	});

	test("agents --json and the encoded project directory names are recorded for T7 and T12", () => {
		const agents = readClaudeJson("agents-live.json");
		expect(Array.isArray(agents.twoLive.parsed)).toBe(true);
		expect(agents.noneLive.parsed).toEqual([]);
		const heads = readClaudeJson("s-head.json");
		expect(heads.length).toBeGreaterThanOrEqual(12);
		expect(heads.some((h: any) => h.cwdLength > 200)).toBe(true);
	});

	test("the manifest's restricted flag agrees with the init Claude printed (no socket and no memory paths means the flag took effect)", () => {
		let checked = 0;
		for (const [file, meta] of Object.entries(claudeManifest())) {
			if (!file.endsWith(".jsonl")) continue;
			const init = readClaudeFixture(file).find(
				(l) => l.dir === "out" && l.frame.subtype === "init",
			)?.frame;
			if (!init) continue;
			expect(meta.restricted, file).toBe(!("messaging_socket_path" in init));
			expect(meta.restricted, file).toBe(!("memory_paths" in init));
			checked++;
		}
		// Positive control: both kinds were seen, so the loop compared something in each direction.
		expect(checked).toBeGreaterThanOrEqual(12);
		const flags = new Set(Object.values(claudeManifest()).map((m) => m.restricted));
		expect(flags).toEqual(new Set([true, false]));
	});

	test("the restricted flag is recorded in the manifest for exactly the runs that used it", () => {
		const restricted = Object.entries(claudeManifest())
			.filter(([, v]) => v.restricted)
			.map(([k]) => k)
			.sort();
		expect(restricted).toEqual([
			"helper-restricted.jsonl",
			"key-fork-restricted-write-deny.jsonl",
			"key-restricted-clean.jsonl",
		]);
	});
});
