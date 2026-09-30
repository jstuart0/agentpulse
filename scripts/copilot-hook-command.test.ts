/**
 * Phase 7 (D7/D8/D13): replays every Copilot fixture through the *generated*
 * sh command with `sh -c` (not bash — the generated command is POSIX sh,
 * see src/shared/hook-command.test.ts's "posix sh compatibility" suite),
 * against a real stub HTTP server.
 *
 * Mirrors scripts/codex-hook-command.test.ts's "fixture replay (item 3)"
 * describe block, which loops CODEX_EVENTS only — Copilot's own 10
 * registered events had no equivalent per-event byte-exact delayed-delivery
 * replay of their own (the item-13 safety matrix in that file exercises
 * every Copilot fixture too, but for no-stdout/never-fail-closed/bounded
 * behavior, not for body/header/query byte-exactness).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBashHookCommand } from "../src/shared/hook-command.js";

const COPILOT_FIXTURES_DIR = join(
	import.meta.dir,
	"../src/server/services/agents/__fixtures__/copilot",
);

const COPILOT_EVENTS = [
	"sessionStart",
	"sessionEnd",
	"userPromptSubmitted",
	"postToolUse",
	"postToolUseFailure",
	"agentStop",
	"subagentStart",
	"subagentStop",
	"preCompact",
	"errorOccurred",
];

type Recorded = {
	method: string;
	path: string;
	search: string;
	body: string;
	headers: Record<string, string>;
};

function startStub() {
	const requests: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const body = await req.text();
			requests.push({
				method: req.method,
				path: url.pathname,
				search: url.search,
				body,
				headers: Object.fromEntries(req.headers),
			});
			return new Response("ok", { status: 200 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

async function runSh(
	cmd: string,
	stdin: Uint8Array | string,
	env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["sh", "-c", cmd], {
		stdin: typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 3000,
	stepMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(stepMs);
	}
	return await check();
}

function baseEnv(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: join(home, "tmp"),
	};
}

async function loadFixture(name: string): Promise<Uint8Array> {
	return new Uint8Array(await Bun.file(join(COPILOT_FIXTURES_DIR, `${name}.json`)).arrayBuffer());
}

let tmp: string;
const stops: Array<() => unknown> = [];

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-copilot-hook-cmd-"));
}, 30_000);

afterEach(async () => {
	while (stops.length) {
		const stop = stops.pop();
		if (stop) await Promise.resolve(stop());
	}
	await rm(tmp, { recursive: true, force: true });
}, 30_000);

describe("copilot-hook-command.test.ts — fixture replay (Phase 7 punch item 4)", () => {
	for (const event of COPILOT_EVENTS) {
		test(`${event}: byte-exact body, right headers and ?event=, delivered detached, temp file removed`, async () => {
			const stub = startStub();
			stops.push(stub.stop);
			const home = join(tmp, `home-${event}`);
			const tmpDir = join(home, "tmp");
			await mkdir(tmpDir, { recursive: true });

			const cmd = buildBashHookCommand({
				baseUrl: stub.url,
				direct: false,
				agent: "copilot_cli",
				event,
			});
			const fixture = await loadFixture(event);
			const result = await runSh(cmd, fixture, baseEnv(home));

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");

			const delivered = await waitFor(() => stub.requests.length > 0);
			expect(delivered).toBe(true);
			const req = stub.requests[0];
			expect(req.search).toBe(`?event=${event}`);
			expect(req.headers["x-agent-type"]).toBe("copilot_cli");
			expect(new TextDecoder().decode(fixture)).toBe(req.body);

			// The generated command's own mktemp file (`$t`) is removed after
			// delivery — the per-test TMPDIR is empty once the async subshell
			// finishes, not just once `sh -c` itself has returned.
			expect(await waitFor(async () => (await readdir(tmpDir)).length === 0, 5000)).toBe(true);
		});
	}
});
