/**
 * Post-merge E3 (D19, event-dedup's test-contract.md "Post-merge: E2, E3,
 * E3-canon"): "the sibling's shim writes exactly the marker the observer
 * reads."
 *
 * Runs the SIBLING campaign's (cli-parity's) generated Codex hook shim —
 * buildBashHookCommand's actual output, the exact text every installer
 * writes into hooks.json, not a hand-copied approximation — against a
 * vendored native Codex PreToolUse fixture on stdin, with the server URL
 * pointed at a closed port (curl fails; the marker write happens first, in
 * the detached subshell, so it must still land). Then proves the
 * event-dedup observer's own isNativeCovered/codexNativeMarkerPath/
 * processRolloutFile see exactly what the shim wrote.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildBashHookCommand } from "../../shared/hook-command.js";
import { NO_EXCLUDE_RULES } from "./codex-observer-test-support.js";

const { codexNativeMarkerPath, isNativeCovered, processRolloutFile } = await import(
	"./codex-observer.js"
);

const PRE_TOOL_USE_FIXTURE = join(
	import.meta.dir,
	"../../server/services/agents/__fixtures__/codex/PreToolUse.json",
);

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

async function findClosedPort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port as number;
	probe.stop(true);
	return port;
}

async function runShim(
	stdinText: string,
	home: string,
	closedPort: number,
): Promise<{ code: number | null }> {
	const cmd = buildBashHookCommand({
		baseUrl: `http://127.0.0.1:${closedPort}`,
		direct: false,
		agent: "codex_cli",
		event: "PreToolUse",
	});
	const proc = Bun.spawn(["sh", "-c", cmd], {
		stdin: new TextEncoder().encode(stdinText),
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home },
	});
	const code = await proc.exited;
	return { code };
}

function listAllFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else out.push(relative(dir, p));
		}
	};
	walk(dir);
	return out;
}

describe("E3 (D19): the sibling's shim writes exactly the marker the observer reads", () => {
	test("a real native PreToolUse fixture through the generated shim writes the marker the observer sees", async () => {
		const home = mkTmp("ap-e3-home-");
		const closedPort = await findClosedPort();
		const fixtureRaw = readFileSync(PRE_TOOL_USE_FIXTURE, "utf-8");
		const fixture = JSON.parse(fixtureRaw) as { session_id: string };
		const sid = fixture.session_id;

		const { code } = await runShim(fixtureRaw, home, closedPort);
		// D13: the shim never fails closed — exit 0 regardless of curl's outcome.
		expect(code).toBe(0);

		const markerPath = codexNativeMarkerPath(home, sid);
		const deadline = Date.now() + 5_000;
		while (!existsSync(markerPath) && Date.now() < deadline) {
			await Bun.sleep(25);
		}
		expect(existsSync(markerPath)).toBe(true);
		expect(statSync(markerPath).isFile()).toBe(true);
		expect(statSync(markerPath).size).toBe(0);

		expect(isNativeCovered(sid, home)).toBe(true);

		// A rollout for this now-covered session posts 0 hooks: the observer
		// stands down once the marker exists.
		const rolloutDir = mkTmp("ap-e3-rollout-");
		const rolloutPath = join(rolloutDir, "rollout.jsonl");
		await Bun.write(
			rolloutPath,
			`${JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: "/tmp/e3" } })}\n`,
		);
		let postCount = 0;
		const fetchImpl = async () => {
			postCount++;
			return new Response("{}", { status: 200 });
		};
		await processRolloutFile(
			rolloutPath,
			undefined,
			"http://x",
			null,
			new Map(),
			fetchImpl,
			home,
			NO_EXCLUDE_RULES,
		);
		expect(postCount).toBe(0);
	});

	test("a stdin session_id of '../evil' creates no marker file anywhere under the codex-native tree", async () => {
		const home = mkTmp("ap-e3-evil-home-");
		const closedPort = await findClosedPort();
		const evilPayload = JSON.stringify({
			session_id: "../evil",
			hook_event_name: "PreToolUse",
			cwd: "/tmp/evil",
		});

		const { code } = await runShim(evilPayload, home, closedPort);
		expect(code).toBe(0);

		// Give the detached subshell a beat, then assert no file exists
		// anywhere under $home — not just at the naive joined path.
		await Bun.sleep(300);
		const agentpulseDir = join(home, ".agentpulse");
		const allFiles = listAllFiles(agentpulseDir);
		const evilFiles = allFiles.filter((f) => f.includes("evil"));
		expect(evilFiles).toEqual([]);
	});
});
