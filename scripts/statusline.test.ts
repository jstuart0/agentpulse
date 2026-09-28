/**
 * Phase 3 (D17, bob L1): statusline.sh pushes a native name only when it
 * differs from the cached last push, confines its cache to cache/, never
 * sends an unsafe session id over the wire, and appends the relay status hint
 * without breaking the one-line statusline protocol.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "statusline.sh");

type Recorded = { method: string; path: string; body: string };

let tmp: string;
let requests: Recorded[];
let server: ReturnType<typeof Bun.serve>;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-statusline-test-"));
	requests = [];
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? "" : await req.text();
			requests.push({ method: req.method, path: url.pathname, body });
			if (req.method === "GET" && url.pathname.startsWith("/api/v1/sessions/")) {
				return Response.json({ session: { displayName: "brave-falcon" } });
			}
			if (req.method === "PUT" && url.pathname.endsWith("/native-name")) {
				return Response.json({ ok: true, applied: false });
			}
			return new Response("not found", { status: 404 });
		},
	});
});

afterEach(async () => {
	server.stop(true);
	await rm(tmp, { recursive: true, force: true });
});

const agentpulseDir = () => join(tmp, "agentpulse");

async function run(input: Record<string, unknown>) {
	const proc = Bun.spawn(["bash", SCRIPT], {
		stdin: new TextEncoder().encode(JSON.stringify(input)),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: tmp,
			AGENTPULSE_PORT: String(server.port),
			AGENTPULSE_DIR: agentpulseDir(),
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { stdout, stderr, code: proc.exitCode };
}

const puts = () => requests.filter((r) => r.method === "PUT");

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pred()) return;
		await Bun.sleep(25);
	}
	throw new Error("timed out");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes from captured terminal output
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function listRecursive(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, { recursive: true })) as string[];
	} catch {
		return [];
	}
}

describe("statusline.sh", () => {
	test("carries the agentpulse-statusline marker", async () => {
		expect(await readFile(SCRIPT, "utf-8")).toContain("# agentpulse-statusline");
	});

	test("same name twice → one PUT; a different name → a second PUT", async () => {
		const input = {
			session_id: "abc-123_X",
			session_name: "my-thread",
			model: { display_name: "M" },
		};
		await run(input);
		const cacheFile = join(agentpulseDir(), "cache", "native-name-abc-123_X");
		await waitFor(() => puts().length === 1);
		await waitFor(() => Bun.file(cacheFile).exists());
		expect(await readFile(cacheFile, "utf-8")).toBe("my-thread");

		await run(input);
		await Bun.sleep(400);
		expect(puts()).toHaveLength(1);

		await run({ ...input, session_name: "renamed-thread" });
		await waitFor(() => puts().length === 2);
		expect(JSON.parse(puts()[1].body)).toEqual({ name: "renamed-thread" });
		expect(puts()[1].path).toBe("/api/v1/sessions/abc-123_X/native-name");
	});

	test("a failed push is not cached, so the next render retries", async () => {
		server.stop(true);
		const input = { session_id: "retry-1", session_name: "n1" };
		await run(input);
		await Bun.sleep(300);
		expect(await Bun.file(join(agentpulseDir(), "cache", "native-name-retry-1")).exists()).toBe(
			false,
		);
	});

	test("a session_id containing ../ never escapes cache/ and is never sent to the relay", async () => {
		const { stdout, code } = await run({ session_id: "../../escape", session_name: "evil" });
		expect(code).toBe(0);
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
		await Bun.sleep(400);
		expect(requests).toEqual([]);
		for (const rel of await listRecursive(tmp)) {
			if (rel.includes("escape")) expect(rel.startsWith(join("agentpulse", "cache"))).toBe(true);
		}
		expect(await Bun.file(join(tmp, "escape")).exists()).toBe(false);
		expect(await Bun.file(join(agentpulseDir(), "escape")).exists()).toBe(false);
	});

	test("status file present → the single stdout line ends with the hint", async () => {
		await mkdir(agentpulseDir(), { recursive: true });
		await writeFile(join(agentpulseDir(), "status"), "key lacks observe — re-run setup-relay\n");
		const { stdout, code } = await run({ session_id: "s-1", model: { display_name: "M" } });
		expect(code).toBe(0);
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		expect(
			stripAnsi(lines[0]).endsWith(" · agentpulse: key lacks observe — re-run setup-relay"),
		).toBe(true);
	});

	test("control characters in the status file cannot inject a second line", async () => {
		await mkdir(agentpulseDir(), { recursive: true });
		await writeFile(join(agentpulseDir(), "status"), "first\rline\u001b[2J\nsecond line\n");
		const { stdout } = await run({ session_id: "s-2" });
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\r");
		expect(lines[0]).not.toContain("second line");
	});

	test("no status file → no hint", async () => {
		const { stdout } = await run({ session_id: "s-3", model: { display_name: "M" } });
		expect(stdout).not.toContain("agentpulse:");
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
	});
});
