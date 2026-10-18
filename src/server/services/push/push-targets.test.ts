/**
 * Guards on how push is reached. Targeting is one policy (push-targets.ts), every
 * trigger goes through `dispatchEvent`, and the send path decrypts tokens without
 * blocking the event loop. These scan the source so a new caller can't skip them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { InMemoryDeviceSource, SoloPushTargets } from "./push-targets.js";
import type { PushDevice } from "./types.js";

const SERVER = join(import.meta.dir, "../..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
		return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

/** Repo-relative path -> number of lines matching `pattern`, for non-test source only. */
function occurrences(pattern: RegExp): Map<string, number> {
	const found = new Map<string, number>();
	for (const file of sourceFiles(SERVER)) {
		const hits = readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => pattern.test(l)).length;
		if (hits > 0) found.set(relative(SERVER, file), hits);
	}
	return found;
}

describe("trigger sites", () => {
	test("dispatchEvent( is defined once, in push/dispatch.ts; the triggers that call it land with the S4 trigger work", () => {
		const sites = occurrences(/\bdispatchEvent\(/);
		// The one definition. Pattern #5 expects 10 call sites once every trigger has landed; none exist yet,
		// and each addition must be listed here deliberately.
		expect([...sites.keys()]).toEqual(["services/push/dispatch.ts"]);
	});

	test("push is started from index.ts and nowhere else", () => {
		expect([...occurrences(/\bstartPush\(/).keys()].sort()).toEqual([
			"index.ts",
			"services/push/push-runtime.ts",
		]);
	});

	test("only dispatch and the single-device test route call sendToDevices", () => {
		expect([...occurrences(/\.sendToDevices\(/).keys()].sort()).toEqual([
			"routes/devices.ts",
			"services/push/dispatch.ts",
		]);
	});
});

describe("the send path never decrypts synchronously", () => {
	test("nothing under services/push calls the synchronous decryptSecret or readSendToken", () => {
		const pushFiles = sourceFiles(join(SERVER, "services/push"));
		const offenders = pushFiles.filter((file) =>
			/\bdecryptSecret\(|\bdecryptSecret\b[^A]|\breadSendToken\(\s*\w+\.sendToken\b/.test(
				readFileSync(file, "utf8").replace(/decryptSecretAsync/g, ""),
			),
		);
		expect(offenders.map((f) => relative(SERVER, f))).toEqual([]);
	});

	test("the synchronous readSendToken is used by no production code", () => {
		const users = [...occurrences(/\breadSendToken\(/).keys()].filter(
			(f) => f !== "services/mobile-devices-service.ts" && !f.startsWith("services/push/"),
		);
		expect(users).toEqual([]);
	});
});

describe("SoloPushTargets", () => {
	const device = (id: string, token: string): PushDevice => ({
		id,
		userId: "u",
		platform: "ios",
		relayDeviceId: `relay-${id}`,
		sendTokenCiphertext: token,
		kid: "kid",
		publicKey: "AAAA",
		clientServerRef: "ref",
		prefs: {},
	});

	test("every device with a token in solo mode; none in team mode; revoked (empty token) devices never", async () => {
		const source = new InMemoryDeviceSource([
			device("a", "t1"),
			device("b", ""),
			device("c", "t3"),
		]);
		expect(
			(
				await new SoloPushTargets(source, async () => "solo").resolve({
					type: "stuck",
					sessionId: "s",
				})
			).map((d) => d.id),
		).toEqual(["a", "c"]);
		expect(
			await new SoloPushTargets(source, async () => "team").resolve({
				type: "stuck",
				sessionId: "s",
			}),
		).toEqual([]);
	});
});
