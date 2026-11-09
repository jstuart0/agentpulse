/** AGEN-141 plan step 17 for OpenCode 1.x: the shared cases, then what only 1.x does. */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBashExcludeScript } from "../src/shared/hook-command.ts";
import { SID, defineCommonPluginTests, names, rig } from "./lib/opencode-plugin-common-tests.ts";
import {
	loadPluginModule,
	makeDriver,
	readCapture,
	replayCapture,
	resetRecord,
	scratchDir,
	settle,
	startCollector,
	v1Ctx,
} from "./lib/opencode-plugin-kit.ts";

defineCommonPluginTests("v1");

const ev = (type: string, properties: Record<string, unknown>, id: string) => ({
	id,
	type,
	properties,
});
const partTool = (sid: string, callID: string, tool: string, state: Record<string, unknown>) =>
	ev(
		"message.part.updated",
		{ sessionID: sid, part: { type: "tool", tool, callID, id: `prt_${callID}`, state } },
		`evt_p${Math.random().toString(36).slice(2, 12)}`,
	);

describe("v1 plugin: only 1.x", () => {
	test("M2 a session of unknown directory seen by a second instance is dropped when rules exist", async () => {
		const first = await rig("v1");
		mkdirSync(join(first.home, ".agentpulse"), { mode: 0o700, recursive: true });
		chmodSync(join(first.home, ".agentpulse"), 0o700);
		writeFileSync(join(first.home, ".agentpulse", "exclude"), `${first.dir}\n`, { mode: 0o600 });
		writeFileSync(join(first.home, ".agentpulse", "exclude-check.sh"), buildBashExcludeScript(), {
			mode: 0o500,
		});
		// Same process, second project: it shares the record, so there are two instances.
		const other = scratchDir("project-b");
		const plugin = await loadPluginModule("v1", first.url, first.seam);
		const second = await makeDriver("v1", plugin, other);
		second.prompt("ses_unknown000000000000001", "secret from the excluded project");
		await second.flush();
		await settle("v1");
		expect(
			first.received.filter((x) => x.body.session_id === "ses_unknown000000000000001"),
		).toEqual([]);
		second.cleanup();
	});

	test("abort: session.error MessageAbortedError is sent, and the session.idle that follows (twice) is not", async () => {
		const r = await rig("v1");
		r.drv.created(SID, r.dir);
		r.drv.prompt(SID, "go");
		r.drv.before(SID, "call_1", "bash", { c: 1 });
		r.drv.event(
			ev(
				"session.error",
				{ sessionID: SID, error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
				"evt_a1",
			),
		);
		r.drv.event(ev("session.idle", { sessionID: SID }, "evt_a2"));
		r.drv.after(
			SID,
			"call_1",
			"bash",
			{ c: 1 },
			"(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
		);
		r.drv.event(ev("session.idle", { sessionID: SID }, "evt_a3"));
		await settle("v1");
		const seq = names(r);
		expect(seq).toContain("session.error");
		expect(seq).not.toContain("session.idle");
		// the call still gets exactly one terminal row, before the end of the turn
		expect(seq.filter((n) => n === "tool.execute.after").length).toBe(1);
	});

	test("abort captures replayed through the plugin send no Stop; the next prompt re-arms Stop", async () => {
		resetRecord("v1");
		const c = startCollector();
		const plugin = await loadPluginModule("v1", c.url, {
			env: { HOME: scratchDir("h"), PATH: "/usr/bin:/bin" },
		});
		const cap = readCapture("v1", "abort");
		await replayCapture("v1", cap, plugin, "/scratch/proj/v1-abort");
		await settle("v1");
		expect(c.received.map((x) => x.body.hook_event_name)).not.toContain("session.idle");
		expect(c.received.map((x) => x.body.hook_event_name)).toContain("session.error");
		const hooks = await plugin.AgentPulse(v1Ctx("/scratch/proj/v1-abort"));
		hooks["chat.message"](
			{ sessionID: "ses_e4099e69dffer6O0RUE8r04ehr" },
			{ message: {}, parts: [{ type: "text", text: "again" }] },
		);
		hooks.event({
			event: ev(
				"session.idle",
				{ sessionID: "ses_e4099e69dffer6O0RUE8r04ehr" },
				"evt_after_prompt",
			),
		});
		await settle("v1");
		expect(c.received.map((x) => x.body.hook_event_name)).toContain("session.idle");
		c.stop();
	});

	test("a tool that throws sends one failure row from the part, with name Error, input and no output", async () => {
		const r = await rig("v1");
		r.drv.created(SID, r.dir);
		r.drv.before(SID, "call_1", "read", { filePath: "/x" });
		r.drv.event(
			partTool(SID, "call_1", "read", {
				status: "error",
				input: { filePath: "/x" },
				error: "File not found: /x SECRET",
			}),
		);
		await settle("v1");
		const after = r.received.filter((x) => x.body.hook_event_name === "tool.execute.after");
		expect(after.length).toBe(1);
		expect(after[0]?.body.data).toEqual({
			tool: "read",
			tool_use_id: "call_1",
			input: { filePath: "/x" },
			status: "error",
			error: { name: "Error" },
		});
		expect(JSON.stringify(after[0]?.body)).not.toContain("SECRET");
	});

	test("17p after is held for the part's status, and a Stop never overtakes it", async () => {
		const r = await rig("v1");
		r.drv.created(SID, r.dir);
		r.drv.before(SID, "call_1", "bash", { c: 1 });
		r.drv.hooks["tool.execute.after"](
			{ tool: "bash", sessionID: SID, callID: "call_1", args: { c: 1 } },
			{ metadata: { exit: 0 }, output: "ok" },
		);
		r.drv.event(ev("session.idle", { sessionID: SID }, "evt_idle1"));
		await settle("v1");
		expect(names(r)).toEqual([
			"session.created",
			"tool.execute.before",
			"tool.execute.after",
			"session.idle",
		]);
	});

	test("an after that fired is held, and a part that then ends in error makes it the one failure row", async () => {
		const r = await rig("v1");
		r.drv.created(SID, r.dir);
		r.drv.before(SID, "call_1", "bash", { c: 1 });
		r.drv.hooks["tool.execute.after"](
			{ tool: "bash", sessionID: SID, callID: "call_1", args: { c: 1 } },
			{ metadata: { exit: 0 }, output: "ok" },
		);
		r.drv.event(
			partTool(SID, "call_1", "bash", { status: "error", input: { c: 1 }, error: "boom SECRET" }),
		);
		await settle("v1");
		const after = r.received.filter((x) => x.body.hook_event_name === "tool.execute.after");
		expect(after.length).toBe(1);
		expect(after[0]?.body.data).toMatchObject({ status: "error", error: { name: "Error" } });
		expect(after[0]?.body.data.output).toBeUndefined();
		expect(JSON.stringify(after[0]?.body)).not.toContain("SECRET");
	});

	test("a held after whose part never arrives is sent after 2 s as completed", async () => {
		const r = await rig("v1");
		r.drv.created(SID, r.dir);
		r.drv.before(SID, "call_1", "bash", { c: 1 });
		r.drv.hooks["tool.execute.after"](
			{ tool: "bash", sessionID: SID, callID: "call_1", args: { c: 1 } },
			{ metadata: { exit: 3 }, output: "boom" },
		);
		await new Promise((res) => setTimeout(res, 2300));
		await settle("v1");
		const after = r.received.find((x) => x.body.hook_event_name === "tool.execute.after")?.body;
		expect(after.data).toMatchObject({ status: "completed", exit_code: 3 });
	});

	test("permission: asked takes the call's number, replied links by request id, a reject carries the same tool_use_id", async () => {
		const r = await rig("v1");
		r.drv.created(SID, r.dir);
		r.drv.event(
			ev(
				"permission.asked",
				{
					id: "per_1",
					sessionID: SID,
					permission: "edit",
					patterns: ["a.txt"],
					tool: { messageID: "m", callID: "call_9" },
				},
				"evt_pa",
			),
		);
		r.drv.before(SID, "call_9", "write", { f: 1 });
		r.drv.event(
			ev("permission.replied", { sessionID: SID, requestID: "per_1", reply: "reject" }, "evt_pr"),
		);
		r.drv.event(
			ev(
				"permission.asked",
				{ id: "per_2", sessionID: SID, permission: "bash", patterns: [] },
				"evt_pa2",
			),
		);
		r.drv.event(
			ev("permission.replied", { sessionID: SID, requestID: "per_2", reply: "once" }, "evt_pr2"),
		);
		await settle("v1");
		const ids = r.received.map((x) => x.body.data?.tool_use_id).filter(Boolean);
		expect(ids).toEqual(["call_9", "call_9", "call_9", "perm:per_2", "perm:per_2"]);
		expect(r.received.find((x) => x.body.data?.reply === "reject")?.body.data.tool_use_id).toBe(
			"call_9",
		);
	});

	test("the prompt joins the user's text parts and leaves out synthetic and ignored ones", async () => {
		const r = await rig("v1");
		r.drv.hooks["chat.message"](
			{ sessionID: SID },
			{
				message: { model: { providerID: "p", modelID: "m" } },
				parts: [
					{ type: "text", text: "one" },
					{ type: "text", text: "injected", synthetic: true },
					{ type: "text", text: "ignored", ignored: true },
					{ type: "file" },
					{ type: "text", text: "two" },
				],
			},
		);
		await settle("v1");
		expect(r.received[0]?.body.data.text).toBe("one\ntwo");
		expect(r.received[0]?.body.model).toBe("p/m");
	});

	test("the last assistant message is the assistant's own text, and is cleared on each Stop", async () => {
		const r = await rig("v1");
		r.drv.created(SID, r.dir);
		r.drv.idle(SID, "first answer");
		r.drv.idle(SID);
		await settle("v1");
		const stops = r.received.filter((x) => x.body.hook_event_name === "session.idle");
		expect(stops[0]?.body.last_assistant_message).toBe("first answer");
		expect(stops[1]?.body.last_assistant_message).toBeUndefined();
	});
});
