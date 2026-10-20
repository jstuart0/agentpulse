/**
 * Manual / nightly check, never CI (takes about 6 minutes).
 *
 * Bun's fetch cuts a request at 300 s of socket idle time unless `timeout:
 * false` is passed. This answers a local request at 330 s through `llmFetch`
 * and expects the 200 to arrive.
 *
 *   bun scripts/check-fetch-idle-cap.ts
 */
import { llmFetch, readTextCapped } from "../src/server/services/ai/http.js";

const ANSWER_AFTER_MS = 330_000;

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 255,
	async fetch() {
		await Bun.sleep(ANSWER_AFTER_MS);
		return new Response("ok");
	},
});

const started = Date.now();
try {
	const res = await llmFetch(
		`http://127.0.0.1:${server.port}/`,
		{},
		{ timeoutMs: 600_000, label: "idle-cap check" },
	);
	const body = await readTextCapped(res);
	const seconds = (Date.now() - started) / 1000;
	if (res.status !== 200 || body !== "ok" || seconds < ANSWER_AFTER_MS / 1000 - 1) {
		console.error(`unexpected result: status ${res.status} after ${seconds.toFixed(1)}s`);
		process.exitCode = 1;
	} else {
		console.log(`ok status ${res.status} after ${seconds.toFixed(1)}s`);
	}
} catch (err) {
	console.error(`failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${err}`);
	process.exitCode = 1;
} finally {
	server.stop(true);
}
