// ---- OpenCode 2.x ---------------------------------------------------------------

const V2_CLAIM_LIMIT = 4096;

// The event names this plugin forwards. scripts/check-hook-event-parity.ts holds this list to OpenCodeV2Event
// in src/shared/types.ts, and emit() sends nothing that isn't on it.
const AP_FORWARDED = [
	"session.created",
	"session.inbox.enqueued",
	"tool.before",
	"tool.after",
	"permission.asked",
	"permission.replied",
	"session.step.failed",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
];

export default {
	id: "agentpulse",
	async setup(ctx) {
		const noop = () => {};
		let rec;
		try {
			// The reduced ctx that OpenCode 1.x hands a 2.x-style file has none of these.
			if (
				!ctx ||
				!ctx.event ||
				typeof ctx.event.subscribe !== "function" ||
				!ctx.tool ||
				typeof ctx.tool.hook !== "function" ||
				!ctx.location
			) {
				return noop;
			}
			rec = getRecord();
		} catch {
			return noop;
		}
		const myDir = plainText(ctx.location.directory, 4096);
		if (!myDir) return noop;
		const appVersion = plainText(ctx.app && ctx.app.version, 64);
		rec.instances += 1;
		hookExit(rec);

		function emit(sid, name, data, opts) {
			if (AP_FORWARDED.indexOf(name) === -1) return;
			const root = rootOf(rec, sid);
			const info = sessionInfo(rec, sid) || {};
			// A claimed session lives in this instance's directory. One nobody claimed, seen by several instances, has no safe owner: judged as unknown, it is dropped when rules exist.
			const own =
				info.dir || (rec.claims.get(sid) === myDir || rec.instances <= 1 ? myDir : undefined);
			const env = envelopeBase(
				2,
				info.version || appVersion,
				sid,
				root !== sid ? root : undefined,
				own,
			);
			env.hook_event_name = name;
			env.data = data;
			if (opts && opts.last) env.last_assistant_message = opts.last;
			enqueue(rec, stateOf(rec, root), env, {
				dirs: judgedDirs(rec, sid, own),
				evt: opts && opts.evt,
				key: opts && opts.key,
			});
		}

		function isChild(sid) {
			const info = sessionInfo(rec, sid);
			return !!(info && info.parent);
		}

		/** "yes", "no", or "unknown" (no claim and no directory to claim by). */
		function mine(sid, evDir) {
			const claimant = rec.claims.get(sid);
			if (claimant !== undefined) return claimant === myDir ? "yes" : "no";
			const dir = evDir || (sessionInfo(rec, sid) || {}).dir;
			if (dir === undefined) return "unknown";
			if (dir !== myDir) return "no";
			lruTouch(rec.claims, sid, myDir, V2_CLAIM_LIMIT);
			return "yes";
		}

		function handle(ev, run) {
			const sid = apIdOf(ev.data && ev.data.sessionID);
			if (!sid) return;
			const evDir = plainText(ev.location && ev.location.directory, 4096);
			const verdict = mine(sid, evDir);
			if (verdict === "yes") {
				run(sid);
			} else if (verdict === "unknown") {
				if (rec.instances > 1) {
					run(sid);
					return;
				}
				// Nothing says whose session this is: wait briefly for a claim, then drop it.
				const timer = setTimeout(() => {
					try {
						if (mine(sid, evDir) === "yes") run(sid);
						else rec.counters.droppedClaim += 1;
					} catch {
						swallow(rec);
					}
				}, HOLD_MS);
				if (typeof timer.unref === "function") timer.unref();
			}
		}

		function errorOf(error) {
			const e = error || {};
			return wireError(e.type || e._tag || e.name, e.status);
		}

		function onEvent(ev) {
			const data = ev.data || {};
			const evt = typeof ev.id === "string" ? ev.id : undefined;
			switch (ev.type) {
				case "session.created": {
					const sid = apIdOf(data.sessionID);
					if (!sid) return;
					const dir = plainText(
						(data.location && data.location.directory) || (ev.location && ev.location.directory),
						4096,
					);
					rememberSession(rec, sid, apIdOf(data.parentID), dir, plainText(data.version, 64));
					handle(ev, () => {
						emit(sid, "session.created", {}, { evt: evt });
					});
					return;
				}
				case "session.inbox.enqueued":
					handle(ev, (sid) => {
						const item = data.item || {};
						const text = item.type === "user" && item.payload ? item.payload.text : undefined;
						if (isChild(sid) || typeof text !== "string" || text === "") return;
						emit(sid, "session.inbox.enqueued", { text: capString(text) }, { evt: evt });
					});
					return;
				case "session.text.ended":
					handle(ev, (sid) => {
						const st = stateOf(rec, rootOf(rec, sid));
						if (st.lastVerdict === false || typeof data.text !== "string") return;
						const msg = plainText(data.assistantMessageID, 200) || "msg";
						rememberRole(st, msg, "assistant");
						rememberText(st, msg + ":" + String(data.ordinal), msg, sid, capString(data.text));
					});
					return;
				case "session.step.failed":
				case "session.execution.failed":
					handle(ev, (sid) => {
						emit(sid, ev.type, { error: errorOf(data.error) }, { evt: evt });
					});
					return;
				case "session.execution.succeeded":
					handle(ev, (sid) => {
						const st = stateOf(rec, rootOf(rec, sid));
						const last = isChild(sid) ? undefined : lastAssistantText(st, sid);
						for (const [id, entry] of st.texts) if (entry.sid === sid) st.texts.delete(id);
						emit(sid, ev.type, {}, { evt: evt, last: last });
					});
					return;
				case "session.execution.interrupted":
					handle(ev, (sid) => {
						emit(sid, ev.type, {}, { evt: evt });
					});
					return;
				case "permission.asked":
					handle(ev, (sid) => {
						const per = plainText(data.id, 200);
						if (!per) return;
						const st = stateOf(rec, rootOf(rec, sid));
						const callID = callIdOf(data.source && data.source.id);
						const tuid = callID ? toolUseId(callID, callEntry(st, callID, true)) : "perm:" + per;
						lruTouch(st.perms, per, tuid, MAP_LIMIT);
						const out = {
							request_id: per,
							tool_use_id: tuid,
							permission: plainText(data.action, 128) || "unknown",
						};
						if (Array.isArray(data.resources)) {
							out.patterns = data.resources
								.filter((x) => typeof x === "string" && x.length <= 1024)
								.slice(0, 32);
						}
						emit(sid, ev.type, out, { evt: evt });
					});
					return;
				case "permission.replied":
					handle(ev, (sid) => {
						const per = plainText(data.requestID, 200);
						if (!per) return;
						const st = stateOf(rec, rootOf(rec, sid));
						const reply =
							typeof data.reply === "string" && /^[a-z_-]{1,32}$/.test(data.reply)
								? data.reply
								: "unknown";
						emit(
							sid,
							ev.type,
							{ request_id: per, tool_use_id: st.perms.get(per) || "perm:" + per, reply: reply },
							{ evt: evt },
						);
					});
					return;
				default:
			}
		}

		/** A tool hook runs on the instance of the session's own project (measured, G15). One that reaches another project's instance is skipped. */
		function ownTool(sid) {
			const claimant = rec.claims.get(sid);
			if (claimant !== undefined) return claimant === myDir;
			const known = (sessionInfo(rec, sid) || {}).dir;
			// Nobody claimed it and no directory is known: with rules in force, no instance may take it for its own.
			if (known === undefined) return !rulesOrMarkerPresentSync();
			return known === myDir;
		}

		function toolBefore(event) {
			const sid = apIdOf(event && event.sessionID);
			const callID = callIdOf(event && event.id);
			const tool = plainText(event && event.tool, 128);
			if (!sid || !callID || !tool) return;
			if (!ownTool(sid)) return;
			const entry = callEntry(stateOf(rec, rootOf(rec, sid)), callID, true);
			const tuid = toolUseId(callID, entry);
			emit(
				sid,
				"tool.before",
				{ tool: tool, tool_use_id: tuid, input: capInput(event.input) },
				{ key: tuid + "|before" },
			);
		}

		function toolAfter(event) {
			const sid = apIdOf(event && event.sessionID);
			const callID = callIdOf(event && event.id);
			const tool = plainText(event && event.tool, 128);
			if (!sid || !callID || !tool) return;
			if (!ownTool(sid)) return;
			const st = stateOf(rec, rootOf(rec, sid));
			const entry = callEntry(st, callID, false);
			entry.closed = true;
			const tuid = toolUseId(callID, entry);
			const data = {
				tool: tool,
				tool_use_id: tuid,
				input: capInput(event.input),
				status: "completed",
			};
			if (event.status === "error") {
				data.status = "error";
				data.error = errorOf(event.error);
			} else {
				const result = event.result || {};
				const meta = result.metadata || {};
				const out = result.output;
				const exit =
					typeof meta.exit === "number"
						? meta.exit
						: out && typeof out === "object"
							? out.exit
							: undefined;
				if (typeof exit === "number" && Number.isInteger(exit)) data.exit_code = exit;
				let text;
				if (out && typeof out === "object" && typeof out.output === "string") text = out.output;
				else if (typeof out === "string") text = out;
				else if (
					Array.isArray(result.content) &&
					result.content[0] &&
					typeof result.content[0].text === "string"
				)
					text = result.content[0].text;
				if (text !== undefined) data.output = capString(text);
			}
			emit(sid, "tool.after", data, { key: tuid + "|after" });
		}

		const ac = new AbortController();
		void (async () => {
			try {
				for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
					try {
						if (ev && typeof ev.type === "string") onEvent(ev);
					} catch {
						swallow(rec);
					}
				}
			} catch {
				swallow(rec);
			}
		})();
		try {
			await ctx.tool.hook("execute.before", (event) => {
				try {
					toolBefore(event);
				} catch {
					swallow(rec);
				}
			});
			await ctx.tool.hook("execute.after", (event) => {
				try {
					toolAfter(event);
				} catch {
					swallow(rec);
				}
			});
		} catch {
			swallow(rec);
		}
		return () => {
			try {
				ac.abort();
				rec.instances -= 1;
			} catch {
				swallow(rec);
			}
		};
	},
};
