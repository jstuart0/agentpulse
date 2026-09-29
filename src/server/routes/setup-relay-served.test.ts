/**
 * Phase 4 (D19, F16, F44, F55; r7 byte-identical embeds; F165/F166/F172/F174):
 * the four served installers. They're embedded in the server at build time,
 * never read from disk per request. `/setup-relay.sh` is scripts/setup-relay.sh
 * with scripts/relay.ts and scripts/statusline.sh spliced in verbatim, /health
 * checksums the same embedded strings, and nothing is derived from the `Host`
 * hostname. The three local installers take at most a numeric port from `Host`.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { health, markDbReady } = await import("./health.js");
const { computeChecksum } = await import("../util/checksum.js");
const { INSTALLER_SOURCES, buildRelayInstaller } = await import("../installers.js");
const {
	setup,
	resolveLocalHookBaseUrl,
	resolvePublicServerUrl,
	INSTALLER_ERROR_CODES,
	installerErrorBody,
} = await import("./setup.js");

const SCRIPTS = join(import.meta.dir, "../../../scripts");
const INJECTION_HOST = 'evil.example";rm -rf ~;"';
const LOCAL_INSTALLERS = ["/setup.sh", "/install-local.sh", "/install-local.ps1"] as const;
const ALL_INSTALLERS = [...LOCAL_INSTALLERS, "/setup-relay.sh"] as const;

const saved = {
	publicUrl: config.publicUrl,
	publicUrlExplicit: config.publicUrlExplicit,
	port: config.port,
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

async function runBash(args: string[], body: string) {
	const dir = await mkdtemp(join(tmpdir(), "ap-served-bash-"));
	try {
		const file = join(dir, "script.sh");
		await writeFile(file, body);
		const proc = Bun.spawn(["bash", ...args, file], { stdout: "pipe", stderr: "pipe" });
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

const sources = () => ({
	setupRelay: INSTALLER_SOURCES.setupRelay,
	relay: INSTALLER_SOURCES.relay,
	statusline: INSTALLER_SOURCES.statusline,
});

beforeAll(async () => {
	await initializeDatabase();
	markDbReady();
});

afterEach(() => {
	config.publicUrl = saved.publicUrl;
	config.publicUrlExplicit = saved.publicUrlExplicit;
	config.port = saved.port;
});

describe("F165: the installers are embedded at build time", () => {
	test("the embedded sources are today's files, byte for byte", async () => {
		expect(INSTALLER_SOURCES.setupRelay).toBe(
			await readFile(join(SCRIPTS, "setup-relay.sh"), "utf-8"),
		);
		expect(INSTALLER_SOURCES.relay).toBe(await readFile(join(SCRIPTS, "relay.ts"), "utf-8"));
		expect(INSTALLER_SOURCES.statusline).toBe(
			await readFile(join(SCRIPTS, "statusline.sh"), "utf-8"),
		);
		expect(INSTALLER_SOURCES.installLocalSh).toBe(
			await readFile(join(SCRIPTS, "install-local.sh"), "utf-8"),
		);
		expect(INSTALLER_SOURCES.installLocalPs1).toBe(
			await readFile(join(SCRIPTS, "install-local.ps1"), "utf-8"),
		);
	});

	test("/health checksums the same embedded bytes /setup-relay.sh splices in", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const body = (await (await get("/api/v1/health")).json()) as {
			clients: { relay: string; statusline: string };
		};
		expect(body.clients).toEqual({
			relay: await computeChecksum(INSTALLER_SOURCES.relay, { trimEnd: true }),
			statusline: await computeChecksum(INSTALLER_SOURCES.statusline, { trimEnd: true }),
		});
		const served = await (await get("/setup-relay.sh")).text();
		const relay = served
			.split("<< 'AGENTPULSE_RELAY_TS_EOF'\n")[1]
			.split("\nAGENTPULSE_RELAY_TS_EOF\n")[0];
		expect(await computeChecksum(relay, { trimEnd: true })).toBe(body.clients.relay);
	});
});

describe("/setup-relay.sh — one installer, canonical sources spliced in", () => {
	test("the body carries relay.ts and statusline.sh byte-for-byte, no markers, and parses", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const res = await get("/setup-relay.sh", "agentpulse.example.com");
		expect(res.status).toBe(200);
		const body = await res.text();

		expect(body).toContain(
			`<< 'AGENTPULSE_RELAY_TS_EOF'\n${heredocPayload(INSTALLER_SOURCES.relay)}AGENTPULSE_RELAY_TS_EOF\n`,
		);
		expect(body).toContain(
			`<< 'AGENTPULSE_STATUSLINE_SH_EOF'\n${heredocPayload(INSTALLER_SOURCES.statusline)}AGENTPULSE_STATUSLINE_SH_EOF\n`,
		);
		// The AGEN-16 stamp rides along because the copy is exact.
		expect(body).toContain('const DELIVERY_ID_HEADER = "X-AgentPulse-Delivery-Id";');
		expect(body).not.toContain("@@AGENTPULSE_");
		expect(body).not.toContain("INNER_EOF");
		expect(body).not.toContain("/api/v1/agents-md");

		const syntax = await runBash(["-n"], body);
		expect(syntax.stderr).toBe("");
		expect(syntax.code).toBe(0);
	});

	test("the rest of the body is scripts/setup-relay.sh with only the URL default filled in", async () => {
		setPublicUrl("https://agentpulse.example.com");
		const body = await (await get("/setup-relay.sh")).text();
		expect(INSTALLER_SOURCES.setupRelay).toContain('REMOTE_URL_DEFAULT=""');
		expect(body).toContain('REMOTE_URL_DEFAULT="https://agentpulse.example.com"');
		expect(body).not.toContain('REMOTE_URL_DEFAULT=""');
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
		expect(unspliced).toBe(INSTALLER_SOURCES.setupRelay);
	});
});

describe("buildRelayInstaller refuses broken sources (F16)", () => {
	test("the real sources build", () => {
		expect(buildRelayInstaller(sources(), "https://example.invalid").ok).toBe(true);
	});

	test("an empty relay.ts is refused", () => {
		expect(
			buildRelayInstaller({ ...sources(), relay: "" }, "https://example.invalid"),
		).toMatchObject({
			ok: false,
		});
	});

	test("a source line equal to a heredoc terminator is refused", () => {
		const relay = "// ok\nAGENTPULSE_RELAY_TS_EOF\nrm -rf ~\n";
		expect(buildRelayInstaller({ ...sources(), relay }, "https://example.invalid").ok).toBe(false);
	});

	test("a source carrying an installer marker is refused", () => {
		const statusline = "#!/bin/sh\n# @@AGENTPULSE_RELAY_TS@@\n";
		expect(buildRelayInstaller({ ...sources(), statusline }, "https://example.invalid").ok).toBe(
			false,
		);
	});

	test("a setup-relay.sh without its markers is refused", () => {
		const setupRelay = '#!/usr/bin/env bash\nREMOTE_URL_DEFAULT=""\n';
		expect(buildRelayInstaller({ ...sources(), setupRelay }, "https://example.invalid").ok).toBe(
			false,
		);
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

describe("D19/F44/F55/F172/F174 — /setup-relay.sh never reflects Host", () => {
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

	test("PUBLIC_URL unset + non-loopback Host → 503 public_url_unset", async () => {
		setPublicUrl(null);
		const res = await get("/setup-relay.sh", "attacker.example");
		expect(res.status).toBe(503);
		const body = await res.text();
		expect(body).toContain('{"error":"public_url_unset"}');
		expect(body).toContain(
			"Set PUBLIC_URL on the AgentPulse server so the relay installer knows its public address.",
		);
		expect(body).not.toContain("attacker.example");
	});

	test("F174: PUBLIC_URL unset + loopback Host → the Host's numeric port, else config.port", async () => {
		setPublicUrl(null);
		config.port = 3000;
		for (const [host, url] of [
			["localhost:3000", "http://localhost:3000"],
			["127.0.0.1:4321", "http://localhost:4321"],
			["[::1]:4322", "http://localhost:4322"],
			["localhost", "http://localhost:3000"],
		]) {
			const res = await get("/setup-relay.sh", host);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain(`REMOTE_URL_DEFAULT="${url}"`);
		}
	});

	test("F172/F198: an explicit loopback PUBLIC_URL isn't handed to another machine", async () => {
		for (const publicUrl of [
			"http://localhost:3000",
			"http://127.0.0.1:3000",
			"http://[::1]:3000",
			// F198: 0.0.0.0 is a bind address, not a routable host.
			"http://0.0.0.0:3000",
		]) {
			setPublicUrl(publicUrl);
			const res = await get("/setup-relay.sh", "agentpulse.example.com");
			expect(res.status).toBe(503);
			const body = await res.text();
			expect(body).toContain('{"error":"public_url_loopback"}');
			expect(body).toContain("Set PUBLIC_URL on the AgentPulse server");
			// The same machine may still use it.
			const local = await get("/setup-relay.sh", "localhost:3000");
			expect(local.status).toBe(200);
			expect(await local.text()).toContain(`REMOTE_URL_DEFAULT="${publicUrl}"`);
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

describe("F166: every 503 body is valid shell that fails loudly", () => {
	for (const code of INSTALLER_ERROR_CODES) {
		test(`${code}: bash -n passes, and running it prints the reason and exits 1`, async () => {
			const body = installerErrorBody(code);
			expect(body).toContain(JSON.stringify({ error: code }));
			const syntax = await runBash(["-n"], body);
			expect(syntax.stderr).toBe("");
			expect(syntax.code).toBe(0);
			const run = await runBash([], body);
			expect(run.code).toBe(1);
			expect(run.stderr).toContain("AgentPulse: ");
			expect(run.stderr.length).toBeGreaterThan("AgentPulse: ".length + 20);
		});
	}

	test("the codes include the loopback and invalid PUBLIC_URL cases", () => {
		expect([...INSTALLER_ERROR_CODES].sort()).toEqual([
			"installer_unavailable",
			"public_url_invalid",
			"public_url_loopback",
			"public_url_unset",
		]);
	});
});

describe("F192: installer responses are never cached across requesters", () => {
	// Bodies embed the requester's Host (F172/F174), so a cache keyed only on
	// the URL would serve one requester's script to the next.
	for (const path of ALL_INSTALLERS) {
		test(`${path}: 200 response carries Cache-Control: no-store and Vary: Host`, async () => {
			setPublicUrl("https://agentpulse.example.com");
			config.port = 3000;
			const res = await get(path, "agentpulse.example.com");
			expect(res.status).toBe(200);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(res.headers.get("Vary")).toBe("Host");
		});
	}

	test("/setup-relay.sh: the 503 error response also carries both headers", async () => {
		setPublicUrl(null);
		const res = await get("/setup-relay.sh", "attacker.example");
		expect(res.status).toBe(503);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Vary")).toBe("Host");
	});
});
