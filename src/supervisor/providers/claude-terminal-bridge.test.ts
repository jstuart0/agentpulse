/**
 * The real terminal bridge script, run for real under python3 in a pseudo-terminal. The bridge must never reach
 * the network: it writes every report as a private file under `reports/`, and the supervisor's drain sends them.
 * This runs the script, drives a prompt through its control socket, lets the child exit, and then feeds what it
 * wrote to the real drain, so the script's output and the drain's whitelist are held to each other.
 *
 * Needs python3 on PATH; it fails (rather than skips) without it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import { createBridgeSpoolDrain } from "../services/bridge-spool.js";
import { createCredentialTripwire } from "../services/report-resilience.js";

const BRIDGE = join(import.meta.dir, "..", "..", "..", "scripts", "claude_terminal_bridge.py");
const NONCE = "abcdef0123456789abcdef0123456789";
const PTY_RUNNER = "import pty,sys;sys.exit(pty.spawn(sys.argv[1:])>>8)";

let home: string;
let id: string;
let dir: string;
let reports: string;

beforeEach(() => {
	// A Unix socket path is limited to about 100 characters, and macOS's temp directory is long.
	home = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "apb-"));
	id = `py-${Math.random().toString(36).slice(2, 10)}`;
	mkdirSync(join(home, ".agentpulse", "interactive"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	chmodSync(join(home, ".agentpulse", "interactive"), 0o700);
	dir = join(home, ".agentpulse", "interactive", id);
	reports = join(dir, "reports");
	mkdirSync(dir, { mode: 0o700 });
	chmodSync(dir, 0o700);
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function listing(): string {
	return `${dir}: ${existsSync(dir) ? readdirSync(dir).join(", ") : "(missing)"}; reports: ${
		existsSync(reports) ? readdirSync(reports).join(", ") : "(missing)"
	}`;
}

/** Polls until `check` is true, or fails after 10 s naming the bridge directory and what is in it. */
async function until(what: string, check: () => boolean) {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. ${listing()}`);
		await sleep(25);
	}
}

const spoolFiles = () =>
	existsSync(reports)
		? readdirSync(reports)
				.filter((n) => /^\d{16}\.json$/.test(n))
				.sort()
		: [];

function writeConfig(go: string) {
	const config = join(dir, "bridge.json");
	writeFileSync(
		config,
		JSON.stringify({
			session_id: id,
			cwd: home,
			command: ["/bin/sh", "-c", 'while [ ! -e "$GO" ]; do sleep 0.05; done; exit 3'],
			env: { GO: go },
			socket_path: join(dir, "control.sock"),
			launchNonce: NONCE,
		}),
		{ mode: 0o600 },
	);
	chmodSync(config, 0o600);
	return config;
}

function runBridge(config: string) {
	return Bun.spawn(["python3", "-c", PTY_RUNNER, "python3", BRIDGE, "--config", config], {
		// An open pipe that is never written: end-of-input would make pty.spawn hang up on the bridge.
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

function sendPrompt(text: string) {
	return new Promise<void>((resolve, reject) => {
		const socket = createConnection(join(dir, "control.sock"), () => {
			socket.end(`${text}\n`);
		});
		socket.on("close", () => resolve());
		socket.on("error", reject);
	});
}

function readSpool() {
	return spoolFiles().map((name) => ({
		name,
		mode: statSync(join(reports, name)).mode & 0o777,
		envelope: JSON.parse(readFileSync(join(reports, name), "utf-8")),
	}));
}

describe("the real bridge under python3", () => {
	test("python3 is available", () => {
		const probe = Bun.spawnSync(["python3", "--version"]);
		expect(probe.exitCode).toBe(0);
	});

	test("spools the start state, a typed prompt, the failed state and the end event, in order and private; the child's exit code is the bridge's; bridge.pid is gone", async () => {
		const go = join(home, "go");
		const proc = runBridge(writeConfig(go));
		try {
			await until("the start state to be spooled", () => spoolFiles().length >= 1);
			expect(existsSync(join(dir, "bridge.pid")), "a pid file while it runs").toBe(true);
			expect(JSON.parse(readFileSync(join(dir, "bridge.pid"), "utf-8")).pid).toBeGreaterThan(0);
			await until("the control socket", () => existsSync(join(dir, "control.sock")));
			await sendPrompt("hello from the workspace");
			await until("the prompt to be spooled", () =>
				readSpool().some((r) => JSON.stringify(r.envelope).includes("hello from the workspace")),
			);
			writeFileSync(go, "");
			const exit = await proc.exited;
			expect(exit).toBe(3);
		} finally {
			proc.kill();
		}

		const spooled = readSpool();
		expect(
			spooled.map((r) => {
				const body = r.envelope.body;
				return r.envelope.kind === "state"
					? `state:${body.status}`
					: `events:${body.events[0].eventType}`;
			}),
		).toEqual([
			"state:active",
			"events:InteractivePromptObserved",
			"state:failed",
			"events:InteractiveSessionEnded",
		]);
		expect(spooled.map((r) => r.name)).toEqual([
			"0000000000000001.json",
			"0000000000000002.json",
			"0000000000000003.json",
			"0000000000000004.json",
		]);
		for (const r of spooled) {
			expect(r.mode, r.name).toBe(0o600);
			expect(r.envelope.v).toBe(1);
			expect(r.envelope.nonce).toBe(NONCE);
			expect(Date.parse(r.envelope.occurredAt)).not.toBeNaN();
			expect(r.envelope.deliveryId !== undefined, r.name).toBe(r.envelope.kind === "events");
		}
		expect(statSync(reports).mode & 0o777).toBe(0o700);
		expect(existsSync(join(dir, "bridge.pid")), "bridge.pid is removed on exit").toBe(false);
		expect(existsSync(join(reports, "lost"))).toBe(false);
		expect(readFileSync(BRIDGE, "utf-8")).not.toMatch(/supervisor_token|api_key/);

		// The drain, the real one, accepts every file the script wrote and attributes them to the directory.
		const calls: Array<{
			kind: string;
			id: string;
			body?: ManagedSessionStateInput;
			events?: ManagedSessionEventInput[];
			deliveryId?: string;
		}> = [];
		const gate = {
			async reportState(body: ManagedSessionStateInput) {
				calls.push({ kind: "state", id: body.sessionId, body });
				return { outcome: "sent" } as never;
			},
			async reportEvents(
				sessionId: string,
				events: ManagedSessionEventInput[],
				opts?: { deliveryId?: string },
			) {
				calls.push({ kind: "events", id: sessionId, events, deliveryId: opts?.deliveryId });
				return "sent" as const;
			},
		};
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: Date.now }),
			onCredentialRejected: () => undefined,
		});
		drain.admit(id);
		await drain.drain();
		expect(calls.map((c) => c.kind)).toEqual(["state", "events", "state", "events"]);
		expect(calls.every((c) => c.id === id)).toBe(true);
		expect(calls[1]?.events?.[0]?.content).toBe("hello from the workspace");
		expect(calls[3]?.events?.[0]).toMatchObject({
			eventType: "InteractiveSessionEnded",
			rawPayload: { exitCode: 3, source: "terminal_bridge" },
		});
		expect(calls[1]?.deliveryId).not.toBe(calls[3]?.deliveryId);
		expect(drain.stats().lost, "nothing the script wrote was rejected").toBe(0);
		expect(spoolFiles()).toEqual([]);
	}, 60_000);

	test("a write that fails is lost and counted, and the terminal session is unaffected (a directory sits where the next temp file would go)", async () => {
		mkdirSync(reports, { mode: 0o700 });
		chmodSync(reports, 0o700);
		// O_EXCL on this path fails whoever runs the test, root included: no chmod needed.
		mkdirSync(join(reports, ".tmp-0000000000000001"));
		const go = join(home, "go");
		writeFileSync(go, "");
		const proc = runBridge(writeConfig(go));
		let exit: number;
		try {
			exit = await proc.exited;
		} finally {
			proc.kill();
		}
		expect(exit, "the child's exit code still comes back").toBe(3);
		const lost = JSON.parse(readFileSync(join(reports, "lost"), "utf-8"));
		expect(lost).toEqual({ v: 1, lostTotal: 1 });
		expect(
			statSync(join(reports, ".tmp-0000000000000001")).isDirectory(),
			"the planted entry is untouched",
		).toBe(true);
		const kinds = readSpool().map((r) => r.envelope.kind);
		expect(kinds, "the later reports were still spooled").toEqual(["state", "events"]);
		expect(existsSync(join(dir, "bridge.pid"))).toBe(false);
	}, 60_000);
});

describe("the spool class, driven from threads (python3 -I)", () => {
	const HELPER = `
import importlib.util, json, os, sys, threading

spec = importlib.util.spec_from_file_location("bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
directory = sys.argv[2]
mode = sys.argv[3]

if mode == "threads":
    spool = bridge.ReportSpool(directory, "n" * 32)
    def work(tag):
        for i in range(200):
            spool.spool("events", {"events": [{"eventType": "InteractivePromptObserved", "category": "prompt", "content": f"{tag}-{i}", "rawPayload": {}}]})
    threads = [threading.Thread(target=work, args=(t,)) for t in ("a", "b")]
    for t in threads: t.start()
    for t in threads: t.join()
    names = sorted(n for n in os.listdir(directory) if n.endswith(".json"))
    seqs = {int(n[:-5]) for n in names}
    if len(names) != 400 or len(seqs) != 400 or spool.lost_total != 0:
        print("expected 400 distinct seqs, got", len(names), len(seqs), spool.lost_total)
        sys.exit(1)
    for n in names:
        envelope = json.load(open(os.path.join(directory, n)))
        if envelope["v"] != 1 or "deliveryId" not in envelope:
            sys.exit(2)
elif mode == "cap":
    bridge.SPOOL_MAX_FILES = 5
    spool = bridge.ReportSpool(directory, "n" * 32)
    for i in range(8):
        spool.spool("state", {"i": i})
    names = [n for n in os.listdir(directory) if n.endswith(".json")]
    lost = json.load(open(os.path.join(directory, "lost")))
    if len(names) != 5 or spool.lost_total != 3 or lost != {"v": 1, "lostTotal": 3}:
        print("cap", len(names), spool.lost_total, lost)
        sys.exit(1)
elif mode == "resume":
    first = bridge.ReportSpool(directory, "n" * 32)
    first.spool("state", {"i": 1})
    first.spool("state", {"i": 2})
    second = bridge.ReportSpool(directory, "n" * 32)
    second.spool("state", {"i": 3})
    names = sorted(n for n in os.listdir(directory) if n.endswith(".json"))
    if names != ["0000000000000001.json", "0000000000000002.json", "0000000000000003.json"]:
        print(names)
        sys.exit(1)
elif mode == "symlink":
    spool = bridge.ReportSpool(directory, "n" * 32)
    spool.spool("state", {"i": 1})
    if spool.lost_total != 1:
        print("a symlinked reports directory must not be used", spool.lost_total)
        sys.exit(1)
`;

	function runHelper(mode: string, target: string) {
		const helper = join(home, "helper.py");
		writeFileSync(helper, HELPER);
		return Bun.spawnSync(["python3", "-I", helper, BRIDGE, target, mode], {
			stdout: "pipe",
			stderr: "pipe",
		});
	}
	const out = (r: ReturnType<typeof runHelper>) =>
		`${new TextDecoder().decode(r.stdout)}${new TextDecoder().decode(r.stderr)}`;

	test("two threads spooling 200 reports each get 400 distinct sequence numbers", () => {
		const target = join(home, "threads");
		mkdirSync(target, { mode: 0o700 });
		const result = runHelper("threads", target);
		expect(result.exitCode, out(result)).toBe(0);
		expect(readdirSync(target).filter((n) => /^\d{16}\.json$/.test(n))).toHaveLength(400);
	}, 60_000);

	test("a full spool counts further reports lost and records the total in reports/lost", () => {
		const target = join(home, "cap");
		mkdirSync(target, { mode: 0o700 });
		const result = runHelper("cap", target);
		expect(result.exitCode, out(result)).toBe(0);
	});

	test("a restarted spool continues the numbering", () => {
		const target = join(home, "resume");
		mkdirSync(target, { mode: 0o700 });
		const result = runHelper("resume", target);
		expect(result.exitCode, out(result)).toBe(0);
	});

	test("a reports directory that is a symlink is never written through", () => {
		const real = join(home, "elsewhere");
		mkdirSync(real, { mode: 0o700 });
		const link = join(home, "linked");
		symlinkSync(real, link);
		const result = runHelper("symlink", link);
		expect(result.exitCode, out(result)).toBe(0);
		expect(readdirSync(real)).toEqual([]);
	});
});
