/**
 * Phase 4 (D19, F16, F44, F55; r7 byte-identical embeds): the four served
 * installers. `/setup-relay.sh` is built per request from scripts/setup-relay.sh
 * with scripts/relay.ts and scripts/statusline.sh spliced in verbatim, and it
 * never derives anything from `Host`. The three local installers take at most
 * a numeric port from `Host`, never its hostname.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { health, markDbReady } = await import("./health.js");
const { setup, resolveLocalHookBaseUrl, resolvePublicServerUrl, SCRIPTS_DIR_ENV } = await import(
	"./setup.js"
);

const SCRIPTS = join(import.meta.dir, "../../../scripts");
const INJECTION_HOST = 'evil.example";rm -rf ~;"';
const LOCAL_INSTALLERS = ["/setup.sh", "/install-local.sh", "/install-local.ps1"] as const;
const ALL_INSTALLERS = [...LOCAL_INSTALLERS, "/setup-relay.sh"] as const;

const saved = {
	publicUrl: config.publicUrl,
	publicUrlExplicit: config.publicUrlExplicit,
	port: config.port,
	scriptsDir: process.env[SCRIPTS_DIR_ENV],
};

function buildApp() {
	const app = new Hono();
	app.route("/api/v1", health);
	app.route("/", setup);
	return app;
}

function get(path: string, host?: string) {
	return buildApp().request(path, host ? { headers: { Host: host } } : undefined);
}

function setPublicUrl(value: string | null) {
	config.publicUrl = value ?? "http://localhost:3000";
	config.publicUrlExplicit = value !== null;
}

async function bashSyntaxOk(body: string) {
	const dir = await mkdtemp(join(tmpdir(), "ap-served-syntax-"));
	try {
		const file = join(dir, "setup-relay.sh");
		await writeFile(file, body);
		const proc = Bun.spawn(["bash", "-n", file], { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		return { code: proc.exitCode, stderr };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** What a quoted heredoc writes: the file with exactly one trailing newline. */
function heredocPayload(content: string) {
	return `${content.replace(/\n+$/, "")}\n`;
}

beforeAll(async () => {
	await initializeDatabase();
	markDbReady();
});

afterEach(() => {
	config.publicUrl = saved.publicUrl;
	config.publicUrlExplicit = saved.publicUrlExplicit;
	config.port = saved.port;
	if (saved.scriptsDir === undefined) delete process.env[SCRIPTS_DIR_ENV];
	else process.env[SCRIPTS_DIR_ENV] = saved.scriptsDir;
});

describe("/setup-relay.sh — one installer, canonical sources spliced at request time", () => {
	test("the body carries relay.ts and statusline.sh byte-for-byte, no markers, and parses", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const res = await get("/setup-relay.sh", "agentpulse.example.com");
		expect(res.status).toBe(200);
		const body = await res.text();

		const relay = await readFile(join(SCRIPTS, "relay.ts"), "utf-8");
		const statusline = await readFile(join(SCRIPTS, "statusline.sh"), "utf-8");
		expect(body).toContain(
			`<< 'AGENTPULSE_RELAY_TS_EOF'\n${heredocPayload(relay)}AGENTPULSE_RELAY_TS_EOF\n`,
		);
		expect(body).toContain(
			`<< 'AGENTPULSE_STATUSLINE_SH_EOF'\n${heredocPayload(statusline)}AGENTPULSE_STATUSLINE_SH_EOF\n`,
		);
		// The AGEN-16 stamp rides along because the copy is exact.
		expect(body).toContain('const DELIVERY_ID_HEADER = "X-AgentPulse-Delivery-Id";');
		expect(body).not.toContain("@@AGENTPULSE_");
		// The stale embedded relay and its agents-md handler are gone.
		expect(body).not.toContain("INNER_EOF");
		expect(body).not.toContain("/api/v1/agents-md");

		const syntax = await bashSyntaxOk(body);
		expect(syntax.stderr).toBe("");
		expect(syntax.code).toBe(0);
	});

	test("the rest of the body is scripts/setup-relay.sh with only the URL default filled in", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const body = await (await get("/setup-relay.sh")).text();
		const source = await readFile(join(SCRIPTS, "setup-relay.sh"), "utf-8");
		expect(source).toContain('REMOTE_URL_DEFAULT=""');
		expect(body).toContain('REMOTE_URL_DEFAULT="https://agentpulse.example.com"');
		expect(body).not.toContain('REMOTE_URL_DEFAULT=""');
		// Removing the two spliced heredocs gives back the source with the markers.
		const unspliced = body
			.replace(
				/^cat > "\$SRC_DIR\/relay\.ts" << 'AGENTPULSE_RELAY_TS_EOF'\n[\s\S]*?\nAGENTPULSE_RELAY_TS_EOF$/m,
				"# @@AGENTPULSE_RELAY_TS@@",
			)
			.replace(
				/^cat > "\$SRC_DIR\/statusline\.sh" << 'AGENTPULSE_STATUSLINE_SH_EOF'\n[\s\S]*?\nAGENTPULSE_STATUSLINE_SH_EOF$/m,
				"# @@AGENTPULSE_STATUSLINE_SH@@",
			)
			.replace('REMOTE_URL_DEFAULT="https://agentpulse.example.com"', 'REMOTE_URL_DEFAULT=""');
		expect(unspliced).toBe(source);
	});

	test("the sources are read per request: an edit on disk shows up without a restart", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const dir = await mkdtemp(join(tmpdir(), "ap-served-live-"));
		try {
			for (const name of ["setup-relay.sh", "statusline.sh"]) {
				await writeFile(join(dir, name), await readFile(join(SCRIPTS, name), "utf-8"));
			}
			process.env[SCRIPTS_DIR_ENV] = dir;
			await writeFile(join(dir, "relay.ts"), "// first\n");
			expect(await (await get("/setup-relay.sh")).text()).toContain("// first\n");
			await writeFile(join(dir, "relay.ts"), "// second\n");
			const body = await (await get("/setup-relay.sh")).text();
			expect(body).toContain("// second\n");
			expect(body).not.toContain("// first\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("D19 — Host is never used as a hostname (all four served installers)", () => {
	for (const path of ALL_INSTALLERS) {
		test(`${path}: an injection Host reaches no part of the body`, async () => {
			setPublicUrl("https://agentpulse.example.com");
			config.port = 3000;
			const res = await get(path, INJECTION_HOST);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).not.toContain("rm -rf ~");
			expect(body).not.toContain("evil.example");
			if (path === "/setup-relay.sh") {
				expect(body).toContain('REMOTE_URL_DEFAULT="https://agentpulse.example.com"');
			} else {
				expect(body).toContain("http://localhost:3000");
			}
		});
	}

	for (const path of LOCAL_INSTALLERS) {
		test(`${path}: an injection riding in the Host port reaches no part of the body`, async () => {
			config.port = 3000;
			const res = await get(path, 'evil.example:1";rm -rf ~;"');
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).not.toContain("rm -rf ~");
			expect(body).toContain("http://localhost:3000");
		});

		test(`${path}: Host evil.example:3999 → http://localhost:3999, hostname ignored`, async () => {
			config.port = 3000;
			const body = await (await get(path, "evil.example:3999")).text();
			expect(body).toContain("http://localhost:3999");
			expect(body).not.toContain("evil.example");
		});
	}

	test("resolveLocalHookBaseUrl takes only a well-formed numeric port", () => {
		config.port = 3000;
		expect(resolveLocalHookBaseUrl(undefined)).toBe("http://localhost:3000");
		expect(resolveLocalHookBaseUrl("localhost:4321")).toBe("http://localhost:4321");
		expect(resolveLocalHookBaseUrl("[::1]:4321")).toBe("http://localhost:4321");
		expect(resolveLocalHookBaseUrl("evil.example:3999")).toBe("http://localhost:3999");
		expect(resolveLocalHookBaseUrl("evil.example")).toBe("http://localhost:3000");
		expect(resolveLocalHookBaseUrl("evil.example:39x9")).toBe("http://localhost:3000");
		expect(resolveLocalHookBaseUrl("evil.example:123456")).toBe("http://localhost:3000");
		expect(resolveLocalHookBaseUrl("evil.example:99999")).toBe("http://localhost:3000");
		expect(resolveLocalHookBaseUrl(INJECTION_HOST)).toBe("http://localhost:3000");
		expect(resolveLocalHookBaseUrl('x:1";rm -rf ~;"')).toBe("http://localhost:3000");
	});
});

describe("D19/F44/F55 — /setup-relay.sh never reflects Host", () => {
	test("PUBLIC_URL set: the default is PUBLIC_URL whatever the Host", async () => {
		setPublicUrl("https://agentpulse.example.com");
		for (const host of ["attacker.example", "localhost:3000", INJECTION_HOST]) {
			const res = await get("/setup-relay.sh", host);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain('REMOTE_URL_DEFAULT="https://agentpulse.example.com"');
			expect(body).not.toContain("attacker.example");
		}
	});

	test("PUBLIC_URL unset + non-loopback Host → 503 public_url_unset, safe to pipe into bash", async () => {
		setPublicUrl(null);
		const res = await get("/setup-relay.sh", "attacker.example");
		expect(res.status).toBe(503);
		const body = await res.text();
		expect(body).toContain('{"error":"public_url_unset"}');
		expect(body).toContain(
			"Set PUBLIC_URL on the AgentPulse server so the relay installer knows its public address.",
		);
		expect(body).not.toContain("attacker.example");
		// A `curl | bash` user sees the message and a failing exit, not garbage.
		const proc = Bun.spawn(["bash", "-c", body], { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("Set PUBLIC_URL");
	});

	test("PUBLIC_URL unset + loopback Host → 200 with the local server URL", async () => {
		setPublicUrl(null);
		config.port = 3000;
		for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
			const res = await get("/setup-relay.sh", host);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('REMOTE_URL_DEFAULT="http://localhost:3000"');
		}
	});

	test("resolvePublicServerUrl: first entry of a comma-separated PUBLIC_URL, trailing slash dropped", () => {
		config.publicUrl = "https://agentpulse.example.com/,http://localhost:5173";
		config.publicUrlExplicit = true;
		expect(resolvePublicServerUrl("anything.example")).toEqual({
			ok: true,
			url: "https://agentpulse.example.com",
		});
	});

	test("resolvePublicServerUrl refuses a PUBLIC_URL that isn't a plain http(s) URL", () => {
		config.publicUrlExplicit = true;
		for (const bad of ['https://x.example/"$(id)"', "ftp://x.example", "https://x.example/`id`"]) {
			config.publicUrl = bad;
			expect(resolvePublicServerUrl("localhost:3000")).toEqual({
				ok: false,
				error: "public_url_invalid",
			});
		}
	});
});

describe("F16 — unavailable sources are a 503, never a throw", () => {
	test("a missing scripts/relay.ts → 503 installer_unavailable, and /health is still 200", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const dir = await mkdtemp(join(tmpdir(), "ap-served-missing-"));
		try {
			for (const name of ["setup-relay.sh", "statusline.sh"]) {
				await writeFile(join(dir, name), await readFile(join(SCRIPTS, name), "utf-8"));
			}
			process.env[SCRIPTS_DIR_ENV] = dir;
			const res = await get("/setup-relay.sh");
			expect(res.status).toBe(503);
			const body = await res.text();
			expect(body).toContain('{"error":"installer_unavailable"}');
			expect(body).not.toContain(dir);

			const healthRes = await get("/api/v1/health");
			expect(healthRes.status).toBe(200);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a source line equal to a heredoc terminator → 503 installer_unavailable", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const dir = await mkdtemp(join(tmpdir(), "ap-served-collide-"));
		try {
			for (const name of ["setup-relay.sh", "statusline.sh"]) {
				await writeFile(join(dir, name), await readFile(join(SCRIPTS, name), "utf-8"));
			}
			await writeFile(join(dir, "relay.ts"), "// ok\nAGENTPULSE_RELAY_TS_EOF\nrm -rf ~\n");
			process.env[SCRIPTS_DIR_ENV] = dir;
			const res = await get("/setup-relay.sh");
			expect(res.status).toBe(503);
			const body = await res.text();
			expect(body).toContain('{"error":"installer_unavailable"}');
			expect(body).not.toContain("rm -rf ~");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a setup-relay.sh without its markers → 503 installer_unavailable", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const dir = await mkdtemp(join(tmpdir(), "ap-served-nomarker-"));
		try {
			for (const name of ["relay.ts", "statusline.sh"]) {
				await writeFile(join(dir, name), await readFile(join(SCRIPTS, name), "utf-8"));
			}
			await writeFile(join(dir, "setup-relay.sh"), '#!/usr/bin/env bash\nREMOTE_URL_DEFAULT=""\n');
			process.env[SCRIPTS_DIR_ENV] = dir;
			expect((await get("/setup-relay.sh")).status).toBe(503);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
