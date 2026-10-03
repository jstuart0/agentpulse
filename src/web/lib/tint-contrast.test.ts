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

/** Tailwind's own palette, as the app's classes resolve it. */
const PALETTE: Record<string, [number, number, number]> = {
	"amber-500": [245 / 255, 158 / 255, 11 / 255],
	"amber-800": [146 / 255, 64 / 255, 14 / 255],
	"amber-900": [120 / 255, 53 / 255, 15 / 255],
	"blue-500": [59 / 255, 130 / 255, 246 / 255],
	"blue-700": [29 / 255, 78 / 255, 216 / 255],
	"blue-800": [30 / 255, 64 / 255, 175 / 255],
	"emerald-500": EMERALD_500,
	"red-500": [239 / 255, 68 / 255, 68 / 255],
	"red-800": [153 / 255, 27 / 255, 27 / 255],
	"red-700": [185 / 255, 28 / 255, 28 / 255],
	"amber-400": [251 / 255, 191 / 255, 36 / 255],
	"blue-400": [96 / 255, 165 / 255, 250 / 255],
	"emerald-400": [52 / 255, 211 / 255, 153 / 255],
};

/** The light-theme text colour and the wash (colour and strength) a pill's class string asks for. */
function pillColours(classes: string): {
	text: [number, number, number];
	wash: [number, number, number];
	alpha: number;
} {
	const tokens = classes.split(/\s+/).filter((token) => !token.includes(":"));
	const textToken = tokens.find((token) =>
		/^text-(?:[a-z]+-\d+|\[hsl\(var\(--working-text\)\)\])$/.test(token),
	);
	const text = textToken?.includes("--working-text")
		? toRgb(LIGHT["working-text"])
		: PALETTE[(textToken ?? "").replace("text-", "")];
	const washMatch = tokens.map((token) => /^bg-([a-z]+-500)\/(\d+)$/.exec(token)).find(Boolean);
	if (!text || !washMatch) throw new Error(`can't read colours from: ${classes}`);
	return { text, wash: PALETTE[washMatch[1]], alpha: Number(washMatch[2]) / 100 };
}

const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");
const HEADER = read("components", "session-detail", "SessionHeader.tsx");
const CARD = read("components", "SessionCard.tsx");

/** Every class string in `source` that matches `pattern` (its first capture group). */
function classStrings(source: string, pattern: RegExp): string[] {
	return [...source.matchAll(pattern)].map((match) => match[1]);
}

const SESSION_DETAIL_PILLS: Record<string, string[]> = {
	"the working pill": classStrings(
		HEADER,
		/className="([^"]*)">\s*<span className="w-1\.5 h-1\.5 rounded-full bg-amber-400 animate-pulse-dot"/g,
	),
	"the project link pill": classStrings(HEADER, /className="([^"]*)"\s*title=\{`Project:/g),
	"the branch pill": classStrings(HEADER, /className="([^"]*)">\s*\{session\.gitBranch\}/g),
	"Dismiss error and Stop (header)": classStrings(
		HEADER,
		/"([^"]*border-red-500\/30 bg-red-500\/10[^"]*)"/g,
	),
	"Dismiss error (card)": classStrings(CARD, /"([^"]*border-red-500\/30 bg-red-500\/10[^"]*)"/g),
};

describe("the session page's pills and buttons, light theme", () => {
	test("positive control: every one was found, and the old working pill colour fails", () => {
		for (const [name, found] of Object.entries(SESSION_DETAIL_PILLS)) {
			expect(found.length, name).toBeGreaterThanOrEqual(1);
		}
		expect(SESSION_DETAIL_PILLS["Dismiss error and Stop (header)"]).toHaveLength(3);
		const oldWorking = over(PALETTE["amber-400"], 0.1, toRgb(LIGHT.background));
		expect(contrast(PALETTE["amber-400"], oldWorking)).toBeLessThan(MIN_CONTRAST);
	});

	for (const [name, found] of Object.entries(SESSION_DETAIL_PILLS)) {
		test(`${name} is at least 4.5:1 on its wash over the page, a card and every tint`, () => {
			for (const classes of found) {
				const { text, wash, alpha } = pillColours(classes);
				const worst = Math.min(
					...lightBackdrops().map((bg) => contrast(text, over(wash, alpha, bg))),
				);
				expect({ classes, ok: worst >= MIN_CONTRAST, worst: worst.toFixed(2) }).toEqual({
					classes,
					ok: true,
					worst: worst.toFixed(2),
				});
			}
		});
	}

	test("dark theme is unchanged: each keeps its dark: colour", () => {
		for (const classes of Object.values(SESSION_DETAIL_PILLS).flat()) {
			expect(classes).toMatch(/dark:text-(amber|blue|emerald|red)-(300|400)/);
		}
		const originalDark = {
			working: "dark:text-amber-400",
			project: "dark:text-blue-400",
			branch: "dark:text-emerald-400",
			dismiss: "dark:text-red-300",
		};
		expect(SESSION_DETAIL_PILLS["the working pill"][0]).toContain(originalDark.working);
		expect(SESSION_DETAIL_PILLS["the project link pill"][0]).toContain(originalDark.project);
		expect(SESSION_DETAIL_PILLS["the branch pill"][0]).toContain(originalDark.branch);
		for (const classes of SESSION_DETAIL_PILLS["Dismiss error and Stop (header)"]) {
			expect(classes).toContain(originalDark.dismiss);
		}
	});
});
