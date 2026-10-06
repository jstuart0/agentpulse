/**
 * AGEN-69 phase 2a, TC-2.23: the stand-in model provider is itself tested, so
 * a stub that answers everything can never make another test pass vacuously.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type LlmStubServer, UNSCRIPTED_STATUS, startLlmStubServer } from "./llm-stub-server.js";

const started: LlmStubServer[] = [];
function start(): LlmStubServer {
	const s = startLlmStubServer();
	started.push(s);
	return s;
}
afterEach(async () => {
	for (const s of started.splice(0)) await s.stop();
});

async function post(url: string, body: unknown): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-test": "1" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("TC-2.23 stub server", () => {
	test("TC-2.23 binds the loopback address only", () => {
		const s = start();
		expect(s.hostname).toBe("127.0.0.1");
		expect(s.origin.startsWith("http://127.0.0.1:")).toBe(true);
	});

	test("TC-2.23 records raw request bodies, paths and headers per request", async () => {
		const s = start();
		s.script("openai", { text: "a", stop: "stop" });
		const raw = '{"keep":  "spacing"}';
		await post(`${s.baseUrl("openai")}/chat/completions`, raw);
		const [req] = s.requests("openai");
		expect(req.body).toBe(raw);
		expect(req.path).toBe("/v1/chat/completions");
		expect(req.headers["x-test"]).toBe("1");
		expect(s.requests("anthropic")).toHaveLength(0);
		expect(s.requests()).toHaveLength(1);
	});

	test("TC-2.23 replays scripted answers in order, in each provider's wire shape", async () => {
		const s = start();
		s.script("openai", { text: "o1", stop: "stop" }, { text: "o2", stop: "length" });
		s.script("anthropic", { text: "a1", stop: "end_turn" });
		s.script("cohere", { text: "c1", stop: "COMPLETE" });

		const o1 = await (await post(`${s.baseUrl("openai")}/chat/completions`, {})).json();
		const o2 = await (await post(`${s.baseUrl("openai")}/chat/completions`, {})).json();
		expect(o1.choices[0].message.content).toBe("o1");
		expect(o1.choices[0].finish_reason).toBe("stop");
		expect(o2.choices[0].message.content).toBe("o2");
		expect(o2.choices[0].finish_reason).toBe("length");

		const a = await (await post(`${s.baseUrl("anthropic")}/v1/messages`, {})).json();
		expect(a.content[0]).toEqual({ type: "text", text: "a1" });
		expect(a.stop_reason).toBe("end_turn");

		const c = await (await post(`${s.baseUrl("cohere")}/v1/chat`, {})).json();
		expect(c.text).toBe("c1");
		expect(c.finish_reason).toBe("COMPLETE");
		s.verify();
	});

	test("TC-2.23 an unset stop field is omitted from the wire; null is sent as null", async () => {
		const s = start();
		s.script("openai", { text: "x" }, { text: "y", stop: null });
		const first = await (await post(`${s.baseUrl("openai")}/chat/completions`, {})).json();
		const second = await (await post(`${s.baseUrl("openai")}/chat/completions`, {})).json();
		expect("finish_reason" in first.choices[0]).toBe(false);
		expect(second.choices[0].finish_reason).toBeNull();
	});

	test("TC-2.23 reported usage is sent, and absent usage is omitted", async () => {
		const s = start();
		s.script("openai", { text: "x", usage: { input: 3, output: 2 } }, { text: "y" });
		const a = await (await post(`${s.baseUrl("openai")}/chat/completions`, {})).json();
		const b = await (await post(`${s.baseUrl("openai")}/chat/completions`, {})).json();
		expect(a.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
		expect("usage" in b).toBe(false);
	});

	test("TC-2.23 a scripted error status carries its body", async () => {
		const s = start();
		s.script("anthropic", { text: "", status: 429, errorBody: "slow down" });
		const res = await post(`${s.baseUrl("anthropic")}/v1/messages`, {});
		expect(res.status).toBe(429);
		expect(await res.text()).toBe("slow down");
	});

	test("TC-2.23 the gate holds a response until released", async () => {
		const s = start();
		const gate = s.createGate();
		s.script("openai", { text: "held", stop: "stop", gate });
		let settled = false;
		const pending = post(`${s.baseUrl("openai")}/chat/completions`, {}).then((r) => {
			settled = true;
			return r.json();
		});
		await gate.arrived;
		await Bun.sleep(30);
		expect(settled).toBe(false);
		gate.release();
		const body = await pending;
		expect(body.choices[0].message.content).toBe("held");
	});

	test("TC-2.23 a gate released before the request arrives does not hold it", async () => {
		const s = start();
		const gate = s.createGate();
		gate.release();
		s.script("cohere", { text: "free", stop: "COMPLETE", gate });
		const body = await (await post(`${s.baseUrl("cohere")}/v1/chat`, {})).json();
		expect(body.text).toBe("free");
	});

	test("TC-2.23 an unscripted request returns the marker status, is recorded, and fails verify()", async () => {
		const s = start();
		const res = await post(`${s.baseUrl("anthropic")}/v1/messages`, { hello: 1 });
		expect(res.status).toBe(UNSCRIPTED_STATUS);
		expect(s.unscripted).toHaveLength(1);
		expect(s.unscripted[0].shape).toBe("anthropic");
		expect(() => s.verify()).toThrow(/unscripted/i);
		s.reset();
		expect(() => s.verify()).not.toThrow();
	});

	test("TC-2.23 a request to an unknown path is unscripted too", async () => {
		const s = start();
		const res = await post(`${s.origin}/nope`, {});
		expect(res.status).toBe(UNSCRIPTED_STATUS);
		expect(() => s.verify()).toThrow(/unscripted/i);
		s.reset();
	});

	test("TC-2.23 an exhausted script fails the next request loudly", async () => {
		const s = start();
		s.script("cohere", { text: "only", stop: "COMPLETE" });
		await post(`${s.baseUrl("cohere")}/v1/chat`, {});
		const res = await post(`${s.baseUrl("cohere")}/v1/chat`, {});
		expect(res.status).toBe(UNSCRIPTED_STATUS);
		expect(() => s.verify()).toThrow(/unscripted/i);
		s.reset();
	});
});

describe("P2-24 the stub cannot be stopped past an unscripted request, nor given a foreign gate", () => {
	test("P2-24 stop() throws when an unscripted request was received, and still stops the server", async () => {
		const s = startLlmStubServer();
		await post(`${s.baseUrl("openai")}/chat/completions`, {});
		await expect(s.stop()).rejects.toThrow(/unscripted/i);
		await expect(post(`${s.baseUrl("openai")}/chat/completions`, {})).rejects.toThrow();
	});

	test("P2-24 stop() is quiet when everything was scripted, or after reset()", async () => {
		const a = startLlmStubServer();
		a.script("openai", { text: "x", stop: "stop" });
		await post(`${a.baseUrl("openai")}/chat/completions`, {});
		await a.stop();

		const b = startLlmStubServer();
		await post(`${b.baseUrl("openai")}/chat/completions`, {});
		b.reset();
		await b.stop();
	});

	test("P2-24 script() throws when the answer's gate was not made by createGate()", () => {
		const s = start();
		const forged = { arrived: Promise.resolve(), release() {} };
		expect(() => s.script("openai", { text: "x", gate: forged })).toThrow(/createGate/);
		expect(() => s.script("openai", { text: "x", gate: undefined })).not.toThrow();
		expect(() => s.script("openai", { text: "y", gate: s.createGate() })).not.toThrow();
		s.reset();
	});

	test("P2-24 a gate made by another stub instance is accepted and holds the response", async () => {
		const other = start();
		const s = start();
		const gate = other.createGate();
		s.script("openai", { text: "held", stop: "stop", gate });
		const pending = post(`${s.baseUrl("openai")}/chat/completions`, {});
		await gate.arrived;
		gate.release();
		expect((await (await pending).json()).choices[0].message.content).toBe("held");
	});

	test("P2-24 a script that was never consumed does not fail stop()", async () => {
		const s = startLlmStubServer();
		s.script("openai", { text: "never asked", stop: "stop" });
		await s.stop();
	});
});

describe("P2-23 the stub answers an OpenAI stream request as server-sent events", () => {
	async function stream(s: LlmStubServer, body: unknown = { stream: true }): Promise<string> {
		const res = await post(`${s.baseUrl("openai")}/chat/completions`, body);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		return res.text();
	}
	const frames = (text: string) =>
		text
			.split("\n\n")
			.filter(Boolean)
			.map((f) => f.replace(/^data: /, ""));

	test("P2-23 pieces are content deltas, the last carries finish_reason, usage trails with no choices, then [DONE]", async () => {
		const s = start();
		s.script("openai", {
			text: "ignored when pieces are given",
			streamPieces: ["Hel", "lo"],
			stop: "length",
			usage: { input: 11, output: 7 },
		});
		const out = frames(await stream(s));
		expect(out.at(-1)).toBe("[DONE]");
		const chunks = out.slice(0, -1).map((f) => JSON.parse(f));
		expect(chunks).toEqual([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: { content: "lo" }, finish_reason: "length" }] },
			{ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
		]);
	});

	test("P2-23 without pieces the text is one delta; without a stop or usage those frames are left out", async () => {
		const s = start();
		s.script("openai", { text: "whole" });
		const chunks = frames(await stream(s))
			.slice(0, -1)
			.map((f) => JSON.parse(f));
		expect(chunks).toEqual([{ choices: [{ delta: { content: "whole" } }] }]);
	});

	test("P2-23 a null stop is sent as null on the last content chunk", async () => {
		const s = start();
		s.script("openai", { text: "x", stop: null });
		const chunks = frames(await stream(s))
			.slice(0, -1)
			.map((f) => JSON.parse(f));
		expect(chunks[0].choices[0].finish_reason).toBeNull();
	});

	test("P2-23 a request without stream:true still gets the plain JSON body", async () => {
		const s = start();
		s.script("openai", { text: "plain", stop: "stop", streamPieces: ["pl", "ain"] });
		const res = await post(`${s.baseUrl("openai")}/chat/completions`, { stream: false });
		expect(res.headers.get("content-type")).toContain("application/json");
		expect((await res.json()).choices[0].message.content).toBe("plain");
	});

	test("P2-23 a stream request on the Anthropic or Cohere path is unscripted, not silently answered", async () => {
		const s = start();
		s.script("anthropic", { text: "x", stop: "end_turn" });
		const res = await post(`${s.baseUrl("anthropic")}/v1/messages`, { stream: true });
		expect(res.status).toBe(UNSCRIPTED_STATUS);
		expect(() => s.verify()).toThrow(/stream/i);
		s.reset();
	});

	test("releaseGates lets every held response go, so a failed test cannot leave one held", async () => {
		const s = start();
		const first = s.createGate();
		const second = s.createGate();
		s.script(
			"openai",
			{ text: "a", stop: "stop", gate: first },
			{ text: "b", stop: "stop", gate: second },
		);
		const calls = [
			post(`${s.baseUrl("openai")}/chat/completions`, {}),
			post(`${s.baseUrl("openai")}/chat/completions`, {}),
		];
		await first.arrived;
		await second.arrived;
		s.releaseGates();
		const answers = await Promise.all(calls);
		expect(answers.map((r) => r.status)).toEqual([200, 200]);
	});
});
