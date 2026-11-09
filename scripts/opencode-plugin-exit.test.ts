/**
 * AGEN-141: the exit flush. A one-shot "opencode run" exits right after the turn ends and the plugin's chain may
 * not have sent the last items. At exit the plugin sends what is queued with a synchronous curl, within 300 ms,
 * for a directory it already judged "send" in this process. Real curl runs through a logging wrapper, against a
 * collector in another process (a synchronous curl would block one in this process).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rig } from "./lib/opencode-plugin-common-tests.ts";
import {
	type Line,
	recordOf,
	scratchDir,
	settle,
	startRemoteCollector,
} from "./lib/opencode-plugin-kit.ts";

const SID = "ses_exit00000000000000001";
// Built in two parts so the repo-wide redactor self-scan does not read this file as holding a credential.
const AUTH_PREFIX = ["Authorization: ", "Bearer "].join("");
const remotes: Array<() => unknown> = [];
afterEach(() => {
	while (remotes.length) remotes.pop()?.();
});

function wrapper() {
	const dir = scratchDir("curlwrap");
	const log = join(dir, "log.txt");
	const script = join(dir, "curl");
	writeFileSync(
		script,
		`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"\nprintf -- '--end--\\n' >> "${log}"\nexec /usr/bin/curl "$@"\n`,
	);
	chmodSync(script, 0o755);
	return {
		script,
		args: () =>
			existsSync(log)
				? (readFileSync(log, "utf8") as string).split("--end--\n").filter(Boolean)
				: [],
	};
}

async function setup(line: Line, argv: string[], direct = false) {
	const remote = await startRemoteCollector();
	remotes.push(remote.stop);
	const w = wrapper();
	const r = await rig(line, { url: remote.url, direct, seam: { curl: w.script, argv } as never });
	const flush = () => (r.seam as unknown as { exitFlush: () => void }).exitFlush();
	// One item goes out the normal way so the directory has a "send" verdict in this process.
	r.drv.created(SID, r.dir);
	await r.drv.flush();
	await settle(line);
	return { r, remote, w, flush };
}

const RUN = ["bun", "/$bunfs/root/opencode", "run", "go"];

for (const line of ["v1", "v2"] as const) {
	describe(`${line} plugin: the exit flush`, () => {
		test("a one-shot run sends what is queued at exit; argv holds no body, no key and no -L", async () => {
			const { r, remote, w, flush } = await setup(line, RUN);
			remote.hang(true);
			for (let i = 0; i < 3; i++)
				r.drv.before(SID, `call_${i}`, "bash", { secret: `BODYTEXT${i}` });
			await new Promise((res) => setTimeout(res, 30));
			remote.hang(false);
			const before = remote.read().length;
			flush();
			const got = remote.read().slice(before);
			expect(
				got.filter((x) => String(x.body?.hook_event_name).endsWith("before")).length,
			).toBeGreaterThanOrEqual(3);
			const all = w.args().join("\n");
			expect(all).not.toContain("BODYTEXT");
			expect(all).not.toContain("ap_");
			expect(all).not.toMatch(/(^|\n)-L(\n|$)/);
			expect(all).toContain("/api/v1/hooks?event=");
			expect(all).toContain("X-Agent-Type: opencode");
			expect(all).toContain("X-AgentPulse-Delivery-Id: ");
		});

		test("a hanging server costs at most 350 ms at exit", async () => {
			const { r, remote, flush } = await setup(line, RUN);
			remote.hang(true);
			for (let i = 0; i < 10; i++) r.drv.before(SID, `call_${i}`, "bash", { a: i });
			await new Promise((res) => setTimeout(res, 30));
			const t = performance.now();
			flush();
			expect(performance.now() - t).toBeLessThan(350);
		});

		test("a long-lived serve process flushes nothing at exit", async () => {
			const { r, remote, flush } = await setup(line, ["bun", "x", "serve", "--port", "4096"]);
			remote.hang(true);
			r.drv.before(SID, "call_0", "bash", { a: 1 });
			await new Promise((res) => setTimeout(res, 30));
			remote.hang(false);
			const before = remote.read().length;
			flush();
			expect(remote.read().length).toBe(before);
		});

		test("2.x's private server, serve --stdio, is one-shot", async () => {
			const { r, remote, flush } = await setup(line, [
				"bun",
				"x",
				"serve",
				"--stdio",
				"--port",
				"0",
			]);
			remote.hang(true);
			r.drv.before(SID, "call_0", "bash", { a: 1 });
			await new Promise((res) => setTimeout(res, 30));
			remote.hang(false);
			const before = remote.read().length;
			flush();
			expect(remote.read().length - before).toBeGreaterThanOrEqual(1);
		});

		test("a directory with no verdict yet sends nothing at exit (no gate runs at exit)", async () => {
			const { remote, flush } = await setup(line, RUN);
			recordOf(line).sessions.set("ses_nothing0000000000001", {
				q: [
					{
						body: "{}",
						size: 2,
						dirs: ["/never/judged"],
						key: "k",
						sid: "ses_nothing0000000000001",
						name: "x",
					},
				],
				bytes: 2,
				running: false,
				dead: false,
				calls: new Map(),
				roles: new Map(),
				texts: new Map(),
				perms: new Map(),
			});
			const before = remote.read().length;
			flush();
			expect(remote.read().length).toBe(before);
		});

		test("direct mode: no key file sends without Authorization, a trusted one passes the file to curl, an untrusted one sends nothing", async () => {
			for (const mode of ["none", "good", "bad", "garbled"] as const) {
				const { r, remote, w, flush } = await setup(line, RUN, true);
				if (mode !== "none") {
					mkdirSync(join(r.home, ".agentpulse"), { recursive: true });
					const file = join(r.home, ".agentpulse", "hook-auth-header");
					writeFileSync(
						file,
						mode === "garbled" ? "not a credential line\n" : `${AUTH_PREFIX}ap_exitkey\n`,
					);
					chmodSync(file, mode === "bad" ? 0o666 : 0o600);
				}
				// The item is still queued: the flush runs before the chain's first microtask.
				const before = remote.read().length;
				r.drv.before(SID, "call_x", "bash", { a: 1 });
				flush();
				const flushed = remote
					.read()
					.slice(before)
					.filter((x) => String(x.body?.hook_event_name).endsWith("before"));
				if (mode === "bad" || mode === "garbled") expect(flushed.length).toBe(0);
				else {
					expect(flushed.length).toBeGreaterThanOrEqual(1);
					expect(flushed[0]?.headers.authorization).toBe(
						mode === "good" ? "Bearer ap_exitkey" : undefined,
					);
				}
				expect(w.args().join("\n")).not.toContain("ap_exitkey");
			}
		});
	});
}
