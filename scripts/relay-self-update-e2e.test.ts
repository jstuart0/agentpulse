/**
 * The relay's self-refresh (AGEN-155, 6.3 and 6.4) end to end against local test servers: a throwaway HOME,
 * the throwaway test signing key (never the production trust root), an injected `exit`, and the real self-check
 * runner (real Bun for the relay, real sh and bash for the two shell files). Nothing here starts or signals a
 * process this test did not start, and nothing reads or writes the real ~/.agentpulse or ~/.claude.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALLER_SOURCES, buildRelayInstaller } from "../src/server/installers.ts";
import {
	NOW,
	TEST_KEYS,
	TEST_KEY_LIST,
	envelopeFor,
	testPayload,
	testRelease,
} from "../src/shared/__fixtures__/release-test-signer.ts";
import { materializeExcludeScript } from "../src/shared/hook-command.ts";
import { EXCLUDE_SCRIPT_SEND_STATUS } from "../src/shared/hook-headers.ts";
import {
	type ClientDigests,
	clientDigests,
	extractRelayInstallerParts,
} from "../src/shared/relay-installer-parts.ts";
import {
	EXCLUDE_CHECK_SEND_STATUS,
	type RelayConfig,
	type SelfUpdateDeps,
	confirmPendingStart,
	createRelayContext,
	relaySelfUpdate,
	runRelaySelfCheck,
	startRelay,
} from "./relay.ts?module";

const REAL_RELAY = readFileSync(join(import.meta.dir, "relay.ts"), "utf-8");
const REAL_STATUSLINE = readFileSync(join(import.meta.dir, "statusline.sh"), "utf-8");
const SECRET_KEY = ["relay", "canary", "never", "sent"].join("-");
const OLD_EXCLUDE_CHECK = "#!/bin/sh\n# an older release's check\nexit 42\n";
const MIB = 1024 * 1024;

const savedProxy = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
beforeAll(() => {
	// The servers here are on 127.0.0.1; another test file may have left a proxy variable set.
	process.env.NO_PROXY = "127.0.0.1,localhost,[::1]";
	process.env.no_proxy = "127.0.0.1,localhost,[::1]";
});
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
});
afterAll(() => {
	for (const [name, value] of Object.entries(savedProxy)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

// ---- the world the relay sees ----

interface Served {
	relay: string;
	statusline: string;
	excludeCheck: string;
	script: string;
	digests: ClientDigests;
}

/** What `GET /setup-relay.sh` serves for the new release, built by the real installer builder. */
async function serve(over: { relay?: string; statusline?: string } = {}): Promise<Served> {
	const relay = over.relay ?? `${REAL_RELAY}\n// refreshed relay\n`;
	const statusline = over.statusline ?? `${REAL_STATUSLINE}\n# refreshed statusline\n`;
	const built = buildRelayInstaller(
		{ ...INSTALLER_SOURCES, relay, statusline },
		"http://127.0.0.1:1",
	);
	if (!built.ok) throw new Error(built.reason);
	const extracted = extractRelayInstallerParts(built.script);
	if (!extracted.ok) throw new Error(extracted.reason);
	const excludeCheck = materializeExcludeScript(extracted.parts.excludeHeredoc);
	return {
		relay: extracted.parts.relay,
		statusline: extracted.parts.statusline,
		excludeCheck,
		script: built.script,
		digests: await clientDigests({
			relay: extracted.parts.relay,
			statusline: extracted.parts.statusline,
			excludeCheck,
		}),
	};
}

interface Logged {
	path: string;
	headers: Record<string, string>;
}

interface TestServer {
	url: string;
	requests: Logged[];
	close(): void;
}

function startServer(handler: (path: string) => Response): TestServer {
	const requests: Logged[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			requests.push({
				path: `${url.pathname}${url.search}`,
				headers: Object.fromEntries(req.headers.entries()),
			});
			return handler(`${url.pathname}${url.search}`);
		},
	});
	const handle: TestServer = {
		url: `http://127.0.0.1:${server.port}`,
		requests,
		close: () => server.stop(true),
	};
	cleanups.push(handle.close);
	return handle;
}

interface World {
	home: string;
	relayDir: string;
	relayPath: string;
	statuslinePath: string;
	excludeCheckPath: string;
	exits: number[];
	logs: string[];
	server: TestServer;
	ctx: ReturnType<typeof createRelayContext>;
	served: Served;
	/** Runs one pass of the self-refresh. */
	tick(): ReturnType<typeof relaySelfUpdate>;
}

interface WorldOptions {
	served?: Served;
	/** The version the server reports. */
	version?: string;
	payload?: Parameters<typeof testPayload>[0];
	/** A different manifest digest for the new release (to make the served parts disagree with it). */
	newClients?: Partial<ClientDigests>;
	envelope?: (payload: ReturnType<typeof testPayload>) => string;
	consent?: unknown;
	launcher?: boolean;
	selfCheck?: SelfUpdateDeps["selfCheck"];
	installerResponse?: (served: Served) => Response;
	healthBody?: (body: Record<string, unknown>) => string;
	remoteUrl?: (server: TestServer) => string;
	installedRelay?: string;
	installedStatusline?: string;
	installedExcludeCheck?: string;
	uid?: () => number | undefined;
	now?: number;
}

async function world(opts: WorldOptions = {}): Promise<World> {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ap-relay-selfupdate-")));
	cleanups.push(() => rmSync(home, { recursive: true, force: true }));
	const relayDir = join(home, ".agentpulse");
	mkdirSync(relayDir, { mode: 0o700 });
	chmodSync(relayDir, 0o700);
	mkdirSync(join(home, ".claude"));
	const relayPath = join(relayDir, "relay.ts");
	const statuslinePath = join(home, ".claude", "statusline-agentpulse.sh");
	const excludeCheckPath = join(relayDir, "exclude-check.sh");
	writeFileSync(relayPath, opts.installedRelay ?? REAL_RELAY, { mode: 0o600 });
	writeFileSync(statuslinePath, opts.installedStatusline ?? REAL_STATUSLINE, { mode: 0o755 });
	chmodSync(statuslinePath, 0o755);
	writeFileSync(excludeCheckPath, opts.installedExcludeCheck ?? OLD_EXCLUDE_CHECK, { mode: 0o500 });
	chmodSync(excludeCheckPath, 0o500);
	writeFileSync(
		join(relayDir, "update-consent.json"),
		`${JSON.stringify(
			opts.consent ?? {
				schema: 1,
				clients: { on: true, components: ["relay", "statusline", "excludeCheck"] },
			},
		)}\n`,
		{ mode: 0o600 },
	);

	const served = opts.served ?? (await serve());
	const oldDigests = await clientDigests({
		relay: REAL_RELAY,
		statusline: REAL_STATUSLINE,
		excludeCheck: OLD_EXCLUDE_CHECK,
	});
	const payload = testPayload({
		releases: [
			testRelease("0.12.0", { clients: { ...served.digests, ...opts.newClients } }),
			testRelease("0.11.0", { clients: oldDigests }),
		],
		...opts.payload,
	});
	const envelope = opts.envelope ? opts.envelope(payload) : envelopeFor(payload);
	const server = startServer((path) => {
		if (path.startsWith("/api/v1/health")) {
			const body = {
				status: "ok",
				version: opts.version ?? "0.12.0",
				releaseManifest: envelope,
			};
			return new Response(opts.healthBody ? opts.healthBody(body) : JSON.stringify(body), {
				headers: { "content-type": "application/json" },
			});
		}
		if (path === "/setup-relay.sh") {
			return opts.installerResponse?.(served) ?? new Response(served.script);
		}
		return new Response("not found", { status: 404 });
	});

	const exits: number[] = [];
	const logs: string[] = [];
	const config: RelayConfig = {
		remoteUrl: opts.remoteUrl ? opts.remoteUrl(server) : server.url,
		apiKey: SECRET_KEY,
		port: 0,
		codexNamePolicy: "codex",
		stateDir: relayDir,
		configPath: join(relayDir, "config.json"),
	};
	const ctx = createRelayContext(config, {
		env: { HOME: home },
		scriptPath: relayPath,
		now: () => opts.now ?? NOW,
		log: (line) => logs.push(line),
		selfUpdate: {
			keys: TEST_KEY_LIST,
			env: opts.launcher === false ? {} : { AGENTPULSE_RELAY_LAUNCHER: "1" },
			exit: (code) => exits.push(code),
			...(opts.selfCheck ? { selfCheck: opts.selfCheck } : {}),
			...(opts.uid ? { uid: opts.uid } : {}),
		},
	});
	return {
		home,
		relayDir,
		relayPath,
		statuslinePath,
		excludeCheckPath,
		exits,
		logs,
		server,
		ctx,
		served,
		tick: () => relaySelfUpdate(ctx),
	};
}

const text = (path: string) => readFileSync(path, "utf-8");
const mode = (path: string) => statSync(path).mode & 0o777;
const stateFile = (w: World) => join(w.relayDir, "relay-update-state.json");
const readState = (w: World) => JSON.parse(text(stateFile(w)));

/** Nothing was written: the three installed files are as they were and no staging or pending file exists. */
function expectUntouched(w: World): void {
	expect(text(w.relayPath)).toBe(REAL_RELAY);
	expect(text(w.statuslinePath)).toBe(REAL_STATUSLINE);
	expect(text(w.excludeCheckPath)).toBe(OLD_EXCLUDE_CHECK);
	for (const name of readdirSync(w.relayDir)) {
		expect(name, "a leftover from an update").not.toMatch(/\.new$|\.prev$|^relay-pending\.json$/);
	}
	expect(existsSync(`${w.statuslinePath}.new`)).toBe(false);
	expect(w.exits).toEqual([]);
}

// ---- the accepted path ----

describe("a signed, matching release is applied", () => {
	test("the three files are replaced with exactly the served bytes, the old relay is kept as .prev, pending is written and the relay exits 0", async () => {
		const w = await world();
		expect(await w.tick()).toBe("applied");

		expect(text(w.relayPath)).toBe(w.served.relay);
		expect(text(`${w.relayPath}.prev`)).toBe(REAL_RELAY);
		expect(text(w.statuslinePath)).toBe(w.served.statusline);
		expect(text(w.excludeCheckPath)).toBe(w.served.excludeCheck);
		expect(mode(w.relayPath)).toBe(0o600);
		expect(mode(w.statuslinePath)).toBe(0o700);
		expect(mode(w.excludeCheckPath)).toBe(0o500);

		const pending = join(w.relayDir, "relay-pending.json");
		expect(JSON.parse(text(pending))).toEqual({ version: "0.12.0", attempts: 0 });
		expect(mode(pending)).toBe(0o600);
		expect(w.exits).toEqual([0]);
		expect(existsSync(`${w.relayPath}.new`)).toBe(false);
		expect(existsSync(`${w.statuslinePath}.new`)).toBe(false);
		expect(existsSync(`${w.excludeCheckPath}.new`)).toBe(false);
		expect(w.logs.join("\n")).toContain("refreshed to 0.12.0");
	});

	test("the replay state is written 0600 after the envelope verified, with what the manifest said", async () => {
		const w = await world();
		expect(existsSync(stateFile(w))).toBe(false);
		await w.tick();
		expect(mode(stateFile(w))).toBe(0o600);
		const state = readState(w);
		expect(state.schema).toBe(1);
		expect(state.last.seq).toBe(100);
		expect(state.last.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(state.revoked).toEqual([]);
	});

	test("the relay talks to one origin only, two paths, with no credential, cookie or custom header", async () => {
		const w = await world();
		await w.tick();
		expect(w.server.requests.map((r) => r.path)).toEqual([
			"/api/v1/health?manifest=1",
			"/setup-relay.sh",
		]);
		for (const request of w.server.requests) {
			expect(Object.keys(request.headers)).not.toContain("authorization");
			expect(Object.keys(request.headers)).not.toContain("cookie");
			expect(JSON.stringify(request.headers)).not.toContain(SECRET_KEY);
		}
		expect(w.logs.join("\n")).not.toContain(SECRET_KEY);
	});

	test("the pass is quiet when nothing is newer: one request, no write", async () => {
		const w = await world({ version: "0.11.0" });
		expect(await w.tick()).toBe("up_to_date");
		expect(w.server.requests).toHaveLength(1);
		expectUntouched(w);
	});

	test("a second pass after the same release found nothing to do does not fetch the installer again", async () => {
		const w = await world({
			consent: { schema: 1, clients: { on: true, components: ["statusline"] } },
			installedStatusline: "# the person's own statusline\n",
		});
		expect(await w.tick()).toBe("nothing_to_apply");
		const requests = w.server.requests.length;
		expect(await w.tick()).toBe("nothing_to_apply");
		// the second pass still reads the health (one request) but not the installer
		expect(w.server.requests.length).toBe(requests + 1);
	});
});

// ---- the gates ----

describe("nothing is written until every precondition holds", () => {
	test("a relay not started by its launcher never self-updates, and makes no request at all", async () => {
		const w = await world({ launcher: false });
		expect(await w.tick()).toBe("not_launcher");
		expect(w.server.requests).toEqual([]);
		expectUntouched(w);
	});

	test("no consent: no request, no write", async () => {
		const w = await world({ consent: { schema: 1, clients: { on: false, components: [] } } });
		expect(await w.tick()).toBe("no_consent");
		expect(w.server.requests).toEqual([]);
		expectUntouched(w);
	});

	test("a consent file owned by someone else is not believed", async () => {
		const w = await world({ uid: () => (process.getuid?.() ?? 0) + 1 });
		expect(await w.tick()).toBe("no_consent");
		expect(w.server.requests).toEqual([]);
	});

	test("consent that names only the statusline refreshes only the statusline, and the relay doesn't exit", async () => {
		const w = await world({
			consent: { schema: 1, clients: { on: true, components: ["statusline"] } },
		});
		expect(await w.tick()).toBe("applied");
		expect(text(w.statuslinePath)).toBe(w.served.statusline);
		expect(text(w.relayPath)).toBe(REAL_RELAY);
		expect(text(w.excludeCheckPath)).toBe(OLD_EXCLUDE_CHECK);
		expect(existsSync(join(w.relayDir, "relay-pending.json"))).toBe(false);
		expect(w.exits).toEqual([]);
	});

	test("consent that names only the relay refreshes only the relay: the statusline and exclude check stay as they were", async () => {
		const w = await world({ consent: { schema: 1, clients: { on: true, components: ["relay"] } } });
		expect(await w.tick()).toBe("applied");
		expect(text(w.relayPath)).toBe(w.served.relay);
		expect(text(w.statuslinePath)).toBe(REAL_STATUSLINE);
		expect(text(w.excludeCheckPath)).toBe(OLD_EXCLUDE_CHECK);
		expect(w.exits).toEqual([0]);
	});

	test("each of the two requests asks for the rules the relay promises: https or loopback only, no redirect, the stated byte caps", async () => {
		const asked: { url: string; options: Record<string, unknown> }[] = [];
		const w = await world({
			// A spy over the capped GET: it records what was asked and then really asks.
			selfCheck: async () => true,
		});
		const { fetchCapped } = await import("./relay.ts?module");
		const spyCtx = createRelayContext(w.ctx.config, {
			env: { HOME: w.home },
			scriptPath: w.relayPath,
			now: () => NOW,
			log: () => {},
			selfUpdate: {
				keys: TEST_KEY_LIST,
				env: { AGENTPULSE_RELAY_LAUNCHER: "1" },
				exit: () => {},
				selfCheck: async () => true,
				fetchText: (url, options) => {
					asked.push({ url, options: options as unknown as Record<string, unknown> });
					return fetchCapped(url, options);
				},
			},
		});
		await relaySelfUpdate(spyCtx);
		expect(asked.map((a) => new URL(a.url).pathname + new URL(a.url).search)).toEqual([
			"/api/v1/health?manifest=1",
			"/setup-relay.sh",
		]);
		expect(asked[0]?.options).toMatchObject({ maxBytes: 64 * 1024, httpsOrLoopbackOnly: true });
		expect(asked[1]?.options).toMatchObject({ maxBytes: 8 * MIB, httpsOrLoopbackOnly: true });
		for (const a of asked) expect(a.options.deadlineMs).toBeGreaterThan(0);
	});

	test("an unsigned envelope, a tampered signature and a key the relay doesn't know are all refused", async () => {
		const tamper = (payload: ReturnType<typeof testPayload>) => {
			const env = JSON.parse(envelopeFor(payload));
			const sig = Buffer.from(env.sig, "base64url");
			sig[0] = (sig[0] ?? 0) ^ 0xff;
			return JSON.stringify({ ...env, sig: sig.toString("base64url") });
		};
		const cases: [string, (p: ReturnType<typeof testPayload>) => string][] = [
			["not an envelope", () => '{"payload":"x"}'],
			["a tampered signature", tamper],
			["a key the relay doesn't trust", (p) => envelopeFor(p, "unknown")],
		];
		for (const [label, envelope] of cases) {
			const w = await world({ envelope });
			expect(await w.tick(), label).toBe("unverified");
			expectUntouched(w);
			// Nothing verified, so no replay point moved.
			expect(existsSync(stateFile(w)), label).toBe(false);
			expect(
				w.server.requests.map((r) => r.path),
				label,
			).toEqual(["/api/v1/health?manifest=1"]);
		}
	});

	test("a health answer with no manifest is unverified", async () => {
		const w = await world({
			healthBody: (body) => JSON.stringify({ ...body, releaseManifest: null }),
		});
		expect(await w.tick()).toBe("unverified");
		expectUntouched(w);
	});

	test("a stale manifest verifies for display and is never acted on", async () => {
		const w = await world({ now: Date.parse("2026-12-30T00:00:00.000Z") });
		expect(await w.tick()).toBe("stale");
		expectUntouched(w);
	});

	test("an envelope with a lower seq than the relay already accepted is refused, and the stored point is not lowered", async () => {
		const w = await world();
		writeFileSync(
			stateFile(w),
			`${JSON.stringify({
				schema: 1,
				last: { seq: 200, issuedAt: "2026-11-19T10:00:00.000Z", fingerprint: "a".repeat(64) },
				revoked: [],
				refused: {},
			})}\n`,
			{ mode: 0o600 },
		);
		expect(await w.tick()).toBe("unverified");
		expectUntouched(w);
		expect(readState(w).last.seq).toBe(200);
	});

	test("a key the relay has seen revoked can no longer sign for it", async () => {
		const w = await world();
		writeFileSync(
			stateFile(w),
			`${JSON.stringify({ schema: 1, last: null, revoked: [TEST_KEYS.active.keyId], refused: {} })}\n`,
			{ mode: 0o600 },
		);
		expect(await w.tick()).toBe("unverified");
		expectUntouched(w);
	});

	test("a corrupt state file reads as no state: a verifying fresh envelope is accepted", async () => {
		const w = await world();
		writeFileSync(stateFile(w), "{ not json", { mode: 0o600 });
		expect(await w.tick()).toBe("applied");
		expect(readState(w).last.seq).toBe(100);
	});

	test("a pulled release, a pre-release and a version the manifest doesn't list are not applied", async () => {
		const pulled = await world({
			payload: {
				releases: [
					testRelease("0.12.1"),
					testRelease("0.12.0", { pulled: true, pulledReason: "bad_build" }),
					testRelease("0.11.0"),
				],
				latest: "0.12.1",
			},
		});
		expect(await pulled.tick()).toBe("pulled");
		expectUntouched(pulled);

		const pre = await world({
			version: "0.12.0-rc.1",
			payload: {
				releases: [testRelease("0.12.0-rc.1"), testRelease("0.11.0")],
				latest: "0.11.0",
			},
		});
		expect(await pre.tick()).toBe("prerelease");
		expectUntouched(pre);

		const unknown = await world({ version: "0.12.7" });
		expect(await unknown.tick()).toBe("unknown_version");
		expectUntouched(unknown);

		const malformed = await world({ version: "0.12" });
		expect(await malformed.tick()).toBe("unknown_version");
		expectUntouched(malformed);
	});

	test("a server version below the manifest's minSupported is not applied", async () => {
		const w = await world({
			payload: {
				latest: "0.13.0",
				minSupported: "0.12.1",
				releases: [testRelease("0.13.0"), testRelease("0.12.0"), testRelease("0.11.0")],
			},
		});
		expect(await w.tick()).toBe("below_minimum");
		expectUntouched(w);
	});

	test("a release not newer than the relay's own version is not applied (the relay never moves backwards)", async () => {
		const w = await world({ version: "0.11.0" });
		expect(await w.tick()).toBe("up_to_date");
		const older = await world({ version: "0.10.9" });
		expect(["up_to_date", "unknown_version"]).toContain(await older.tick());
		expectUntouched(older);
	});
});

describe("where bytes may come from", () => {
	test("a plain-http server that isn't loopback is refused with no request, and so is a hostname that only starts like localhost", async () => {
		for (const remote of [
			"http://192.0.2.1:4000",
			"http://localhost.evil.example:4000",
			"http://127.0.0.1.evil.example:4000",
			"http://example.com",
			["http://user", "pass@127.0.0.1:4000"].join(":"),
		]) {
			const w = await world({ remoteUrl: () => remote });
			expect(await w.tick(), remote).toBe("insecure");
			expect(w.server.requests, remote).toEqual([]);
			expectUntouched(w);
		}
	});

	test("a loopback literal over plain http is allowed (the positive control for the refusals above)", async () => {
		for (const host of ["127.0.0.1", "localhost"]) {
			const w = await world({ remoteUrl: (s) => s.url.replace("127.0.0.1", host) });
			expect(await w.tick(), host).toBe("applied");
		}
	});

	test("a redirect on /setup-relay.sh to a second origin is refused and the second origin gets no request", async () => {
		const other = startServer(() => new Response("should never be asked"));
		const w = await world({
			installerResponse: () =>
				new Response(null, { status: 302, headers: { location: `${other.url}/setup-relay.sh` } }),
		});
		expect(await w.tick()).toBe("installer_failed");
		expect(other.requests).toEqual([]);
		expectUntouched(w);
	});

	test("a redirect on /health is refused too", async () => {
		const other = startServer(() => new Response("never"));
		const w = await world({ healthBody: () => "" });
		w.server.close();
		const redirecting = startServer(
			() => new Response(null, { status: 301, headers: { location: other.url } }),
		);
		const ctx = createRelayContext(
			{ ...w.ctx.config, remoteUrl: redirecting.url },
			{
				env: { HOME: w.home },
				scriptPath: w.relayPath,
				now: () => NOW,
				log: () => {},
				selfUpdate: {
					keys: TEST_KEY_LIST,
					env: { AGENTPULSE_RELAY_LAUNCHER: "1" },
					exit: () => {},
				},
			},
		);
		expect(await relaySelfUpdate(ctx)).toBe("health_failed");
		expect(other.requests).toEqual([]);
	});

	test("an installer one byte over 8 MiB and a health answer one byte over 64 KiB are refused; at the cap they are read", async () => {
		// Padded past the cap but otherwise exactly what a good server sends: only the cap can refuse these.
		const over = await world({
			installerResponse: (served) => new Response(`${served.script}\n#${"x".repeat(8 * MIB)}\n`),
		});
		expect(await over.tick()).toBe("installer_failed");
		expectUntouched(over);

		const health = await world({
			healthBody: (body) => JSON.stringify({ ...body, padding: "x".repeat(64 * 1024) }),
		});
		expect(await health.tick()).toBe("health_failed");
		expectUntouched(health);
		// just under the cap, the same shape is read and applied
		const fits = await world({
			healthBody: (body) => JSON.stringify({ ...body, padding: "x".repeat(8 * 1024) }),
		});
		expect(await fits.tick()).toBe("applied");

		// At exactly the cap a body is read, and then judged as what it is: not an installer.
		const atCap = await world({ installerResponse: () => new Response("x".repeat(8 * MIB)) });
		expect(await atCap.tick()).toBe("installer_failed");
		const reached = atCap.server.requests.map((r) => r.path);
		expect(reached).toEqual(["/api/v1/health?manifest=1", "/setup-relay.sh"]);
	});

	test("a digest that disagrees with the manifest refuses the version, writes nothing and is not retried", async () => {
		const w = await world({ newClients: { relay: "f".repeat(64) } });
		expect(await w.tick()).toBe("digest_mismatch");
		expectUntouched(w);
		expect(readState(w).refused).toEqual({ "0.12.0": "digest_mismatch" });
		const requests = w.server.requests.length;
		expect(await w.tick()).toBe("refused_before");
		// the health is read again; the installer is not
		expect(w.server.requests.length).toBe(requests + 1);
	});

	test("each part is held to its own digest: a wrong statusline digest or exclude-check digest refuses too", async () => {
		for (const key of ["statusline", "excludeCheck"] as const) {
			const w = await world({ newClients: { [key]: "e".repeat(64) } });
			expect(await w.tick(), key).toBe("digest_mismatch");
			expectUntouched(w);
		}
	});
});

describe("files that aren't the relay's to replace", () => {
	test("a statusline or exclude-check whose content no release shipped is left alone; the relay itself is still refreshed", async () => {
		const w = await world({
			installedStatusline: "# the person's hand-edited statusline\n",
			installedExcludeCheck: "#!/bin/sh\n# hand edited\nexit 42\n",
		});
		expect(await w.tick()).toBe("applied");
		expect(text(w.statuslinePath)).toBe("# the person's hand-edited statusline\n");
		expect(text(w.excludeCheckPath)).toBe("#!/bin/sh\n# hand edited\nexit 42\n");
		expect(text(w.relayPath)).toBe(w.served.relay);
	});

	test("a relay that already is the served file is not replaced: no .prev, no exit (the other files are still refreshed)", async () => {
		const served = await serve();
		const w = await world({ served, installedRelay: served.relay });
		expect(await w.tick()).toBe("applied");
		expect(text(w.relayPath)).toBe(served.relay);
		expect(existsSync(`${w.relayPath}.prev`)).toBe(false);
		expect(existsSync(join(w.relayDir, "relay-pending.json"))).toBe(false);
		expect(w.exits).toEqual([]);
		expect(text(w.statuslinePath)).toBe(served.statusline);
	});

	test("a statusline that is already the new release's is not rewritten", async () => {
		const served = await serve();
		const w = await world({
			served,
			installedStatusline: served.statusline,
			installedExcludeCheck: served.excludeCheck,
		});
		const beforeStatusline = statSync(w.statuslinePath).ino;
		expect(await w.tick()).toBe("applied");
		expect(statSync(w.statuslinePath).ino).toBe(beforeStatusline);
	});

	test("a symlinked statusline (a dotfiles repo) is left alone and its target untouched", async () => {
		const w = await world();
		const target = join(w.home, "dotfiles-statusline.sh");
		writeFileSync(target, REAL_STATUSLINE, { mode: 0o755 });
		rmSync(w.statuslinePath);
		symlinkSync(target, w.statuslinePath);
		expect(await w.tick()).toBe("applied");
		expect(text(target)).toBe(REAL_STATUSLINE);
		expect(statSync(w.statuslinePath).isFile()).toBe(true);
		expect(text(w.relayPath)).toBe(w.served.relay);
	});

	test("a pre-existing symlinked relay.ts.new, relay.ts.prev, or hardlinked .new is refused; what the link points at is untouched; the relay isn't replaced", async () => {
		for (const [label, plant] of [
			["symlinked .new", (w: World, target: string) => symlinkSync(target, `${w.relayPath}.new`)],
			["symlinked .prev", (w: World, target: string) => symlinkSync(target, `${w.relayPath}.prev`)],
			["hardlinked .new", (w: World, target: string) => linkSync(target, `${w.relayPath}.new`)],
			[
				"symlinked statusline .new",
				(w: World, target: string) => symlinkSync(target, `${w.statuslinePath}.new`),
			],
		] as const) {
			const w = await world();
			const target = join(w.home, "precious.txt");
			writeFileSync(target, "precious\n", { mode: 0o600 });
			plant(w, target);
			expect(await w.tick(), label).toBe("unsafe_path");
			expect(text(target), label).toBe("precious\n");
			expect(text(w.relayPath), label).toBe(REAL_RELAY);
			expect(w.exits, label).toEqual([]);
			expect(text(w.statuslinePath), label).toBe(REAL_STATUSLINE);
			expect(readState(w).refused["0.12.0"], label).toBe("unsafe_path");
		}
	});

	test("a stale .new left by an earlier crash (a plain file of ours) is replaced, not trusted", async () => {
		const w = await world();
		writeFileSync(`${w.relayPath}.new`, "// half written by a crash", { mode: 0o600 });
		expect(await w.tick()).toBe("applied");
		expect(text(w.relayPath)).toBe(w.served.relay);
	});
});

describe("a staged file is judged before it replaces anything", () => {
	test("a relay whose exclude evaluator excludes less fails its own self-check: nothing is replaced, the version is refused and not retried", async () => {
		// Same relay, but the skip variable no longer excludes anything.
		const weakened = REAL_RELAY.replace(
			"export function isSkipValue(value: string | null | undefined): boolean {",
			"export function isSkipValue(value: string | null | undefined): boolean {\n\treturn false;",
		);
		expect(weakened).not.toBe(REAL_RELAY);
		const served = await serve({ relay: weakened });
		const w = await world({ served });
		expect(await w.tick()).toBe("self_check_failed");
		expectUntouched(w);
		expect(readState(w).refused).toEqual({ "0.12.0": "self_check_failed" });
		const installerFetches = () =>
			w.server.requests.filter((r) => r.path === "/setup-relay.sh").length;
		expect(installerFetches()).toBe(1);
		expect(await w.tick()).toBe("refused_before");
		expect(installerFetches()).toBe(1);
	});

	test("one staged file failing its check stops them all: the others aren't replaced either", async () => {
		const w = await world({ selfCheck: async (kind) => kind !== "excludeCheck" });
		expect(await w.tick()).toBe("self_check_failed");
		expectUntouched(w);
	});

	test("a relay that is syntactically broken fails the real self-check (a subprocess of the real Bun)", async () => {
		const served = await serve({ relay: `${REAL_RELAY}\nthis is not ( valid typescript\n` });
		const w = await world({ served });
		expect(await w.tick()).toBe("self_check_failed");
		expectUntouched(w);
	});

	test("an exclude-check that sends when it should exclude fails the real self-check", async () => {
		// The shell file served is the real one; weaken it in the installer text itself.
		const built = buildRelayInstaller(
			{ ...INSTALLER_SOURCES, relay: `${REAL_RELAY}\n// r\n` },
			"http://127.0.0.1:1",
		);
		if (!built.ok) throw new Error(built.reason);
		const broken = built.script.replace(
			'if [ "$ap_excluded" = "1" ]; then exit 1; fi',
			'if [ "$ap_excluded" = "1" ]; then exit 42; fi',
		);
		expect(broken).not.toBe(built.script);
		const extracted = extractRelayInstallerParts(broken);
		if (!extracted.ok) throw new Error(extracted.reason);
		const excludeCheck = materializeExcludeScript(extracted.parts.excludeHeredoc);
		const served: Served = {
			relay: extracted.parts.relay,
			statusline: extracted.parts.statusline,
			excludeCheck,
			script: broken,
			digests: await clientDigests({
				relay: extracted.parts.relay,
				statusline: extracted.parts.statusline,
				excludeCheck,
			}),
		};
		const w = await world({ served });
		expect(await w.tick()).toBe("self_check_failed");
		expectUntouched(w);
	});

	test("the written bytes are exactly the hashed ones: a write that doesn't read back to the digest is refused", async () => {
		// A server that serves a relay with a character the text path would alter is caught at the digest, never written.
		const served = await serve();
		const w = await world({ served, newClients: { relay: served.digests.statusline } });
		expect(await w.tick()).toBe("digest_mismatch");
		expectUntouched(w);
	});
});

// ---- the checks themselves ----

describe("the self-checks", () => {
	test("the real relay passes its own --self-check, in the real runner and as a subprocess with a scrubbed environment", () => {
		expect(runRelaySelfCheck()).toBe(true);
		const proc = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "relay.ts"), "--self-check"],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: tmpdir(),
					AGENTPULSE_TEST_RELAY_ACCOUNT_HOME: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(proc.exitCode).toBe(0);
	});

	test("the send status the self-check expects is the one the shell file exits with", () => {
		expect(EXCLUDE_CHECK_SEND_STATUS).toBe(EXCLUDE_SCRIPT_SEND_STATUS);
	});
});

// ---- startup confirmation ----

describe("a swapped-in relay confirms itself from its own loopback health", () => {
	const config = (dir: string): RelayConfig => ({
		remoteUrl: "http://127.0.0.1:1",
		apiKey: "",
		port: 0,
		codexNamePolicy: "codex",
		stateDir: dir,
		configPath: null,
	});

	test("once bound and answering, the pending file is removed; with none it reports none", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-relay-pending-")));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const relay = await startRelay(config(dir), {
			timers: false,
			env: { HOME: dir },
			scriptPath: join(dir, "relay.ts"),
			accountHome: () => undefined,
			log: () => {},
		});
		cleanups.push(() => relay.stop());
		expect(await confirmPendingStart(relay.ctx, { timeoutMs: 3000, pollMs: 50 })).toBe("none");
		writeFileSync(join(dir, "relay-pending.json"), '{"version":"0.12.0","attempts":1}\n', {
			mode: 0o600,
		});
		expect(await confirmPendingStart(relay.ctx, { timeoutMs: 5000, pollMs: 50 })).toBe("cleared");
		expect(existsSync(join(dir, "relay-pending.json"))).toBe(false);
	});

	test("a pending file that is a link is removed as a link; its target is untouched", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-relay-pending-")));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const relay = await startRelay(config(dir), {
			timers: false,
			env: { HOME: dir },
			scriptPath: join(dir, "relay.ts"),
			accountHome: () => undefined,
			log: () => {},
		});
		cleanups.push(() => relay.stop());
		const target = join(dir, "target.json");
		writeFileSync(target, "precious\n");
		symlinkSync(target, join(dir, "relay-pending.json"));
		expect(await confirmPendingStart(relay.ctx, { timeoutMs: 5000, pollMs: 50 })).toBe("cleared");
		expect(readFileSync(target, "utf-8")).toBe("precious\n");
	});

	test("a relay that isn't answering locally leaves the pending file, so the launcher counts the start", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-relay-pending-")));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const relay = await startRelay(config(dir), {
			timers: false,
			env: { HOME: dir },
			scriptPath: join(dir, "relay.ts"),
			accountHome: () => undefined,
			log: () => {},
		});
		writeFileSync(join(dir, "relay-pending.json"), '{"version":"0.12.0","attempts":1}\n', {
			mode: 0o600,
		});
		relay.stop();
		expect(await confirmPendingStart(relay.ctx, { timeoutMs: 600, pollMs: 50 })).toBe("unhealthy");
		expect(existsSync(join(dir, "relay-pending.json"))).toBe(true);
	});
});

describe("what the launcher leaves behind is folded into the state", () => {
	test("a refusal the launcher recorded becomes a refused version and the file is removed", async () => {
		const w = await world({ version: "0.11.0" });
		writeFileSync(join(w.relayDir, "relay-update-refused.json"), '{"version":"0.12.0"}\n', {
			mode: 0o600,
		});
		await w.tick();
		expect(readState(w).refused).toEqual({ "0.12.0": "rolled_back" });
		expect(existsSync(join(w.relayDir, "relay-update-refused.json"))).toBe(false);
		// and that version is then never applied
		const next = await world();
		writeFileSync(join(next.relayDir, "relay-update-refused.json"), '{"version":"0.12.0"}\n', {
			mode: 0o600,
		});
		expect(await next.tick()).toBe("refused_before");
		expectUntouched(next);
	});

	test("a refusal file that names something that isn't a version is removed unbelieved", async () => {
		const w = await world({ version: "0.11.0" });
		writeFileSync(join(w.relayDir, "relay-update-refused.json"), '{"version":"../../etc"}\n', {
			mode: 0o600,
		});
		await w.tick();
		expect(existsSync(stateFile(w)) ? readState(w).refused : {}).toEqual({});
		expect(existsSync(join(w.relayDir, "relay-update-refused.json"))).toBe(false);
	});
});
