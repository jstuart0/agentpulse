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
	lstatSync,
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
import { rename as renameFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
	RELAY_PENDING_CLEAR_WITHIN_MS,
	type RelayConfig,
	type SelfUpdateDeps,
	clearOwnStale,
	confirmPendingOrExit,
	confirmPendingStart,
	createRelayContext,
	relaySelfUpdate,
	runRelaySelfCheck,
	runSelfCheck,
	setSelfCheckLimitsForTests,
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
	setSelfCheckLimitsForTests(null);
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
	/** More self-update dependencies: the writer, the read-back and the commit's rename. */
	selfUpdate?: Partial<SelfUpdateDeps>;
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
			...opts.selfUpdate,
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

	test("a digest that disagrees with the manifest writes nothing; it is retried on later passes and refused for good only after three in a row (B7)", async () => {
		const w = await world({ newClients: { relay: "f".repeat(64) } });
		const installerFetches = () =>
			w.server.requests.filter((r) => r.path === "/setup-relay.sh").length;
		for (const pass of [1, 2]) {
			expect(await w.tick(), `pass ${pass}`).toBe("digest_mismatch");
			expectUntouched(w);
			// a server caught mid-upgrade must not cost the machine this release for good
			expect(readState(w).refused, `pass ${pass}`).toEqual({});
			expect(installerFetches(), `pass ${pass}`).toBe(pass);
		}
		expect(await w.tick()).toBe("digest_mismatch");
		expect(readState(w).refused).toEqual({ "0.12.0": "digest_mismatch" });
		expectUntouched(w);
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

	test("a served part that disagrees with its digest is refused before anything is staged", async () => {
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

// ====================================================================================================
// Phase 6 gate fixes (AGEN-155): the commit order and its undo, the launcher-visible state, the manifest rules
// a server's own word can't override, and the checks that were missing a test.
// ====================================================================================================

/** Nothing an update stages or keeps for a rollback is left in the relay directory or the statusline directory. */
function expectNoLeftovers(w: World, allow: string[] = []): void {
	for (const dir of [w.relayDir, dirname(w.statuslinePath)]) {
		for (const name of readdirSync(dir)) {
			if (allow.includes(name)) continue;
			expect(name, `a leftover in ${dir}`).not.toMatch(/\.new$|\.prev$/);
		}
	}
}

const pendingFile = (w: World) => join(w.relayDir, "relay-pending.json");
const statuslinePrev = (w: World) => `${w.statuslinePath}.prev`;
const excludePrev = (w: World) => `${w.excludeCheckPath}.prev`;

/** The three installed files are as the world made them (their modes too). */
function expectInstalledAsFound(w: World): void {
	expect(text(w.relayPath)).toBe(REAL_RELAY);
	expect(text(w.statuslinePath)).toBe(REAL_STATUSLINE);
	expect(text(w.excludeCheckPath)).toBe(OLD_EXCLUDE_CHECK);
	expect(mode(w.statuslinePath)).toBe(0o755);
	expect(mode(w.excludeCheckPath)).toBe(0o500);
}

describe("the commit never leaves a swapped relay without its rollback guard (B1)", () => {
	test("pending is written before the first rename; the small files go first and the relay last", async () => {
		const calls: string[] = [];
		let pendingAtFirstRename: string | null = null;
		const ref = {} as { w: World };
		const w = await world({
			selfUpdate: {
				rename: async (from, to) => {
					if (calls.length === 0) {
						pendingAtFirstRename = existsSync(pendingFile(ref.w))
							? text(pendingFile(ref.w))
							: "absent";
					}
					calls.push(`${basename(from)}>${basename(to)}`);
					await renameFile(from, to);
				},
			},
		});
		ref.w = w;
		expect(await w.tick()).toBe("applied");
		expect(calls).toEqual([
			"statusline-agentpulse.sh.new>statusline-agentpulse.sh",
			"exclude-check.sh.new>exclude-check.sh",
			"relay.ts>relay.ts.prev",
			"relay.ts.new>relay.ts",
		]);
		expect(JSON.parse(pendingAtFirstRename ?? "null")).toEqual({ version: "0.12.0", attempts: 0 });
	});

	test("a pending file that can't be written stops the update before anything is replaced", async () => {
		const w = await world();
		mkdirSync(pendingFile(w));
		expect(await w.tick()).toBe("write_failed");
		expectInstalledAsFound(w);
		expectNoLeftovers(w);
		expect(w.exits).toEqual([]);
		expect(readState(w).refused).toEqual({ "0.12.0": "write_failed" });
	});

	const failures: [string, (w: World, from: string, to: string) => boolean][] = [
		["the statusline's rename", (w, _from, to) => to === w.statuslinePath],
		[
			"the exclude check's rename (the statusline was already replaced)",
			(w, _from, to) => to === w.excludeCheckPath,
		],
		[
			"the relay's first rename (relay.ts to relay.ts.prev)",
			(w, from, to) => from === w.relayPath && to === `${w.relayPath}.prev`,
		],
		[
			"the relay's second rename (relay.ts.new to relay.ts, with the old relay already moved aside)",
			(w, from, to) => from === `${w.relayPath}.new` && to === w.relayPath,
		],
	];
	for (const [label, shouldFail] of failures) {
		test(`${label} failing puts everything back: old files, no pending, no leftovers, the version refused`, async () => {
			const ref = {} as { w: World };
			const w = await world({
				selfUpdate: {
					rename: async (from, to) => {
						if (shouldFail(ref.w, from, to)) throw new Error("injected rename failure");
						await renameFile(from, to);
					},
				},
			});
			ref.w = w;
			expect(await w.tick()).toBe("write_failed");
			expectInstalledAsFound(w);
			expect(existsSync(pendingFile(w))).toBe(false);
			expectNoLeftovers(w);
			expect(w.exits).toEqual([]);
			expect(readState(w).refused).toEqual({ "0.12.0": "write_failed" });
		});
	}

	test("when the relay can't be put back either, pending and .prev stay so the launcher can finish the rollback", async () => {
		const ref = {} as { w: World };
		const w = await world({
			selfUpdate: {
				// every rename that would land on relay.ts fails: the commit's second rename and the undo's
				rename: async (from, to) => {
					if (to === ref.w.relayPath) throw new Error("injected rename failure");
					await renameFile(from, to);
				},
			},
		});
		ref.w = w;
		expect(await w.tick()).toBe("write_failed");
		// relay.ts is absent, the old one is beside it and pending is still there: exactly what the launcher repairs
		expect(existsSync(w.relayPath)).toBe(false);
		expect(text(`${w.relayPath}.prev`)).toBe(REAL_RELAY);
		expect(JSON.parse(text(pendingFile(w)))).toEqual({ version: "0.12.0", attempts: 0 });
		// the small files were put back all the same
		expect(text(w.statuslinePath)).toBe(REAL_STATUSLINE);
		expect(text(w.excludeCheckPath)).toBe(OLD_EXCLUDE_CHECK);
		expect(w.exits).toEqual([]);
	});
});

describe("the files a rollback needs are kept beside a swapped relay (B3)", () => {
	test("the replaced statusline and exclude check are kept as .prev with their old content and modes", async () => {
		const w = await world();
		expect(await w.tick()).toBe("applied");
		expect(text(statuslinePrev(w))).toBe(REAL_STATUSLINE);
		expect(mode(statuslinePrev(w))).toBe(0o755);
		expect(text(excludePrev(w))).toBe(OLD_EXCLUDE_CHECK);
		expect(mode(excludePrev(w))).toBe(0o500);
		expect(text(`${w.relayPath}.prev`)).toBe(REAL_RELAY);
	});

	test("a relay-only update clears a stale small .prev: a rollback must never put an older release's file back", async () => {
		const w = await world({
			consent: { schema: 1, clients: { on: true, components: ["relay"] } },
		});
		writeFileSync(statuslinePrev(w), "# stale from an earlier update\n", { mode: 0o700 });
		writeFileSync(excludePrev(w), "# stale\n", { mode: 0o500 });
		expect(await w.tick()).toBe("applied");
		expect(existsSync(statuslinePrev(w))).toBe(false);
		expect(existsSync(excludePrev(w))).toBe(false);
		expect(text(w.statuslinePath)).toBe(REAL_STATUSLINE);
	});

	test("with no relay in the plan no .prev copies are made and no pending file is written", async () => {
		const w = await world({
			consent: { schema: 1, clients: { on: true, components: ["statusline", "excludeCheck"] } },
		});
		expect(await w.tick()).toBe("applied");
		expect(existsSync(statuslinePrev(w))).toBe(false);
		expect(existsSync(excludePrev(w))).toBe(false);
		expect(existsSync(pendingFile(w))).toBe(false);
		expect(w.exits).toEqual([]);
	});

	test("a .prev that is someone else's or a link is not overwritten: the update is refused as unsafe_path", async () => {
		for (const plant of [
			(w: World, target: string) => symlinkSync(target, statuslinePrev(w)),
			(w: World, target: string) => symlinkSync(target, excludePrev(w)),
		]) {
			const w = await world();
			const target = join(w.home, "precious.txt");
			writeFileSync(target, "precious\n", { mode: 0o600 });
			plant(w, target);
			expect(await w.tick()).toBe("unsafe_path");
			expect(text(target)).toBe("precious\n");
			expect(text(w.relayPath)).toBe(REAL_RELAY);
			expect(w.exits).toEqual([]);
		}
	});
});

// ---- the manifest rules a server's own word can't override ----

const hex64 = (c: string) => c.repeat(64);
const manifestRelease = (version: string, overrides: Parameters<typeof testRelease>[1] = {}) =>
	testRelease(version, {
		clients: { relay: hex64("7"), statusline: hex64("8"), excludeCheck: hex64("9") },
		...overrides,
	});

async function oldDigests(): Promise<ClientDigests> {
	return await clientDigests({
		relay: REAL_RELAY,
		statusline: REAL_STATUSLINE,
		excludeCheck: OLD_EXCLUDE_CHECK,
	});
}

describe("a digest mismatch is counted per version (B7)", () => {
	test("two mismatches for one version and then one for another don't add up: nothing is refused", async () => {
		const served = await serve();
		let reported = "0.12.0";
		const wrong = { relay: hex64("a"), statusline: hex64("b"), excludeCheck: hex64("c") };
		const w = await world({
			served,
			healthBody: (body) => JSON.stringify({ ...body, version: reported }),
			payload: {
				latest: "0.13.0",
				releases: [
					testRelease("0.13.0", { clients: wrong }),
					testRelease("0.12.0", { clients: wrong }),
					testRelease("0.11.0", { clients: await oldDigests() }),
				],
			},
		});
		expect(await w.tick()).toBe("digest_mismatch");
		expect(await w.tick()).toBe("digest_mismatch");
		reported = "0.13.0";
		expect(await w.tick()).toBe("digest_mismatch");
		expect(readState(w).refused).toEqual({});
		expectUntouched(w);
	});
});

describe("a newer security release in the signed manifest outranks the server's own version (B4)", () => {
	async function worldWithNewer(newer: ReturnType<typeof testRelease>, latest: string) {
		const served = await serve();
		return await world({
			served,
			payload: {
				latest,
				releases: [
					newer,
					testRelease("0.12.0", { clients: served.digests }),
					testRelease("0.11.0", { clients: await oldDigests() }),
				],
			},
		});
	}

	test("W is refused as behind_security, nothing is written or recorded, and the installer isn't fetched", async () => {
		const w = await worldWithNewer(manifestRelease("0.13.0", { severity: "security" }), "0.13.0");
		expect(await w.tick()).toBe("behind_security");
		expectUntouched(w);
		expect(readState(w).refused).toEqual({});
		expect(w.server.requests.map((r) => r.path)).toEqual(["/api/v1/health?manifest=1"]);
		// not permanent: the same answer on the next pass
		expect(await w.tick()).toBe("behind_security");
	});

	test("anything that is not a newer, non-pulled, stable security release lets W proceed", async () => {
		const cases: [string, ReturnType<typeof testRelease>, string][] = [
			["a newer release that is only normal", manifestRelease("0.13.0"), "0.13.0"],
			[
				"a newer security release that was pulled",
				manifestRelease("0.13.0", { severity: "security", pulled: true }),
				"0.12.0",
			],
			[
				"a newer security pre-release",
				manifestRelease("0.13.0-rc.1", { severity: "security" }),
				"0.12.0",
			],
			[
				"a security release OLDER than W",
				manifestRelease("0.11.5", { severity: "security" }),
				"0.12.0",
			],
		];
		for (const [label, newer, latest] of cases) {
			const w = await worldWithNewer(newer, latest);
			expect(await w.tick(), label).toBe("applied");
		}
	});

	test("W behind the manifest's latest (for a normal release) proceeds and says so once", async () => {
		const w = await worldWithNewer(manifestRelease("0.13.0"), "0.13.0");
		expect(await w.tick()).toBe("applied");
		await w.tick();
		const lines = w.logs.filter((line) => line.includes("behind the latest signed release 0.13.0"));
		expect(lines).toHaveLength(1);
		// and when W is the latest there is no such line
		const plain = await world();
		await plain.tick();
		expect(plain.logs.join("\n")).not.toContain("behind the latest");
	});
});

describe("the relay is replaced only when it is a plain file of ours that an older release shipped (B5)", () => {
	test("a symlinked relay.ts (a development checkout) is left alone, its target untouched, with the skip logged", async () => {
		const w = await world();
		const target = join(w.home, "checkout-relay.ts");
		writeFileSync(target, REAL_RELAY, { mode: 0o644 });
		rmSync(w.relayPath);
		symlinkSync(target, w.relayPath);
		expect(await w.tick()).toBe("applied");
		expect(lstatSync(w.relayPath).isSymbolicLink()).toBe(true);
		expect(text(target)).toBe(REAL_RELAY);
		expect(existsSync(`${w.relayPath}.prev`)).toBe(false);
		expect(existsSync(pendingFile(w))).toBe(false);
		expect(w.exits).toEqual([]);
		expect(w.logs.join("\n")).toContain("relay:not_plain_own_file");
		// the other two files are still refreshed
		expect(text(w.statuslinePath)).toBe(w.served.statusline);
	});

	test("a hard-linked relay.ts is left alone", async () => {
		const w = await world();
		linkSync(w.relayPath, join(w.home, "second-name.ts"));
		expect(await w.tick()).toBe("applied");
		expect(text(w.relayPath)).toBe(REAL_RELAY);
		expect(w.exits).toEqual([]);
		expect(w.logs.join("\n")).toContain("relay:not_plain_own_file");
	});

	test("a locally modified relay is left alone, with the skip logged", async () => {
		const w = await world({ installedRelay: `${REAL_RELAY}\n// my own edit\n` });
		expect(await w.tick()).toBe("applied");
		expect(text(w.relayPath)).toBe(`${REAL_RELAY}\n// my own edit\n`);
		expect(existsSync(`${w.relayPath}.prev`)).toBe(false);
		expect(w.exits).toEqual([]);
		expect(w.logs.join("\n")).toContain("relay:not_an_older_release");
	});

	test("a relay equal to a release NEWER than the one being applied is left alone too", async () => {
		const newerRelay = `${REAL_RELAY}\n// a newer release\n`;
		const served = await serve();
		const w = await world({
			served,
			installedRelay: newerRelay,
			payload: {
				latest: "0.13.0",
				releases: [
					manifestRelease("0.13.0", {
						clients: {
							...(await clientDigests({
								relay: newerRelay,
								statusline: "# s\n",
								excludeCheck: "# e\n",
							})),
						},
					}),
					testRelease("0.12.0", { clients: served.digests }),
					testRelease("0.11.0", { clients: await oldDigests() }),
				],
			},
		});
		await w.tick();
		expect(text(w.relayPath)).toBe(newerRelay);
		expect(w.exits).toEqual([]);
	});
});

describe("the written bytes are exactly the hashed ones (B6)", () => {
	test("a relay served with trailing white space is written as its trimmed text and one line end", async () => {
		const served = await serve({ relay: `${REAL_RELAY}\n// refreshed relay   \n\n\n` });
		// the installer carries trailing spaces on the last line; the digest does not cover them
		expect(served.relay).not.toBe(`${served.relay.trimEnd()}\n`);
		const w = await world({ served });
		expect(await w.tick()).toBe("applied");
		expect(readFileSync(w.relayPath)).toEqual(Buffer.from(`${served.relay.trimEnd()}\n`));
		expect(readFileSync(w.statuslinePath)).toEqual(Buffer.from(`${served.statusline.trimEnd()}\n`));
		// the exclude check's digest covers the whole text, so it is written whole
		expect(readFileSync(w.excludeCheckPath)).toEqual(Buffer.from(served.excludeCheck));
	});

	test("a read-back that differs only in trailing white space is refused (the digest alone would pass it)", async () => {
		const w = await world({
			selfUpdate: {
				// only the two files whose digest is over the trimmed text: for them the digest alone can't see it
				readBack: async (path) =>
					path.endsWith("exclude-check.sh.new")
						? readFileSync(path, "utf-8")
						: `${readFileSync(path, "utf-8")}\n\n`,
			},
		});
		expect(await w.tick()).toBe("write_failed");
		expectUntouched(w);
		expect(readState(w).refused).toEqual({ "0.12.0": "write_failed" });
	});

	test("a writer that writes other bytes than it was given is refused at the read-back", async () => {
		const w = await world({
			selfUpdate: {
				writeNew: async (finalPath, bytes) => {
					const temp = `${finalPath}.new`;
					writeFileSync(temp, Buffer.concat([bytes, Buffer.from("// tampered\n")]), {
						mode: 0o600,
					});
					return temp;
				},
			},
		});
		expect(await w.tick()).toBe("write_failed");
		expectUntouched(w);
	});

	test("a read-back that can't read the file is refused", async () => {
		const w = await world({ selfUpdate: { readBack: async () => null } });
		expect(await w.tick()).toBe("write_failed");
		expectUntouched(w);
	});
});

// ---- self-check runner (T2, T3, T4, B8) ----

describe("the self-check runner scrubs the environment and keeps the child inside its sandbox (T2, B8)", () => {
	function stagedDir(): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-staged-")));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	test("a staged relay sees no parent secret and no AGENTPULSE_ variable, HOME is its sandbox and so is its working directory", async () => {
		const dir = stagedDir();
		const out = join(dir, "seen.json");
		const staged = join(dir, "relay.ts.new");
		writeFileSync(
			staged,
			`import { writeFileSync } from "node:fs";\nif (process.argv.includes("--self-check")) {\n\twriteFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, cwd: process.cwd() }));\n\tprocess.exit(0);\n}\nprocess.exit(1);\n`,
		);
		const secret = "RELAY_PARENT_SECRET_FOR_TEST";
		process.env[secret] = "must-not-leak";
		process.env.AGENTPULSE_SELFCHECK_PROBE = "must-not-leak";
		try {
			expect(await runSelfCheck("relay", staged, process.execPath)).toBe(true);
		} finally {
			Reflect.deleteProperty(process.env, secret);
			Reflect.deleteProperty(process.env, "AGENTPULSE_SELFCHECK_PROBE");
		}
		const seen = JSON.parse(readFileSync(out, "utf-8")) as {
			env: Record<string, string>;
			cwd: string;
		};
		expect(
			Object.keys(seen.env).filter((k) => k === secret || k.startsWith("AGENTPULSE_")),
		).toEqual([]);
		expect(JSON.stringify(seen.env)).not.toContain("must-not-leak");
		expect(Object.keys(seen.env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
		expect(seen.env.HOME).toBe(seen.cwd);
		expect(seen.cwd).not.toBe(dir);
		expect(seen.cwd).not.toBe(realpathSync(process.cwd()));
		expect(seen.cwd.startsWith(realpathSync(tmpdir()))).toBe(true);
	});

	test("a staged relay that hangs is judged within the deadline: false, and only that child was signalled", async () => {
		const dir = stagedDir();
		const staged = join(dir, "relay.ts.new");
		writeFileSync(staged, "setInterval(() => {}, 1000);\nawait new Promise(() => {});\n");
		setSelfCheckLimitsForTests({ relayMs: 400, shellMs: 400 });
		const started = Date.now();
		expect(await runSelfCheck("relay", staged, process.execPath)).toBe(false);
		expect(Date.now() - started).toBeLessThan(4000);
	});

	test("end to end: a served relay that hangs on --self-check is refused for good and nothing is replaced", async () => {
		const lines = REAL_RELAY.split("\n");
		const hang =
			'if (process.argv.includes("--self-check")) { setInterval(() => {}, 1000); await new Promise(() => {}); }';
		const withHang = [lines[0], hang, ...lines.slice(1)].join("\n");
		const served = await serve({ relay: withHang });
		const w = await world({ served });
		setSelfCheckLimitsForTests({ relayMs: 600, shellMs: 600 });
		expect(await w.tick()).toBe("self_check_failed");
		expectUntouched(w);
		expect(readState(w).refused).toEqual({ "0.12.0": "self_check_failed" });
	});
});

describe("the statusline's self-check (T3)", () => {
	const jqPresent =
		Bun.spawnSync([
			"/usr/bin/env",
			"PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
			"jq",
			"--version",
		]).exitCode === 0;

	test("a served statusline with a syntax error is refused", async () => {
		const served = await serve({ statusline: `${REAL_STATUSLINE}\nif then fi ((\n` });
		const w = await world({ served });
		expect(await w.tick()).toBe("self_check_failed");
		expectUntouched(w);
	});

	test("a syntax error after an early exit is caught by the parse check alone (the fixture run never reaches it)", async () => {
		const served = await serve({ statusline: "#!/bin/bash\nexit 0\nif then fi ((\n" });
		const w = await world({ served });
		expect(await w.tick()).toBe("self_check_failed");
		expectUntouched(w);
	});

	test(jqPresent
		? "with jq present, a statusline that exits non-zero on the fixture input is refused"
		: "without jq the fixture run is skipped and only syntax is judged (stated)", async () => {
		const served = await serve({ statusline: "#!/bin/bash\nexit 3\n" });
		const w = await world({ served });
		if (jqPresent) {
			expect(await w.tick()).toBe("self_check_failed");
			expectUntouched(w);
		} else {
			expect(await w.tick()).toBe("applied");
		}
	});
});

describe("the exclude-check fixture run refuses a check that sends when it should not (T4)", () => {
	// A tiny implementation of the rules that the self-check's cases accept, and one variant per way to get it wrong.
	const reference = [
		"#!/bin/sh",
		'case "${AGENTPULSE_SKIP:-}" in 1) exit 1;; esac',
		'f="$HOME/.agentpulse/exclude"',
		'if [ -e "$f" ]; then',
		"  here=$(pwd -P)",
		"  while IFS= read -r line; do",
		"    case \"$line\" in '*'*) exit 1;; esac",
		'    [ "$line" = "$here" ] && exit 1',
		'  done < "$f"',
		"fi",
		"exit 42",
		"",
	];
	const without = (needle: string) => reference.filter((line) => !line.includes(needle)).join("\n");
	const variants: [string, string][] = [
		["ignores the skip variable", without("AGENTPULSE_SKIP")],
		[
			"ignores the rules file",
			["#!/bin/sh", 'case "${AGENTPULSE_SKIP:-}" in 1) exit 1;; esac', "exit 42", ""].join("\n"),
		],
		["excludes everything", "#!/bin/sh\nexit 1\n"],
		["sends on an invalid rules file", without("'*'*)")],
		["ignores a valid rule (but fails closed on an invalid file)", without('"$line" = "$here"')],
		[
			"excludes every directory as soon as any rules file exists",
			[
				"#!/bin/sh",
				'case "${AGENTPULSE_SKIP:-}" in 1) exit 1;; esac',
				'[ -e "$HOME/.agentpulse/exclude" ] && exit 1',
				"exit 42",
				"",
			].join("\n"),
		],
	];

	function stagedCheck(body: string): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-excl-")));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "exclude-check.sh.new");
		writeFileSync(path, body, { mode: 0o500 });
		return path;
	}

	test("the reference passes (the positive control: this harness can say yes)", async () => {
		expect(
			await runSelfCheck("excludeCheck", stagedCheck(reference.join("\n")), process.execPath),
		).toBe(true);
	});

	for (const [label, body] of variants) {
		test(`a check that ${label} is refused`, async () => {
			expect(body).not.toBe(reference.join("\n"));
			expect(await runSelfCheck("excludeCheck", stagedCheck(body), process.execPath)).toBe(false);
		});
	}
});

// ---- the older-release rule for the small files (T1) ----

describe("a small file is replaced only when it equals an OLDER release's, never a newer one's (T1)", () => {
	const S10 = "# statusline of 0.10\n";
	const S13 = "# statusline of 0.13\n";
	const E10 = "#!/bin/sh\n# exclude check of 0.10\nexit 42\n";
	const E13 = "#!/bin/sh\n# exclude check of 0.13\nexit 42\n";

	async function threeReleases(over: {
		installedStatusline: string;
		installedExcludeCheck: string;
	}) {
		const served = await serve();
		const d10 = await clientDigests({ relay: "// r10\n", statusline: S10, excludeCheck: E10 });
		const d13 = await clientDigests({ relay: "// r13\n", statusline: S13, excludeCheck: E13 });
		return await world({
			served,
			...over,
			consent: { schema: 1, clients: { on: true, components: ["statusline", "excludeCheck"] } },
			payload: {
				latest: "0.13.0",
				minSupported: "0.10.0",
				releases: [
					testRelease("0.13.0", { clients: d13 }),
					testRelease("0.12.0", { clients: served.digests }),
					testRelease("0.11.0", { clients: await oldDigests() }),
					testRelease("0.10.0", { clients: d10 }),
				],
			},
		});
	}

	test("a statusline equal to a release newer than the one applied is left alone while the exclude check, two releases back, is replaced", async () => {
		const w = await threeReleases({ installedStatusline: S13, installedExcludeCheck: E10 });
		expect(await w.tick()).toBe("applied");
		expect(text(w.statuslinePath)).toBe(S13);
		expect(text(w.excludeCheckPath)).toBe(w.served.excludeCheck);
	});

	test("the other way round: a statusline two releases back is replaced and an exclude check from a newer release is left alone", async () => {
		const w = await threeReleases({ installedStatusline: S10, installedExcludeCheck: E13 });
		expect(await w.tick()).toBe("applied");
		expect(text(w.statuslinePath)).toBe(w.served.statusline);
		expect(text(w.excludeCheckPath)).toBe(E13);
	});
});

// ---- the consent reader's refusals (T6) ----

describe("consent that is off, of another schema or writable by others gives no refresh (T6)", () => {
	const components = ["relay", "statusline", "excludeCheck"];
	const cases: [string, (w: World) => void][] = [
		[
			"on:false with components listed",
			(w) =>
				writeFileSync(
					join(w.relayDir, "update-consent.json"),
					`${JSON.stringify({ schema: 1, clients: { on: false, components } })}\n`,
					{ mode: 0o600 },
				),
		],
		[
			"schema 2",
			(w) =>
				writeFileSync(
					join(w.relayDir, "update-consent.json"),
					`${JSON.stringify({ schema: 2, clients: { on: true, components } })}\n`,
					{ mode: 0o600 },
				),
		],
		[
			"a file writable by everyone (mode 0666)",
			(w) => chmodSync(join(w.relayDir, "update-consent.json"), 0o666),
		],
	];
	for (const [label, change] of cases) {
		test(`${label}: no request, nothing written`, async () => {
			const w = await world({ version: "0.12.0" });
			change(w);
			expect(await w.tick()).toBe("no_consent");
			expect(w.server.requests).toEqual([]);
			expectUntouched(w);
		});
	}

	test("clearOwnStale removes a plain file of the given owner and refuses a link, a second hard link and a file of another owner", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-stale-")));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const mine = process.getuid?.();
		const plain = join(dir, "a.new");
		writeFileSync(plain, "x");
		expect(await clearOwnStale(plain, mine)).toBe(true);
		expect(existsSync(plain)).toBe(false);
		expect(await clearOwnStale(plain, mine)).toBe(true); // nothing there is fine

		// a file the account does not own (the uid seam stands in for a foreign owner: chown needs root)
		const foreign = join(dir, "b.prev");
		writeFileSync(foreign, "x");
		expect(await clearOwnStale(foreign, (mine ?? 0) + 1)).toBe(false);
		expect(existsSync(foreign)).toBe(true);

		const target = join(dir, "t");
		writeFileSync(target, "t");
		const link = join(dir, "c.new");
		symlinkSync(target, link);
		expect(await clearOwnStale(link, mine)).toBe(false);
		const hard = join(dir, "d.new");
		linkSync(target, hard);
		expect(await clearOwnStale(hard, mine)).toBe(false);
		expect(text(target)).toBe("t");
	});
});

// ---- startup confirmation (T5, B9) ----

describe("a swapped-in relay confirms itself only from its own, well-formed health answer (T5, B9)", () => {
	function ctxFor(port: number, dir: string, log: (line: string) => void = () => {}) {
		return createRelayContext(
			{
				remoteUrl: "http://127.0.0.1:1",
				apiKey: "",
				port,
				codexNamePolicy: "codex",
				stateDir: dir,
				configPath: null,
			},
			{ env: { HOME: dir }, scriptPath: join(dir, "relay.ts"), accountHome: () => undefined, log },
		);
	}
	function pendingDir(): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-confirm-")));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		writeFileSync(join(dir, "relay-pending.json"), '{"version":"0.12.0","attempts":1}\n', {
			mode: 0o600,
		});
		return dir;
	}

	test("the confirm window is 30 seconds", () => {
		expect(RELAY_PENDING_CLEAR_WITHIN_MS).toBe(30000);
	});

	test("200 with status ok but no relay:true, and a 200 that isn't JSON, are unhealthy and keep the pending file", async () => {
		for (const body of [
			'{"status":"ok"}',
			'{"status":"ok","relay":false}',
			"<html>ok</html>",
			'{"relay":true}',
		]) {
			const server = startServer(
				() => new Response(body, { headers: { "content-type": "application/json" } }),
			);
			const dir = pendingDir();
			const ctx = ctxFor(Number(new URL(server.url).port), dir);
			expect(await confirmPendingStart(ctx, { timeoutMs: 500, pollMs: 50 }), body).toBe(
				"unhealthy",
			);
			expect(existsSync(join(dir, "relay-pending.json")), body).toBe(true);
		}
	});

	test("positive control: status ok with relay:true clears it", async () => {
		const server = startServer(
			() =>
				new Response('{"status":"ok","relay":true}', {
					headers: { "content-type": "application/json" },
				}),
		);
		const dir = pendingDir();
		expect(
			await confirmPendingStart(ctxFor(Number(new URL(server.url).port), dir), {
				timeoutMs: 2000,
				pollMs: 50,
			}),
		).toBe("cleared");
		expect(existsSync(join(dir, "relay-pending.json"))).toBe(false);
	});

	test("an unhealthy start logs and exits 1 (so the launcher counts it); a healthy one doesn't exit", async () => {
		const dir = pendingDir();
		const logs: string[] = [];
		const exits: number[] = [];
		const bad = startServer(() => new Response("nope"));
		const outcome = await confirmPendingOrExit(
			ctxFor(Number(new URL(bad.url).port), dir, (line) => logs.push(line)),
			(code) => exits.push(code),
			{ timeoutMs: 400, pollMs: 50 },
		);
		expect(outcome).toBe("unhealthy");
		expect(exits).toEqual([1]);
		expect(logs.join("\n")).toContain("exiting so the launcher counts the start");

		const dir2 = pendingDir();
		const good = startServer(() => new Response('{"status":"ok","relay":true}'));
		const exits2: number[] = [];
		expect(
			await confirmPendingOrExit(
				ctxFor(Number(new URL(good.url).port), dir2),
				(c) => exits2.push(c),
				{ timeoutMs: 2000, pollMs: 50 },
			),
		).toBe("cleared");
		expect(exits2).toEqual([]);
	});

	test("main() starts the confirmation through the exiting form with process.exit", () => {
		const mainText = REAL_RELAY.slice(REAL_RELAY.indexOf("async function main("));
		expect(mainText).toContain("confirmPendingOrExit(relay.ctx, (code) => process.exit(code))");
		expect(mainText).not.toContain("confirmPendingStart(");
	});
});

// ---- operator-visible lines (B9, B10) and the test-only seam (B12) ----

describe("the relay says what it is doing and what it is not (B9, B10, B12)", () => {
	test("consent on but not started by the launcher: one line saying to re-run the installer, and none without consent", async () => {
		const w = await world({ launcher: false });
		expect(await w.tick()).toBe("not_launcher");
		expect(await w.tick()).toBe("not_launcher");
		const lines = w.logs.filter((line) => line.includes("wasn't started by its launcher"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("re-run the relay installer");
		expect(w.server.requests).toEqual([]);

		const quiet = await world({
			launcher: false,
			consent: { schema: 1, clients: { on: false, components: [] } },
		});
		expect(await quiet.tick()).toBe("not_launcher");
		expect(quiet.logs.join("\n")).not.toContain("launcher");
	});

	test("the relay logs when it absorbs a refusal the launcher recorded", async () => {
		const w = await world({ version: "0.11.0" });
		writeFileSync(join(w.relayDir, "relay-update-refused.json"), '{"version":"0.12.0"}\n', {
			mode: 0o600,
		});
		await w.tick();
		expect(w.logs.join("\n")).toContain("the launcher rolled back 0.12.0");
	});

	test("the selfUpdate option is passed only by tests: the plumbing is the four known places and main() never names it", () => {
		const optionLines = REAL_RELAY.split("\n")
			.map((line) => line.trim())
			.filter((line) => /\bselfUpdate\??:/.test(line));
		expect(optionLines).toEqual([
			"selfUpdate: {",
			"selfUpdate?: Partial<SelfUpdateDeps>;",
			"selfUpdate?: Partial<SelfUpdateDeps>;",
			"...(opts.selfUpdate ? { selfUpdate: opts.selfUpdate } : {}),",
		]);
		const mainText = REAL_RELAY.slice(REAL_RELAY.indexOf("async function main("));
		expect(mainText).not.toContain("selfUpdate");
	});
});

// ---- where bytes may come from: the loopback grammar (T9) ----

describe("which hosts count as loopback (T9)", () => {
	test("[::1] and any 127.x.y.z over http pass the transport rule; lookalikes and other addresses don't", async () => {
		for (const [url, expected] of [
			["http://[::1]:1", "health_failed"],
			["http://127.0.0.2:1", "health_failed"],
			["http://127.200.7.9:1", "health_failed"],
			["http://localhost:1", "health_failed"],
			["http://128.0.0.1:1", "insecure"],
			["http://[::2]:1", "insecure"],
			["http://126.0.0.1:1", "insecure"],
			["http://127.0.0.1.example.invalid:1", "insecure"],
			["http://localhost.example.invalid:1", "insecure"],
		] as const) {
			const w = await world({ remoteUrl: () => url });
			expect(await w.tick(), url).toBe(expected);
			expectUntouched(w);
		}
	}, 60_000);
});

// ---- the launcher and the relay together ----

describe("a rollback by the launcher is learned by the relay and never retried", () => {
	test("launcher restores the old relay at attempts 2, the next tick folds the refusal into its state, and the one after answers refused_before", async () => {
		const setupRelay = readFileSync(join(import.meta.dir, "setup-relay.sh"), "utf-8");
		const lines = setupRelay.split("\n");
		const open = lines.findIndex((line) => line.includes("<<'AP_RELAY_LAUNCHER_EOF'"));
		const end = lines.indexOf("AP_RELAY_LAUNCHER_EOF", open + 1);
		const template = `${lines.slice(open + 1, end).join("\n")}\n`;

		const w = await world();
		// the state an update that failed twice leaves: the new relay in place, the old one beside it, pending at 2
		writeFileSync(w.relayPath, "// the new relay that never served\n", { mode: 0o600 });
		writeFileSync(`${w.relayPath}.prev`, REAL_RELAY, { mode: 0o600 });
		writeFileSync(pendingFile(w), '{"version":"0.12.0","attempts":2}\n', { mode: 0o600 });
		const fakeBun = join(w.home, "fake-bun");
		writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const launcher = join(w.home, "relay-launch.sh");
		writeFileSync(
			launcher,
			template
				.replaceAll("@@AP_RELAY_DIR@@", w.relayDir)
				.replaceAll("@@AP_BUN@@", fakeBun)
				.replaceAll("@@AP_CONFIG@@", join(w.relayDir, "config.json"))
				.replaceAll("@@AP_CLAUDE_DIR@@", join(w.home, ".claude")),
			{ mode: 0o700 },
		);
		const proc = Bun.spawnSync(["/bin/sh", launcher], {
			env: { PATH: "/usr/bin:/bin" },
			stderr: "pipe",
		});
		expect(proc.exitCode).toBe(0);
		expect(text(w.relayPath)).toBe(REAL_RELAY);
		expect(existsSync(pendingFile(w))).toBe(false);

		// the relay that is running again learns it, and 0.12.0 is not tried again
		expect(await w.tick()).toBe("refused_before");
		expect(readState(w).refused).toEqual({ "0.12.0": "rolled_back" });
		expect(existsSync(join(w.relayDir, "relay-update-refused.json"))).toBe(false);
		expect(w.server.requests.filter((r) => r.path === "/setup-relay.sh")).toHaveLength(0);
		expect(await w.tick()).toBe("refused_before");
		expect(w.exits).toEqual([]);
		expect(text(w.relayPath)).toBe(REAL_RELAY);
	});
});
