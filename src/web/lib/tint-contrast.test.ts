import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectColor } from "./utils.js";

/**
 * Muted text must stay readable on every surface it sits on, in both themes:
 * the page, cards, the muted wells that hold the tab labels and, above all,
 * every project tint a card can be washed with. The tint steps are enumerated
 * by asking projectColor() about many project names; the text colours are read
 * from globals.css so the numbers here are the ones the app ships.
 */
type Hsl = [number, number, number];

const CSS = readFileSync(join(import.meta.dir, "..", "globals.css"), "utf8");

function tokens(selector: ":root" | ".dark"): Record<string, Hsl> {
	const start = CSS.indexOf(`${selector} {`);
	const end = CSS.indexOf("}", start);
	const out: Record<string, Hsl> = {};
	for (const match of CSS.slice(start, end).matchAll(
		/--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g,
	)) {
		out[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
	}
	return out;
}

function toRgb([h, s, l]: Hsl): [number, number, number] {
	const sat = s / 100;
	const light = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = sat * Math.min(light, 1 - light);
	const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)];
}

function luminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Colourfulness of a wash: 0 is grey. */
function chroma([, s, l]: Hsl): number {
	return (1 - Math.abs((2 * l) / 100 - 1)) * (s / 100);
}

const LIGHT = tokens(":root");
const DARK = tokens(".dark");
const MIN_CONTRAST = 4.5;
const MIN_CHROMA = 0.06;

/** hsl(...) pairs out of "light-dark(hsl(H S% L%), hsl(H S% L%))". */
function washes(): { light: Hsl; dark: Hsl }[] {
	const out: { light: Hsl; dark: Hsl }[] = [];
	for (let i = 0; i < 4000; i += 1) {
		const color = projectColor(`/work/project-${i}-${(i * 7919) % 104729}`);
		if (!color) continue;
		const parts = [...color.bg.matchAll(/hsl\((\d+) (\d+)% (\d+)%\)/g)].map(
			(m) => [Number(m[1]), Number(m[2]), Number(m[3])] as Hsl,
		);
		out.push({ light: parts[0], dark: parts[1] });
	}
	return out;
}

describe("the tint enumeration sees every step (positive control)", () => {
	test("many distinct washes come out, in both themes", () => {
		const all = washes();
		expect(all.length).toBeGreaterThan(3000);
		expect(new Set(all.map((w) => `${w.dark[1]}/${w.dark[2]}`)).size).toBeGreaterThanOrEqual(3);
		expect(new Set(all.map((w) => `${w.light[1]}/${w.light[2]}`)).size).toBeGreaterThanOrEqual(3);
		expect(LIGHT["muted-foreground"]).toBeDefined();
		expect(DARK["muted-foreground"]).toBeDefined();
	});
});

describe("muted text on a project tint", () => {
	test("is at least 4.5:1 on every tint, light theme", () => {
		const fg = toRgb(LIGHT["muted-foreground"]);
		const worst = Math.min(...washes().map((w) => contrast(fg, toRgb(w.light))));
		expect(worst).toBeGreaterThanOrEqual(MIN_CONTRAST);
	});

	test("is at least 4.5:1 on every tint, dark theme", () => {
		const fg = toRgb(DARK["muted-foreground"]);
		const worst = Math.min(...washes().map((w) => contrast(fg, toRgb(w.dark))));
		expect(worst).toBeGreaterThanOrEqual(MIN_CONTRAST);
	});

	test("no tint reads as grey: each keeps a minimum of colour in both themes", () => {
		for (const wash of washes()) {
			expect(chroma(wash.light)).toBeGreaterThanOrEqual(MIN_CHROMA);
			expect(chroma(wash.dark)).toBeGreaterThanOrEqual(MIN_CHROMA);
		}
	});
});

describe("muted text on the surfaces it sits on", () => {
	for (const [name, theme] of [
		["light", LIGHT],
		["dark", DARK],
	] as const) {
		test(`is at least 4.5:1 on the page, a card and a muted well, ${name} theme`, () => {
			const fg = toRgb(theme["muted-foreground"]);
			for (const surface of ["background", "card", "muted", "secondary", "accent"]) {
				expect(contrast(fg, toRgb(theme[surface]))).toBeGreaterThanOrEqual(MIN_CONTRAST);
			}
		});
	}
});

/** `over` composites a translucent colour on a backdrop the way the browser does. */
function over(fg: [number, number, number], alpha: number, bg: [number, number, number]) {
	return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as [number, number, number];
}

const EMERALD_500: [number, number, number] = [16 / 255, 185 / 255, 129 / 255];
const SOURCE_DIR = join(import.meta.dir, "..", "components");

/** Every surface a tinted card, the page or a card can put behind a pill or a name link, light theme. */
function lightBackdrops(): [number, number, number][] {
	return [toRgb(LIGHT.background), toRgb(LIGHT.card), ...washes().map((w) => toRgb(w.light))];
}

describe("the session name link on a tinted card", () => {
	test("positive control: the plain primary colour is too faint on the link's own wash", () => {
		const primary = toRgb(LIGHT.primary);
		const worst = Math.min(
			...lightBackdrops().map((bg) => contrast(primary, over(primary, 0.1, bg))),
		);
		expect(worst).toBeLessThan(MIN_CONTRAST);
	});

	test("its light-theme text is at least 4.5:1 on its wash over every tint", () => {
		const text = toRgb(LIGHT["primary-on-tint"]);
		const primary = toRgb(LIGHT.primary);
		const worst = Math.min(...lightBackdrops().map((bg) => contrast(text, over(primary, 0.1, bg))));
		expect(worst).toBeGreaterThanOrEqual(MIN_CONTRAST);
	});

	test("the dark theme keeps the primary colour exactly", () => {
		expect(DARK["primary-on-tint"]).toEqual(DARK.primary);
	});

	test("the card's link uses the token in light and the primary colour in dark", () => {
		const card = readFileSync(join(SOURCE_DIR, "SessionCard.tsx"), "utf8");
		expect(card.includes("text-[hsl(var(--primary-on-tint))] dark:text-primary")).toBe(true);
		expect(/font-bold text-primary bg-primary\/10/.test(card)).toBe(false);
	});
});

describe("the working pill", () => {
	test("positive control: the old emerald-700 text was too faint on its own wash", () => {
		const emerald700: [number, number, number] = [4 / 255, 120 / 255, 87 / 255];
		const worst = Math.min(
			...lightBackdrops().map((bg) => contrast(emerald700, over(EMERALD_500, 0.12, bg))),
		);
		expect(worst).toBeLessThan(MIN_CONTRAST);
	});

	test("its light-theme text is at least 4.5:1 on its wash over every tint", () => {
		const text = toRgb(LIGHT["working-text"]);
		const worst = Math.min(
			...lightBackdrops().map((bg) => contrast(text, over(EMERALD_500, 0.12, bg))),
		);
		expect(worst).toBeGreaterThanOrEqual(MIN_CONTRAST);
	});

	test("the badge uses the token in light and keeps emerald-400 in dark", () => {
		const badge = readFileSync(join(SOURCE_DIR, "StatusBadge.tsx"), "utf8");
		const working = badge.slice(badge.indexOf("working: {"), badge.indexOf("waiting: {"));
		expect(working.includes("text-[hsl(var(--working-text))] dark:text-emerald-400")).toBe(true);
	});
});
