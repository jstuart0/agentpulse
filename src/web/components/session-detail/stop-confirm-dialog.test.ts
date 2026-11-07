/**
 * The Stop dialog's words and weight, read from the element the component returns: `StopConfirmDialog` is
 * a plain function of its props, so calling it directly gives the `ConfirmDialog` element and its props
 * (title, body, confirm label, destructive) without a DOM.
 */
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { STOP_FALLBACK_FOCUS_ID, StopConfirmDialog } from "./StopConfirmDialog.js";

function dialogFor(agentType: string, isWorking?: boolean) {
	const element = StopConfirmDialog({
		session: { agentType, isWorking } as never,
		busy: false,
		error: "A refusal",
		onConfirm: () => {},
		onCancel: () => {},
	}) as ReactElement<Record<string, unknown>>;
	const body = (element.props.children as ReactElement<{ children: string }>).props.children;
	return { element, props: element.props, body };
}

describe("StopConfirmDialog, called directly", () => {
	test("a launched Claude: title, body, confirm label, destructive", () => {
		const { element, props, body } = dialogFor("claude_code");
		expect(element.type).toBe(ConfirmDialog);
		expect(props.title).toBe("Stop this turn?");
		expect(props.confirmLabel).toBe("Stop turn");
		expect(props.destructive).toBe(true);
		expect(body).toBe(
			"Claude stops now. Anything it left running in the background may keep running. Files already changed stay changed. You can send another prompt to carry on.",
		);
	});

	test("an idle launched Claude: the idle words and the plain label, still destructive", () => {
		const { props, body } = dialogFor("claude_code", false);
		expect(props.title).toBe("Stop Claude?");
		expect(props.confirmLabel).toBe("Stop");
		expect(props.destructive).toBe(true);
		expect(String(body)).not.toContain("this turn");
	});

	test("Codex: its own title, label and body, and also destructive", () => {
		const { props, body } = dialogFor("codex_cli");
		expect(props.title).toBe("Stop this session?");
		expect(props.confirmLabel).toBe("Stop session");
		expect(props.destructive).toBe(true);
		expect(body).toBe(
			"Codex stops now and this session can't take more prompts. To keep working, start a new session. Anything it left running in the background may keep running. Files already changed stay changed.",
		);
	});

	test("it passes the hook's busy, error and handlers through, and names a focus target that exists at every width", () => {
		const { props } = dialogFor("claude_code");
		expect(props.busy).toBe(false);
		expect(props.error).toBe("A refusal");
		expect(props.busyLabel).toBe("Stopping…");
		expect(typeof props.onConfirm).toBe("function");
		expect(typeof props.onCancel).toBe("function");
		expect(props.fallbackFocusId).toBe(STOP_FALLBACK_FOCUS_ID);
	});

	test("the focus target is the header's id, which the header renders unconditionally", async () => {
		const { readFileSync } = await import("node:fs");
		const header = readFileSync(new URL("./SessionHeader.tsx", import.meta.url), "utf8");
		expect(header).toContain(`id="${STOP_FALLBACK_FOCUS_ID}"`);
	});
});
