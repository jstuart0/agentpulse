/**
 * AGEN-123: the panel that shows what a call ran. Everything it shows comes from text nodes, each state has
 * its words, and the roles around it are right.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ForkToolCallDto } from "../../../shared/fork-tool-calls.js";
import { CallDetails, TurnDetails } from "./ForkRowDetails.js";
import { type DetailLoad, ForkToolCallPanel } from "./ForkToolCallDetail.js";

const call = (over: Partial<ForkToolCallDto> = {}): ForkToolCallDto => ({
	toolUseId: "toolu_1",
	tool: "Bash",
	outcome: "unasked",
	fromSubagent: false,
	input: '{"command":"ls"}',
	inputTruncated: false,
	output: "a.txt",
	outputTruncated: false,
	redacted: false,
	createdAt: "2026-11-08T10:00:00.000Z",
	...over,
});

const panel = (
	load: DetailLoad,
	access: "allowed" | "admin_on_others" | "denied" = "allowed",
	ownerName: string | null = null,
) =>
	renderToStaticMarkup(
		<ForkToolCallPanel
			id="p"
			load={load}
			access={access}
			ownerName={ownerName}
			onRetry={() => {}}
		/>,
	);

describe("the panel", () => {
	test("input and output are headed, in pre blocks that wrap and scroll, with Copy and the retention footer", () => {
		const html = panel({ state: "loaded", call: call() });
		expect(html).toContain("Input");
		expect(html).toContain("Output");
		const pre = /<pre class="([^"]*)"/.exec(html)?.[1] ?? "";
		for (const cls of [
			"whitespace-pre-wrap",
			"[overflow-wrap:anywhere]",
			"max-h-80",
			"overflow-auto",
		]) {
			expect(pre, cls).toContain(cls);
		}
		expect(html.match(/>Copy</g)).toHaveLength(2);
		expect(html).toContain("Kept for 7 days.");
		expect(html).not.toContain("secret");
	});

	test("<script>, Markdown and a link in the output render as text, never as markup", () => {
		const evil =
			"<script>alert(1)</script> **bold** [click](https://evil.example) <img src=x onerror=alert(1)>";
		const html = panel({ state: "loaded", call: call({ output: evil, input: evil }) });
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<a ");
		expect(html).not.toContain("<strong>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("**bold**");
		expect(html).toContain("[click](https://evil.example)");
	});

	test("what was hidden and what was cut are said", () => {
		const html = panel({ state: "loaded", call: call({ redacted: true, outputTruncated: true }) });
		expect(html).toContain("Some text that looked like a secret was hidden.");
		expect(html).toContain("Only the first 16 KB is shown.");
		const clean = panel({ state: "loaded", call: call() });
		expect(clean).not.toContain("looked like a secret");
		expect(clean).not.toContain("first 16 KB");
	});

	test("each failure has its own words: skeleton, not captured, arriving, forbidden, load failed with a retry", () => {
		expect(panel({ state: "loading" })).toContain('aria-busy="true"');
		expect(panel({ state: "not_captured" })).toContain(
			"Details weren&#x27;t captured for this call.",
		);
		expect(panel({ state: "arriving" })).toContain("Details are still arriving.");
		expect(panel({ state: "forbidden" })).toContain(
			"Only the owner or an admin can see what this ran.",
		);
		const failed = panel({ state: "failed" });
		expect(failed).toContain("Couldn&#x27;t load the details.");
		expect(failed).toContain("Try again");
		expect(failed).toContain('role="alert"');
	});

	test("an admin on someone else's session is told whose; the owner is told nothing extra", () => {
		expect(panel({ state: "loaded", call: call() }, "admin_on_others", "Ana")).toContain(
			"This is Ana&#x27;s session. Only they and admins can see this.",
		);
		expect(panel({ state: "loaded", call: call() }, "admin_on_others", null)).toContain(
			"This session has no owner. Only admins can see this.",
		);
		expect(panel({ state: "loaded", call: call() }, "allowed", "Ana")).not.toContain(
			"Only they and admins",
		);
	});

	test("a call with only one of input or output shows just that one", () => {
		const html = panel({ state: "loaded", call: call({ output: null }) });
		expect(html).toContain("Input");
		expect(html).not.toContain(">Output<");
	});
});

describe("the controls", () => {
	const context = { sessionId: "s1", access: "allowed" as const, ownerName: null };

	test("Details is a button with aria-expanded and aria-controls, named for the tool, at least 44 px on touch", () => {
		const html = renderToStaticMarkup(
			<CallDetails context={context} record={call()} turnEndedAt={null} />,
		);
		expect(html).toMatch(/<button[^>]*type="button"/);
		expect(html).toContain('aria-expanded="false"');
		expect(html).toMatch(/aria-controls="[^"]+"/);
		expect(html).toContain('aria-label="Show what Bash ran"');
		expect(html).toContain("min-h-11");
		expect(html).toContain(">Details<");
		// The controlled region exists even when closed, so aria-controls points at something.
		const controls = /aria-controls="([^"]+)"/.exec(html)?.[1] ?? "";
		expect(html).toContain(`id="${controls}"`);
	});

	test("an MCP tool is named 'MCP tool', never by its server or tool name", () => {
		const html = renderToStaticMarkup(
			<CallDetails context={context} record={call({ tool: "mcp" })} turnEndedAt={null} />,
		);
		expect(html).toContain('aria-label="Show what MCP tool ran"');
	});

	test("an Agent call is named 'Agent'", () => {
		const html = renderToStaticMarkup(
			<CallDetails context={context} record={call({ tool: "Agent" })} turnEndedAt={null} />,
		);
		expect(html).toContain('aria-label="Show what Agent ran"');
	});

	test("'Show what ran' appears for a turn with unasked calls and not for one with none", () => {
		const some = renderToStaticMarkup(
			<TurnDetails context={context} records={[call()]} turnEndedAt={null} />,
		);
		expect(some).toContain(">Show what ran<");
		expect(some).toContain('aria-expanded="false"');
		const none = renderToStaticMarkup(
			<TurnDetails context={context} records={[]} turnEndedAt={null} />,
		);
		expect(none).toBe("");
	});
});
