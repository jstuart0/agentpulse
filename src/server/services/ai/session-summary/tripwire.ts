/**
 * AGEN-69: the instruction tripwire (plan "What the server verifies", rule 6;
 * build note BN-7). It looks for shapes that suggest a summary carries
 * instructions for whoever reads or pastes it, and returns reason codes. It
 * never alters the text and it is a tripwire, not a filter: the summary is
 * stored as written and the UI warns before it is copied.
 *
 * Detection runs on a folded copy (invisible characters stripped, NFKD with
 * marks removed, look-alike letters mapped to Latin, defanged dots restored), so
 * a zero-width character, a fullwidth letter or a Cyrillic "a" does not evade a
 * rule. Every rule is linear in the length of a field: no unbounded
 * backtracking window and no scan that restarts at every occurrence.
 *
 * Rules that cost a false positive on honest text are named in
 * `tripwire.test.ts`'s decision table; the cost of each is measured there.
 */
import {
	SUMMARY_SUSPECT_REASONS,
	type SessionSummary,
	type SummarySuspectReason,
} from "../../../../shared/session-summary.js";
import { stripInvisibleKeepNewlines } from "../untrusted-text.js";
import { classifyCommand } from "./command-class.js";

// ── folding ──────────────────────────────────────────────────────────────────

/** Hostile input is bounded: nothing past this many characters of one field is looked at. */
const SCAN_LIMIT = 200_000;

/** Invisible or blank characters beyond what `stripInvisibleKeepNewlines` removes. */
const EXTRA_INVISIBLE_RE = /[឴឵⠀܏]/g;
const MARKS_RE = /\p{M}/gu;

/** Cyrillic and Greek letters that read as Latin ones, mapped to the lowercase Latin letter. */
const CONFUSABLES: Record<string, string> = {
	а: "a",
	А: "a",
	е: "e",
	Е: "e",
	о: "o",
	О: "o",
	р: "p",
	Р: "p",
	с: "c",
	С: "c",
	х: "x",
	Х: "x",
	у: "y",
	У: "y",
	і: "i",
	І: "i",
	ѕ: "s",
	Ѕ: "s",
	ј: "j",
	Ј: "j",
	к: "k",
	К: "k",
	м: "m",
	М: "m",
	н: "h",
	Н: "h",
	т: "t",
	Т: "t",
	в: "b",
	В: "b",
	ο: "o",
	Ο: "o",
	α: "a",
	Α: "a",
	ν: "v",
	ρ: "p",
	Ρ: "p",
	ι: "i",
	Ι: "i",
	κ: "k",
	Κ: "k",
	τ: "t",
	Τ: "t",
	υ: "u",
	Υ: "y",
	ε: "e",
	Ε: "e",
	Β: "b",
	Η: "h",
	Μ: "m",
	Ν: "n",
	Χ: "x",
	Ζ: "z",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");
const DEFANG_DOT_RE = /\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)/gi;

/** Braille blank: read as a separator by a person, so a field is judged both with it removed and as a space. */
const BRAILLE_BLANK_RE = /\u2800/g;

function fold(text: string, brailleAs = ""): string {
	return stripInvisibleKeepNewlines(text.slice(0, SCAN_LIMIT))
		.replace(BRAILLE_BLANK_RE, brailleAs)
		.replace(EXTRA_INVISIBLE_RE, "")
		.normalize("NFKD")
		.replace(MARKS_RE, "")
		.replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
		.replace(/。/g, ".")
		.replace(DEFANG_DOT_RE, ".")
		.replace(/\bhxxp(s?)\b/gi, "http$1")
		.replace(/\[:\/\/\]|\[:\]\/\//g, "://");
}

// ── top-level domains ────────────────────────────────────────────────────────

/** All two-letter country-code TLDs, and the common generic ones. A token ending in anything else is not a host. */
const TLDS = new Set(
	(
		"ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz " +
		"ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk " +
		"fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir " +
		"is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk " +
		"ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl " +
		"pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc " +
		"td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw " +
		"com net org edu gov mil int info biz name pro dev app xyz online site tech cloud store shop blog link " +
		"live top club vip icu work space website page zip mov news today world network digital agency systems " +
		"solutions email download click review fit ltd inc llc team tools run host press wiki studio software " +
		"codes foundation social rocks ninja zone fun art one"
	).split(" "),
);

/** Product names whose "TLD" is part of the name; accepted as names, not hosts, only written with no path (`asp.net/Core` is the real domain). */
const PRODUCT_NAMES = new Set(["asp.net", "socket.io", "vb.net"]);

// ── URLs ─────────────────────────────────────────────────────────────────────

/** A candidate is cut here: nothing past this is a URL worth judging, and every later step is bounded by it. */
const MAX_CANDIDATE = 2048;

const SCHEME_URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`]+/gi;
const OPAQUE_URL_RE = /\b(?:javascript|vbscript):[^\s<>"'`]*/gi;
const DATA_URL_RE = /\bdata:[a-z]+\/[a-z0-9.+-]+[;,][^\s<>"'`]*/gi;
const FILE_URL_RE = /\bfile:\/[^\s<>"'`]+/gi;
const SCP_URL_RE = /(?<![\w.@-])[\w.-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+):([\w./~-]+)/gi;
const WWW_URL_RE = /(?<![\w.@/-])www\.[^\s<>"'`]+/gi;
const BARE_URL_RE = /(?<![\w./@:-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{1,5})?\/[^\s<>"'`]*/gi;
const IPV4_URL_RE = /(?<![\w./@:-])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\/[^\s<>"'`]*/g;
const BARE_IPV4_RE = /(?<![\w./@:-])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?![\w/-])(?!\.\d)/g;
const BARE_HOST_RE = /(?<![\w./@:-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?![\w/-])/gi;

const TRAILING_PUNCTUATION = new Set([...".,;:!?)]}>'\"*_`"]);

/** Drops trailing punctuation with one backwards pass: linear, whatever the run. */
function trimTrailingPunctuation(text: string): string {
	let end = text.length;
	while (end > 0 && TRAILING_PUNCTUATION.has(text[end - 1] as string)) end--;
	return text.slice(0, end);
}

interface Candidate {
	host: string;
	/** No trailing slash, no query or fragment; empty for a bare host. */
	path: string;
	/** Written without a scheme: a file name can look like this, so the ledger is consulted. */
	bare: boolean;
	/** A shape no honest summary has: backslash or percent in the authority, `javascript:`, unparsable, a numeric or hex host. */
	suspect: boolean;
	/** `suspect`, or userinfo in the authority: what `malformed_url` reports. */
	malformed: boolean;
	/** The token as written (lowercase, no scheme), for the ledger-path comparison. */
	token: string;
}

const LOOPBACK_HOSTS = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/;

const NUMERIC_PART_RE = /^(?:0x[0-9a-f]+|\d+)$/i;
const PLAIN_OCTET_RE = /^(?:0|[1-9]\d{0,2})$/;

/** `2130706433`, `0x7f.0.0.1`, `0177.0.0.1`, `127.1`: a host the URL parser turns into an address. A plain dotted quad is not odd. */
function isOddNumericHost(host: string): boolean {
	const parts = host.split(".");
	if (parts.length > 4 || !parts.every((p) => NUMERIC_PART_RE.test(p))) return false;
	const plainQuad =
		parts.length === 4 && parts.every((p) => PLAIN_OCTET_RE.test(p) && Number(p) <= 255);
	return !plainQuad;
}

/** Parses one candidate with the URL parser (a scheme is added when missing) and compares `hostname`. */
function parseCandidate(rawIn: string, hasScheme: boolean): Candidate | null {
	const raw = trimTrailingPunctuation(rawIn.slice(0, MAX_CANDIDATE));
	if (!raw) return null;
	const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	const authorityEnd = withoutScheme.search(/[/?#]/);
	const authority = authorityEnd === -1 ? withoutScheme : withoutScheme.slice(0, authorityEnd);
	if (!authority) return null;
	const userinfo = hasScheme && authority.includes("@");
	const hostPart = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
	const suspect = /[\\%]/.test(authority) || (hasScheme && isOddNumericHost(hostPart));
	let url: URL;
	try {
		url = new URL(hasScheme ? raw : `http://${raw}`);
	} catch {
		return {
			host: authority.toLowerCase(),
			path: "",
			bare: !hasScheme,
			suspect: true,
			malformed: true,
			token: raw,
		};
	}
	const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
	if (!host) return null;
	return {
		host,
		path: url.pathname.replace(/\/+$/, ""),
		bare: !hasScheme,
		suspect,
		malformed: suspect || userinfo,
		token: withoutScheme.replace(/[?#].*$/, "").toLowerCase(),
	};
}

const tldOf = (host: string): string => host.slice(host.lastIndexOf(".") + 1);

function opaqueCandidate(raw: string): Candidate {
	return {
		host: raw.slice(0, 24).toLowerCase(),
		path: "",
		bare: false,
		suspect: true,
		malformed: true,
		token: raw,
	};
}

function candidates(folded: string, includeBareHosts: boolean): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>();
	const push = (c: Candidate | null, hostOnly = false) => {
		if (!c) return;
		const id = `${c.host}${c.path}|${hostOnly}|${c.suspect}|${c.malformed}`;
		if (seen.has(id)) return;
		seen.add(id);
		out.push(c);
	};
	const bareAllowed = (c: Candidate | null): Candidate | null => {
		if (!c) return null;
		if (PRODUCT_NAMES.has(c.host) && c.path === "") return null;
		const tld = tldOf(c.host);
		const isIp =
			/^\d{1,3}(?:\.\d{1,3}){3}$/.test(c.host) && c.host.split(".").every((o) => Number(o) <= 255);
		return TLDS.has(tld) || isIp ? c : null;
	};
	for (const m of folded.matchAll(SCHEME_URL_RE)) push(parseCandidate(m[0], true));
	for (const m of folded.matchAll(OPAQUE_URL_RE)) push(opaqueCandidate(m[0]));
	for (const m of folded.matchAll(DATA_URL_RE)) push(opaqueCandidate(m[0]));
	for (const m of folded.matchAll(FILE_URL_RE)) push(opaqueCandidate(m[0]));
	for (const m of folded.matchAll(SCP_URL_RE)) {
		push(parseCandidate(`${m[1]}/${trimTrailingPunctuation(m[2] ?? "")}`, false));
	}
	for (const m of folded.matchAll(WWW_URL_RE)) push(parseCandidate(m[0], false));
	for (const m of folded.matchAll(BARE_URL_RE)) push(bareAllowed(parseCandidate(m[0], false)));
	for (const m of folded.matchAll(IPV4_URL_RE)) push(bareAllowed(parseCandidate(m[0], false)));
	if (includeBareHosts) {
		for (const m of folded.matchAll(BARE_HOST_RE)) {
			push(bareAllowed(parseCandidate(m[0], false)), true);
		}
		for (const m of folded.matchAll(BARE_IPV4_RE)) {
			push(bareAllowed(parseCandidate(m[0], false)), true);
		}
	}
	return out;
}

const keyOf = (c: { host: string; path: string }): string => `${c.host}${c.path}`;

/** Normalised `host/path` keys of every URL-like string in `text`. `user` mode also takes bare hosts. */
export function extractUrlKeys(text: string, mode: "model" | "user"): string[] {
	const found = candidates(fold(text), mode === "user");
	return [...new Set(found.filter((c) => !c.suspect).map(keyOf))];
}

/**
 * The URLs a user typed, as normalised keys. Call it on each prompt's text the
 * loader returns: that text is SQL-cut (1,756 / 4,256 code points), so a URL
 * past the cut is not seen here and raises `unexpected_url` (a note, the
 * safe direction).
 */
export function collectUserPromptUrls(texts: Iterable<string>): Set<string> {
	const urls = new Set<string>();
	for (const text of texts) {
		for (const key of extractUrlKeys(text, "user")) urls.add(key);
	}
	return urls;
}

// ── what the session recorded ────────────────────────────────────────────────

export interface TripwireContext {
	/** Normalised URLs the user typed (`collectUserPromptUrls`). */
	userPromptUrls: ReadonlySet<string>;
	/** File paths the ledger shows (edited files), as shown. */
	recordedPaths: readonly string[];
	/** Command lines the ledger shows, as shown. A withheld or not-shown command has none. */
	recordedCommands: readonly string[];
}

export const NO_RECORDS: Pick<TripwireContext, "recordedPaths" | "recordedCommands"> = {
	recordedPaths: [],
	recordedCommands: [],
};

/** A context from a typed-URL set alone, for callers and tests with no ledger. */
export const contextOf = (
	userPromptUrls: ReadonlySet<string>,
	records: Partial<Pick<TripwireContext, "recordedPaths" | "recordedCommands">> = {},
): TripwireContext => ({ userPromptUrls, ...NO_RECORDS, ...records });

const COMMAND_SPLIT_RE = /&&|\|\||;|\||\n/;

function squash(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Command words that make a code span or a "run ..." phrase read as a command. */
const COMMAND_VERBS = new Set([
	"curl",
	"wget",
	"iwr",
	"irm",
	"sh",
	"bash",
	"zsh",
	"sudo",
	"rm",
	"mv",
	"cp",
	"chmod",
	"chown",
	"ssh",
	"scp",
	"rsync",
	"nc",
	"ncat",
	"git",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"bun",
	"bunx",
	"pip",
	"pip3",
	"pipx",
	"cargo",
	"go",
	"docker",
	"kubectl",
	"helm",
	"terraform",
	"make",
	"python",
	"python3",
	"node",
	"deno",
	"perl",
	"ruby",
	"php",
	"gh",
	"aws",
	"gcloud",
	"az",
	"brew",
	"apt",
	"apt-get",
	"yum",
	"dnf",
	"systemctl",
	"kill",
	"pkill",
	"export",
	"source",
	"eval",
	"exec",
	"tee",
	"dd",
	"crontab",
	"xargs",
	"osascript",
	"powershell",
	"pwsh",
	"iex",
]);

const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "branch"]);

/** A redirect that only silences or merges output (`2>&1`, `>/dev/null`): it cannot name a file worth writing, so it does not make a command another command. */
const HARMLESS_REDIRECT_RE = /^(?:\d*>&\d|&?\d*>>?\/dev\/null)$/;

/** Segments of a command line that name a command with arguments, as `[verb, rest...]` token lists. */
function segmentsOf(command: string): string[][] {
	return command
		.split(COMMAND_SPLIT_RE)
		.map((s) =>
			squash(s)
				.replace(/^\$ /, "")
				.split(" ")
				.filter((t) => !HARMLESS_REDIRECT_RE.test(t)),
		)
		.filter((tokens) => tokens.length > 0 && tokens[0] !== "");
}

/** The identity of a command segment: it matches a recorded one only when every token does. */
const segmentKey = (tokens: string[]): string => tokens.join(" ");

interface RecordIndex {
	paths: Set<string>;
	commandText: string;
	/** Every segment of every recorded command, whole (`bun install`, not just `bun`), built once. */
	segments: Set<string>;
}

function indexRecords(ctx: TripwireContext): RecordIndex {
	const segments = new Set<string>();
	for (const command of ctx.recordedCommands) {
		for (const tokens of segmentsOf(fold(command))) segments.add(segmentKey(tokens));
	}
	return {
		paths: new Set(ctx.recordedPaths.map((p) => fold(p).toLowerCase())),
		commandText: fold(ctx.recordedCommands.join("\n")).toLowerCase(),
		segments,
	};
}

/** The token is, or ends (on a `/`) with, a file path the ledger shows, or is a word of a recorded command. */
function isRecordedName(token: string, records: RecordIndex): boolean {
	for (const p of records.paths) {
		if (p === token || p.endsWith(`/${token}`)) return true;
	}
	return records.commandText.includes(token);
}

// ── the URL rule ─────────────────────────────────────────────────────────────

interface TypedUrls {
	keys: ReadonlySet<string>;
	hosts: Set<string>;
	/** Host to the typed paths that are not empty. */
	paths: Map<string, string[]>;
}

function indexTyped(userPromptUrls: ReadonlySet<string>): TypedUrls {
	const hosts = new Set<string>();
	const paths = new Map<string, string[]>();
	for (const key of userPromptUrls) {
		const slash = key.indexOf("/");
		const host = slash === -1 ? key : key.slice(0, slash);
		hosts.add(host);
		if (slash !== -1 && key.length > slash + 1) {
			const list = paths.get(host) ?? [];
			list.push(key.slice(slash));
			paths.set(host, list);
		}
	}
	return { keys: userPromptUrls, hosts, paths };
}

interface UrlFindings {
	/** An address the user never typed (and, outside `loopbackNote`, not a loopback one). */
	unexpected: boolean;
	/** An address with a shape no honest summary has. */
	malformed: boolean;
}

/**
 * `loopbackNote`: a loopback address counts as unexpected unless typed. The
 * sections Copy handoff emits are judged that way; elsewhere, and when judging a
 * command span for `risky_command`, loopback is exempt.
 */
function urlFindings(
	folded: string,
	typed: TypedUrls,
	records: RecordIndex,
	loopbackNote: boolean,
): UrlFindings {
	const found: UrlFindings = { unexpected: false, malformed: false };
	for (const c of candidates(folded, true)) {
		if (c.malformed) found.malformed = true;
		if (found.unexpected) {
			if (found.malformed) break;
			continue;
		}
		if (c.suspect) {
			found.unexpected = true;
			continue;
		}
		if (!loopbackNote && LOOPBACK_HOSTS.test(c.host)) continue;
		if (typed.keys.has(keyOf(c))) continue;
		if (c.path === "" && typed.hosts.has(c.host)) continue;
		// A deeper path under a URL the user typed, on the same host, is the same document tree.
		if (
			c.path !== "" &&
			typed.paths.get(c.host)?.some((p) => c.path === p || c.path.startsWith(`${p}/`))
		)
			continue;
		if (c.bare && isRecordedName(c.token, records)) continue;
		found.unexpected = true;
	}
	return found;
}

// ── role markers and override phrases ────────────────────────────────────────

const LABEL = "system|assistant|developer|user|human";
const PREFIX = "[ \\t>\\-*#_`\"'\\[(|]*";

const COLON_LABEL_RE = new RegExp(
	`(?:^|\\n)${PREFIX}(${LABEL})[ \\t]{0,8}["'*_\`]{0,4}[ \\t]{0,8}:[ \\t]{0,8}([^\\n]*)`,
	"gi",
);
const BRACKET_LABEL_RE = new RegExp(
	`(?:^|\\n)${PREFIX}(?:\\[(?:${LABEL})\\]|<\\/?(?:${LABEL})>|#{1,6}[ \\t]*(?:system|assistant|developer)[ \\t]*(?:\\n|$))`,
	"i",
);
const CHAT_TEMPLATE_RE =
	/<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>/i;

/**
 * `system:` and `developer:` at a line start are also how an environment is
 * described ("System: Linux x64"). Only a value made of operating-system,
 * architecture and version words is a label; anything else after the colon is
 * text addressed to a reader and fires. `assistant:`, `user:` and `human:` always fire.
 */
const ENVIRONMENT_WORD_RE =
	/^(?:linux|darwin|macos|windows|ubuntu|debian|x86_64|x86|x64|arm64|aarch64|amd64|i386|i686|\d[\d.]*)$/i;
const ENVIRONMENT_SPLIT_RE = /[\s,;/()-]+/;

/** Tokens, not a repeated pattern: linear whatever the value. */
function isEnvironmentValue(value: string): boolean {
	return value
		.split(ENVIRONMENT_SPLIT_RE)
		.filter(Boolean)
		.every((word) => ENVIRONMENT_WORD_RE.test(word));
}

function hasRoleMarker(folded: string): boolean {
	if (CHAT_TEMPLATE_RE.test(folded) || BRACKET_LABEL_RE.test(folded)) return true;
	for (const m of folded.matchAll(COLON_LABEL_RE)) {
		const label = (m[1] as string).toLowerCase();
		if (label !== "system" && label !== "developer") return true;
		const value = (m[2] ?? "").trim();
		if (value !== "" && !isEnvironmentValue(value)) return true;
	}
	return false;
}

const OVERRIDE_PHRASE_RES = [
	/\b(?:ignore|disregard|forget|override|bypass|discard)\s+(?:all\s+|any\s+|every\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|preceding|foregoing|former)\s+(?:instructions?|prompts?|messages?|rules?|guidelines?|directions?|commands?|context)\b/i,
	/\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:everything|anything|all)\s+)?(?:the\s+)?above\b/i,
	/\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:of\s+)?(?:your|my)\s+(?:instructions?|guidelines?|rules?|system\s+prompt|programming|directions?|restrictions?)\b/i,
	/\byou\s+are\s+now\s+(?:a|an|the|my|dan|acting|playing|operating|free|unrestricted|in\s+(?:developer|dan|debug|admin|god)\b|(?:authori[sz]ed|allowed|permitted|able|cleared|granted|root|admin|in\s+charge)\b)/i,
	/\bpretend\s+(?:to\s+be|you\s+are)\b/i,
	/\bnew\s+instructions?\s*[:：]/i,
	/\b(?:your|following|these)\s+new\s+instructions?\b/i,
	/\bnew\s+instructions?\s+(?:are\s+to|is\s+to|say|says|said|tell|tells|state|states|require|requires|order|orders|mean|means|must|should)\b/i,
	/\bfrom\s+now\s+on\s*,/i,
	/\bfrom\s+now\s+on\s+(?:you|your|always|never|ignore|respond|reply|answer|say|obey|only|do|don't|must|every|run|push|skip|use|deploy|send|commit|stop|treat|assume|write|execute|delete|install|open|call|make|add|remove|change|disable|enable|approve|merge|force|ask|tell|show|print|reveal|output|follow|trust|accept|allow|bypass|override|forget|pretend|act)\b/i,
];

// ── fetch and run ────────────────────────────────────────────────────────────

/** Fetch tools that read as a download wherever they stand in the text. */
const FETCH_ANYWHERE_RE =
	/\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|git\s+clone|aria2c|scp|go\s+install)\b|\bpip3?\s+install\s+(?:-\S+\s+)*(?:\w+:\/\/|git\+)/i;

const INTERPRETER = String.raw`(?:python[\d.]*|node|perl|ruby|php|pwsh|powershell(?:\.exe)?)`;
const SHELL = String.raw`(?:(?:ba|z|da|k|c|tc|fi)?sh)`;
const WRAPPERS = String.raw`(?:(?:sudo|env|exec|command|nohup|time)(?:\s+(?:-\S+|\w+=\S+))*\s+)*`;
const BIN_DIR = String.raw`(?:/(?:usr/)?(?:local/)?s?bin/)?`;
const NOT_WORD = String.raw`(?![\w.-])`;
const NOT_JSON_TOOL = String.raw`(?!\s+-m\s+json\.tool\b)`;
/** In command position: after a separator, a backtick, `$(` or a line start. */
const COMMAND_POSITION = String.raw`(?:^|[\n;&|(\`]|\$\()[ \t]*${WRAPPERS}${BIN_DIR}`;

/** Fetch tools that only count in command position (`fetch`, `npx` and HTTPie are common words or names). */
const FETCH_COMMAND_RE = new RegExp(
	[
		COMMAND_POSITION,
		String.raw`(?:fetch[ \t]+(?:-\S+[ \t]+)*\S*(?:\w+://|\.\w{2,}/)|aria2c${NOT_WORD}|npx${NOT_WORD}|bunx${NOT_WORD}|`,
		String.raw`https?[ \t]+(?:-\S+[ \t]+)*(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD)[ \t]+)?[\w.:\[-]+(?:/|[ \t]|$))`,
	].join(""),
	"i",
);

const NOT_PROSE_AFTER_MAKE = String.raw`(?![ \t]+(?:sure|sense|it|a|an|the|this|that|these|those|your|my|our|changes?|progress|certain|them|do|any|no)\b)`;

/** A run step, in command position. */
const RUN_STEP_RE = new RegExp(
	[
		COMMAND_POSITION,
		"(?:",
		`${SHELL}${NOT_WORD}|`,
		`${INTERPRETER}${NOT_WORD}${NOT_JSON_TOOL}|`,
		String.raw`chmod\s+(?:-\w+\s+)*(?:[ugoa]*\+x|[0-7]?[1357][0-7]{2})\b|source${NOT_WORD}|eval${NOT_WORD}|exec${NOT_WORD}|`,
		String.raw`base64\s+(?:-d|--decode|-D)\b|iex${NOT_WORD}|`,
		String.raw`\.{1,2}/[\w.-]|\.[ \t]+\.{0,2}/[\w.-]|open[ \t]+(?:-\w+[ \t]+)*\S*[./~]\S*|`,
		String.raw`make${NOT_WORD}${NOT_PROSE_AFTER_MAKE}|(?:npm|pnpm|yarn|bun)[ \t]+(?:install|add|i)${NOT_WORD}|docker[ \t]+run${NOT_WORD}`,
		")",
	].join(""),
	"i",
);

const PIPE_TO_SHELL_RES = [
	new RegExp(
		String.raw`\|[ \t]*${WRAPPERS}${BIN_DIR}(?:${SHELL}${NOT_WORD}|${INTERPRETER}${NOT_WORD}${NOT_JSON_TOOL}|iex${NOT_WORD})`,
		"i",
	),
	/\b(?:ba|z|da)?sh\s+<\(\s*(?:curl|wget)\b/i,
	/\$\(\s*(?:curl|wget)\b/i,
	/\beval\s+(?:`|"?\$\()\s*(?:curl|wget)\b/i,
	/\/dev\/tcp\//i,
	/\bnc(?:at)?\s+(?:-[a-z]+\s+)*-e\b/i,
	/\bpowershell(?:\.exe)?\s+(?:-[a-z]+\s+)*-e(?:nc(?:odedcommand)?)?\b/i,
	/\b(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?\b[^\n]*\b(?:iex|invoke-expression)\b/i,
	/\biex\s*\(?\s*(?:iwr|irm|invoke-webrequest|new-object)\b/i,
	/\bpython[\d.]*\s+-c\b/i,
	/\b(?:node|deno)\s+(?:-e|--eval)\b/i,
	/\b(?:perl|ruby)\s+-e\b/i,
];

/** Where the earliest fetch tool in `folded` ends, or -1. */
function firstFetchEnd(folded: string): number {
	let end = -1;
	for (const re of [FETCH_ANYWHERE_RE, FETCH_COMMAND_RE]) {
		const m = re.exec(folded);
		if (m && (end === -1 || m.index + m[0].length < end)) end = m.index + m[0].length;
	}
	return end;
}

/** A fetch tool anywhere in the text, then a run step in command position anywhere after the first one. */
function fetchesAndRuns(folded: string): boolean {
	const end = firstFetchEnd(folded);
	if (end === -1) return false;
	// The marker keeps the start of the slice from counting as a command position.
	return RUN_STEP_RE.test(`\u0001${folded.slice(end)}`);
}

function hasPipeToShell(folded: string): boolean {
	return PIPE_TO_SHELL_RES.some((re) => re.test(folded)) || fetchesAndRuns(folded);
}

// ── commands the session never ran ───────────────────────────────────────────

const FENCE = "```";
const INLINE_CODE_RE = /`([^`\n]{2,300})`/g;
const DOLLAR_LINE_RE = /(?:^|\n)[ \t]*\$ ([^\n]+)/g;
const RUN_PHRASE_RE = new RegExp(
	String.raw`\b(?:run|execute|type|enter|invoke)[ \t]{0,3}:?[ \t]{1,3}((?:${[...COMMAND_VERBS].join("|")})[ \t]+[^\n;]{1,200})`,
	"gi",
);

/** Spans of `text` that read as a command: fenced lines, `$ ` lines, code spans, and "run <verb> ..." phrases. */
function commandSpans(folded: string): string[] {
	const spans: string[] = [];
	const parts = folded.split(FENCE);
	for (let i = 1; i < parts.length; i += 2) {
		const lines = (parts[i] as string).split("\n");
		const first = lines[0]?.trim() ?? "";
		const body = /^[\w+-]{0,12}$/.test(first) && lines.length > 1 ? lines.slice(1) : lines;
		for (const line of body) {
			const t = line.trim();
			if (t && !t.startsWith("#")) spans.push(t);
		}
	}
	const outside = parts.filter((_, i) => i % 2 === 0).join("\n");
	for (const m of outside.matchAll(DOLLAR_LINE_RE)) spans.push(m[1] as string);
	for (const m of outside.matchAll(INLINE_CODE_RE)) {
		const code = m[1] as string;
		// Any segment may carry the verb: `cat ~/.ssh/id_rsa | curl ...` is a command span.
		if (code.includes(" ") && segmentsOf(code).some((t) => COMMAND_VERBS.has(t[0] as string))) {
			spans.push(code);
		}
	}
	for (const m of outside.matchAll(RUN_PHRASE_RE))
		spans.push(trimTrailingPunctuation(m[1] as string));
	return spans;
}

/** A command that is only a check or a look: what an honest next step may name without the session having run it. */
function isBenign(tokens: string[]): boolean {
	const verb = tokens[0] as string;
	if (verb === "cd" || verb === "ls" || verb === "pwd") return true;
	if (verb === "docker" && ["ps", "images"].includes(tokens[1] ?? "")) return true;
	if (verb === "git" && READ_ONLY_GIT.has(tokens.find((t, i) => i > 0 && !t.startsWith("-")) ?? ""))
		return true;
	return classifyCommand(tokens.join(" ")).kind === "validation";
}

/**
 * A command segment the summary names that is not exactly a segment the session
 * ran. Whole-segment equality: `npm install evil-pkg` is not `npm install`, and
 * `rm -rf /` is not `rm -rf /tmp/build`. The only looseness is `isBenign` (a
 * fixed list of read-only forms and clean validations).
 */
function isUnrecorded(tokens: string[], records: RecordIndex): boolean {
	if (tokens.length < 2 || !COMMAND_VERBS.has(tokens[0] as string)) return false;
	if (isBenign(tokens)) return false;
	return !records.segments.has(segmentKey(tokens));
}

function hasUnrecordedCommand(folded: string, records: RecordIndex): boolean {
	for (const span of commandSpans(folded)) {
		for (const tokens of segmentsOf(span)) if (isUnrecorded(tokens, records)) return true;
	}
	return false;
}

// ── risky commands ───────────────────────────────────────────────────────────

/** Verbs that reach the network, run what they fetch, or delete and change things, whatever follows. */
const RISKY_VERBS = new Set([
	"curl",
	"wget",
	"iwr",
	"irm",
	"ssh",
	"scp",
	"nc",
	"ncat",
	"npx",
	"bunx",
	"chmod",
	"chown",
	"sudo",
	"rm",
	"dd",
	"crontab",
	"kill",
]);

/** Verbs that are risky only with one of these subcommands (`git status` is not, `git push` is). */
const RISKY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	git: new Set(["clone", "remote", "push", "pull", "fetch"]),
	npm: new Set(["add", "install", "i"]),
	pnpm: new Set(["add", "install", "i"]),
	yarn: new Set(["add", "install", "i"]),
	bun: new Set(["add", "install", "i"]),
	pip: new Set(["install"]),
	pip3: new Set(["install"]),
	go: new Set(["install"]),
	docker: new Set(["run", "pull"]),
	make: new Set(["install"]),
};

const LEADING_WRAPPERS = new Set([
	"env",
	"nohup",
	"time",
	"exec",
	"command",
	"nice",
	"xargs",
	"timeout",
]);

/** The tokens after leading assignments (`FOO=1`) and wrappers that only run what follows. */
function afterWrappers(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i] as string;
		const wrapper = LEADING_WRAPPERS.has(t);
		if (/^[A-Za-z_]\w*=/.test(t) || wrapper) i++;
		else if (i > 0 && (t.startsWith("-") || /^\d+$/.test(t))) i++;
		else break;
	}
	return tokens.slice(i);
}

const LOOPBACK_TOKEN_RE =
	/^(?:\w+:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const FETCH_TOOLS = new Set(["curl", "wget", "iwr", "irm"]);
const GIT_FORCE_RE = /^(?:--force(?:-with-lease|-if-includes)?(?:=.*)?|-[a-zA-Z]*f[a-zA-Z]*)$/;
const NETWORK_GIT = new Set(["push", "pull", "fetch"]);
const MANIFEST_INSTALLERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/**
 * Exception 1: a fetch tool whose every target is a loopback address (at least
 * one), with no upload from a file and no pipe or download-then-run in the span.
 * Any other host, a malformed address or an upload makes it risky as before.
 */
function isLoopbackOnly(tokens: string[], span: string, index: Index): boolean {
	const t = afterWrappers(tokens);
	if (!FETCH_TOOLS.has(t[0] as string)) return false;
	if (t.some((x) => x.startsWith("@") || x.includes("=@"))) return false;
	if (hasPipeToShell(span)) return false;
	let loopback = 0;
	for (const x of t.slice(1)) if (LOOPBACK_TOKEN_RE.test(x)) loopback++;
	if (loopback === 0) return false;
	const rest = t.slice(1).filter((x) => !LOOPBACK_TOKEN_RE.test(x));
	for (const c of candidates(rest.join(" "), true)) {
		if (c.malformed || !LOOPBACK_HOSTS.test(c.host)) return false;
	}
	for (const c of candidates(t.slice(1).join(" "), true)) if (c.malformed) return false;
	return urlFindings(rest.join(" "), index.typed, index.records, false).unexpected === false;
}

/** A path that stays inside the repository: relative, no `..`, no scheme, no home. */
const isRepoPath = (p: string): boolean =>
	p !== "" &&
	!p.startsWith("/") &&
	!p.startsWith("~") &&
	!p.includes(":") &&
	!p.split("/").includes("..");

/** Exception 2: an install that names no package, URL or outside path: `bun install`, `npm ci`, `pip install -r requirements.txt`, `pip install -e .`. */
function isManifestInstall(t: string[]): boolean {
	const verb = t[0] as string;
	const args = t.slice(1);
	if (MANIFEST_INSTALLERS.has(verb)) {
		const sub = args.find((x) => !x.startsWith("-"));
		if (sub !== "install" && sub !== "i" && sub !== "ci") return false;
		return args.every((x) => x === sub || (x.startsWith("-") && !/[/:]/.test(x)));
	}
	if (verb !== "pip" && verb !== "pip3") return false;
	if (args[0] !== "install") return false;
	let sawManifest = false;
	for (let i = 1; i < args.length; i++) {
		const x = args[i] as string;
		if (x === "-r" || x === "--requirement") {
			if (!isRepoPath(args[++i] ?? "")) return false;
			sawManifest = true;
		} else if (x.startsWith("--requirement=")) {
			if (!isRepoPath(x.slice("--requirement=".length))) return false;
			sawManifest = true;
		} else if (x === "-e" || x === "--editable") {
			const target = args[++i];
			if (target !== "." && target !== "./") return false;
			sawManifest = true;
		} else if (!x.startsWith("-") || /[/:]/.test(x)) return false;
	}
	return sawManifest;
}

/** The git subcommand, past global options; `config` is set when a `-c` override came first. */
function gitSub(t: string[]): { sub: string | undefined; override: boolean; rest: string[] } {
	let override = false;
	for (let i = 1; i < t.length; i++) {
		const x = t[i] as string;
		if (x === "-c") {
			override = true;
			i++;
		} else if (x === "-C") i++;
		else if (!x.startsWith("-")) return { sub: x, override, rest: t.slice(i + 1) };
	}
	return { sub: undefined, override, rest: [] };
}

/** Exception 3: push, pull or fetch to a plain remote name (or the default), with no force. */
function isNamedRemoteGit(t: string[]): boolean {
	const { sub, override, rest } = gitSub(t);
	if (override || sub === undefined || !NETWORK_GIT.has(sub)) return false;
	if (rest.some((x) => GIT_FORCE_RE.test(x) || x.startsWith("+"))) return false;
	const remote = rest.find((x) => !x.startsWith("-"));
	return remote === undefined || !/[:/@.\\]/.test(remote);
}

function isRiskyCommand(tokens: string[], span: string, index: Index): boolean {
	const t = afterWrappers(tokens);
	const verb = t[0];
	if (!verb) return false;
	if (verb === "git") {
		const { sub, override } = gitSub(t);
		if (override) return true;
		if (sub === undefined || !RISKY_SUBCOMMANDS.git?.has(sub)) return false;
		return !(NETWORK_GIT.has(sub) && isNamedRemoteGit(t));
	}
	if (RISKY_VERBS.has(verb)) return !isLoopbackOnly(tokens, span, index);
	const subs = RISKY_SUBCOMMANDS[verb];
	if (!subs) return false;
	const sub = t.slice(1).find((x) => !x.startsWith("-"));
	if (sub === undefined || !subs.has(sub)) return false;
	return !isManifestInstall(t);
}

/**
 * An address the user never typed, or (in the sections Copy handoff emits) a
 * command the session never ran, inside a command whose verb is risky. A segment
 * the session ran exactly is not risky.
 */
function hasRiskyCommand(folded: string, index: Index, emitsHandoff: boolean): boolean {
	for (const span of commandSpans(folded)) {
		for (const tokens of segmentsOf(span)) {
			if (!isRiskyCommand(tokens, span, index) || index.records.segments.has(segmentKey(tokens)))
				continue;
			if (urlFindings(segmentKey(tokens), index.typed, index.records, false).unexpected)
				return true;
			if (emitsHandoff && isUnrecorded(tokens, index.records)) return true;
		}
	}
	return false;
}

// ── the rules together ───────────────────────────────────────────────────────

interface Index {
	typed: TypedUrls;
	records: RecordIndex;
}

function indexOfContext(ctx: TripwireContext): Index {
	return { typed: indexTyped(ctx.userPromptUrls), records: indexRecords(ctx) };
}

function scan(text: string, index: Index, emitsHandoff: boolean): SummarySuspectReason[] {
	const found = new Set(scanFolded(fold(text), index, emitsHandoff));
	if (text.includes("\u2800")) {
		for (const r of scanFolded(fold(text, " "), index, emitsHandoff)) found.add(r);
	}
	return SUMMARY_SUSPECT_REASONS.filter((reason) => found.has(reason));
}

function scanFolded(folded: string, index: Index, emitsHandoff: boolean): SummarySuspectReason[] {
	const reasons: SummarySuspectReason[] = [];
	const urls = urlFindings(folded, index.typed, index.records, emitsHandoff);
	if (hasRoleMarker(folded)) reasons.push("role_marker");
	if (OVERRIDE_PHRASE_RES.some((re) => re.test(folded))) reasons.push("override_phrase");
	if (urls.unexpected) reasons.push("unexpected_url");
	if (urls.malformed) reasons.push("malformed_url");
	if (hasPipeToShell(folded)) reasons.push("pipe_to_shell");
	if (emitsHandoff && hasUnrecordedCommand(folded, index.records)) {
		reasons.push("unrecorded_command");
	}
	if (hasRiskyCommand(folded, index, emitsHandoff)) reasons.push("risky_command");
	return reasons;
}

/** Reason codes for one string. `checkCommands` is true for the sections Copy handoff emits. */
export function checkText(
	text: string,
	ctx: TripwireContext,
	opts: { checkCommands?: boolean } = {},
): SummarySuspectReason[] {
	return scan(text, indexOfContext(ctx), opts.checkCommands === true);
}

/** A fetch in one field and its run step in a later one: the text a copy action emits, in its order. */
function fetchesAndRunsAcross(fields: readonly string[]): boolean {
	for (const brailleAs of ["", " "]) {
		if (brailleAs === " " && !fields.some((f) => f.includes("\u2800"))) continue;
		if (fetchesAndRuns(fields.map((f) => fold(f, brailleAs)).join("\n"))) return true;
	}
	return false;
}

/**
 * Every string field is scanned for every rule that runs on text. The sections
 * Copy handoff emits (outcome explanation, unfinished work, next actions and the
 * handoff itself) are also judged for commands the session never ran and for
 * loopback addresses. The download-then-run rule also runs over what each copy
 * action emits, joined in order: Copy handoff as above, Copy summary as every
 * section, so a fetch and its run step cannot hide in two fields.
 */
export function runTripwire(summary: SessionSummary, ctx: TripwireContext): SummarySuspectReason[] {
	const index = indexOfContext(ctx);
	const unfinished = summary.unfinished.map((i) => i.text);
	const nextActions = summary.nextActions.map((i) => i.text);
	const problems = summary.problems.map((i) => i.text);
	const decisions = summary.decisions.flatMap((i) => [i.text, i.why]);
	const validation = summary.validation.flatMap((i) => [i.what, i.detail]);
	const accomplishments = summary.accomplishments.map((i) => i.text);
	const changes = summary.changes.map((i) => i.text);

	const plain = [
		summary.overview,
		...accomplishments,
		...changes,
		...decisions,
		...validation,
		...problems,
	];
	const emittedByHandoff = [
		summary.outcome.explanation,
		...unfinished,
		...nextActions,
		summary.handoff,
	];
	const emittedBySummary = [
		summary.overview,
		summary.outcome.explanation,
		...accomplishments,
		...changes,
		...decisions,
		...validation,
		...problems,
		...unfinished,
		...nextActions,
		summary.handoff,
	];
	const found = new Set<SummarySuspectReason>();
	for (const text of plain) for (const r of scan(text, index, false)) found.add(r);
	for (const text of emittedByHandoff) for (const r of scan(text, index, true)) found.add(r);
	if (fetchesAndRunsAcross(emittedByHandoff) || fetchesAndRunsAcross(emittedBySummary)) {
		found.add("pipe_to_shell");
	}
	return SUMMARY_SUSPECT_REASONS.filter((reason) => found.has(reason));
}
