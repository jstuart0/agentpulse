/**
 * The phone's overflow menu offers Stop turn above End session while a continued session's turn runs
 * (AGEN-119). The menu opens on a click, so the item list is drawn here from `MenuItem`, the one component
 * every entry is made of, and the wiring is held by the source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MenuItem } from "./SessionOverflowMenu.js";
import { STOPPING_TURN_LABEL, STOP_TURN_LABEL } from "./stop-view.js";

const source = readFileSync(join(import.meta.dir, "SessionOverflowMenu.tsx"), "utf8");
const header = readFileSync(join(import.meta.dir, "SessionHeader.tsx"), "utf8");
const html = (props: Parameters<typeof MenuItem>[0]) =>
	renderToStaticMarkup(createElement(MenuItem, props));

describe("the Stop turn item", () => {
	test("is at least 44 px high, and is not the red End session style", () => {
		const out = html({ label: STOP_TURN_LABEL, tall: true, onClick: () => {} });
		expect(out).toContain("min-h-[44px]");
		expect(out).toContain(">Stop turn<");
		expect(out).not.toContain("text-red");
	});

	test("while a stop is on its way it reads 'Stopping turn…' and is off", () => {
		const out = html({ label: STOPPING_TURN_LABEL, tall: true, disabled: true, onClick: () => {} });
		expect(out).toContain("Stopping turn…");
		expect(out).toContain('disabled=""');
	});

	test("an ordinary entry keeps its compact height", () => {
		expect(html({ label: "Jump to top", onClick: () => {} })).not.toContain("min-h-[44px]");
	});
});

describe("where it sits and how it is fed", () => {
	test("above End session in the menu, shown only when the page says a turn runs and gives a handler", () => {
		const turnItem = source.indexOf("canStopTurn && onStopTurn");
		const endItem = source.indexOf("{canStop && (");
		expect(turnItem).toBeGreaterThan(-1);
		expect(turnItem).toBeLessThan(endItem);
		expect(source).toContain("label={stoppingTurn ? STOPPING_TURN_LABEL : STOP_TURN_LABEL}");
	});

	test("the End session item keeps its danger tone and the header hands the menu the page's control", () => {
		expect(source).toMatch(/label=\{stopLabel\}[\s\S]*tone="danger"/);
		expect(header).toMatch(/canStopTurn=\{stopTurn\?\.available === true\}/);
		expect(header).toMatch(/onStopTurn=\{stopTurn\?\.onStop\}/);
	});

	test("the header's End session button is alone: no Stop turn button is added to the desktop actions", () => {
		expect(header).not.toMatch(/data-stop-turn|STOP_TURN_LABEL/);
	});
});
