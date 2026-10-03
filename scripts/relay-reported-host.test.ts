/**
 * The relay names its own machine (os.hostname()) on every hook it forwards, in
 * the X-AgentPulse-Host header, so the hook body is never rewritten. Display
 * only. relay.ts stays one self-contained file with node: builtins only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_HEADER } from "../src/shared/hook-headers.js";
import { parseReportedHostHeader } from "../src/shared/reported-host.js";
import { checkRelayEmbed } from "./lib/relay-exclude-embed.ts";

type RelayModule = typeof import("./relay.ts");
let loaded: RelayModule | undefined;
async function mod(): Promise<RelayModule> {
	loaded ??= await import("./relay.ts?module");
	return loaded;
}

const ROOT = join(import.meta.dir, "..");
const TEST_KEY = "ap_TESTKEY_host_0123456789";

type Recorded = { method: string; path: string; body: string; headers: Record<string, string> };

function startStub() {
	const requests: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			requests.push({
				method: req.method,
				path: url.pathname,
				body: req.method === "GET" ? "" : await req.text(),
				headers: Object.fromEntries(req.headers),
			});
			return Response.json({ ok: true });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

let tmp: string;
const stops: Array<() => unknown> = [];
beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-relay-host-"));
});
afterEach(async () => {
	while (stops.length) await stops.pop()?.();
	await rm(tmp, { recursive: true, force: true });
});

async function startRelayFor(remote: string, hostName?: () => string) {
	const R = await mod();
	const stateDir = join(tmp, "state");
	await mkdir(stateDir, { recursive: true });
	await mkdir(join(tmp, "home"), { recursive: true });
	const relay = await R.startRelay(
		{
			remoteUrl: remote,
			apiKey: TEST_KEY,
			port: 0,
			codexNamePolicy: "codex",
			stateDir,
			configPath: null,
		},
		{
			timers: false,
			env: { HOME: join(tmp, "home") },
			scriptPath: join(import.meta.dir, "relay.ts"),
			accountHome: () => undefined,
			log: () => {},
			...(hostName ? { hostName } : {}),
		},
	);
	stops.push(() => relay.stop());
	return { R, relay, base: `http://127.0.0.1:${relay.port}` };
}

async function sendHook(base: string, body: Record<string, unknown>) {
	await fetch(`${base}/api/v1/hooks`, { method: "POST", body: JSON.stringify(body) });
}

describe("relay host header", () => {
	test("relay.ts spells the header the way the server reads it", async () => {
		const R = await mod();
		expect(R.HOST_HEADER).toBe(HOST_HEADER);
		expect(R.HOST_HEADER).toBe("X-AgentPulse-Host");
	});

	test("every forwarded hook carries the machine name; the body is exactly what the agent sent", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const { R, relay, base } = await startRelayFor(stub.url, () => "alice-mbp");

		const first = { session_id: "h1", hook_event_name: "SessionStart", cwd: "/work/a" };
		const second = { session_id: "h1", hook_event_name: "PreToolUse", tool_name: "Bash" };
		await sendHook(base, first);
		await sendHook(base, second);
		await R.processHookQueue(relay.ctx);

		const calls = stub.requests.filter((r) => r.path === "/api/v1/hooks");
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(parseReportedHostHeader(call.headers[HOST_HEADER.toLowerCase()])).toBe("alice-mbp");
		}
		expect(calls.map((c) => JSON.parse(c.body))).toEqual([first, second]);
	});

	test("a retried hook carries it again", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const { R, relay, base } = await startRelayFor(stub.url, () => "retry-box");
		await sendHook(base, { session_id: "h2", hook_event_name: "Stop" });
		await R.processHookQueue(relay.ctx);
		expect(stub.requests.filter((r) => r.path === "/api/v1/hooks")).toHaveLength(1);
		expect(stub.requests[0]?.headers[HOST_HEADER.toLowerCase()]).toBe("retry-box");
	});

	test("a machine name outside Latin-1 is encoded, so the forward still goes through", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const { R, relay, base } = await startRelayFor(stub.url, () => "Alex’s MacBook Pro");
		await sendHook(base, { session_id: "h3", hook_event_name: "Stop" });
		await R.processHookQueue(relay.ctx);
		const call = stub.requests.find((r) => r.path === "/api/v1/hooks");
		expect(call).toBeDefined();
		expect(parseReportedHostHeader(call?.headers[HOST_HEADER.toLowerCase()])).toBe(
			"Alex’s MacBook Pro",
		);
	});

	test("by default the name is the operating system's host name", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const { R, relay, base } = await startRelayFor(stub.url);
		await sendHook(base, { session_id: "h4", hook_event_name: "Stop" });
		await R.processHookQueue(relay.ctx);
		const call = stub.requests.find((r) => r.path === "/api/v1/hooks");
		expect(parseReportedHostHeader(call?.headers[HOST_HEADER.toLowerCase()])).toBe(
			parseReportedHostHeader(encodeURIComponent(hostname().slice(0, 128))),
		);
	});

	test("other forwards (a proxied read) do not carry it", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const { base } = await startRelayFor(stub.url, () => "alice-mbp");
		await fetch(`${base}/api/v1/sessions/abc`);
		const read = stub.requests.find((r) => r.path === "/api/v1/sessions/abc");
		expect(read).toBeDefined();
		expect(read?.headers[HOST_HEADER.toLowerCase()]).toBeUndefined();
	});

	test("an excluded hook is neither forwarded nor does its host go anywhere", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const { R, relay, base } = await startRelayFor(stub.url, () => "alice-mbp");
		await fetch(`${base}/api/v1/hooks`, {
			method: "POST",
			headers: { "X-AgentPulse-Skip": "1" },
			body: JSON.stringify({ session_id: "h5", hook_event_name: "SessionStart" }),
		});
		await R.processHookQueue(relay.ctx);
		expect(stub.requests.filter((r) => r.path === "/api/v1/hooks")).toHaveLength(0);
	});
});

describe("relay stays self-contained", () => {
	const relaySource = () => readFile(join(ROOT, "scripts/relay.ts"), "utf-8");

	test("the embed guard still passes on the tree", async () => {
		expect(
			checkRelayEmbed({
				relaySource: await relaySource(),
				exclusionSource: await readFile(join(ROOT, "src/shared/exclude-rules.ts"), "utf-8"),
				headersSource: await readFile(join(ROOT, "src/shared/hook-headers.ts"), "utf-8"),
			}),
		).toEqual([]);
	});

	test("it imports only node: builtins (nothing from src/)", async () => {
		const specifiers = [
			...(await relaySource()).matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm),
		].map((m) => m[1] ?? "");
		expect(specifiers.length).toBeGreaterThan(5);
		for (const spec of specifiers) expect(spec.startsWith("node:")).toBe(true);
	});
});
