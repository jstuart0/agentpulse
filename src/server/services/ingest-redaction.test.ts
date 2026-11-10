import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_EVENT_CONTENT_CHARS } from "../../shared/managed-report-limits.js";
import type { HookEventPayload } from "../../shared/types.js";
import { redactionSamples } from "./ai/__fixtures__/redaction-samples.js";
import { DEFAULT_RULES, redact } from "./ai/redactor.js";
import type { NormalizedEvent } from "./event-normalizer.js";
import { TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP } from "./event-normalizer.js";
import {
	ADMISSION_WAIT_MS,
	BACKLOG_MARKER,
	CUT_MARGIN_CHARS,
	ERROR_MARKER,
	HEAD_CHARS,
	INLINE_MAX_UNITS,
	MASK,
	NAME_MARKER,
	OVER_LIMIT_MARKER,
	type PreparedHookPayload,
	SENDER_PENDING_CAP_UNITS,
	SLICE_UNITS,
	TAIL_CHARS,
	__testing,
	getIngestRedactionCounters,
	prepareHookPayloadForStorage,
	redactEventsForStorage,
	redactShortForStorage,
	redactTextForStorage,
	storableFromPrepared,
} from "./ingest-redaction.js";

const ghp = `ghp_${"d".repeat(36)}`;
const anthropic = `sk-ant-${"api03-"}${"A".repeat(40)}`;

function hook(extra: Record<string, unknown> = {}): HookEventPayload {
	return {
		session_id: "sess-1",
		hook_event_name: "UserPromptSubmit",
		...extra,
	} as unknown as HookEventPayload;
}

async function prepare(payload: HookEventPayload, keyId = "k1"): Promise<PreparedHookPayload> {
	const result = await prepareHookPayloadForStorage(payload, { keyId });
	if ("refused" in result) throw new Error("refused");
	return result;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

const ev = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
	eventType: "ManagedAgentMessage",
	category: "assistant_message",
	source: "managed_control",
	content: null,
	isNoise: false,
	providerEventType: null,
	toolName: null,
	toolInput: null,
	toolResponse: null,
	rawPayload: {},
	...over,
});

beforeEach(() => __testing.reset());
afterEach(() => __testing.setSliceObserver(null));

describe("prepareHookPayloadForStorage: structure", () => {
	test("masks a secret in a prompt, never mutates the input, and gives the same answer twice", async () => {
		const input = deepFreeze(
			hook({ prompt: `use ${ghp} please`, tool_input: { command: `echo ${anthropic}` } }),
		);
		const a = await prepare(input);
		const b = await prepare(input);
		expect(JSON.stringify(a.payload)).not.toContain("dddddddd");
		expect(JSON.stringify(a.payload)).not.toContain("api03-");
		expect(a.payload.prompt).toContain("[REDACTED:github_token]");
		expect(a.payload).toEqual(b.payload);
		expect((input as unknown as { prompt: string }).prompt).toContain(ghp);
	});

	test("ids and names that are plain stay byte-identical", async () => {
		const input = hook({
			tool_use_id: "toolu_01AbC-xyz:9",
			turn_id: "019a-turn.1",
			tool_name: "Bash",
			agent_type: "claude_code",
			cwd: "/work/some dir/repo",
			transcript_path: "/home/u/.claude/projects/x/y.jsonl",
		});
		const { payload } = await prepare(input);
		expect(payload).toEqual(input);
	});

	test("an id shaped like a token is dropped, and said so", async () => {
		const { payload } = await prepare(hook({ tool_use_id: ghp, turn_id: "ok-1" }));
		const raw = payload as unknown as Record<string, unknown>;
		expect(raw.tool_use_id).toBeUndefined();
		expect(raw.tool_use_id_redacted).toBe(true);
		expect(raw.turn_id).toBe("ok-1");
		expect(getIngestRedactionCounters().idsDropped).toBe(1);
	});

	test("an id with characters the grammar refuses is dropped even when no rule matches it", async () => {
		const { payload } = await prepare(hook({ tool_use_id: "has space and more" }));
		expect((payload as unknown as Record<string, unknown>).tool_use_id_redacted).toBe(true);
	});

	test("a name that is not a plain name becomes a marker", async () => {
		const { payload } = await prepare(
			hook({ tool_name: `Bash ${ghp}`, permission_mode: "default" }),
		);
		expect(payload.tool_name).toBe(NAME_MARKER);
		expect((payload as unknown as Record<string, unknown>).permission_mode).toBe("default");
	});

	test("a reserved event name is kept as written so the normalizer still refuses it", async () => {
		const { payload } = await prepare(hook({ hook_event_name: " AiContinueSent " }));
		expect(payload.hook_event_name).toBe(" AiContinueSent ");
	});

	test("a session id that is a secret, or not a plain id, refuses the delivery", async () => {
		expect(await prepareHookPayloadForStorage(hook({ session_id: ghp }), { keyId: "k" })).toEqual({
			refused: "session_id",
		});
		expect(getIngestRedactionCounters().sessionIdRefused).toBe(1);
		const odd = await prepareHookPayloadForStorage(hook({ session_id: "has space" }), {
			keyId: "k",
		});
		// The grammar comes first: an id that is not a plain id is refused whether or not a rule matches it.
		expect(odd).toEqual({ refused: "session_id" });
	});

	test("a nested session_id is an ordinary leaf", async () => {
		const { payload } = await prepare(hook({ tool_input: { session_id: ghp, tool_use_id: ghp } }));
		expect(JSON.stringify(payload)).not.toContain("dddddddd");
	});

	test("an own __proto__ key stays data and reaches no prototype", async () => {
		const input = JSON.parse(
			`{"session_id":"s","hook_event_name":"Notification","message":"x","extra":{"__proto__":{"polluted":"${ghp}"}}}`,
		);
		const { payload } = await prepare(input);
		const extra = (payload as unknown as { extra: Record<string, unknown> }).extra;
		expect(Object.keys(extra)).toEqual(["__proto__"]);
		expect(Object.getPrototypeOf(extra)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(JSON.stringify(extra)).not.toContain("dddddddd");
	});

	test("a kubectl env pair is masked by its name, whatever the value looks like", async () => {
		const { payload } = await prepare(
			hook({
				tool_input: {
					env: [
						{ name: "DB_PASSWORD", value: "plainvalue" },
						{ name: "REGION", value: "eu-west-1" },
					],
				},
			}),
		);
		const env = (payload.tool_input as { env: Array<{ name: string; value: string }> }).env;
		expect(env[0]?.value).toBe(MASK);
		expect(env[1]?.value).toBe("eu-west-1");
	});

	test("a header list: [k, v] pairs and objects keyed name/key/header", async () => {
		const { payload } = await prepare(
			hook({
				tool_input: {
					headers: [
						["Authorization", "Bearer abcdefghijkl"],
						["Accept", "text/html"],
					],
					list: [
						{ header: "X-Api-Key", Value: "zzzzzzzz" },
						{ Key: "token", value: "abcd" },
					],
				},
			}),
		);
		const input = payload.tool_input as {
			headers: string[][];
			list: Array<Record<string, string>>;
		};
		expect(input.headers[0]?.[1]).toBe(MASK);
		expect(input.headers[1]?.[1]).toBe("text/html");
		expect(input.list[0]?.Value).toBe(MASK);
		expect(input.list[1]?.value).toBe(MASK);
	});

	test("a string under a secret key is masked at six characters; a short one and a placeholder stay", async () => {
		const { payload } = await prepare(
			hook({
				tool_input: {
					password: "hunter",
					token: "abc",
					api_key: "${API_KEY}",
					items: { secret: ["abcdefg", "xy"] },
				},
			}),
		);
		const input = payload.tool_input as Record<string, unknown>;
		expect(input.password).toBe(MASK);
		expect(input.token).toBe("abc");
		expect(input.api_key).toBe("${API_KEY}");
		expect((input.items as { secret: string[] }).secret).toEqual([MASK, "xy"]);
	});

	test("memo: the same string twice in one event is scanned once, and the secret-key form is a different answer", async () => {
		const text = `${"word ".repeat(3000)}${ghp}`;
		const once = await prepare(hook({ prompt: text }));
		const twice = await prepare(hook({ prompt: text, message: text, extra: { note: text } }));
		expect(twice.stats.units).toBe(once.stats.units);
		const keyed = await prepare(hook({ prompt: "abcdefg", tool_input: { password: "abcdefg" } }));
		expect((keyed.payload.tool_input as { password: string }).password).toBe(MASK);
		expect(keyed.payload.prompt).toBe("abcdefg");
	});

	test("a model name is redacted and cut at 256 characters", async () => {
		const { payload } = await prepare(hook({ model: `m-${ghp}${"x".repeat(400)}` }));
		expect(payload.model).not.toContain("dddddddd");
		expect(payload.model?.length).toBeLessThanOrEqual(256);
	});

	test("a structure past the depth limit is replaced, not stored", async () => {
		let deep: unknown = ghp;
		for (let i = 0; i < 200; i++) deep = { n: deep };
		const { payload } = await prepare(hook({ tool_input: deep as Record<string, unknown> }));
		expect(JSON.stringify(payload)).not.toContain("dddddddd");
		expect(JSON.stringify(payload)).toContain("[REDACTED:too_deep]");
	});
});

describe("tool responses (D5)", () => {
	test("a 5 MB Read response costs one cap and a margin, equals redact-then-cut, and keeps its true length", async () => {
		const line = "const value = compute(items);\n";
		const body = `${line.repeat(136)}${"z ".repeat(5)}${ghp}\n${line.repeat(170_000)}`;
		const tr = body.length;
		expect(tr).toBeGreaterThan(5_000_000);
		const { payload, originalToolResponseChars, stats } = await prepare(
			hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_response: body }),
		);
		expect(originalToolResponseChars).toBe(tr);
		expect(stats.units).toBeLessThanOrEqual(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP + 4096 + 64);
		const stored = payload.tool_response as unknown as string;
		expect(stored.slice(0, TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP)).toBe(
			redact(body).text.slice(0, TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP),
		);
		expect(stored).not.toContain("dddddddd");
	});

	test("a structured response is redacted leaf by leaf, so a line-anchored rule still sees its line", async () => {
		const response = { stdout: `ls\nTOKEN=${"q".repeat(12)}\nok`, stderr: "", exit_code: 1 };
		const { payload, originalToolResponseChars } = await prepare(
			hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: response as never }),
		);
		const stored = payload.tool_response as unknown as string;
		expect(stored).not.toContain("qqqqqqqq");
		expect(JSON.parse(stored).exit_code).toBe(1);
		expect(originalToolResponseChars).toBe(JSON.stringify(response).length);
	});

	test("a failure event is handled the same way", async () => {
		const { payload } = await prepare(
			hook({
				hook_event_name: "PostToolUseFailure",
				tool_name: "Bash",
				tool_response: `boom ${ghp}`,
			}),
		);
		expect(payload.tool_response as unknown as string).not.toContain("dddddddd");
	});

	test("another event type keeps a long tool_response under the leaf cap", async () => {
		const { payload, originalToolResponseChars } = await prepare(
			hook({ hook_event_name: "PermissionRequest", tool_response: `x ${ghp}` }),
		);
		expect(originalToolResponseChars).toBeUndefined();
		expect(payload.tool_response as unknown as string).toContain("[REDACTED:github_token]");
	});
});

describe("text over the content cap (D4)", () => {
	const filler = (n: number) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)).slice(0, n);

	test("head and tail are kept around a marker, and the result is under the cap", async () => {
		const text = `${"a".repeat(HEAD_CHARS + 5000)}MIDDLE${"b".repeat(TAIL_CHARS + 5000)}`;
		const out = await redactTextForStorage(text, "t");
		expect(out.length).toBeLessThan(MAX_EVENT_CONTENT_CHARS);
		expect(out).toContain(OVER_LIMIT_MARKER);
		expect(out.startsWith("aaaa")).toBe(true);
		expect(out).not.toContain("MIDDLE");
		expect(getIngestRedactionCounters().cutLeaves).toBe(1);
	});

	test("every family straddling the head boundary, the tail start and the 1,000,000 boundary", async () => {
		const total = MAX_EVENT_CONTENT_CHARS + 5000;
		const samples = redactionSamples().filter((_, i) => i % 3 === 0);
		for (const sample of samples) {
			const spots = [
				HEAD_CHARS - 10,
				total - TAIL_CHARS - 10,
				MAX_EVENT_CONTENT_CHARS - 10,
				0,
				total - sample.text.length,
			];
			for (const at of spots) {
				const text = `${filler(at)}\n${sample.text}\n${filler(total - at - sample.text.length)}`;
				const out = await redactTextForStorage(text, "t");
				if (out.includes(sample.secret)) throw new Error(`${sample.family} at ${at} survived`);
			}
		}
	}, 120_000);

	test("a PEM block whose BEGIN is before the scanned tail loses its body and END line", async () => {
		// The rule never sees the BEGIN (it is before the margin), so the tail edge pass has to drop
		// the orphaned body and the END line.
		const body = `${"QUJD".repeat(16)}\n`.repeat(400);
		const pem = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`;
		// Far enough from the head that the two scanned ends don't overlap.
		const total = 2 * MAX_EVENT_CONTENT_CHARS;
		const startOfKept = total - TAIL_CHARS;
		const at = startOfKept - CUT_MARGIN_CHARS - 100;
		const text = `${filler(at)}\n${pem}${filler(total - at - pem.length - 1)}`;
		expect(text.indexOf("-----END") - startOfKept).toBeGreaterThan(1000);
		const out = await redactTextForStorage(text, "t");
		expect(out).not.toContain("QUJDQUJD");
		expect(out).not.toContain("-----END");
	}, 60_000);

	test("a 1.2 MB prompt next to a tool name: the name survives and the prompt is cut", async () => {
		const { payload } = await prepare(
			hook({ prompt: filler(1_200_000), tool_name: "Bash", tool_input: { command: "ls" } }),
		);
		expect(payload.tool_name).toBe("Bash");
		expect((payload.prompt as string).length).toBeLessThan(MAX_EVENT_CONTENT_CHARS);
		expect(payload.prompt).toContain(OVER_LIMIT_MARKER);
	}, 60_000);

	test("a lone surrogate is never produced by the cut", async () => {
		const text = `${"😀".repeat(HEAD_CHARS)}${"x".repeat(1000)}${"😀".repeat(TAIL_CHARS)}`;
		const out = await redactTextForStorage(text, "t");
		expect((out as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
	}, 60_000);
});

describe("failure handling", () => {
	test("a rule that throws becomes a marker, the event is still stored, and nothing throws", async () => {
		const rule = DEFAULT_RULES.find((r) => r.name === "anthropic_api_key");
		if (!rule) throw new Error("rule missing");
		const original = rule.replacement;
		rule.replacement = () => {
			throw new Error("boom");
		};
		try {
			const { payload, stats } = await prepare(hook({ prompt: `k ${anthropic}`, message: "fine" }));
			expect(payload.prompt).toBe(ERROR_MARKER);
			expect((payload as unknown as { message: string }).message).toBe("fine");
			expect(stats.errors).toBeGreaterThan(0);
			expect(getIngestRedactionCounters().errors).toBeGreaterThan(0);
		} finally {
			rule.replacement = original;
		}
	});
});

describe("redactEventsForStorage", () => {
	test("content, tool input, tool response and raw payload are all redacted", async () => {
		const events = await redactEventsForStorage("s:sup", [
			ev({
				content: `say ${ghp}`,
				toolInput: { command: `echo ${anthropic}` },
				toolResponse: `out ${ghp}`,
				toolName: "Bash",
				providerEventType: "prompt",
				rawPayload: { message: ghp, kind: "call", tool_use_id: "toolu_1", turn_id: ghp },
			}),
		]);
		const text = JSON.stringify(events);
		expect(text).not.toContain("dddddddd");
		expect(text).not.toContain("api03-");
		expect(events[0]?.toolName).toBe("Bash");
		expect((events[0]?.rawPayload as Record<string, unknown>).tool_use_id).toBe("toolu_1");
		expect((events[0]?.rawPayload as Record<string, unknown>).turn_id_redacted).toBe(true);
	});

	test("the brand: events from a prepared payload need the witness", async () => {
		const prepared = await prepare(hook({ prompt: "x" }));
		expect(() => storableFromPrepared({ ...prepared } as PreparedHookPayload, [])).toThrow();
		expect([...storableFromPrepared(prepared, [])]).toEqual([]);
	});
});

describe("backpressure (D8)", () => {
	test("a sender over its share gets a marker-only event that keeps its ids and names", async () => {
		const big = "y".repeat(MAX_EVENT_CONTENT_CHARS);
		const leaves = Array.from({ length: 9 }, () =>
			big.slice(0, MAX_EVENT_CONTENT_CHARS - Math.floor(Math.random() * 1)),
		);
		const input = hook({
			prompt: "p",
			tool_use_id: "toolu_keep",
			tool_name: "Bash",
			tool_input: { parts: leaves, command: ghp },
		});
		expect(leaves.length * leaves[0]!.length).toBeGreaterThan(SENDER_PENDING_CAP_UNITS);
		const { payload, stats } = await prepare(input);
		expect(stats.backlog).toBe(true);
		expect(payload.prompt).toBe(BACKLOG_MARKER);
		expect(payload.tool_use_id).toBe("toolu_keep");
		expect(payload.tool_name).toBe("Bash");
		expect(payload.tool_input).toEqual({ _withheld: BACKLOG_MARKER });
		expect(JSON.stringify(payload)).not.toContain("dddddddd");
		expect(getIngestRedactionCounters().backlogMarkers).toBe(1);
	}, 60_000);

	test("an event batch over the sender's share is marker-only, keeping valid ids and names", async () => {
		const big = "y".repeat(MAX_EVENT_CONTENT_CHARS);
		const batch = Array.from({ length: 9 }, (_, i) =>
			ev({
				content: big,
				toolInput: { command: ghp },
				toolName: "Bash",
				providerEventType: "prompt",
				rawPayload: { tool_use_id: `toolu_${i}`, kind: "call", message: ghp },
			}),
		);
		const out = await redactEventsForStorage("s:greedy", batch);
		expect(out).toHaveLength(9);
		out.forEach((event, i) => {
			expect(event.content).toBe(BACKLOG_MARKER);
			expect(event.toolInput).toEqual({ _withheld: BACKLOG_MARKER });
			expect(event.toolResponse).toBeNull();
			expect(event.toolName).toBe("Bash");
			expect(event.rawPayload).toEqual({ tool_use_id: `toolu_${i}`, kind: "call" });
		});
		expect(JSON.stringify(out)).not.toContain("dddddddd");
	}, 60_000);

	test("an event waits for capacity, bounded, and then falls back to the marker", async () => {
		const a = "z ".repeat(2_000_000);
		const hold = (key: string) =>
			prepareHookPayloadForStorage(
				hook({
					tool_input: {
						a: a.slice(0, 1_000_000),
						b: a.slice(0, 1_000_000),
						c: a.slice(0, 1_000_000),
						d: a.slice(0, 1_000_000),
						e: a.slice(0, 1_000_000),
						f: a.slice(0, 1_000_000),
						g: a.slice(0, 1_000_000),
					},
				}),
				{ keyId: key },
			);
		const first = hold("busy");
		const second = hold("busy");
		const [r1, r2] = await Promise.all([first, second]);
		expect("refused" in r1).toBe(false);
		// The second waited for the first and was then admitted (the first finishes well inside the wait).
		expect((r2 as PreparedHookPayload).stats.backlog).toBe(false);
		expect(ADMISSION_WAIT_MS).toBe(2000);
		expect(__testing.pending().units).toBe(0);
		expect(__testing.pending().waiters).toBe(0);
	}, 60_000);
});

describe("scheduler", () => {
	test("slices of two concurrent 256 KiB single-line jobs are bounded and a turn runs between them", async () => {
		const line = `${"alpha beta gamma ".repeat(16_400)}`.slice(0, 262_144);
		let turns = 0;
		let running = true;
		const tick = () => {
			turns++;
			if (running) setImmediate(tick);
		};
		setImmediate(tick);
		const slices: Array<{ sender: string; units: number; at: number }> = [];
		__testing.setSliceObserver((info) =>
			slices.push({ sender: info.sender, units: info.units, at: turns }),
		);
		const [a, b] = await Promise.all([
			redactTextForStorage(`${line} ${ghp}`, "a"),
			redactTextForStorage(`${line} ${ghp}`, "b"),
		]);
		running = false;
		expect(a).not.toContain("dddddddd");
		expect(b).not.toContain("dddddddd");
		expect(slices.length).toBeGreaterThan(20);
		expect(Math.max(...slices.map((s) => s.units))).toBeLessThanOrEqual(SLICE_UNITS + 64);
		for (let i = 1; i < slices.length; i++) {
			expect(slices[i]!.at).toBeGreaterThan(slices[i - 1]!.at);
		}
		// Round-robin: neither sender runs twice in a row while the other has work.
		let longest = 1;
		let run = 1;
		for (let i = 1; i < slices.length; i++) {
			run = slices[i]!.sender === slices[i - 1]!.sender ? run + 1 : 1;
			longest = Math.max(longest, run);
		}
		expect(longest).toBeLessThanOrEqual(2);
	});

	test("a batch of many small events is paced by the scheduler, not run in one stretch", async () => {
		const batch = Array.from({ length: 200 }, () =>
			ev({ content: `${"word ".repeat(800)}${ghp}` }),
		);
		let turns = 0;
		let running = true;
		const tick = () => {
			turns++;
			if (running) setImmediate(tick);
		};
		setImmediate(tick);
		const slices: number[] = [];
		__testing.setSliceObserver((info) => slices.push(info.units));
		const out = await redactEventsForStorage("s:batch", batch);
		running = false;
		expect(JSON.stringify(out)).not.toContain("dddddddd");
		// Only the first slice's worth ran in place; everything else took turns.
		expect(slices.length).toBeGreaterThan(150);
		expect(turns).toBeGreaterThan(150);
		expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_UNITS + 64);
	});

	test("a small event with nothing queued is redacted with no turn at all", async () => {
		let turns = 0;
		const started = setImmediate(() => turns++);
		const text = "x".repeat(INLINE_MAX_UNITS - 10);
		const before = getIngestRedactionCounters().pendingJobs;
		const out = redactTextForStorage(text, "t");
		expect(before).toBe(0);
		await out;
		clearImmediate(started);
		expect(turns).toBe(0);
	});

	test("jobs of one sender resolve in the order they were admitted", async () => {
		const order: number[] = [];
		const sizes = [200_000, 20_000, 100_000, 20_000];
		await Promise.all(
			sizes.map((n, i) =>
				redactTextForStorage("w ".repeat(n / 2), "same").then(() => order.push(i)),
			),
		);
		expect(order).toEqual([0, 1, 2, 3]);
	});
});

describe("short fields", () => {
	test("redactShortForStorage masks and cuts", () => {
		expect(redactShortForStorage(`b-${ghp}`)).not.toContain("dddddddd");
		expect(redactShortForStorage("x".repeat(1000)).length).toBe(256);
	});
});

describe("CUT_MARGIN_CHARS", () => {
	test("is larger than any bounded rule reaches", () => {
		expect(CUT_MARGIN_CHARS).toBeGreaterThan(16_000);
	});
});
