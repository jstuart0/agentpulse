#!/usr/bin/env bun
/**
 * F165/F187: the bundled server (what `bun run start` runs) must serve the
 * installers from strings embedded at build time, never from a scripts/
 * directory read at request time. This builds the server into a temp package
 * root that has its migrations but no scripts/, starts it there, and checks that
 * /setup-relay.sh carries today's relay.ts and statusline.sh verbatim, that
 * /install-local.sh is served, and that /health's `clients` checksums are the
 * relay's.
 */
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeChecksum } from "../src/server/util/checksum.js";

const ROOT = join(import.meta.dir, "..");
const BUN = process.execPath;
const PUBLIC_URL = "https://agentpulse.example.com";
const STARTUP_TIMEOUT_MS = 30_000;

function heredocPayload(content: string) {
	return `${content.replace(/\n+$/, "")}\n`;
}

async function freePort() {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = s.port as number;
	s.stop(true);
	return port;
}

async function main() {
	const pkg = await mkdtemp(join(tmpdir(), "ap-bundled-installers-"));
	let server: ReturnType<typeof Bun.spawn> | null = null;
	let serverLog = "";
	try {
		const build = Bun.spawnSync(
			[
				BUN,
				"build",
				"src/server/index.ts",
				"--outdir",
				join(pkg, "dist/server"),
				"--target",
				"bun",
			],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);
		if (build.exitCode !== 0) throw new Error(`bun build failed:\n${build.stderr.toString()}`);

		// A real package root: the bundle plus its migrations, but no scripts/.
		await cp(join(ROOT, "drizzle"), join(pkg, "drizzle"), { recursive: true });
		await mkdir(join(pkg, "data"));
		const port = await freePort();
		server = Bun.spawn([BUN, join(pkg, "dist/server/index.js")], {
			cwd: pkg,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: pkg,
				PORT: String(port),
				HOST: "127.0.0.1",
				DISABLE_AUTH: "true",
				DATA_DIR: join(pkg, "data"),
				PUBLIC_URL,
				NODE_ENV: "production",
				AGENTPULSE_TELEMETRY: "off",
			},
		});
		const collect = async (stream: ReadableStream<Uint8Array>) => {
			for await (const chunk of stream) serverLog += new TextDecoder().decode(chunk);
		};
		void collect(server.stdout as ReadableStream<Uint8Array>);
		void collect(server.stderr as ReadableStream<Uint8Array>);

		const base = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		let health: Response | null = null;
		while (Date.now() < deadline) {
			health = await fetch(`${base}/api/v1/health`).catch(() => null);
			if (health?.ok) break;
			await Bun.sleep(200);
		}
		if (!health?.ok)
			throw new Error(`the bundled server never became healthy\n\nserver log:\n${serverLog}`);
		const clients = ((await health.json()) as { clients?: Record<string, string> }).clients;

		const relay = await readFile(join(ROOT, "scripts/relay.ts"), "utf-8");
		const statusline = await readFile(join(ROOT, "scripts/statusline.sh"), "utf-8");
		const relayRes = await fetch(`${base}/setup-relay.sh`);
		const relayBody = await relayRes.text();
		const localRes = await fetch(`${base}/install-local.sh`);

		const failures: string[] = [];
		if (relayRes.status !== 200) failures.push(`/setup-relay.sh answered ${relayRes.status}`);
		if (!relayBody.includes(`<< 'AGENTPULSE_RELAY_TS_EOF'\n${heredocPayload(relay)}`)) {
			failures.push("/setup-relay.sh doesn't carry scripts/relay.ts verbatim");
		}
		if (!relayBody.includes(`<< 'AGENTPULSE_STATUSLINE_SH_EOF'\n${heredocPayload(statusline)}`)) {
			failures.push("/setup-relay.sh doesn't carry scripts/statusline.sh verbatim");
		}
		if (!relayBody.includes(`REMOTE_URL_DEFAULT="${PUBLIC_URL}"`)) {
			failures.push("/setup-relay.sh doesn't default to PUBLIC_URL");
		}
		if (localRes.status !== 200) failures.push(`/install-local.sh answered ${localRes.status}`);
		const relaySum = await computeChecksum(relay, { trimEnd: true });
		const statuslineSum = await computeChecksum(statusline, { trimEnd: true });
		if (clients?.relay !== relaySum || clients?.statusline !== statuslineSum) {
			failures.push(`/health clients ${JSON.stringify(clients)} don't match the scripts`);
		}
		if (failures.length > 0) {
			throw new Error(`${failures.join("\n")}\n\nserver log:\n${serverLog}`);
		}
		console.log("OK: the bundled server serves the embedded installers and checksums them");
	} finally {
		server?.kill();
		await server?.exited;
		await rm(pkg, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
