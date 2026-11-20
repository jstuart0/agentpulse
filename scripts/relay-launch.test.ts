/**
 * The relay launcher (AGEN-155, 6.5): the POSIX sh file the service units run. It is read here out of
 * setup-relay.sh (the one place it is written), given throwaway paths, and run with `/bin/sh` and a fake
 * Bun that records what it was started with. Nothing here touches the real ~/.agentpulse, launchd or
 * systemd: every path is a temp directory and every process is one this test started.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETUP_RELAY = readFileSync(join(import.meta.dir, "setup-relay.sh"), "utf-8");
const RELAY_SRC = join(import.meta.dir, "relay.ts");
const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The launcher text as setup-relay.sh writes it, before its three paths are filled in. */
function launcherTemplate(): string {
	const lines = SETUP_RELAY.split("\n");
	const open = lines.findIndex((line) => line.includes("<<'AP_RELAY_LAUNCHER_EOF'"));
	const end = lines.indexOf("AP_RELAY_LAUNCHER_EOF", open + 1);
	expect(open).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(open);
	return `${lines.slice(open + 1, end).join("\n")}\n`;
}

interface Rig {
	dir: string;
	pending: string;
	prev: string;
	relay: string;
	refused: string;
	launcher: string;
	bunLog: string;
	/** Runs the launcher once and returns what the fake Bun was started with. */
	run(): { status: number | null; started: string[]; launcherEnv: string };
}

function rig(prevText = "// previous relay\n"): Rig {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-launch-")));
	roots.push(dir);
	const bunLog = join(dir, "bun.log");
	const bun = join(dir, "fake-bun");
	writeFileSync(
		bun,
		`#!/bin/sh\nprintf '%s|%s\\n' "$*" "$AGENTPULSE_RELAY_LAUNCHER" >> '${bunLog}'\n`,
		{ mode: 0o700 },
	);
	chmodSync(bun, 0o700);
	const relay = join(dir, "relay.ts");
	writeFileSync(relay, "// new relay\n");
	const prev = join(dir, "relay.ts.prev");
	writeFileSync(prev, prevText);
	const config = join(dir, "config.json");
	const launcher = join(dir, "relay-launch.sh");
	writeFileSync(
		launcher,
		launcherTemplate()
			.replaceAll("@@AP_RELAY_DIR@@", dir)
			.replaceAll("@@AP_BUN@@", bun)
			.replaceAll("@@AP_CONFIG@@", config),
		{ mode: 0o700 },
	);
	return {
		dir,
		pending: join(dir, "relay-pending.json"),
		prev,
		relay,
		refused: join(dir, "relay-update-refused.json"),
		launcher,
		bunLog,
		run() {
			writeFileSync(bunLog, "");
			const proc = Bun.spawnSync(["/bin/sh", launcher], {
				env: { PATH: "/usr/bin:/bin" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const started = readFileSync(bunLog, "utf-8").split("\n").filter(Boolean);
			return { status: proc.exitCode, started, launcherEnv: started[0]?.split("|")[1] ?? "" };
		},
	};
}

const pendingText = (attempts: number | string, version = "0.12.0") =>
	`{"version":"${version}","attempts":${attempts}}\n`;

describe("the launcher starts the relay as the launcher", () => {
	test("with nothing pending it starts the relay with AGENTPULSE_RELAY_LAUNCHER=1 and leaves every file alone", () => {
		const r = rig();
		const out = r.run();
		expect(out.started).toEqual([`${r.relay} --config ${join(r.dir, "config.json")}|1`]);
		expect(readFileSync(r.relay, "utf-8")).toBe("// new relay\n");
		expect(existsSync(r.pending)).toBe(false);
		expect(existsSync(r.refused)).toBe(false);
	});

	test("the template is POSIX sh: dash (or the platform sh) parses it", () => {
		const r = rig();
		const proc = Bun.spawnSync(["/bin/sh", "-n", r.launcher]);
		expect(proc.exitCode).toBe(0);
		// and it names no bash-only syntax
		expect(launcherTemplate()).not.toMatch(/\[\[|\bfunction\b|<<<|\$'|local /);
	});
});

describe("two failed starts put the previous relay back", () => {
	test("each start counts up; at attempts 2 the previous relay is restored, the version is recorded and the pending file goes", () => {
		const r = rig();
		writeFileSync(r.pending, pendingText(0), { mode: 0o600 });

		expect(r.run().started).toHaveLength(1);
		expect(readFileSync(r.pending, "utf-8")).toBe(`${pendingText(1).trimEnd()}\n`);
		expect(readFileSync(r.relay, "utf-8")).toBe("// new relay\n");

		expect(r.run().started).toHaveLength(1);
		expect(readFileSync(r.pending, "utf-8")).toContain('"attempts":2');
		expect(readFileSync(r.relay, "utf-8")).toBe("// new relay\n");

		// The third start finds attempts >= 2: the second one never served.
		const third = r.run();
		expect(third.started).toHaveLength(1);
		expect(readFileSync(r.relay, "utf-8")).toBe("// previous relay\n");
		expect(existsSync(r.prev)).toBe(false);
		expect(existsSync(r.pending)).toBe(false);
		expect(JSON.parse(readFileSync(r.refused, "utf-8"))).toEqual({ version: "0.12.0" });

		// And after that it is an ordinary start again.
		expect(r.run().started).toHaveLength(1);
		expect(readFileSync(r.relay, "utf-8")).toBe("// previous relay\n");
	});

	test("with the pending file already at 2 and no .prev, nothing is restored but the pending file is dropped and the refusal recorded", () => {
		const r = rig();
		rmSync(r.prev);
		writeFileSync(r.pending, pendingText(2, "0.13.1"), { mode: 0o600 });
		const out = r.run();
		expect(out.started).toHaveLength(1);
		expect(readFileSync(r.relay, "utf-8")).toBe("// new relay\n");
		expect(existsSync(r.pending)).toBe(false);
		expect(JSON.parse(readFileSync(r.refused, "utf-8"))).toEqual({ version: "0.13.1" });
	});

	test("a symlinked .prev is not moved over the relay", () => {
		const r = rig();
		const target = join(r.dir, "elsewhere");
		writeFileSync(target, "// somebody else's file\n");
		rmSync(r.prev);
		symlinkSync(target, r.prev);
		writeFileSync(r.pending, pendingText(2), { mode: 0o600 });
		r.run();
		expect(readFileSync(r.relay, "utf-8")).toBe("// new relay\n");
		expect(readFileSync(target, "utf-8")).toBe("// somebody else's file\n");
	});
});

describe("a pending file that can't be believed is no pending file", () => {
	const unreadable: [string, string][] = [
		["corrupt JSON", "{ not json at all"],
		["a negative number", '{"version":"0.12.0","attempts":-3}\n'],
		["a non-numeric count", '{"version":"0.12.0","attempts":"two"}\n'],
		["no version", '{"attempts":5}\n'],
		["no count", '{"version":"0.12.0"}\n'],
		["an empty file", ""],
		["a count too long to be real", '{"version":"0.12.0","attempts":99999999999}\n'],
		["a version with a shell metacharacter", '{"version":"0.12.0;rm -rf x","attempts":5}\n'],
	];
	for (const [label, text] of unreadable) {
		test(`${label}: no restore, the file isn't rewritten, the relay starts`, () => {
			const r = rig();
			writeFileSync(r.pending, text, { mode: 0o600 });
			const out = r.run();
			expect(out.started).toHaveLength(1);
			expect(readFileSync(r.relay, "utf-8")).toBe("// new relay\n");
			expect(readFileSync(r.prev, "utf-8")).toBe("// previous relay\n");
			expect(readFileSync(r.pending, "utf-8")).toBe(text);
			expect(existsSync(r.refused)).toBe(false);
		});
	}

	test("a symlinked pending file is ignored, and what it points at is untouched", () => {
		const r = rig();
		const target = join(r.dir, "target.json");
		writeFileSync(target, pendingText(5), { mode: 0o600 });
		symlinkSync(target, r.pending);
		const out = r.run();
		expect(out.started).toHaveLength(1);
		expect(readFileSync(r.relay, "utf-8")).toBe("// new relay\n");
		expect(readFileSync(target, "utf-8")).toBe(pendingText(5));
		expect(existsSync(r.refused)).toBe(false);
	});

	test("a pending file that is too large to be ours is ignored", () => {
		const r = rig();
		writeFileSync(r.pending, `${pendingText(5)}${" ".repeat(9000)}`, { mode: 0o600 });
		r.run();
		expect(readFileSync(r.relay, "utf-8")).toBe("// new relay\n");
		expect(existsSync(r.refused)).toBe(false);
	});
});

// ---- the real relay under the real launcher ----

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return check();
}

/** A launcher over the real relay.ts and the real Bun, a config pointing at a remote that is down, and a free port. */
async function realRig(port: number, relaySource: string) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-launch-real-")));
	roots.push(dir);
	const home = join(dir, "home");
	mkdirSync(home);
	const relay = join(dir, "relay.ts");
	writeFileSync(relay, relaySource);
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			// Nothing listens on port 1: the remote is down for the whole test.
			remote_url: "http://127.0.0.1:1",
			api_key: "",
			port,
			state_dir: dir,
		}),
		{ mode: 0o600 },
	);
	const launcher = join(dir, "relay-launch.sh");
	writeFileSync(
		launcher,
		launcherTemplate()
			.replaceAll("@@AP_RELAY_DIR@@", dir)
			.replaceAll("@@AP_BUN@@", process.execPath)
			.replaceAll("@@AP_CONFIG@@", join(dir, "config.json")),
		{ mode: 0o700 },
	);
	return { dir, home, relay, launcher, pending: join(dir, "relay-pending.json") };
}

describe("the real relay under the launcher", () => {
	test("a swapped-in relay that is serving locally clears the pending file even with the remote server down, and nothing is reverted", async () => {
		const port = await freePort();
		const rg = await realRig(port, readFileSync(RELAY_SRC, "utf-8"));
		writeFileSync(join(rg.dir, "relay.ts.prev"), "// previous\n");
		writeFileSync(rg.pending, pendingText(0), { mode: 0o600 });
		const child = Bun.spawn(["/bin/sh", rg.launcher], {
			env: {
				PATH: "/usr/bin:/bin",
				HOME: rg.home,
				NO_PROXY: "127.0.0.1,localhost",
				AGENTPULSE_TEST_RELAY_ACCOUNT_HOME: "",
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			// attempts went 0 -> 1 on start, then the relay cleared the file after answering its own /health.
			expect(await waitFor(() => !existsSync(rg.pending), 20_000)).toBe(true);
			expect(readFileSync(rg.relay, "utf-8")).toBe(readFileSync(RELAY_SRC, "utf-8"));
			expect(existsSync(join(rg.dir, "relay-update-refused.json"))).toBe(false);
		} finally {
			child.kill();
			await child.exited;
		}
	}, 40_000);

	test("a relay that can't bind reverts once: two failed starts, then the previous relay is back", async () => {
		// Hold the port, so the relay's Bun.serve fails and the process exits non-zero before it serves.
		const holder = createServer();
		const port = await new Promise<number>((resolve) =>
			holder.listen(0, "127.0.0.1", () => resolve((holder.address() as { port: number }).port)),
		);
		try {
			const rg = await realRig(port, readFileSync(RELAY_SRC, "utf-8"));
			writeFileSync(join(rg.dir, "relay.ts.prev"), "// previous relay\n");
			writeFileSync(rg.pending, pendingText(0), { mode: 0o600 });
			const start = async () => {
				const child = Bun.spawn(["/bin/sh", rg.launcher], {
					env: { PATH: "/usr/bin:/bin", HOME: rg.home, AGENTPULSE_TEST_RELAY_ACCOUNT_HOME: "" },
					stdout: "ignore",
					stderr: "ignore",
				});
				return child.exited;
			};
			expect(await start()).not.toBe(0);
			expect(readFileSync(rg.pending, "utf-8")).toContain('"attempts":1');
			expect(await start()).not.toBe(0);
			expect(readFileSync(rg.pending, "utf-8")).toContain('"attempts":2');
			// The third start reverts to the previous relay (which is a comment: it runs and exits 0).
			await start();
			expect(readFileSync(rg.relay, "utf-8")).toBe("// previous relay\n");
			expect(existsSync(rg.pending)).toBe(false);
			expect(JSON.parse(readFileSync(join(rg.dir, "relay-update-refused.json"), "utf-8"))).toEqual({
				version: "0.12.0",
			});
		} finally {
			holder.close();
		}
	}, 60_000);
});
