/**
 * AGEN-117 P3 item 1: the fake `claude` is only as honest as the recordings. Every answer the host writes is
 * validated by the fake against the shapes real Claude Code 2.1.318 was recorded accepting, and the builders
 * are byte-equal to the recorded lines.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	AWAIT,
	type Harness,
	INIT,
	canUseTool,
	createHarness,
	recordingPort,
	resultOk,
	until,
} from "../test-utils/claude-stream-harness.js";
import { inLines, readClaudeFixture, wireText } from "./__fixtures__/claude-frames.js";
import { fixtureNames } from "./__fixtures__/claude-frames.js";
import { isRecordedControlResponse } from "./__fixtures__/claude-response-shapes.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";
import {
	allowResponse,
	controlErrorLine,
	controlResponseLine,
	denyResponse,
	userLine,
} from "./claude-wire.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	await disposeAllClaudeStreamRuntimes({
		interruptMs: 0,
		stdinCloseMs: 300,
		termMs: 300,
		killMs: 300,
	});
	_resetClaudeStreamForTest();
	for (const h of harnesses.splice(0)) {
		expect(h.guard.refused).toEqual([]);
		h.assertCleanWire();
		h.cleanup();
	}
});

describe("the validator accepts exactly what was recorded", () => {
	test("every control_response any recording sent is accepted", () => {
		let seen = 0;
		// `unknown-request` is the recording of stray answers sent on purpose to see what Claude does with them.
		for (const name of fixtureNames().filter((n) => n !== "unknown-request.jsonl")) {
			for (const line of readClaudeFixture(name)) {
				if (line.dir === "in" && line.frame.type === "control_response") {
					expect(isRecordedControlResponse(line.frame), `${name}: ${wireText(line.frame)}`).toBe(
						true,
					);
					seen++;
				}
			}
		}
		expect(seen).toBeGreaterThanOrEqual(10);
	});

	test("shapes no recording shows are rejected", () => {
		const wrap = (response: unknown) => ({
			type: "control_response",
			response: { subtype: "success", request_id: "r", response },
		});
		for (const bad of [
			wrap({ behavior: "maybe" }),
			wrap({ behavior: "allow", updatedInput: "string" }),
			wrap({ behavior: "allow", updatedPermissions: [] }),
			wrap({ behavior: "deny" }),
			wrap({ behavior: "deny", message: 5 }),
			wrap("allow"),
			{
				type: "control_response",
				response: {
					subtype: "success",
					request_id: 7,
					response: { behavior: "deny", message: "x" },
				},
			},
			{ type: "control_response", response: { subtype: "error", request_id: "r" } },
			{
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "r",
					response: { behavior: "deny", message: "x" },
					extra: 1,
				},
			},
			{
				type: "control_response",
				extra: true,
				response: { subtype: "error", request_id: "r", error: "x" },
			},
		]) {
			expect(isRecordedControlResponse(bad), JSON.stringify(bad)).toBe(false);
		}
	});
});

describe("the builders are byte-equal to the recordings", () => {
	test("allow, deny and error answers", () => {
		const recorded = inLines("cancel-interrupt").filter((m) => m.type === "control_response");
		const allow = recorded.find((m) => m.response.response?.behavior === "allow");
		expect(
			controlResponseLine(
				allow?.response.request_id,
				allowResponse(allow?.response.response.updatedInput),
			),
		).toBe(wireText(allow));
		const deny = inLines("key-fork-restricted-write-deny").find(
			(m) => m.response?.response?.behavior === "deny",
		);
		expect(
			controlResponseLine(deny?.response.request_id, denyResponse(deny?.response.response.message)),
		).toBe(wireText(deny));
		expect(isRecordedControlResponse(JSON.parse(controlErrorLine("x", "no")))).toBe(true);
		expect(
			isRecordedControlResponse(JSON.parse(controlResponseLine("x", denyResponse("m", true)))),
		).toBe(true);
	});

	test("every recorded user line is what userLine writes for its text", () => {
		let seen = 0;
		for (const name of fixtureNames()) {
			for (const line of readClaudeFixture(name)) {
				if (line.dir === "in" && line.frame.type === "user") {
					const f = line.frame;
					expect(userLine(f.message.content[0].text, f.uuid), name).toBe(wireText(f));
					seen++;
				}
			}
		}
		expect(seen).toBeGreaterThanOrEqual(10);
	});
});

describe("what the host really writes is accepted by the fake", () => {
	test("allow, deny and the default decline each reach the fake as a recorded shape", async () => {
		const h = createHarness({
			defaultTurn: [
				INIT,
				canUseTool("r1", "Write", "t1", { file_path: "/x", content: "y" }),
				AWAIT,
				canUseTool("r2", "Bash", "t2", { command: "ls" }),
				AWAIT,
				canUseTool("r3", "mcp__x__y", "t3", {}),
				AWAIT,
				resultOk,
			],
		});
		harnesses.push(h);
		const port = recordingPort();
		const rt = await h.start({ approvals: port });
		rt.beginSettle();
		rt.settled();
		const sent = await rt.sendPrompt("go", "a1");
		await until(() => port.requests.length === 1, "r1");
		port.ctx?.answer("r1", allowResponse({ file_path: "/x", content: "y" }));
		await until(() => port.requests.length === 2, "r2");
		port.ctx?.answer("r2", denyResponse("no", true));
		await sent.done;
		const responses = h.fake.log().filter((e) => e.ev === "control_response");
		expect(responses).toHaveLength(3);
		for (const r of responses) expect(r.valid).toBe(true);
	});
});
