/**
 * The push modules against a real relay build and a mock APNs, nothing mocked in between:
 * register a device at the relay, mint a send token, seal and send through the service and
 * the client, and read what reached APNs.
 *
 * It needs the relay's built output (`dist/node.js`, `dist/sql/`, `dist-dev/mock-apns.js`) and Node 24.
 * Point AGENTPULSE_RELAY_DIR at the relay directory. Without it the file skips and prints why, so the
 * server's own CI never depends on the relay; AGENTPULSE_E2E_REQUIRE=1 turns a skip into a failure.
 * scripts/e2e-real-relay.sh runs it for real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { config } from "../../config.js";
import { decryptSecret, decryptSecretAsync, encryptSecret } from "../ai/secrets.js";
import { HPKE_INFO, type PushPayload, pushAad } from "./hpke-seal.js";
import { PushService } from "./push-service.js";
import { RelayClient } from "./relay-client.js";
import type { PushDevice, PushLogger } from "./types.js";

const relayDir = process.env.AGENTPULSE_RELAY_DIR ?? "";
const files = {
	node: join(relayDir, "dist/node.js"),
	sql: join(relayDir, "dist/sql"),
	mock: join(relayDir, "dist-dev/mock-apns.js"),
};
const missing = relayDir
	? Object.entries(files)
			.filter(([, path]) => !existsSync(path))
			.map(([name]) => name)
	: ["AGENTPULSE_RELAY_DIR"];
const runnable = missing.length === 0;
if (!runnable) {
	const reason = `real-relay e2e skipped: ${relayDir ? `relay build incomplete (missing ${missing.join(", ")}); run npm ci && npm run build in the relay directory` : "AGENTPULSE_RELAY_DIR is not set"}`;
	if (process.env.AGENTPULSE_E2E_REQUIRE === "1") throw new Error(reason);
	console.log(reason);
}

const BUNDLE_ID = "com.example.agentpulse";
const suite = new CipherSuite({
	kem: new DhkemP256HkdfSha256(),
	kdf: new HkdfSha256(),
	aead: new Aes256Gcm(),
});
const b64u = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

interface Spawned {
	proc: ChildProcess;
	lines: string[];
}
function launch(file: string, args: string[], env: Record<string, string>): Spawned {
	const proc = spawn("node", [file, ...args], {
		env: { PATH: process.env.PATH ?? "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	for (const stream of [proc.stdout, proc.stderr]) {
		stream
			?.setEncoding("utf8")
			.on("data", (d: string) => lines.push(...d.split("\n").filter(Boolean)));
	}
	return { proc, lines };
}
async function listening(child: Spawned): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		for (const line of child.lines) {
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				if (parsed.event === "listening") return parsed;
			} catch {
				// not a log line
			}
		}
		if (child.proc.exitCode !== null)
			throw new Error(`process exited early: ${child.lines.slice(-3).join(" | ")}`);
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting for the process to listen");
}

interface Phone {
	device: PushDevice;
	sendToken: string;
	sendTokenId: string;
	manageSecret: string;
	open(e: string, c: string, d: string, p: string): Promise<PushPayload>;
}

const describeIf = runnable ? describe : describe.skip;

describeIf("real relay + mock APNs", () => {
	let dir = "";
	let mock: Spawned;
	let relay: Spawned;
	let base = "";
	let logPath = "";
	const savedSecretsKey = config.secretsKey;
	const revocations: string[] = [];
	const logLines: string[] = [];
	const logger: PushLogger = {
		info: (m, f) => void logLines.push(`${m} ${JSON.stringify(f ?? {})}`),
		warn: (m, f) => void logLines.push(`${m} ${JSON.stringify(f ?? {})}`),
	};
	const nowMs = Date.now();
	let service: PushService;
	let client: RelayClient;
	let seq = 0;

	beforeAll(async () => {
		(config as { secretsKey: string }).secretsKey = "e2e-instance-secrets-key";
		dir = mkdtempSync(join(tmpdir(), "ap-e2e-"));
		mock = launch(files.mock, ["--port", "0", "--h2-port", "0", "--run-dir", dir], {});
		const mockInfo = await listening(mock);
		logPath = String(mockInfo.log);
		const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
			type: "pkcs8",
			format: "pem",
		});
		relay = launch(files.node, [], {
			APNS_BUNDLE_ID: BUNDLE_ID,
			APNS_ENV_ALLOWED: "sandbox",
			APNS_BASE_URL: `http://127.0.0.1:${mockInfo.h2Port}`,
			APNS_KEY_P8: String(apnsKey),
			APNS_KEY_ID: "ABC123DEFG",
			APNS_TEAM_ID: "TEAM123456",
			TOKEN_ENC_KEY: b64u(randomBytes(32)),
			RELAY_PORT: process.env.AGENTPULSE_E2E_RELAY_PORT ?? "0",
			RELAY_DB_PATH: join(dir, "relay.sqlite"),
		});
		const relayInfo = await listening(relay);
		base = `http://127.0.0.1:${relayInfo.port}`;
		client = new RelayClient({ relayUrl: base, logger });
		service = new PushService({
			relay: client,
			revocations: {
				deviceGone: (d) => void revocations.push(`deviceGone:${d.id}`),
				activityGone: (d, slot) => void revocations.push(`activityGone:${d.id}:${slot}`),
				tokenRejected: (d) => void revocations.push(`tokenRejected:${d.id}`),
			},
			readSendToken: decryptSecretAsync,
			clock: { now: () => nowMs },
			logger,
			newPushId: () => `e2e-push-${++seq}`,
		});
	}, 30_000);

	afterAll(async () => {
		(config as { secretsKey: string }).secretsKey = savedSecretsKey;
		for (const child of [relay, mock]) child?.proc.kill("SIGTERM");
		await new Promise((r) => setTimeout(r, 200));
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	async function api(method: string, path: string, body: unknown, bearer?: string) {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: {
				"content-type": "application/json",
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		});
		const text = await res.text();
		return { status: res.status, body: text ? (JSON.parse(text) as Record<string, string>) : {} };
	}

	/** A phone: registered at the relay with the given APNs token, a send token minted, and a real key pair. */
	async function pairPhone(apnsToken: string): Promise<Phone> {
		const registered = await api("POST", "/v1/devices", {
			platform: "ios",
			env: "sandbox",
			apnsToken,
		});
		expect(registered.status).toBe(201);
		const deviceId = registered.body.deviceId as string;
		const manageSecret = registered.body.manageSecret as string;
		const minted = await api(
			"POST",
			`/v1/devices/${deviceId}/send-tokens`,
			{ label: "e2e" },
			manageSecret,
		);
		expect(minted.status).toBe(201);
		const pair = await suite.kem.generateKeyPair();
		const n = ++seq;
		const device: PushDevice = {
			id: `e2e-dev-${n}`,
			userId: "e2e-user",
			platform: "ios",
			relayDeviceId: deviceId,
			ownerlessKeyId: null,
			sendTokenCiphertext: encryptSecret(minted.body.sendToken as string),
			kid: `e2e-kid-${n}`,
			publicKey: b64u(new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey))),
			clientServerRef: "e2e-ref",
			prefs: { includeAgentText: true },
		};
		return {
			device,
			sendToken: minted.body.sendToken as string,
			sendTokenId: minted.body.sendTokenId as string,
			manageSecret,
			open: async (e, c, d, p) => {
				const plaintext = await suite.open(
					{
						recipientKey: pair.privateKey,
						enc: unb64u(e),
						info: new TextEncoder().encode(HPKE_INFO),
					},
					unb64u(c),
					new TextEncoder().encode(pushAad(d, p)),
				);
				return JSON.parse(new TextDecoder().decode(plaintext)) as PushPayload;
			},
		};
	}

	type ApnsEntry = {
		path: string;
		status: number;
		pushType: string;
		priority: string;
		topic: string;
		payload: Record<string, unknown>;
	};
	const apnsRequests = (apnsToken: string): ApnsEntry[] =>
		readFileSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ApnsEntry)
			.filter((e) => e.path === `/3/device/${apnsToken}`);

	const goneToken = `ffff${"ab".repeat(30)}`;

	test("an alert is sealed by the service and arrives at APNs as fixed-value aps plus the opaque envelope, which opens to the exact plaintext", async () => {
		const tokenHex = "c1".repeat(32);
		const phone = await pairPhone(tokenHex);
		const [outcome] = await service.sendToDevices([phone.device], {
			type: "permission_wait",
			sessionId: "sess-e2e-1",
			sessionName: "migrate the billing tables",
			agent: "claude",
			machine: "example-machine",
			status: "waiting",
			pending: 2,
			text: "Bash wants to run: npm test",
		});
		expect(outcome?.status).toBe("sent");

		const [arrived] = apnsRequests(tokenHex);
		expect(arrived).toBeDefined();
		expect(arrived).toMatchObject({
			status: 200,
			pushType: "alert",
			priority: "10",
			topic: BUNDLE_ID,
		});
		const collapseId = sha256Hex("sess-e2e-1|NEEDS_YOU_PERMISSION").slice(0, 32);
		expect(arrived?.payload.aps).toEqual({
			alert: { title: "AgentPulse", body: "New activity" },
			"mutable-content": 1,
			category: "GENERIC_OPEN",
			"thread-id": sha256Hex(collapseId).slice(0, 16),
			"interruption-level": "time-sensitive",
		});

		const { aps: _aps, ...envelope } = arrived?.payload as {
			aps: unknown;
			v: number;
			e: string;
			c: string;
			d: string;
			p: string;
		};
		expect(Object.keys(envelope).sort()).toEqual(["c", "d", "e", "p", "v"]);
		expect(envelope).toMatchObject({ v: 1, d: phone.device.relayDeviceId });
		const everything = JSON.stringify(arrived?.payload);
		for (const secret of [
			"sess-e2e-1",
			"migrate the billing",
			"npm test",
			"claude",
			"example-machine",
		]) {
			expect(everything.includes(secret), `APNs saw ${secret}`).toBe(false);
		}

		const plaintext = await phone.open(envelope.e, envelope.c, envelope.d, envelope.p);
		expect(plaintext).toEqual({
			v: 1,
			kid: phone.device.kid,
			pid: envelope.p,
			ts: Math.floor(nowMs / 1000),
			ref: "e2e-ref",
			t: "permission_wait",
			cat: "NEEDS_YOU_PERMISSION",
			il: "time-sensitive",
			sid: "sess-e2e-1",
			sname: "migrate the billing tables",
			agent: "claude",
			machine: "example-machine",
			status: "waiting",
			pending: 2,
			text: "Bash wants to run: npm test",
		});
	}, 30_000);

	test("a quiet class event reaches APNs at the relay's passive priority", async () => {
		const tokenHex = "c2".repeat(32);
		const phone = await pairPhone(tokenHex);
		phone.device.prefs = { categories: { SESSION_COMPLETED: true } };
		const [outcome] = await service.sendToDevices([phone.device], {
			type: "session_completed",
			sessionId: "sess-e2e-2",
		});
		expect(outcome?.status).toBe("sent");
		const [arrived] = apnsRequests(tokenHex);
		expect(arrived).toMatchObject({ priority: "5" });
		expect((arrived?.payload.aps as Record<string, unknown>)["interruption-level"]).toBe("passive");
	}, 30_000);

	test("a phone APNs reports as gone becomes gone:device at the relay, the device outcome 'gone', and one revocation", async () => {
		const phone = await pairPhone(goneToken);
		const [outcome] = await service.sendToDevices([phone.device], {
			type: "permission_wait",
			sessionId: "sess-e2e-3",
		});
		expect(outcome).toEqual({ deviceId: phone.device.id, status: "gone" });
		expect(revocations).toContain(`deviceGone:${phone.device.id}`);
		expect(apnsRequests(goneToken)).toHaveLength(1);
		expect(apnsRequests(goneToken)[0]?.status).toBe(410);
	}, 30_000);

	test("a Live Activity token APNs reports as gone becomes gone:activity: that activity ends and the device is kept", async () => {
		const phone = await pairPhone("c3".repeat(32));
		const bound = await api(
			"PUT",
			`/v1/devices/${phone.device.relayDeviceId}/activities/dead`,
			{ token: goneToken, generation: 1, sendTokenId: phone.sendTokenId },
			phone.manageSecret,
		);
		expect(bound.status).toBe(204);
		const outcome = await service.sendActivityUpdate(phone.device, {
			slot: "dead",
			generation: 1,
			event: "update",
			contentState: {
				status: "working",
				statusSince: 1_760_000_000,
				toolCount: 1,
				trace: new Array(24).fill(0),
			},
		});
		expect(outcome).toMatchObject({ status: "activity_gone", slot: "dead" });
		expect(revocations).toContain(`activityGone:${phone.device.id}:dead`);
		expect(revocations).not.toContain(`deviceGone:${phone.device.id}`);
	}, 30_000);

	test("a spent activity budget is a 429 for activities only: the same send token still gets its alerts through", async () => {
		const tokenHex = "c4".repeat(32);
		const phone = await pairPhone(tokenHex);
		const activityToken = "d4".repeat(32);
		await api(
			"PUT",
			`/v1/devices/${phone.device.relayDeviceId}/activities/live`,
			{ token: activityToken, generation: 1, sendTokenId: phone.sendTokenId },
			phone.manageSecret,
		);
		const state = {
			status: "working",
			statusSince: 1_760_000_000,
			toolCount: 1,
			trace: new Array(24).fill(0),
		};
		const kinds: string[] = [];
		let retryAfterSec: number | null = null;
		const plain = decryptSecret(phone.device.sendTokenCiphertext);
		for (let i = 0; i < 14; i++) {
			const result = await client.postLiveActivity(plain, {
				slot: "live",
				generation: 1,
				event: "update",
				contentState: state,
			});
			kinds.push(result.kind === "budget" ? `budget:${result.budget}` : result.kind);
			if (result.kind === "budget") retryAfterSec = result.retryAfterSec;
		}
		expect(kinds.slice(0, 10).every((k) => k === "accepted")).toBe(true);
		expect(kinds).toContain("budget:activity");
		expect(retryAfterSec).toBeGreaterThan(0);

		const [alert] = await service.sendToDevices([phone.device], {
			type: "permission_wait",
			sessionId: "sess-e2e-5",
		});
		expect(alert?.status).toBe("sent");
		expect(apnsRequests(tokenHex).some((e) => e.pushType === "alert")).toBe(true);
	}, 30_000);

	test("a send token the relay does not know is a 401, reported as unauthorized with the owner told", async () => {
		const phone = await pairPhone("c5".repeat(32));
		phone.device.sendTokenCiphertext = encryptSecret(`${phone.sendToken.slice(0, -4)}XXXX`);
		const [outcome] = await service.sendToDevices([phone.device], {
			type: "permission_wait",
			sessionId: "sess-e2e-6",
		});
		expect(outcome).toEqual({ deviceId: phone.device.id, status: "unauthorized" });
		expect(revocations).toContain(`tokenRejected:${phone.device.id}`);
	}, 30_000);

	test("nothing the services logged contains a token, a key or a payload", () => {
		const text = logLines.join("\n");
		expect(text.length).toBeGreaterThan(0);
		for (const secret of ["Bearer", "stored", "sess-e2e", "npm test", "billing"])
			expect(text.includes(secret)).toBe(false);
	});
});
