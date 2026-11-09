// OpenCode 2.x measurement probe (AGEN-141, phase 0). A single file with a plain default-export object (the form
// 2.2.6 loads without importing the SDK). Logs what a plugin sees; never part of the product.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAG_SRC = "@@PROBE_TAG@@";
const here = path.dirname(fileURLToPath(import.meta.url));
let cfg = {};
try {
	cfg = JSON.parse(fs.readFileSync(path.join(here, "..", "probe-config.json"), "utf8"));
} catch {}
const LOG = cfg.log;
const POST = cfg.post;
const KEY = Symbol.for("agentpulse.probe.counter");
const CUT = 6000;

function replacer() {
	const seen = new WeakSet();
	return (_key, value) => {
		if (typeof value === "function") return "[fn]";
		if (typeof value === "bigint") return String(value);
		if (typeof value === "string" && value.length > CUT)
			return `${value.slice(0, CUT)}...[cut ${value.length}]`;
		if (value && typeof value === "object") {
			if (seen.has(value)) return "[circular]";
			seen.add(value);
		}
		return value;
	};
}
function w(kind, data) {
	if (!LOG) return;
	try {
		fs.appendFileSync(
			LOG,
			`${JSON.stringify({ t: Date.now(), pid: process.pid, tag: TAG_SRC, kind, data }, replacer())}\n`,
		);
	} catch {}
}
function post(kind, data) {
	if (!POST) return;
	const t0 = performance.now();
	void fetch(POST, {
		method: "POST",
		body: JSON.stringify({ kind, data, tag: TAG_SRC }),
		headers: { "content-type": "application/json" },
		signal: AbortSignal.timeout(2000),
	})
		.then((r) => w("post.done", { kind, status: r.status, ms: performance.now() - t0 }))
		.catch((e) => w("post.err", { kind, ms: performance.now() - t0, e: String(e) }));
}

export default {
	id: "ap-probe",
	async setup(ctx) {
		globalThis[KEY] = (globalThis[KEY] || 0) + 1;
		const instance = Math.random().toString(36).slice(2, 8);
		const directory = ctx.location?.directory;
		w("load", {
			instance,
			counter: globalThis[KEY],
			ctxKeys: Object.keys(ctx),
			location: ctx.location,
			app: ctx.app,
			skip: process.env.AGENTPULSE_SKIP ?? null,
			argv: process.argv,
			cwd: process.cwd(),
		});
		if (!globalThis[Symbol.for("agentpulse.probe.exit")]) {
			globalThis[Symbol.for("agentpulse.probe.exit")] = true;
			process.on("beforeExit", () => w("process.beforeExit", {}));
			process.on("exit", () => w("process.exit", {}));
		}
		const skip = () => process.env.AGENTPULSE_SKIP ?? null;
		const ac = new AbortController();
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: ac.signal })) {
					try {
						w("event", { instance, directory, event });
						if (
							event?.type === "session.execution.succeeded" ||
							event?.type === "session.execution.failed"
						) {
							post("turn-end", { sessionID: event.data?.sessionID, id: event.id });
						}
					} catch {}
				}
			} catch (e) {
				w("event.loop.end", { instance, e: String(e) });
			}
		})();
		await ctx.tool.hook("execute.before", async (event) => {
			try {
				w("tool.before", { instance, directory, skip: skip(), event });
			} catch {}
		});
		await ctx.tool.hook("execute.after", async (event) => {
			try {
				w("tool.after", { instance, directory, skip: skip(), event });
			} catch {}
		});
		return () => {
			w("cleanup", { instance });
			ac.abort();
		};
	},
};
