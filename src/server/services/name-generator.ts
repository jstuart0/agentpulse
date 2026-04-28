// Generates memorable random names like "brave-falcon" or "swift-panda"
// Used to give sessions human-friendly identifiers

const ADJECTIVES = [
	"bold",
	"brave",
	"calm",
	"cool",
	"crisp",
	"dark",
	"deep",
	"eager",
	"fair",
	"fast",
	"firm",
	"free",
	"glad",
	"gold",
	"grand",
	"keen",
	"kind",
	"late",
	"lean",
	"live",
	"loud",
	"main",
	"mild",
	"neat",
	"next",
	"nice",
	"open",
	"pale",
	"pure",
	"quick",
	"rare",
	"raw",
	"real",
	"rich",
	"ripe",
	"safe",
	"slim",
	"soft",
	"sure",
	"tall",
	"thin",
	"true",
	"vast",
	"warm",
	"wide",
	"wild",
	"wise",
	"zany",
	"zen",
	"epic",
	"iron",
	"jade",
	"neon",
	"rust",
	"teal",
	"onyx",
	"ruby",
	"sage",
	"dusk",
	"dawn",
];

const NOUNS = [
	"ant",
	"ape",
	"bat",
	"bee",
	"cat",
	"cow",
	"cub",
	"deer",
	"dog",
	"dove",
	"duck",
	"elk",
	"emu",
	"fox",
	"frog",
	"hawk",
	"hare",
	"ibis",
	"jay",
	"kite",
	"lark",
	"lion",
	"lynx",
	"mole",
	"moth",
	"newt",
	"orb",
	"orca",
	"owl",
	"puma",
	"ram",
	"ray",
	"seal",
	"slug",
	"swan",
	"toad",
	"wasp",
	"wren",
	"wolf",
	"yak",
	"crow",
	"crab",
	"bass",
	"bear",
	"boar",
	"dart",
	"dune",
	"fern",
	"gull",
	"heron",
	"kiwi",
	"moth",
	"pika",
	"robin",
	"sage",
	"tern",
	"vole",
	"worm",
	"crane",
	"finch",
];

export function generateSessionName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	return `${adj}-${noun}`;
}

const MAX_SLUG_WORDS = 4;
const MAX_SLUG_LENGTH = 40;

/**
 * Convert a free-form task description into a kebab-case slug suitable for
 * use as a session display name. Returns "" if no usable characters remain.
 */
export function slugifyTaskName(input: string): string {
	if (typeof input !== "string") return "";
	const lowered = input.toLowerCase();
	const words = lowered
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 0)
		.slice(0, MAX_SLUG_WORDS);
	if (words.length === 0) return "";
	let slug = words.join("-");
	if (slug.length > MAX_SLUG_LENGTH) slug = slug.slice(0, MAX_SLUG_LENGTH);
	slug = slug.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	return slug;
}

/**
 * Cheap collision suffix — 4 chars from base36. Visible to the user
 * only when two AI-initiated launches in the same project pick the same
 * slug within the collision window.
 */
export function randomSlugSuffix(): string {
	return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}
