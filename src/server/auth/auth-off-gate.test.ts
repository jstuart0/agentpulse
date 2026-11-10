/**
 * AGEN-92: with DISABLE_AUTH=true one app-level gate refuses, before any
 * router runs, a request whose Host couldn't be an address the user opened
 * (DNS rebinding) and a request a browser marks as cross-site. The route walk
 * is the drift guard: it drives every /api and /app-api route through the real
 * app, so a new route can't be left outside the gate.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { app } = await import("../app.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const {
	CROSS_SITE_REFUSED_MESSAGE,
	HOST_REFUSED_MESSAGE,
	__resetAuthOffGateLogForTests,
	logAuthOffBootRule,
} = await import("./request-origin.js");

const originalDisableAuth = config.disableAuth;
const originalPublicUrl = process.env.PUBLIC_URL;
const setAuthOff = (off: boolean) => {
	(config as Record<string, unknown>).disableAuth = off;
};

function setPublicUrl(value: string | undefined) {
	if (value === undefined) {
		// biome-ignore lint/performance/noDelete: restoring an absent env var
		delete process.env.PUBLIC_URL;
	} else {
		process.env.PUBLIC_URL = value;
	}
}

beforeAll(async () => {
	await initializeDatabase();
});
beforeEach(() => {
	setAuthOff(true);
	setPublicUrl("http://mybox.local:3000,http://mybox.example");
	__resetAuthOffGateLogForTests();
});
afterEach(() => {
	setAuthOff(originalDisableAuth);
	setPublicUrl(originalPublicUrl);
	__resetAuthOffGateLogForTests();
});
afterAll(() => {
	setAuthOff(originalDisableAuth);
	setPublicUrl(originalPublicUrl);
});

// ---- route walk ----

interface RouteLike {
	method: string;
	path: string;
}
const MOUNTS = ["/api/", "/app-api/"];
const EXCLUDED_BY_NAME = [
	// process state
	"POST /api/v1/internal/drain",
	// makes an outbound request
	"POST /api/v1/telemetry/ping",
	"POST /app-api/v1/telemetry/ping",
];
// Stateful public POSTs, skipped in the auth-on comparison only.
const STATEFUL_PUBLIC = [
	"/api/v1/pair",
	"/app-api/v1/pair",
	"/api/v1/auth/login",
	"/app-api/v1/auth/login",
	"/api/v1/auth/signup",
	"/app-api/v1/auth/signup",
	"/api/v1/csp-report",
	"/app-api/v1/csp-report",
].map((p) => `POST ${p}`);
// A concrete path under each `ALL` wildcard the walk can't enumerate.
const WILDCARD_SAMPLES = [
	"GET /api/v1/ai/status",
	"POST /api/v1/ai/status",
	"GET /api/v1/admin/supervisors",
	"POST /api/v1/admin/supervisors",
	"GET /app-api/v1/ai/status",
	"POST /app-api/v1/admin/supervisors",
];

function walkPopulation(routes: readonly RouteLike[]): { included: string[]; excluded: string[] } {
	const seen = new Set<string>();
	for (const route of routes) {
		if (!MOUNTS.some((m) => route.path.startsWith(m))) continue;
		if (route.method === "ALL" || route.path.includes("*")) continue;
		seen.add(`${route.method} ${route.path}`);
	}
	for (const sample of WILDCARD_SAMPLES) seen.add(sample);
	const all = [...seen];
	const excluded = all.filter((e) => EXCLUDED_BY_NAME.includes(e));
	return { included: all.filter((e) => !EXCLUDED_BY_NAME.includes(e)), excluded };
}

function concrete(entry: string): { method: string; path: string } {
	const [method, path] = entry.split(" ") as [string, string];
	return { method, path: path.replace(/:[^/]+/g, "abc") };
}

function send(entry: string, headers: Record<string, string>) {
	const { method, path } = concrete(entry);
	const init: RequestInit = { method, headers: { ...headers } };
	if (method !== "GET" && method !== "HEAD") {
		(init.headers as Record<string, string>)["Content-Type"] = "text/plain";
		init.body = "{}";
	}
	return app.request(`http://placeholder${path}`, init);
}

const REFUSED_CASES: Array<{ name: string; headers: Record<string, string>; message: string }> = [
	{
		name: "rebinding Host, no Origin",
		headers: { Host: "rebind.example:3000" },
		message: HOST_REFUSED_MESSAGE,
	},
	{
		name: "rebinding Host with a matching Origin",
		headers: { Host: "rebind.example:3000", Origin: "http://rebind.example:3000" },
		message: HOST_REFUSED_MESSAGE,
	},
	{
		name: "trusted Host with a foreign Origin",
		headers: { Host: "127.0.0.1:3000", Origin: "https://evil.example" },
		message: CROSS_SITE_REFUSED_MESSAGE,
	},
	{
		name: "trusted Host with Sec-Fetch-Site: cross-site and no Origin",
		headers: { Host: "127.0.0.1:3000", "Sec-Fetch-Site": "cross-site" },
		message: CROSS_SITE_REFUSED_MESSAGE,
	},
];

describe("route walk", () => {
	const { included, excluded } = walkPopulation(app.routes);

	test("population: floor, the exact excluded set, and the named members", () => {
		expect(included.length).toBeGreaterThanOrEqual(330);
		expect(excluded.sort()).toEqual([...EXCLUDED_BY_NAME].sort());
		for (const named of [
			"POST /api/v1/launches",
			"GET /app-api/v1/sessions",
			"POST /api/v1/hooks",
			"GET /api/v1/ai/status",
			"GET /api/v1/health",
			"GET /api/v1/auth/me",
			"POST /api/v1/channels/telegram/webhook",
		]) {
			expect(included).toContain(named);
		}
	});

	for (const testCase of REFUSED_CASES) {
		test(`auth off, every route refuses: ${testCase.name}`, async () => {
			const failures: string[] = [];
			for (const entry of included) {
				const res = await send(entry, testCase.headers);
				const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
				if (
					res.status !== 403 ||
					body.error !== "bad_origin" ||
					body.message !== testCase.message
				) {
					failures.push(`${entry} -> ${res.status} ${JSON.stringify(body).slice(0, 80)}`);
				}
			}
			expect(failures).toEqual([]);
		});
	}

	test("an unmatched path is refused too (the gate is app-level)", async () => {
		const res = await app.request("http://placeholder/api/v1/no-such-route", {
			headers: { Host: "rebind.example" },
		});
		expect(res.status).toBe(403);
	});

	test("odd spellings of an API path never answer 200 for a rebinding Host", async () => {
		for (const path of ["/api/%76%31/sessions", "//api/v1/sessions", "/api/v1/sessions/"]) {
			const res = await app.request(`http://placeholder${path}`, {
				headers: { Host: "rebind.example" },
			});
			const type = res.headers.get("content-type") ?? "";
			expect([403, 404].includes(res.status) || !type.includes("json")).toBe(true);
			expect(res.status === 200 && type.includes("json")).toBe(false);
		}
	});

	test("auth on: the extra headers change no status", async () => {
		setAuthOff(false);
		const failures: string[] = [];
		for (const entry of included) {
			if (STATEFUL_PUBLIC.includes(entry)) continue;
			const plain = await send(entry, {});
			for (const testCase of REFUSED_CASES) {
				const res = await send(entry, testCase.headers);
				if (res.status !== plain.status) {
					failures.push(`${entry} [${testCase.name}] ${plain.status} -> ${res.status}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("GET routes that write state (M-A): none beyond the known list", async () => {
		const dialect = config.dialect;
		if (dialect !== "sqlite") return;
		const db = getDb() as unknown as { $client: import("bun:sqlite").Database };
		await getDb()
			.insert(sessions)
			.values({ sessionId: "abc", agentType: "claude_code", status: "active" } as never)
			.onConflictDoNothing();
		const client = db.$client;
		const fingerprint = () => {
			const tables = client
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>;
			expect(tables.length).toBeGreaterThan(20);
			return tables
				.map((t) => `${t.name}:${JSON.stringify(client.query(`SELECT * FROM "${t.name}"`).all())}`)
				.join("\n");
		};
		const writers: string[] = [];
		for (const entry of included.filter((e) => e.startsWith("GET /api/"))) {
			const before = fingerprint();
			await send(entry, { Host: "127.0.0.1:3000" });
			if (fingerprint() !== before) writers.push(entry);
		}
		// Findings, not fixes: a GET that writes is reachable cross-site with no Origin header on plain http.
		expect(writers.sort()).toEqual(KNOWN_GET_WRITERS);
	});
});

const KNOWN_GET_WRITERS: string[] = [];

// ---- Host and Origin rules ----

function get(headers: Record<string, string>, path = "/api/v1/sessions") {
	return app.request(`http://placeholder${path}`, { headers });
}

describe("trusted requests pass (auth off)", () => {
	const HOSTS = [
		"127.0.0.1:3000",
		"127.5.6.7",
		"localhost",
		"LOCALHOST:3000",
		"localhost.",
		"[::1]:3000",
		"192.168.1.5:3000",
		"[fd00::1]:3000",
		"mybox.local:3000",
		"mybox.local.",
	];
	for (const host of HOSTS) {
		test(`Host ${host}`, async () => {
			expect((await get({ Host: host })).status).toBe(200);
		});
	}
	test("no Host header", async () => {
		expect((await get({})).status).toBe(200);
	});

	test("Origins: Vite, loopback on any port, same-origin on an IP", async () => {
		expect((await get({ Host: "localhost:3000", Origin: "http://localhost:5173" })).status).toBe(
			200,
		);
		expect((await get({ Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:8080" })).status).toBe(
			200,
		);
		expect(
			(await get({ Host: "192.168.1.5:3000", Origin: "http://192.168.1.5:3000" })).status,
		).toBe(200);
		expect((await get({ Host: "127.0.0.1:3000", Origin: "http://mybox.example" })).status).toBe(
			200,
		);
	});

	test("Sec-Fetch-Site: same-origin, none, and same-site with a loopback Origin", async () => {
		expect((await get({ Host: "localhost:3000", "Sec-Fetch-Site": "same-origin" })).status).toBe(
			200,
		);
		expect((await get({ Host: "localhost:3000", "Sec-Fetch-Site": "none" })).status).toBe(200);
		expect(
			(
				await get({
					Host: "localhost:3000",
					"Sec-Fetch-Site": "same-site",
					Origin: "http://localhost:5173",
				})
			).status,
		).toBe(200);
	});

	test("an allowlisted Origin passes even when the browser says cross-site", async () => {
		expect(
			(
				await get({
					Host: "127.0.0.1:3000",
					"Sec-Fetch-Site": "cross-site",
					Origin: "http://mybox.example",
				})
			).status,
		).toBe(200);
	});

	test("M-A: a plain-http LAN GET with no Origin and no Sec-Fetch-Site passes (documented residual)", async () => {
		expect((await get({ Host: "192.168.1.5:3000" })).status).toBe(200);
	});
});

describe("untrusted requests are refused (auth off)", () => {
	const HOSTS = [
		"",
		"mybox.other",
		"127.0.0.1.rebind.example",
		"0x7f000001",
		"2130706433",
		"[::1].evil",
		"[fe80::1%25en0]",
		"localhost..",
		"a b",
		"host:99999",
		"localhost:0",
		"01.2.3.4.evil",
	];
	for (const host of HOSTS) {
		test(`Host "${host}"`, async () => {
			const res = await get({ Host: host });
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: string }).error).toBe("bad_origin");
		});
	}

	test("Origins: another port on a LAN IP, null, a sibling of an allowlisted name", async () => {
		for (const [host, origin] of [
			["192.168.1.5:3000", "http://192.168.1.5:8080"],
			["127.0.0.1:3000", "null"],
			["127.0.0.1:3000", "https://evil.mybox.example"],
		] as const) {
			const res = await get({ Host: host, Origin: origin });
			expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
		}
	});

	test("look-alike loopback Origins are refused (L-A)", async () => {
		for (const origin of [
			"http://localhost.evil.example",
			"http://127.0.0.1.evil.example",
			"http://127.0.0.1@evil.example",
			["http://localhost:80", "evil"].join("@"),
			"http://localhost./",
			"ftp://localhost",
			"http://[::1].evil",
			"http://foo.localhost",
			"http://localhost:5173/",
		]) {
			const res = await get({ Host: "127.0.0.1:3000", Origin: origin });
			expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
		}
	});

	test("a sibling same-site subdomain with an Origin is refused", async () => {
		const res = await get({
			Host: "mybox.example",
			"Sec-Fetch-Site": "same-site",
			Origin: "http://evil.mybox.example",
		});
		expect(res.status).toBe(403);
	});
});

describe("PUBLIC_URL allowlist", () => {
	test("a malformed entry is skipped, named once at boot, and never a 500", async () => {
		setPublicUrl("http://ok.example,not a url");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect((await get({ Host: "ok.example" })).status).toBe(200);
			expect((await get({ Host: "other.example" })).status).toBe(403);
			logAuthOffBootRule();
			const lines = warn.mock.calls.map((c) => String(c[0]));
			expect(lines.filter((l) => l.includes("not a url")).length).toBe(1);
			expect(lines.some((l) => l.includes("ok.example"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	test("changing PUBLIC_URL takes effect (the cache is keyed on the raw value)", async () => {
		setPublicUrl("http://first.example");
		expect((await get({ Host: "second.example" })).status).toBe(403);
		setPublicUrl("http://second.example");
		expect((await get({ Host: "second.example" })).status).toBe(200);
	});
});

describe("refusal log lines", () => {
	function capture() {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		return {
			lines: () => warn.mock.calls.map((c) => String(c[0])),
			restore: () => warn.mockRestore(),
		};
	}

	test("one line per new value, five at most a minute, then one summary", async () => {
		let now = 1_000_000;
		__resetAuthOffGateLogForTests(() => now);
		const log = capture();
		try {
			for (let i = 0; i < 8; i++) await get({ Host: `h${i}.example` });
			await get({ Host: "h0.example" });
			expect(log.lines().filter((l) => l.includes("refused a request")).length).toBe(5);
			now += 61_000;
			await get({ Host: "later.example" });
			const lines = log.lines();
			const summary = lines.find((l) => l.includes("more requests refused in the last minute"));
			expect(summary).toBe("[auth] 4 more requests refused in the last minute (8 distinct Hosts)");
			expect(lines.filter((l) => l.includes("refused a request")).length).toBe(6);
		} finally {
			log.restore();
		}
	});

	test("quotes, control characters and length are cleaned; no URL is built from the Host", async () => {
		const log = capture();
		try {
			await get({ Host: `evil"'${"a".repeat(300)}.example` });
			await get({ Host: "127.0.0.1:3000", Origin: 'https://evil.example"\u00ad' });
			const text = log.lines().join("\n");
			expect(text).toContain("from Origin https://evil.example (authentication is off)");
			expect(text).not.toContain("http://evil");
			const hostLine = log.lines().find((l) => l.includes("refused a request")) as string;
			const value = /Host (\S+) is not/.exec(hostLine)?.[1] ?? "";
			expect(value.length).toBeLessThanOrEqual(128);
			expect(value).not.toMatch(/["'`]/);
		} finally {
			log.restore();
		}
	});
});
