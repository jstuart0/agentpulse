/**
 * AGEN-117 P3 item 1: three questions about the wire only real Claude Code can answer, asked of the real
 * binary: what does it do with an `allow` that has no `updatedInput`, with an answer for a request id it
 * never sent, and with a second answer to the same request. The expected outcomes are committed beside the
 * fixtures (`real-outcomes.json`), so a Claude change that moves one fails here.
 *
 * SKIPPED unless `AGENTPULSE_CLAUDE_REAL=1` (the canary sets it), and it spends nothing when skipped: no
 * process, no key read, no file touched. When it runs, it goes only through `scripts/lib/claude-canary-spawn`
 * (a throwaway home inside `AGENTPULSE_CLAUDE_REAL_SCRATCH`, the cheapest model, a budget cap, a kill timer
 * on every child), and the key comes from the environment of the command that runs it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeStream } from "../../../scripts/lib/claude-canary-spawn.js";
import { CLAUDE_FIXTURE_DIR } from "./__fixtures__/claude-frames.js";
import { probeArgv } from "./claude-argv.js";

const ENABLED = process.env.AGENTPULSE_CLAUDE_REAL === "1";
const MODEL = "claude-haiku-5-5";

type Line = Record<string, any>;

const expected = () =>
	JSON.parse(readFileSync(join(CLAUDE_FIXTURE_DIR, "real-outcomes.json"), "utf8"));

describe.skipIf(!ENABLED)("real Claude Code: how it treats an answer it did not expect", () => {
	const scratch = process.env.AGENTPULSE_CLAUDE_REAL_SCRATCH ?? "";
	const key = process.env.ANTHROPIC_API_KEY;

	async function session(
		name: string,
		drive: (s: ClaudeStream, cwd: string, request: Line) => Promise<Record<string, unknown>>,
	) {
		if (!scratch || !key)
			throw new Error(
				"set AGENTPULSE_CLAUDE_REAL_SCRATCH and the key in the environment of this command",
			);
		const root = join(scratch, name);
		const home = join(root, "home");
		const configDir = join(root, "cfg");
		const cwd = join(root, "work");
		for (const dir of [home, configDir, cwd]) mkdirSync(dir, { recursive: true });
		const stream = new ClaudeStream(
			[...probeArgv({ mode: "ask" }), "--model", MODEL, "--max-budget-usd", "0.10"],
			{ scratchRoot: scratch, home, configDir, cwd, key, secrets: [key], timeoutMs: 120_000 },
		);
		try {
			stream.initialize();
			await stream.waitFor((l) => l.type === "control_response", 20_000);
			stream.user(
				"Use the Write tool to create a file named real.txt in the current directory containing exactly: hi. Do nothing else.",
			);
			const request = await stream.waitFor(
				(l) => l.type === "control_request" && (l.request as Line)?.subtype === "can_use_tool",
				60_000,
			);
			expect(request, "Claude asked for the Write").toBeDefined();
			return await drive(stream, cwd, request as Line);
		} finally {
			await stream.finish();
		}
	}

	const toolResults = (s: ClaudeStream, toolUseId: string) =>
		s.lines.filter(
			(l) =>
				l.type === "user" &&
				Array.isArray((l.message as Line)?.content) &&
				((l.message as Line).content as Line[]).some(
					(b) => b.type === "tool_result" && b.tool_use_id === toolUseId,
				),
		);

	test("an allow with no updatedInput runs the tool", async () => {
		const outcome = await session("missing", async (s, cwd, req) => {
			s.respond(req.request_id, { behavior: "allow" });
			await s.waitFor((l) => l.type === "result", 60_000);
			return { toolRan: existsSync(join(cwd, "real.txt")) };
		});
		expect(outcome).toEqual(expected().missing_updatedInput);
	}, 150_000);

	test("an answer for a request id Claude never sent is ignored; the request waits for its own", async () => {
		const outcome = await session("wrongid", async (s, cwd, req) => {
			const toolUseId = (req.request as Line).tool_use_id as string;
			s.respond("never-asked-by-claude", {
				behavior: "allow",
				updatedInput: (req.request as Line).input,
			});
			await Bun.sleep(4_000);
			const ignored = toolResults(s, toolUseId).length === 0 && !existsSync(join(cwd, "real.txt"));
			s.respond(req.request_id, { behavior: "deny", message: "no" });
			await s.waitFor((l) => l.type === "result", 60_000);
			return { ignoredUntilCorrectId: ignored && toolResults(s, toolUseId).length >= 1 };
		});
		expect(outcome).toEqual(expected().wrong_request_id);
	}, 150_000);

	test("a second answer to the same request is ignored: the first one wins", async () => {
		const outcome = await session("duplicate", async (s, cwd, req) => {
			const toolUseId = (req.request as Line).tool_use_id as string;
			s.respond(req.request_id, { behavior: "deny", message: "first answer" });
			s.respond(req.request_id, { behavior: "allow", updatedInput: (req.request as Line).input });
			// A retry of the call is a new request with a new id: deny it so the turn can end.
			const deadline = Date.now() + 60_000;
			let handled = 1;
			while (Date.now() < deadline && !s.lines.some((l) => l.type === "result")) {
				const next = s.lines.filter((l) => l.type === "control_request").at(handled);
				if (next) {
					s.respond(next.request_id as string, { behavior: "deny", message: "again" });
					handled++;
				}
				await Bun.sleep(100);
			}
			const results = toolResults(s, toolUseId);
			const text = JSON.stringify(results[0] ?? {});
			return {
				toolResultsForFirstCall: results.length,
				firstAnswerWins: text.includes("first answer") && !existsSync(join(cwd, "real.txt")),
			};
		});
		expect(outcome).toEqual(expected().duplicate_response);
	}, 150_000);
});

describe("the real-binary test is opt-in", () => {
	test("it is skipped without the opt-in variable, and its expected outcomes are committed", () => {
		if (!ENABLED) expect(ENABLED).toBe(false);
		const outcomes = expected();
		expect(outcomes.version).toBe("2.1.318");
		for (const key of ["missing_updatedInput", "wrong_request_id", "duplicate_response"]) {
			expect(outcomes).toHaveProperty(key);
		}
	});
});
