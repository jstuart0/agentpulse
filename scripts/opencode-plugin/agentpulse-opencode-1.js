// ---- OpenCode 1.x ---------------------------------------------------------------

const V1_EXIT_WAIT_MS = 2000;

export const AgentPulse = async (ctx) => {
	let rec;
	try {
		rec = getRecord();
		rec.instances += 1;
	} catch {
		return {};
	}
	const ctxDir = plainText(ctx && ctx.directory, 4096);
	let lastVersion;

	function emit(sid, name, data, opts) {
		const root = rootOf(rec, sid);
		const info = sessionInfo(rec, sid) || {};
		const own = info.dir || ctxDir;
		const env = envelopeBase(
			1,
			info.version || lastVersion,
			sid,
			root !== sid ? root : undefined,
			own,
		);
		env.hook_event_name = name;
		env.data = data;
		if (opts && opts.model) env.model = opts.model;
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

	function finishCall(sid, callID, entry, status) {
		const pending = entry.pending;
		if (!pending || entry.closed) return;
		clearTimeout(entry.timer);
		entry.pending = undefined;
		entry.closed = true;
		if (status === "error") {
			pending.status = "error";
			pending.error = wireError("Error");
			pending.output = undefined;
			pending.exit_code = undefined;
		}
		emit(sid, "tool.execute.after", pending, { key: pending.tool_use_id + "|after" });
	}

	function flushPending(sid) {
		const st = stateOf(rec, rootOf(rec, sid));
		for (const [callID, entry] of st.calls) {
			if (entry.pending && entry.sid === sid) finishCall(sid, callID, entry, entry.partStatus);
		}
	}

	function onToolPart(sid, part) {
		const callID = callIdOf(part.callID);
		const status = part.state && part.state.status;
		if (!callID || (status !== "completed" && status !== "error")) return;
		const st = stateOf(rec, rootOf(rec, sid));
		const entry = callEntry(st, callID, false);
		if (entry.closed) return;
		if (entry.pending) {
			finishCall(sid, callID, entry, status);
			return;
		}
		if (status === "completed") {
			entry.partStatus = "completed";
			return;
		}
		// A tool that threw never fires tool.execute.after: the part is the only signal.
		entry.closed = true;
		const tool = plainText(part.tool, 128);
		if (!tool) return;
		emit(
			sid,
			"tool.execute.after",
			{
				tool: tool,
				tool_use_id: toolUseId(callID, entry),
				input: capInput(part.state.input),
				status: "error",
				error: wireError("Error"),
			},
			{ key: toolUseId(callID, entry) + "|after" },
		);
	}

	function onEvent(ev) {
		const p = (ev && ev.properties) || {};
		const evt = typeof ev.id === "string" ? ev.id : undefined;
		switch (ev.type) {
			case "session.created": {
				const info = p.info || {};
				const sid = apIdOf(info.id || p.sessionID);
				if (!sid) return;
				const version = plainText(info.version, 64);
				if (version) lastVersion = version;
				rememberSession(rec, sid, apIdOf(info.parentID), plainText(info.directory, 4096), version);
				emit(sid, "session.created", {}, { evt: evt });
				return;
			}
			case "message.updated": {
				const info = p.info || {};
				const sid = apIdOf(info.sessionID || p.sessionID);
				if (!sid || typeof info.id !== "string" || typeof info.role !== "string") return;
				rememberRole(stateOf(rec, rootOf(rec, sid)), info.id, info.role);
				return;
			}
			case "message.part.updated": {
				const part = p.part;
				const sid = apIdOf(p.sessionID || (part && part.sessionID));
				if (!sid || !part || typeof part !== "object") return;
				const st = stateOf(rec, rootOf(rec, sid));
				if (
					part.type === "text" &&
					typeof part.text === "string" &&
					!part.synthetic &&
					!part.ignored
				) {
					if (
						st.lastVerdict !== false &&
						typeof part.messageID === "string" &&
						typeof part.id === "string"
					) {
						rememberText(st, part.id, part.messageID, sid, capString(part.text));
					}
				} else if (part.type === "tool") {
					onToolPart(sid, part);
				}
				return;
			}
			case "permission.asked": {
				const sid = apIdOf(p.sessionID);
				const per = plainText(p.id, 200);
				if (!sid || !per) return;
				const st = stateOf(rec, rootOf(rec, sid));
				const callID = callIdOf(p.tool && p.tool.callID);
				const tuid = callID ? toolUseId(callID, callEntry(st, callID, true)) : "perm:" + per;
				lruTouch(st.perms, per, tuid, MAP_LIMIT);
				const patterns = Array.isArray(p.patterns)
					? p.patterns.filter((x) => typeof x === "string" && x.length <= 1024).slice(0, 32)
					: undefined;
				const data = {
					request_id: per,
					tool_use_id: tuid,
					permission: plainText(p.permission, 128) || "unknown",
				};
				if (patterns) data.patterns = patterns;
				emit(sid, "permission.asked", data, { evt: evt });
				return;
			}
			case "permission.replied": {
				const sid = apIdOf(p.sessionID);
				const per = plainText(p.requestID, 200);
				if (!sid || !per) return;
				const st = stateOf(rec, rootOf(rec, sid));
				const tuid = st.perms.get(per) || "perm:" + per;
				const reply =
					typeof p.reply === "string" && /^[a-z_-]{1,32}$/.test(p.reply) ? p.reply : "unknown";
				emit(
					sid,
					"permission.replied",
					{ request_id: per, tool_use_id: tuid, reply: reply },
					{ evt: evt },
				);
				return;
			}
			case "session.error": {
				const sid = apIdOf(p.sessionID);
				if (!sid) return;
				const error = p.error || {};
				emit(
					sid,
					"session.error",
					{ error: wireError(error.name, error.data && error.data.statusCode) },
					{ evt: evt },
				);
				// A user abort is followed by session.idle; that is not a finished turn.
				if (error.name === "MessageAbortedError" && !isChild(sid)) {
					stateOf(rec, rootOf(rec, sid)).skipIdle = true;
				}
				return;
			}
			case "session.idle": {
				const sid = apIdOf(p.sessionID);
				if (!sid) return;
				const st = stateOf(rec, rootOf(rec, sid));
				flushPending(sid);
				const last = isChild(sid) ? undefined : lastAssistantText(st, sid);
				for (const [id, entry] of st.texts) if (entry.sid === sid) st.texts.delete(id);
				// 1.x sends session.idle (twice, measured) after an abort. The abort is already an
				// Interrupt; a Stop would make the session read WAITING. The next prompt ends this.
				if (!isChild(sid) && st.skipIdle) return;
				emit(sid, "session.idle", {}, { evt: evt, last: last });
				return;
			}
			default:
		}
	}

	return {
		event: (input) => {
			try {
				const ev = input && input.event;
				if (ev && typeof ev.type === "string") onEvent(ev);
			} catch {
				swallow(rec);
			}
		},
		"chat.message": (input, output) => {
			try {
				const sid = apIdOf(input && input.sessionID);
				if (!sid || isChild(sid)) return;
				const st = stateOf(rec, rootOf(rec, sid));
				st.skipIdle = false;
				const parts = output && Array.isArray(output.parts) ? output.parts : [];
				const text = parts
					.filter(
						(x) =>
							x && x.type === "text" && typeof x.text === "string" && !x.synthetic && !x.ignored,
					)
					.map((x) => x.text)
					.join("\n");
				if (text === "") return;
				const m = output.message && output.message.model;
				const model =
					m && typeof m.providerID === "string" && typeof m.modelID === "string"
						? plainText(m.providerID + "/" + m.modelID, 256)
						: undefined;
				emit(sid, "chat.message", { text: capString(text) }, { model: model });
			} catch {
				swallow(rec);
			}
		},
		"tool.execute.before": (input, output) => {
			try {
				const sid = apIdOf(input && input.sessionID);
				const callID = callIdOf(input && input.callID);
				const tool = plainText(input && input.tool, 128);
				if (!sid || !callID || !tool) return;
				const entry = callEntry(stateOf(rec, rootOf(rec, sid)), callID, true);
				const tuid = toolUseId(callID, entry);
				emit(
					sid,
					"tool.execute.before",
					{ tool: tool, tool_use_id: tuid, input: capInput(output && output.args) },
					{ key: tuid + "|before" },
				);
			} catch {
				swallow(rec);
			}
		},
		"tool.execute.after": (input, output) => {
			try {
				const sid = apIdOf(input && input.sessionID);
				const callID = callIdOf(input && input.callID);
				const tool = plainText(input && input.tool, 128);
				if (!sid || !callID || !tool) return;
				const st = stateOf(rec, rootOf(rec, sid));
				const entry = callEntry(st, callID, false);
				if (entry.closed) return;
				const data = {
					tool: tool,
					tool_use_id: toolUseId(callID, entry),
					input: capInput(input.args),
					status: "completed",
				};
				const exit = output && output.metadata && output.metadata.exit;
				if (typeof exit === "number" && Number.isInteger(exit)) data.exit_code = exit;
				if (output && typeof output.output === "string") data.output = capString(output.output);
				entry.sid = sid;
				entry.pending = data;
				if (entry.partStatus === "completed") {
					finishCall(sid, callID, entry, "completed");
					return;
				}
				entry.timer = setTimeout(() => {
					try {
						finishCall(sid, callID, entry, entry.partStatus);
					} catch {
						swallow(rec);
					}
				}, V1_EXIT_WAIT_MS);
				if (typeof entry.timer.unref === "function") entry.timer.unref();
			} catch {
				swallow(rec);
			}
		},
	};
};
