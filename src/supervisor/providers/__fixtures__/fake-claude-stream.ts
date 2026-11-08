/**
 * A stand-in for `claude` for the takeover tests (AGEN-117 P3). Run through a one-line shell wrapper
 * (`makeFakeClaude` in `claude-fake.ts`), it answers the same stream-json wire the real binary does, with
 * frames taken from the recorded 2.1.318 fixtures, and records what it was sent so a test can hold counters
 * (user lines sent, control responses received, the argv it was started with).
 *
 *   FAKE_CLAUDE_CONFIG   path to a JSON file (see `FakeConfig`)
 *
 * Invoked as `claude --version` it prints a version; as `claude agents --json` it prints the configured
 * listing (or fails the configured way); otherwise it speaks the stream. Nothing here reads a real Claude
 * config, talks to a model or touches a transcript.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { outLines } from "./claude-frames.js";
import { isRecordedControlResponse } from "./claude-response-shapes.js";

type Step =
	| { say: Record<string, unknown> }
	| { await: "control_response" }
	| { delay: number }
	| { exit: number }
	| { hold: true };

export type FakeConfig = {
	log?: string;
	version?: string;
	/** The `account` in the initialize answer. `undefined`/missing: the key is left out. */
	account?: unknown;
	/** The `account` for a child started with `--restricted` (a login that reads differently under the flag). Absent: `account`. */
	accountRestricted?: unknown;
	initialize?: "answer" | "silent" | "error";
	initDelayMs?: number;
	/** Merged over the recorded T8 init frame for the `system/init` of each turn. */
	init?: Record<string, unknown>;
	/** Keys to remove from the init frame. */
	initOmit?: string[];
	/** One entry per user line, in order. A turn that is not listed answers the default "ok" turn. */
	turns?: Step[][];
	/** The turn run when a user line arrives and no scripted turn is left. */
	defaultTurn?: Step[];
	/** Exit when stdin closes (default true). */
	exitOnEof?: boolean;
	ignoreTerm?: boolean;
	/** `agents --json` behaviour. */
	agents?: { mode: "json" | "exit3" | "garbage" | "hang"; json?: unknown };
	/** Whether to stamp lifecycle lines with the user line's uuid (default true). */
	lifecycle?: boolean;
	sessionId?: string;
	/**
	 * Frames printed with no user line (an injected turn). Sent once initialize is answered, or, when
	 * `unpromptedTrigger` names a file, once that file exists.
	 */
	unprompted?: Record<string, unknown>[];
	unpromptedTrigger?: string;
	/**
	 * What an `interrupt` control request does (AGEN-119). Absent: the turn aborts with an `aborted_tools` result.
	 * `"ignore"`: answered success and nothing else happens (a Claude that does not stop). `{ frames }`: those
	 * frames are sent, in order, after the answer, instead of the default result (a recorded interrupted turn,
	 * a natural result, an errored one). The turn is aborted either way, so a held turn script ends.
	 */
	onInterrupt?: "ignore" | { frames: Record<string, unknown>[] };
};

const configPath = process.env.FAKE_CLAUDE_CONFIG;
const config: FakeConfig =
	configPath && existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const log = (entry: Record<string, unknown>) => {
	if (config.log) appendFileSync(config.log, `${JSON.stringify(entry)}\n`);
};

const argv = process.argv.slice(2);
const argAfter = (flag: string) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === "--version") {
	console.log(`${config.version ?? "2.1.318"} (Claude Code)`);
	process.exit(0);
}

if (argv[0] === "agents") {
	log({ ev: "agents", argv });
	const agents = config.agents ?? { mode: "json", json: [] };
	if (agents.mode === "exit3") process.exit(3);
	if (agents.mode === "hang") {
		setInterval(() => {}, 1000);
	} else if (agents.mode === "garbage") {
		console.log("banner: not json");
		process.exit(0);
	} else {
		// The listing may name the fork by pid ("$PID" is replaced by the pid of the fake that was started with the session id).
		let text = JSON.stringify(agents.json ?? []);
		const pidFile = process.env.FAKE_CLAUDE_PIDFILE;
		if (pidFile && existsSync(pidFile))
			text = text.replaceAll('"$PID"', readFileSync(pidFile, "utf8").trim());
		console.log(text);
		process.exit(0);
	}
}

if (argv[0] !== "agents") {
	const sessionId =
		config.sessionId ??
		argAfter("--session-id") ??
		argAfter("--resume") ??
		"00000000-0000-4000-8000-000000000000";
	log({
		ev: "start",
		pid: process.pid,
		argv,
		cwd: process.cwd(),
		skip: process.env.AGENTPULSE_SKIP ?? null,
		envKeys: Object.keys(process.env)
			.filter((k) => /^(CLAUDE|ANTHROPIC|AGENTPULSE|AI_AGENT)/i.test(k))
			.sort(),
	});
	if (process.env.FAKE_CLAUDE_PIDFILE) {
		Bun.write(process.env.FAKE_CLAUDE_PIDFILE, String(process.pid));
	}
	if (config.ignoreTerm) process.on("SIGTERM", () => log({ ev: "sigterm-ignored" }));

	const baseInit = (outLines("t8-fork-init").find(
		(m) => m.type === "system" && m.subtype === "init",
	) ?? {}) as Record<string, unknown>;
	// Requests the fake has asked and not had answered: an answer for anything else is stray, as it is to real
	// Claude (measured: ignored), and releases nothing.
	const openRequests = new Set<string>();
	const emit = (frame: Record<string, unknown>) => {
		if (frame.type === "control_request" && typeof frame.request_id === "string") {
			openRequests.add(frame.request_id);
		}
		process.stdout.write(`${JSON.stringify(frame)}\n`);
	};
	const sub = (value: unknown, uuid: string | null): unknown => {
		if (typeof value === "string") {
			return value.replaceAll("$SESSION", sessionId).replaceAll("$UUID", uuid ?? "");
		}
		if (Array.isArray(value)) return value.map((v) => sub(v, uuid));
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) out[k] = sub(v, uuid);
			return out;
		}
		return value;
	};
	const initFrame = (uuid: string | null) => {
		const frame: Record<string, unknown> = { ...baseInit, session_id: sessionId };
		// What the real binary does: `--restricted` leaves out the messaging socket and the memory paths.
		const omit = new Set(config.initOmit ?? []);
		if (argv.includes("--restricted")) {
			omit.add("messaging_socket_path");
			omit.add("memory_paths");
		}
		for (const key of ["messaging_socket_path", "memory_paths"]) {
			if (omit.has(key)) frame[key] = undefined;
		}
		Object.assign(frame, config.init);
		for (const key of config.initOmit ?? []) frame[key] = undefined;
		if (uuid) frame.user_message_uuids = [uuid];
		return frame;
	};
	const defaultTurn = (): Step[] => [
		{ say: { type: "system", subtype: "init" } },
		{
			say: {
				type: "assistant",
				session_id: "$SESSION",
				message: {
					role: "assistant",
					model: "claude-haiku-5-5",
					content: [{ type: "text", text: "ok" }],
				},
			},
		},
		{
			say: {
				type: "result",
				subtype: "success",
				is_error: false,
				terminal_reason: "completed",
				session_id: "$SESSION",
				result: "ok",
				total_cost_usd: 0,
				user_message_uuids: ["$UUID"],
			},
		},
	];

	let controlResponses = 0;
	let waiter: (() => void) | null = null;
	let aborted = false;
	let turnsStarted = 0;
	let userLines = 0;
	let currentUuid: string | null = null;

	async function runTurn(steps: Step[], uuid: string | null) {
		aborted = false;
		currentUuid = uuid;
		for (const step of steps) {
			if (aborted) return;
			if ("say" in step) {
				const frame = step.say as Record<string, unknown>;
				// A bare `{type:"system", subtype:"init"}` is the template; anything with more keys is sent as written.
				if (frame.type === "system" && frame.subtype === "init" && Object.keys(frame).length === 2)
					emit(initFrame(uuid));
				else emit(sub(frame, uuid) as Record<string, unknown>);
			} else if ("delay" in step) {
				await Bun.sleep(step.delay);
			} else if ("await" in step) {
				const before = controlResponses;
				while (controlResponses === before && !aborted)
					await new Promise<void>((resolve) => {
						waiter = resolve;
					});
			} else if ("exit" in step) {
				process.exit(step.exit);
			} else if ("hold" in step) {
				while (!aborted) await Bun.sleep(25);
				return;
			}
		}
	}

	let unpromptedSent = false;
	const sendUnprompted = () => {
		if (unpromptedSent) return;
		unpromptedSent = true;
		for (const frame of config.unprompted ?? []) emit(sub(frame, null) as Record<string, unknown>);
	};
	if (config.unprompted && config.unpromptedTrigger) {
		const trigger = config.unpromptedTrigger;
		const poll = setInterval(() => {
			if (existsSync(trigger)) {
				clearInterval(poll);
				sendUnprompted();
			}
		}, 20);
	}

	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
			if (line.trim()) void onLine(line);
		}
	});
	process.stdin.on("end", () => {
		log({ ev: "stdin-eof" });
		if (config.exitOnEof !== false) process.exit(0);
	});

	async function onLine(line: string) {
		let message: Record<string, any>;
		try {
			message = JSON.parse(line);
		} catch {
			log({ ev: "bad-line" });
			return;
		}
		if (message.type === "control_request") {
			const subtype = message.request?.subtype;
			log({ ev: "control_request", subtype });
			if (subtype === "initialize") {
				if (config.initialize === "silent") return;
				if (config.initDelayMs) await Bun.sleep(config.initDelayMs);
				if (config.initialize === "error") {
					emit({
						type: "control_response",
						response: { subtype: "error", request_id: message.request_id, error: "no" },
					});
					return;
				}
				const response: Record<string, unknown> = { commands: [], agents: [] };
				const account =
					argv.includes("--restricted") && "accountRestricted" in config
						? config.accountRestricted
						: config.account;
				if (account !== undefined) response.account = account;
				emit({
					type: "control_response",
					response: { subtype: "success", request_id: message.request_id, response },
				});
				if (!config.unpromptedTrigger) sendUnprompted();
			} else if (subtype === "interrupt") {
				const ignore = config.onInterrupt === "ignore";
				if (!ignore) {
					aborted = true;
					waiter?.();
				}
				emit({
					type: "control_response",
					response: {
						subtype: "success",
						request_id: message.request_id,
						response: { still_queued: [] },
					},
				});
				if (ignore) return;
				if (config.onInterrupt && typeof config.onInterrupt === "object") {
					for (const frame of config.onInterrupt.frames)
						emit(sub(frame, currentUuid) as Record<string, unknown>);
				} else {
					emit({
						type: "result",
						subtype: "error_during_execution",
						is_error: true,
						terminal_reason: "aborted_tools",
						session_id: sessionId,
					});
				}
			}
			return;
		}
		if (message.type === "control_response") {
			const answeredId = message.response?.request_id;
			const stray = typeof answeredId !== "string" || !openRequests.delete(answeredId);
			if (!stray) controlResponses++;
			log({
				ev: "control_response",
				response: message.response,
				valid: isRecordedControlResponse(message),
				requestId: answeredId,
				stray,
			});
			if (!stray) waiter?.();
			return;
		}
		if (message.type === "user") {
			userLines++;
			const uuid = typeof message.uuid === "string" ? message.uuid : null;
			log({ ev: "user", n: userLines, uuid, text: message.message?.content?.[0]?.text });
			if (uuid && config.lifecycle !== false) {
				emit({
					type: "command_lifecycle",
					command_uuid: uuid,
					state: "queued",
					uuid: crypto.randomUUID(),
					session_id: sessionId,
				});
				emit({
					type: "command_lifecycle",
					command_uuid: uuid,
					state: "started",
					uuid: crypto.randomUUID(),
					session_id: sessionId,
				});
			}
			const scripted = config.turns?.[turnsStarted++];
			await runTurn(scripted ?? config.defaultTurn ?? defaultTurn(), uuid);
		}
	}
	setInterval(() => {}, 1000);
}
