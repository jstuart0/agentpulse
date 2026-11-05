/** Control history shows a host's error text cleaned, because rows stored before the server cleaned it aren't. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ControlAction } from "../../../shared/types.js";
import { ControlHistory } from "./ControlHistory.js";

const action = (error: string | null): ControlAction =>
	({ id: "a1", actionType: "prompt", status: "failed", error }) as ControlAction;

describe("ControlHistory", () => {
	test("bidi and control characters in an old error row are removed and white space collapsed", () => {
		const html = renderToStaticMarkup(
			createElement(ControlHistory, { actions: [action("bad‮evil\n\n  thing\u0007")] }),
		);
		expect(html).toContain("prompt: badevil thing");
		expect(html).not.toContain("‮");
		expect(html).not.toContain("\u0007");
	});

	test("an action with no error shows no colon (positive control)", () => {
		const html = renderToStaticMarkup(createElement(ControlHistory, { actions: [action(null)] }));
		expect(html).not.toContain("prompt:");
	});
});
