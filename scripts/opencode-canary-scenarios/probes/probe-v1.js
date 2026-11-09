// OpenCode 1.x measurement probe (AGEN-141, phase 0). Logs what a plugin sees; never part of the product.
// Settings come from ../probe-config.json (a canary writes it next to the plugins directory), so a probe loaded
// by a long-running process needs no environment.
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

export const Probe = async (ctx) => {
	globalThis[KEY] = (globalThis[KEY] || 0) + 1;
	const instance = Math.random().toString(36).slice(2, 8);
	w("load", {
		instance,
		counter: globalThis[KEY],
		ctxKeys: Object.keys(ctx),
		directory: ctx.directory,
		worktree: ctx.worktree,
		serverUrl: String(ctx.serverUrl),
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
	return {
		event: async ({ event }) => {
			try {
				w("event", { instance, directory: ctx.directory, event });
				if (event?.type === "session.idle")
					post("turn-end", { sessionID: event.properties?.sessionID });
			} catch {}
		},
		"chat.message": async (i, o) => {
			try {
				w("chat.message", { instance, skip: skip(), i, o });
			} catch {}
		},
		"permission.ask": async (i, o) => {
			try {
				w("permission.ask", { instance, i, o });
			} catch {}
		},
		"tool.execute.before": async (i, o) => {
			try {
				w("tool.execute.before", { instance, directory: ctx.directory, skip: skip(), i, o });
			} catch {}
		},
		"tool.execute.after": async (i, o) => {
			try {
				w("tool.execute.after", { instance, directory: ctx.directory, skip: skip(), i, o });
			} catch {}
		},
		"shell.env": async (i) => {
			try {
				w("shell.env", { instance, i });
			} catch {}
		},
	};
};
