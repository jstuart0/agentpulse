/**
 * AGEN-117 P3 item 2: the wire. A fake stdin records what is written; chunks are fed the way a pipe would.
 */
import { describe, expect, test } from "bun:test";
import { inLines, outLines, readClaudeFixture, wireText } from "./__fixtures__/claude-frames.js";
import {
	CLAUDE_CANCEL,
	CLAUDE_CAN_USE_TOOL,
	CLAUDE_ERROR_REPLY_TEXT,
	CLAUDE_UNSUPPORTED_REPLY_TEXT,
	ClaudeControlError,
	ClaudeLink,
	type ClaudeMessage,
	allowResponse,
	controlErrorLine,
	denyResponse,
	userLine,
} from "./claude-wire.js";
import type { JsonRpcServerRequest, RpcTimers } from "./codex-rpc.js";

function harness(options: ConstructorParameters<typeof ClaudeLink>[1] = {}) {
	const written: string[] = [];
	let stdinClosed = false;
	const link = new ClaudeLink(
		{
			write: (line) => {
				written.push(line);
			},
			closeStdin: () => {
				stdinClosed = true;
			},
		},
		options,
	);
	const messages: ClaudeMessage[] = [];
	link.onMessage((m) => messages.push(m));
	const requests: JsonRpcServerRequest[] = [];
	link.client.onServerRequest((call) => {
		requests.push(call);
	});
	const cancels: unknown[] = [];
	link.client.onNotification((n) => {
		if (n.method === CLAUDE_CANCEL) cancels.push(n.params);
	});
	return { link, written, messages, requests, cancels, stdinClosed: () => stdinClosed };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (o: unknown) => `${JSON.stringify(o)}\n`;

function fakeTimers() {
	const pending = new Map<number, () => void>();
	let next = 1;
	const timers: RpcTimers = {
		set: (callback) => {
			pending.set(next, callback);
			return next++;
		},
		clear: (handle) => {
			pending.delete(handle as number);
		},
	};
	return {
		timers,
		fire: () => {
			for (const cb of [...pending.values()]) cb();
		},
		count: () => pending.size,
	};
}

describe("ClaudeLink: reading", () => {
	test("a line split across chunks, and two lines in one chunk, each arrive whole", async () => {
		const h = harness();
		const a = JSON.stringify({ type: "system", subtype: "init", n: 1 });
		const b = JSON.stringify({ type: "result", n: 2 });
		h.link.receive(a.slice(0, 10));
		h.link.receive(`${a.slice(10)}\n${b}\n`);
		await tick();
		expect(h.messages.map((m) => m.n)).toEqual([1, 2]);
	});

	test("a multibyte character split across two chunks is not damaged", async () => {
		const h = harness();
		const bytes = Buffer.from(`${JSON.stringify({ type: "assistant", text: "日本" })}\n`);
		const cut = bytes.indexOf(0xe6) + 1; // inside the first character
		h.link.receive(bytes.subarray(0, cut));
		h.link.receive(bytes.subarray(cut));
		await tick();
		expect(h.messages[0]?.text).toBe("日本");
	});

	test("blank lines, non-JSON and non-object JSON are dropped and counted, never forwarded", async () => {
		const h = harness();
		h.link.receive('\n   \nnot json\n[1,2]\n42\n"str"\n');
		expect(h.messages).toEqual([]);
		expect(h.link.droppedLines).toBe(4);
		h.link.receive(json({ type: "result" }));
		await tick();
		expect(h.messages).toHaveLength(1);
	});

	test("a line exactly at the cap is read; one byte over closes the link", async () => {
		const base = JSON.stringify({ type: "x", pad: "" });
		const cap = 200;
		const exact = JSON.stringify({ type: "x", pad: "a".repeat(cap - base.length) });
		expect(Buffer.byteLength(exact)).toBe(cap);
		const ok = harness({ maxFrameBytes: cap });
		ok.link.receive(`${exact}\n`);
		await tick();
		expect(ok.messages).toHaveLength(1);
		expect(ok.link.isClosed).toBe(false);

		const over = harness({ maxFrameBytes: cap });
		const errors: unknown[] = [];
		over.link.onClose((e) => errors.push(e));
		over.link.receive(`${JSON.stringify({ type: "x", pad: "a".repeat(cap - base.length + 1) })}\n`);
		expect(over.messages).toEqual([]);
		expect(over.link.isClosed).toBe(true);
		expect(over.stdinClosed()).toBe(true);
		expect(errors).toHaveLength(1);
	});

	test("an unfinished line over the cap closes the link without waiting for its newline", () => {
		const h = harness({ maxFrameBytes: 50 });
		h.link.receive("a".repeat(51));
		expect(h.link.isClosed).toBe(true);
	});

	test("a can_use_tool control request becomes a server request with Claude's own request id", async () => {
		const h = harness();
		const frame = outLines("key-fork-restricted-write-deny").find(
			(m) => m.type === "control_request" && m.request?.subtype === "can_use_tool",
		);
		h.link.receive(`${wireText(frame)}\n`);
		await tick();
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]?.id).toBe(frame?.request_id);
		expect(h.requests[0]?.method).toBe(CLAUDE_CAN_USE_TOOL);
		expect((h.requests[0]?.params as any).tool_name).toBe("Write");
		expect(h.messages).toEqual([]);
	});

	test("a control_cancel_request becomes a cancel notification", async () => {
		const h = harness();
		const cancel = outLines("cancel-interrupt").find((m) => m.type === "control_cancel_request");
		h.link.receive(`${wireText(cancel)}\n`);
		await tick();
		expect(h.cancels).toEqual([{ request_id: cancel?.request_id }]);
	});

	test("a request that reuses the id of one still open is dropped and counted; after the answer the id is free", async () => {
		const h = harness();
		const frame = {
			type: "control_request",
			request_id: "dup-1",
			request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
		};
		h.link.receive(json(frame));
		h.link.receive(json(frame));
		await tick();
		expect(h.requests).toHaveLength(1);
		expect(h.link.duplicateRequestIds).toBe(1);
		h.link.client.respond("dup-1", denyResponse("no"));
		h.link.receive(json(frame));
		await tick();
		expect(h.requests).toHaveLength(2);
	});

	test("a control request of an unknown subtype gets an error control_response, never silence", async () => {
		const h = harness();
		h.link.receive(
			json({ type: "control_request", request_id: "q1", request: { subtype: "hook_callback" } }),
		);
		await h.link.flush();
		expect(h.written).toEqual([controlErrorLine("q1", CLAUDE_UNSUPPORTED_REPLY_TEXT)]);
		expect(h.requests).toEqual([]);
	});

	test("cancels are not kept: a fork that lives for days doesn't grow a buffer of them", async () => {
		const h = harness();
		for (let i = 0; i < 2_000; i++)
			h.link.receive(json({ type: "control_cancel_request", request_id: `c${i}` }));
		await tick();
		expect(h.cancels).toHaveLength(2_000);
		expect((h.link.client as unknown as { notifications: unknown[] }).notifications).toHaveLength(
			0,
		);
	});

	test("the Codex client still keeps what it is told to wait for", async () => {
		const { RpcClient } = await import("./codex-rpc.js");
		const client = new RpcClient({ write() {}, close() {} });
		client.receive(`${JSON.stringify({ method: "turn/started", params: {} })}\n`);
		expect((await client.waitForNotification("turn/started", undefined, 100)).method).toBe(
			"turn/started",
		);
	});

	test("a request with no usable id or no body is dropped", () => {
		const h = harness();
		h.link.receive(json({ type: "control_request", request: { subtype: "can_use_tool" } }));
		h.link.receive(json({ type: "control_request", request_id: "x" }));
		h.link.receive(json({ type: "control_cancel_request" }));
		expect(h.link.droppedLines).toBe(3);
	});
});

describe("ClaudeLink: writing", () => {
	test("allow and deny answers are byte-equal to the recorded control_response lines", async () => {
		const recorded = inLines("key-fork-restricted-write-deny").filter(
			(m) => m.type === "control_response",
		);
		const deny = recorded.find((m) => m.response.response?.behavior === "deny");
		expect(deny).toBeDefined();
		const h = harness();
		h.link.receive(
			json({
				type: "control_request",
				request_id: deny?.response.request_id,
				request: { subtype: "can_use_tool", tool_name: "Write" },
			}),
		);
		await tick();
		h.link.client.respond(deny?.response.request_id, denyResponse(deny?.response.response.message));
		await h.link.flush();
		expect(h.written).toEqual([wireText(deny)]);

		const allowed = inLines("cancel-interrupt").find(
			(m) => m.response?.response?.behavior === "allow",
		);
		expect(allowed).toBeDefined();
		expect(
			wireText({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: allowed?.response.request_id,
					response: allowResponse(allowed?.response.response.updatedInput),
				},
			}),
		).toBe(wireText(allowed));
	});

	test("a user line is byte-equal to the recorded one, with and without a uuid", () => {
		const withUuid = inLines("uuid-fork").find((m) => m.type === "user");
		expect(userLine(withUuid?.message.content[0].text, withUuid?.uuid)).toBe(wireText(withUuid));
		const without = inLines("key-fork-restricted-write-deny").find((m) => m.type === "user");
		expect(userLine(without?.message.content[0].text)).toBe(wireText(without));
	});

	test("an initialize and an interrupt are the recorded control requests", () => {
		const h = harness({ newRequestId: (kind) => `${kind}-fixed` });
		void h.link.initialize().catch(() => {});
		void h.link.interrupt().catch(() => {});
		expect(h.link.client.isClosed).toBe(false);
		return h.link.flush().then(() => {
			expect(h.written).toEqual([
				JSON.stringify({
					type: "control_request",
					request_id: "init-fixed",
					request: { subtype: "initialize" },
				}),
				JSON.stringify({
					type: "control_request",
					request_id: "req-fixed",
					request: { subtype: "interrupt" },
				}),
			]);
		});
	});

	test("respond is once only: the second answer to an id writes nothing", async () => {
		const h = harness();
		h.link.receive(
			json({
				type: "control_request",
				request_id: "r1",
				request: { subtype: "can_use_tool", tool_name: "Bash" },
			}),
		);
		await tick();
		expect(h.link.client.respond("r1", denyResponse("a"))).toBe(true);
		expect(h.link.client.respond("r1", allowResponse({}))).toBe(false);
		await h.link.flush();
		expect(h.written).toHaveLength(1);
	});

	test("an error answer carries fixed words, never the caller's text", async () => {
		const h = harness();
		h.link.receive(
			json({
				type: "control_request",
				request_id: "e1",
				request: { subtype: "can_use_tool", tool_name: "Bash" },
			}),
		);
		await tick();
		h.link.client.respondError("e1", -32603, "secret detail /Users/someone");
		await h.link.flush();
		expect(h.written).toEqual([controlErrorLine("e1", CLAUDE_ERROR_REPLY_TEXT)]);
		expect(h.written[0]).not.toContain("secret");
	});

	test("writes go out one at a time, in order, even when the pipe is asynchronous", async () => {
		const order: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const link = new ClaudeLink({
			write: async (line) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, line.length % 3));
				order.push(line);
				inFlight--;
			},
			closeStdin: () => {},
		});
		const lines = ["a", "bb", "ccc", "dddd", "eeeee"].map((t) => userLine(t));
		for (const t of ["a", "bb", "ccc", "dddd", "eeeee"]) link.sendUser(t);
		await link.flush();
		expect(order).toEqual(lines);
		expect(maxInFlight).toBe(1);
	});
});

describe("ClaudeLink: control requests", () => {
	test("an answer resolves the request it names; a stray answer is ignored", async () => {
		const h = harness({ newRequestId: () => "init-1" });
		const answer = h.link.initialize();
		h.link.receive(
			json({
				type: "control_response",
				response: { subtype: "success", request_id: "nope", response: { x: 1 } },
			}),
		);
		h.link.receive(
			json({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "init-1",
					response: { account: { tokenSource: "none" } },
				},
			}),
		);
		expect(await answer).toEqual({ account: { tokenSource: "none" } });
		expect(h.messages).toEqual([]);
	});

	test("an error answer rejects with a ClaudeControlError", async () => {
		const h = harness({ newRequestId: () => "req-1" });
		const answer = h.link.interrupt();
		h.link.receive(
			json({
				type: "control_response",
				response: { subtype: "error", request_id: "req-1", error: "no" },
			}),
		);
		await expect(answer).rejects.toBeInstanceOf(ClaudeControlError);
	});

	test("no answer in the time given rejects, and a late answer afterwards changes nothing", async () => {
		const { timers, fire } = fakeTimers();
		const h = harness({ timers, newRequestId: () => "init-1" });
		const answer = h.link.initialize();
		fire();
		await expect(answer).rejects.toBeInstanceOf(ClaudeControlError);
		h.link.receive(
			json({
				type: "control_response",
				response: { subtype: "success", request_id: "init-1", response: {} },
			}),
		);
		expect(h.messages).toEqual([]);
	});

	test("a closed stream rejects what is waiting and every later request", async () => {
		const h = harness();
		const answer = h.link.initialize();
		h.link.transportClosed(new Error("exit"));
		await expect(answer).rejects.toThrow("exit");
		await expect(h.link.interrupt()).rejects.toBeInstanceOf(ClaudeControlError);
		expect(h.link.client.isClosed).toBe(true);
	});

	test("every recorded control_response in the fixtures is one the link resolves or ignores without a message", () => {
		const h = harness({ newRequestId: () => "never" });
		for (const name of ["cancel-interrupt", "key-ask-fork-noprompt", "unknown-request"]) {
			for (const line of readClaudeFixture(name)) {
				if (line.dir === "out" && line.frame.type === "control_response") {
					h.link.receive(`${wireText(line.frame)}\n`);
				}
			}
		}
		expect(h.messages).toEqual([]);
	});
});
