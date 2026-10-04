/**
 * AGEN-69: the instruction tripwire (plan "What the server verifies", rule 6;
 * build note BN-7). It looks for shapes that suggest a summary carries
 * instructions for whoever reads or pastes it, and returns reason codes. It
 * never alters the text and it is a tripwire, not a filter: the summary is
 * stored as written and the UI warns before it is copied.
 *
 * Detection runs on a folded copy (invisible characters stripped, NFKC), so a
 * zero-width character or a fullwidth letter does not evade a rule.
 */
import type { SessionSummary, SummarySuspectReason } from "../../../../shared/session-summary.js";
import { stripInvisibleKeepNewlines } from "../untrusted-text.js";

// ── folding ──────────────────────────────────────────────────────────────────

/** Hostile input is bounded: nothing past this many characters of one field is looked at. */
const SCAN_LIMIT = 200_000;

function fold(text: string): string {
	return stripInvisibleKeepNewlines(text.slice(0, SCAN_LIMIT)).normalize("NFKC");
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/**
 * Extensions that look like a top-level domain. `src/a.ts` and `package.json/`
 * are paths, not hosts, so a bare `host/path` with one of these never counts
 * (BN-7). A scheme (`https://x.md/`) or `www.` still counts.
 */
const FILE_EXTENSION_TLDS = new Set(
	(
		"json ts tsx js jsx mjs cjs md py rs go sh yml yaml toml txt lock css scss html htm sql rb java kt " +
		"swift c h cpp hpp cs php lua env log conf cfg ini xml csv tsv svg png jpg jpeg gif webp pdf zip tar " +
		"gz tgz bak tmp map snap test spec vue svelte bat ps1 dockerfile mk gradle pl pm ex exs erl hs ml " +
		"scala sbt dart zig nim jl lock sum mod"
	).split(" "),
);

// A bare host or host/path only starts at the start of a token, so a long dotted
// run is one linear scan and not one scan per character.
const SCHEME_URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`]+/gi;
const WWW_URL_RE = /(?<![\w.@/-])www\.[^\s<>"'`]+/gi;
const BARE_URL_RE = /(?<![\w./@:-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{1,5})?\/[^\s<>"'`]*/gi;
const BARE_HOST_RE = /(?<![\w./@:-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?![\w-])/gi;

const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}>'"*_`]+$/;

interface Normalised {
	host: string;
	/** Empty for a bare host. */
	path: string;
}

function tldOf(host: string): string {
	return host.slice(host.lastIndexOf(".") + 1);
}

/** Lowercase host, no scheme, userinfo, port, query or fragment; trailing punctuation stripped. */
function normaliseUrl(raw: string): Normalised | null {
	const trimmed = raw.replace(TRAILING_PUNCTUATION_RE, "");
	const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	const cut = withoutScheme.search(/[/?#]/);
	const authority = cut === -1 ? withoutScheme : withoutScheme.slice(0, cut);
	const rest = cut === -1 ? "" : withoutScheme.slice(cut);
	const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
	const host = hostPort
		.replace(/:\d*$/, "")
		.replace(/\.$/, "")
		.toLowerCase()
		.replace(/^www\./, "");
	if (!host) return null;
	const pathOnly = rest.startsWith("/") ? (rest.split(/[?#]/, 1)[0] ?? "") : "";
	return { host, path: pathOnly.replace(/\/+$/, "") };
}

const keyOf = (n: Normalised): string => `${n.host}${n.path}`;

interface Candidate extends Normalised {
	/** A bare dotted host with no scheme and no path: only the lookalike rule applies. */
	bareHost: boolean;
}

function candidates(folded: string, includeBareHosts: boolean): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>();
	const add = (raw: string, bare: boolean, bareHost = false) => {
		const n = normaliseUrl(raw);
		if (!n) return;
		if (bare && FILE_EXTENSION_TLDS.has(tldOf(n.host))) return;
		const id = `${keyOf(n)}|${bareHost}`;
		if (seen.has(id)) return;
		seen.add(id);
		out.push({ ...n, bareHost });
	};
	for (const m of folded.matchAll(SCHEME_URL_RE)) add(m[0], false);
	for (const m of folded.matchAll(WWW_URL_RE)) add(m[0], false);
	for (const m of folded.matchAll(BARE_URL_RE)) add(m[0], true);
	if (includeBareHosts) {
		for (const m of folded.matchAll(BARE_HOST_RE)) add(m[0], true, true);
	}
	return out;
}

/** Normalised `host/path` keys of every URL-like string in `text`. `user` mode also takes bare hosts. */
export function extractUrlKeys(text: string, mode: "model" | "user"): string[] {
	const found = candidates(fold(text), mode === "user");
	return [...new Set(found.map(keyOf))];
}

/**
 * The URLs a user typed, as normalised keys. Call it on each prompt's text
 * before the ledger caps it: a URL past the cap is still one the user typed.
 */
export function collectUserPromptUrls(texts: Iterable<string>): Set<string> {
	const urls = new Set<string>();
	for (const text of texts) {
		for (const key of extractUrlKeys(text, "user")) urls.add(key);
	}
	return urls;
}

function hostOfKey(key: string): string {
	const slash = key.indexOf("/");
	return slash === -1 ? key : key.slice(0, slash);
}

function hasUnexpectedUrl(folded: string, userPromptUrls: ReadonlySet<string>): boolean {
	const userHosts = new Set<string>();
	for (const key of userPromptUrls) userHosts.add(hostOfKey(key));
	for (const c of candidates(folded, true)) {
		if (c.bareHost) {
			// A bare host is judged only as a lookalike of a host the user typed.
			if (!userHosts.has(c.host) && [...userHosts].some((h) => c.host.startsWith(`${h}.`))) {
				return true;
			}
			continue;
		}
		if (userPromptUrls.has(keyOf(c))) continue;
		if (c.path === "" && userHosts.has(c.host)) continue;
		return true;
	}
	return false;
}

// ── the other rules ──────────────────────────────────────────────────────────

const ROLE_MARKER_RES = [
	/(?:^|\n)[ \t]*(?:system|assistant|developer)[ \t]*:/i,
	/<\|im_(?:start|end)\|>|\[\/?INST\]|<<\/?SYS>>/i,
];

const OVERRIDE_PHRASE_RES = [
	/\b(?:ignore|disregard)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|messages)\b/i,
	/\byou\s+are\s+now\b/i,
	/\bnew\s+instructions\b/i,
	/\bfrom\s+now\s+on\b/i,
];

// `[^\n|]{0,500}` and not `*`: an unbounded scan from every `curl` in a long
// run of them would be quadratic. `sh|python|node` end at a word boundary so
// `| shasum`, `| sha256sum` and `| nodemon` do not match (BN-7).
const PIPE_TO_SHELL_RES = [
	/\b(?:curl|wget)\b[^\n|]{0,500}\|\s*(?:sudo\s+)?(?:(?:ba|z|da)?sh|python3?|node)\b/i,
	/\b(?:ba|z|da)?sh\s+<\(\s*(?:curl|wget)\b/i,
	/\$\(\s*(?:curl|wget)\b/i,
	/\/dev\/tcp\//i,
	/\bnc(?:at)?\s+(?:-[a-z]+\s+)*-e\b/i,
	/\bpowershell(?:\.exe)?\s+(?:-[a-z]+\s+)*-e(?:nc(?:odedcommand)?)?\b/i,
];

const anyMatch = (res: RegExp[], text: string) => res.some((re) => re.test(text));

/** Reason codes for one string. `checkUrls` is true only for handoff and next actions. */
export function checkText(
	text: string,
	opts: { checkUrls: boolean; userPromptUrls: ReadonlySet<string> },
): SummarySuspectReason[] {
	const folded = fold(text);
	const reasons: SummarySuspectReason[] = [];
	if (anyMatch(ROLE_MARKER_RES, folded)) reasons.push("role_marker");
	if (anyMatch(OVERRIDE_PHRASE_RES, folded)) reasons.push("override_phrase");
	if (opts.checkUrls && hasUnexpectedUrl(folded, opts.userPromptUrls))
		reasons.push("unexpected_url");
	if (anyMatch(PIPE_TO_SHELL_RES, folded)) reasons.push("pipe_to_shell");
	return reasons;
}

/** Every string field is scanned; the URL rule runs on `handoff` and `nextActions` only. */
export function runTripwire(
	summary: SessionSummary,
	userPromptUrls: ReadonlySet<string>,
): SummarySuspectReason[] {
	const plain: string[] = [
		summary.overview,
		summary.outcome.explanation,
		...summary.accomplishments.map((i) => i.text),
		...summary.changes.map((i) => i.text),
		...summary.decisions.flatMap((i) => [i.text, i.why]),
		...summary.validation.flatMap((i) => [i.what, i.detail]),
		...summary.problems.map((i) => i.text),
		...summary.unfinished.map((i) => i.text),
	];
	const urlChecked: string[] = [summary.handoff, ...summary.nextActions.map((i) => i.text)];
	const found = new Set<SummarySuspectReason>();
	for (const text of plain) {
		for (const r of checkText(text, { checkUrls: false, userPromptUrls })) found.add(r);
	}
	for (const text of urlChecked) {
		for (const r of checkText(text, { checkUrls: true, userPromptUrls })) found.add(r);
	}
	return [...found];
}
