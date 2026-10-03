/**
 * A real relay process in front of the real app in team mode (both in this
 * test's own throwaway home and on random loopback ports; never port 4000 or
 * 3000, never a real home). The relay holds an exclude rule; two sessions
 * report through it with a member's key: one in the excluded directory, one in
 * an open directory.
 *
 * The open session proves the pipeline is live: it arrives and is owned by the
 * key's owner. The excluded session never reaches the server at all (the app
 * sees no request that mentions it), so it has no row, no owner, and is in no
 * count, list, tab or grouped stat for anyone.
 *
 * Runs on whichever database the suite is pointed at (SQLite by default,
 * Postgres under DATABASE_URL). Each relay is killed by the PID this file
 * started; nothing here touches the network beyond 127.0.0.1.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../src/server/db/__test_db.js";
import { resetIdentityState } from "../src/server/test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../src/server/test-utils/team-fixtures.js";

setDefaultTimeout(90_000);

const RELAY = join(import.meta.dir, "relay.ts");

const { config } = await import("../src/server/config.js");
const { initializeDatabase, getDb } = await import("../src/server/db/client.js");
const { events, sessions } = await import("../src/server/db/schema/index.js");
const { app } = await import("../src/server/app.js");

const originalDisableAuth = config.disableAuth;

type Seen = { method: string; path: string; body: string };
const seen: Seen[] = [];
let root: string;
let server: ReturnType<typeof Bun.serve>;
const children: Array<{ proc: ReturnType<typeof Bun.spawn> }> = [];

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	root = realpathSync(mkdtempSync(join(tmpdir(), "ap-relay-exclude-ownership-")));
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? "" : await req.clone().text();
			seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
			return app.fetch(req);
		},
	});
});

afterEach(async () => {
	while (children.length) {
		const child = children.pop();
		if (!child) break;
		child.proc.kill();
		await child.proc.exited;
	}
});

afterAll(async () => {
	// Other files share this database and expect solo mode with no users or sessions left over.
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(sessions);
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	server.stop(true);
	rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(
	label: string,
	probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await probe();
		if (v) return v as T;
		await Bun.sleep(40);
	}
	throw new Error(`timed out waiting for ${label}\n--- app requests ---\n${dump()}`);
}

const dump = () => seen.map((r) => `${r.method} ${r.path} ${r.body.slice(0, 80)}`).join("\n");
const mentions = (id: string) => seen.filter((r) => `${r.path}${r.body}`.includes(id));

async function startRelay(name: string, apiKey: string) {
	const base = join(root, name);
	const home = join(base, "home");
	const dir = join(home, ".agentpulse");
	const codexHome = join(home, ".codex");
	for (const d of [codexHome, dir]) mkdirSync(d, { recursive: true });
	chmodSync(dir, 0o700);
	const configPath = join(dir, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({ remote_url: `http://127.0.0.1:${server.port}`, api_key: apiKey, port: 0 }),
		{ mode: 0o600 },
	);
	// `--port 0` on the command line too: a relay that ignored the config must never fall back to 4000.
	const proc = Bun.spawn([process.execPath, RELAY, "--config", configPath, "--port", "0"], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			HOME: home,
			CODEX_HOME: codexHome,
			AGENTPULSE_TEST_RELAY_ACCOUNT_HOME: "",
			AGENTPULSE_RELAY_SYNC_MS: "200",
		},
	});
	children.push({ proc });
	let output = "";
	const decoder = new TextDecoder();
	for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
		void (async () => {
			for await (const chunk of stream) output += decoder.decode(chunk);
		})();
	}
	const port = await waitFor(`${name} banner`, () => {
		const m = /Local:\s+http:\/\/localhost:(\d+)/.exec(output);
		return m ? Number(m[1]) : undefined;
	}).catch((err) => {
		proc.kill();
		throw new Error(`${String(err)}\n--- relay output ---\n${output}`);
	});
	expect(port).not.toBe(4000);
	expect(port).not.toBe(3000);
	return { base: `http://127.0.0.1:${port}`, dir, home };
}

async function postHook(relayBase: string, payload: unknown, skip?: string) {
	const res = await fetch(`${relayBase}/api/v1/hooks`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Agent-Type": "claude_code",
			...(skip !== undefined ? { "X-AgentPulse-Skip": skip } : {}),
		},
		body: JSON.stringify(payload),
	});
	return res.status;
}

const body = (sessionId: string, cwd: string, event = "SessionStart") => ({
	session_id: sessionId,
	hook_event_name: event,
	cwd,
});

async function readJson(path: string, headers: Headers) {
	const res = await app.request(`/api/v1${path}`, { headers });
	expect({ path, status: res.status }).toEqual({ path, status: 200 });
	return res.json();
}

describe("a relay-dropped session, in team mode", () => {
	test("never reaches the app, so it has no row and no owner, and is in no count, list, tab or group; the open session next to it is owned by the key's owner", async () => {
		await resetIdentityState();
		await clearInstanceSettings();
		await getDb().delete(events);
		await getDb().delete(sessions);
		await setStoredMode("team");
		const member = await seedLocalUser("relay-member");
		const viewer = await cookieHeadersFor(member.id);
		const key = await seedKey("relay-member-key", ["ingest"], member.id);

		const secret = join(root, "dir", "secret-project");
		const open = join(root, "dir", "open-project");
		mkdirSync(secret, { recursive: true });
		mkdirSync(open, { recursive: true });

		const relay = await startRelay("main", key.key);
		const rules = join(relay.dir, "exclude");
		writeFileSync(rules, `${secret}\n`, { mode: 0o600 });
		chmodSync(rules, 0o600);

		const EXCLUDED = "relay-xo-excluded";
		const SKIPPED = "relay-xo-skipped";
		const OPEN = "relay-xo-open";

		const statuses = [
			await postHook(relay.base, body(EXCLUDED, secret)),
			await postHook(relay.base, body(EXCLUDED, secret, "PreToolUse")),
			await postHook(relay.base, body(EXCLUDED, secret, "Stop")),
			// the header form the Claude installer writes, from the open directory: dropped too
			await postHook(relay.base, body(SKIPPED, open), "1"),
			await postHook(relay.base, body(OPEN, open)),
		];
		for (const status of statuses) expect(status).toBe(200);

		const openRow = await waitFor("the open session's row", async () => {
			const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, OPEN));
			return r;
		});
		expect(openRow.ownerUserId).toBe(member.id);
		// let several relay ticks pass so a late or periodic path would have shown itself
		await Bun.sleep(1200);

		for (const id of [EXCLUDED, SKIPPED]) {
			expect(mentions(id), `requests that mention ${id}\n${dump()}`).toEqual([]);
			const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, id));
			expect({ id, row: r }).toEqual({ id, row: undefined });
		}

		// The whole read model describes exactly the one open session, for its owner and for the team.
		const mine = (await readJson("/sessions?owner=me&limit=100", viewer)) as {
			sessions: Array<{ sessionId: string }>;
			total: number;
		};
		expect(mine.sessions.map((s) => s.sessionId)).toEqual([OPEN]);
		const everyone = (await readJson("/sessions?owner=all&limit=100", viewer)) as {
			total: number;
		};
		expect(everyone.total).toBe(1);
		for (const scope of ["unassigned", "service", member.id]) {
			const total = (
				(await readJson(`/sessions?owner=${scope}&limit=100`, viewer)) as {
					total: number;
				}
			).total;
			expect({ scope, total }).toEqual({ scope, total: scope === member.id ? 1 : 0 });
		}
		const stats = (await readJson("/sessions/stats?owner=all", viewer)) as {
			total: number;
			tabCounts: { active: number; completed: number; archived: number };
		};
		expect(stats.total).toBe(1);
		expect(stats.tabCounts.active + stats.tabCounts.completed + stats.tabCounts.archived).toBe(1);
		const groups = (await readJson("/sessions/stats?group_by=owner", viewer)) as {
			groups: Array<{ ownerUserId: string | null; total: number }>;
		};
		expect(groups.groups).toHaveLength(1);
		expect(groups.groups[0]).toMatchObject({ ownerUserId: member.id, total: 1 });
		const all = await getDb().select().from(sessions);
		expect(all.map((s) => s.sessionId)).toEqual([OPEN]);
	});
});
