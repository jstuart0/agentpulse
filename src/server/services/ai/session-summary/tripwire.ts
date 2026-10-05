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
import { type RealCommand, classifyCommand, realCommandsOf } from "./command-class.js";

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
	"env",
	"nohup",
	"timeout",
	"uv",
	"poetry",
	"gem",
	"composer",
	"invoke-webrequest",
	"invoke-restmethod",
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
		let value = (m[2] ?? "").trim();
		if (value === "") {
			// The instruction may sit on the next non-blank line: judge that as the value.
			value = (/^\s*([^\n]*)/.exec(folded.slice(m.index + m[0].length))?.[1] ?? "").trim();
		}
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
		String.raw`(?:fetch[ \t]+(?:-\S+[ \t]+)*[^\s/:]*(?::\/\/|\.\w{2,}\/)|aria2c${NOT_WORD}|npx${NOT_WORD}|bunx${NOT_WORD}|`,
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

/** A fetch tool and a run step anywhere in the text, in either order: a copy payload that carries both. */
function fetchAndRunInAnyOrder(folded: string): boolean {
	return firstFetchEnd(folded) !== -1 && RUN_STEP_RE.test(folded);
}

function hasPipeToShell(folded: string): boolean {
	return PIPE_TO_SHELL_RES.some((re) => re.test(folded)) || fetchesAndRuns(folded);
}

// ── commands the session never ran ───────────────────────────────────────────

const FENCE = "```";
const INLINE_CODE_RE = /`([^`\n]{2,300})`/g;
const DOLLAR_LINE_RE = /(?:^|\n)[ \t]*\$ ([^\n]+)/g;
const RUN_PHRASE_RE = new RegExp(
	String.raw`\b(?:run|execute|type|enter|invoke)[ \t]{0,3}:?[ \t]{1,3}((?:[A-Za-z_]\w*=\S+[ \t]+){0,4}(?:${[...COMMAND_VERBS].join("|")})[ \t]+[^\n;]{1,200})`,
	"gi",
);

// ── how a command segment is read ────────────────────────────────────────────

interface SegView {
	key: string;
	cmds: RealCommand[];
}

/**
 * A segment as the classifier's parser reads it: the commands it really runs,
 * past wrappers, quoting and flag values. What the parser cannot read is one
 * opaque command judged by its first word. Cached per scan.
 */
function viewOf(tokens: string[], cache: Map<string, SegView>): SegView {
	const key = segmentKey(tokens);
	const hit = cache.get(key);
	if (hit) return hit;
	const cmds = realCommandsOf(key) ?? [
		{ words: tokens, wrappers: [], assigned: false, opaque: true },
	];
	const view = { key, cmds };
	cache.set(key, view);
	return view;
}

/** The verb of a command, lowercase: the leading name of its first word, whatever quoting or expansion follows it. */
function verbOf(cmd: RealCommand): string {
	const head = (cmd.words[0] ?? "").replace(/^[\\"'`$({]+/, "");
	const base = head.slice(head.lastIndexOf("/") + 1);
	return (/^[A-Za-z][\w.+-]*/.exec(base)?.[0] ?? "").toLowerCase();
}

/** Verbs whose first operand is a subcommand that fetches, installs, runs or changes things. */
const RISKY_VERBS = new Set([
	"curl",
	"wget",
	"iwr",
	"irm",
	"invoke-webrequest",
	"invoke-restmethod",
	"ssh",
	"scp",
	"nc",
	"ncat",
	"npx",
	"bunx",
	"pipx",
	"uv",
	"chmod",
	"chown",
	"sudo",
	"doas",
	"rm",
	"dd",
	"crontab",
	"kill",
	// wrappers the parser does not look through: what they run cannot be read
	"strace",
	"ltrace",
	"flock",
	"watch",
	"stdbuf",
	"unbuffer",
	"chroot",
	"nsenter",
	"parallel",
	"su",
	"script",
	"busybox",
	"fish",
]);
/** Wrappers whose presence alone makes the command risky. */
const RISKY_WRAPPERS = new Set(["sudo", "doas", "ssh"]);

const isHeadVerb = (v: string): boolean => COMMAND_VERBS.has(v) || RISKY_VERBS.has(v);
const isCommandCmd = (cmd: RealCommand): boolean => [...cmd.wrappers, verbOf(cmd)].some(isHeadVerb);

/** A command that is only a check or a look, with nothing hidden in front of it or inside it. */
function isBenignCmd(cmd: RealCommand): boolean {
	return (
		!cmd.opaque &&
		!cmd.assigned &&
		cmd.wrappers.length === 0 &&
		cmd.words.every((w) => !/\s/.test(w)) &&
		isBenign(cmd.words)
	);
}

/** Fence labels whose block is a shell session: every line in it is a command whatever its verb. */
const SHELL_FENCE_LABELS = new Set([
	"",
	"sh",
	"bash",
	"zsh",
	"shell",
	"console",
	"terminal",
	"shell-session",
	"powershell",
	"ps1",
	"bat",
]);

interface Span {
	text: string;
	/** Every segment is a command (a shell fence, a `$ ` line); otherwise only a segment with a command verb is. */
	structural: boolean;
}

/** Spans of `text` that read as a command: fenced lines, `$ ` lines, code spans, and "run <verb> ..." phrases. */
function commandSpans(folded: string, cache: Map<string, SegView>): Span[] {
	const spans: Span[] = [];
	const parts = folded.split(FENCE);
	for (let i = 1; i < parts.length; i += 2) {
		const lines = (parts[i] as string).split("\n");
		const first = lines[0]?.trim() ?? "";
		const labelled = /^[\w+-]{0,12}$/.test(first) && lines.length > 1;
		const body = labelled ? lines.slice(1) : lines;
		const structural = SHELL_FENCE_LABELS.has(labelled ? first.toLowerCase() : "");
		for (const line of body) {
			const t = line.trim();
			if (t && !t.startsWith("#")) spans.push({ text: t, structural });
		}
	}
	const outside = parts.filter((_, i) => i % 2 === 0).join("\n");
	for (const m of outside.matchAll(DOLLAR_LINE_RE))
		spans.push({ text: m[1] as string, structural: true });
	for (const m of outside.matchAll(INLINE_CODE_RE)) {
		const code = m[1] as string;
		// Any segment may carry the verb: `cat ~/.ssh/id_rsa | curl ...` is a command span. A
		// single word counts only when it hides its verb (`rm${IFS}-rf`).
		const cmds = segmentsOf(code).flatMap((t) => viewOf(t, cache).cmds);
		if (cmds.some((c) => isCommandCmd(c) && (code.includes(" ") || c.opaque))) {
			spans.push({ text: code, structural: false });
		}
	}
	for (const m of outside.matchAll(RUN_PHRASE_RE))
		spans.push({ text: trimTrailingPunctuation(m[1] as string), structural: false });
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
 * `rm -rf /` is not `rm -rf /tmp/build`. The only looseness is `isBenignCmd` (a
 * fixed list of read-only forms and clean validations). What the parser cannot
 * read (an expansion, a quoted verb) is always a command when its verb is known.
 */
function isUnrecorded(view: SegView, records: RecordIndex): boolean {
	if (records.segments.has(view.key)) return false;
	for (const cmd of view.cmds) {
		if (!isCommandCmd(cmd)) continue;
		if (!cmd.opaque && cmd.words.length + cmd.wrappers.length < 2) continue;
		if (isBenignCmd(cmd)) continue;
		return true;
	}
	return false;
}

function hasUnrecordedCommand(folded: string, index: Index): boolean {
	for (const span of commandSpans(folded, index.segCache)) {
		for (const tokens of segmentsOf(span.text)) {
			if (isUnrecorded(viewOf(tokens, index.segCache), index.records)) return true;
		}
	}
	return false;
}

// ── risky commands ───────────────────────────────────────────────────────────

/** Verbs that are risky only with one of these subcommands (`git status` is not, `git push` is). */
const RISKY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	git: new Set(["clone", "remote", "push", "pull", "fetch"]),
	npm: new Set(["add", "install", "i", "ci"]),
	pnpm: new Set(["add", "install", "i", "ci"]),
	yarn: new Set(["add", "install", "i", "ci"]),
	bun: new Set(["add", "install", "i", "ci"]),
	pip: new Set(["install"]),
	pip3: new Set(["install"]),
	go: new Set(["get", "install"]),
	docker: new Set(["run", "pull"]),
	make: new Set(["install"]),
	cargo: new Set(["install"]),
	poetry: new Set(["add"]),
	gem: new Set(["install"]),
	composer: new Set(["require"]),
	brew: new Set(["install", "tap"]),
	apt: new Set(["install"]),
	"apt-get": new Set(["install"]),
	yum: new Set(["install"]),
	dnf: new Set(["install"]),
	deno: new Set(["run", "install"]),
};

const LOOPBACK_TOKEN_RE =
	/^(?:\w+:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#]\S*)?$/i;
/** curl and wget only: PowerShell's web cmdlets take other parameters, so they never get the exception. */
const FETCH_TOOLS = new Set(["curl", "wget"]);
const NETWORK_GIT = new Set(["push", "pull", "fetch"]);
const MANIFEST_INSTALLERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/** A path that stays inside the repository: relative, no `..`, no scheme, no home. */
const isRepoPath = (p: string): boolean =>
	p !== "" &&
	!p.startsWith("/") &&
	!p.startsWith("~") &&
	!p.includes(":") &&
	!p.split("/").includes("..");

const LONG_WRITE_FLAG_RE =
	/^--(?:data(?:-[a-z]+)?|json|form(?:-string)?|upload-file|post-data|post-file|body-data|body-file|cookie-jar)(?:=|$)/;
const OUTPUT_LONG_FLAGS = new Set(["--output", "--output-document", "--output-file"]);
/** Flags that read the request from elsewhere, follow redirects, or change where it goes. */
const REDIRECTING_LONG_FLAGS = new Set([
	"--config",
	"--next",
	"--location",
	"--location-trusted",
	"--url",
	"--unix-socket",
	"--directory-prefix",
	"--input-file",
]);
/** Long flags that take their value as the next word (so it is not a positional address). */
const VALUE_LONG_FLAGS = new Set([
	"--request",
	"--method",
	"--output",
	"--output-document",
	"--output-file",
	"--write-out",
	"--header",
	"--user-agent",
	"--max-time",
	"--connect-timeout",
	"--retry",
	"--timeout",
	"--tries",
	"--referer",
	"--user",
	"--cookie",
]);
const READ_METHODS = new Set(["GET", "HEAD"]);
/** Short flags that send a body or an upload, or write a cookie jar (curl `-d -F -T -c`). */
const BODY_LETTERS = "dFTc";
/** Short flags that read a config, follow redirects, use a proxy or set a directory (`-K -L -x -P`). */
const REDIRECTING_LETTERS = "KLxP";
/** Short flags that take a value, so they end a cluster. */
const VALUE_LETTERS = "XoOwHAuebmxKErUz";

/** Where a fetch may write its response: stdout, the null device, or a relative path in the working directory. */
const isSafeOutput = (target: string): boolean =>
	target === "-" || target === "/dev/null" || isRepoPath(target);

/**
 * True when a curl or wget argument list is not a plain read: a method other than
 * GET or HEAD (also by header override), any request body or upload, a cookie jar,
 * a config or redirect or proxy or directory flag, or output written anywhere but
 * stdout, /dev/null or a relative path.
 */
function writesOrSends(verb: string, args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const x = args[i] as string;
		if (x === "--request" || x === "--method") {
			if (!READ_METHODS.has((args[i + 1] ?? "").toUpperCase())) return true;
			continue;
		}
		if (x.startsWith("--request=") || x.startsWith("--method=")) {
			if (!READ_METHODS.has(x.slice(x.indexOf("=") + 1).toUpperCase())) return true;
			continue;
		}
		const long = x.split("=")[0] as string;
		if (LONG_WRITE_FLAG_RE.test(x) || REDIRECTING_LONG_FLAGS.has(long) || x.startsWith("--proxy"))
			return true;
		if (
			long === "--header" &&
			/^x-http-method/i.test(x.includes("=") ? x.slice(x.indexOf("=") + 1) : (args[i + 1] ?? ""))
		)
			return true;
		if (OUTPUT_LONG_FLAGS.has(long)) {
			const target = x.includes("=") ? x.slice(x.indexOf("=") + 1) : (args[i + 1] ?? "");
			if (!isSafeOutput(target)) return true;
			continue;
		}
		if (!/^-[A-Za-z]/.test(x) || x.startsWith("--")) continue;
		// A short-flag cluster is read letter by letter; a value letter ends it (the rest is its value).
		const letters = x.slice(1);
		for (let k = 0; k < letters.length; k++) {
			const letter = letters[k] as string;
			if (BODY_LETTERS.includes(letter) || REDIRECTING_LETTERS.includes(letter)) return true;
			if (letter === "i" && verb === "wget") return true;
			if (!VALUE_LETTERS.includes(letter)) continue;
			const given = letters.slice(k + 1) || (args[i + 1] ?? "");
			if (letter === "X" && !READ_METHODS.has(given.toUpperCase())) return true;
			if ((letter === "o" || letter === "O") && !isSafeOutput(given)) return true;
			if (letter === "H" && /^x-http-method/i.test(given)) return true;
			break;
		}
	}
	return false;
}

/** The words of a curl or wget command line that are addresses or files, not flags or flag values. */
function positionals(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const x = args[i] as string;
		if (!x.startsWith("-")) {
			out.push(x);
			continue;
		}
		if (x.startsWith("--")) {
			if (!x.includes("=") && VALUE_LONG_FLAGS.has(x)) i++;
			continue;
		}
		const letters = x.slice(1);
		for (let k = 0; k < letters.length; k++) {
			if (!VALUE_LETTERS.includes(letters[k] as string)) continue;
			if (letters.slice(k + 1) === "") i++;
			break;
		}
	}
	return out;
}

/**
 * Exception 1: curl or wget whose every address is a loopback one (at least one),
 * doing a plain read: no body, upload, non-GET method, redirect, proxy, config or
 * write outside the working directory (the Docker API and this app's own API are
 * on loopback), no word that is not itself a loopback address, and no pipe or
 * download-then-run in the span. Anything else makes it risky.
 */
function isLoopbackOnly(verb: string, args: string[], spanPiped: () => boolean): boolean {
	if (!FETCH_TOOLS.has(verb)) return false;
	if (args.some((x) => x.startsWith("@") || x.includes("=@"))) return false;
	if (writesOrSends(verb, args)) return false;
	const where = positionals(args);
	if (where.length === 0 || !where.every((x) => LOOPBACK_TOKEN_RE.test(x))) return false;
	return !spanPiped();
}

/** Install flags that cannot point at another registry, index, prefix or script. */
const NODE_INSTALL_FLAGS = new Set([
	"--frozen-lockfile",
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
	"--silent",
	"--production",
	"--prod",
	"--legacy-peer-deps",
	"--prefer-offline",
	"-q",
]);
const PIP_INSTALL_FLAGS = new Set(["--no-deps", "--quiet", "-q"]);

/**
 * Exception 2: an install that names no package, URL or outside path and carries
 * only allowlisted flags: `bun install`, `npm ci`, `pip install -r requirements.txt`,
 * `pip install -e .`.
 */
function isManifestInstall(verb: string, args: string[]): boolean {
	if (MANIFEST_INSTALLERS.has(verb)) {
		const sub = args.find((x) => !x.startsWith("-"));
		if (sub !== "install" && sub !== "i" && sub !== "ci") return false;
		return args.every((x) => x === sub || NODE_INSTALL_FLAGS.has(x));
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
		} else if (!PIP_INSTALL_FLAGS.has(x)) return false;
	}
	return sawManifest;
}

/** The git subcommand; `globals` is set when any option came before it, `override` for a `-c`. */
function gitSub(args: string[]): {
	sub: string | undefined;
	override: boolean;
	globals: boolean;
	rest: string[];
} {
	let override = false;
	let globals = false;
	for (let i = 0; i < args.length; i++) {
		const x = args[i] as string;
		if (x === "-c") {
			override = true;
			globals = true;
			i++;
		} else if (x === "-C") {
			globals = true;
			i++;
		} else if (x.startsWith("-")) globals = true;
		else return { sub: x, override, globals, rest: args.slice(i + 1) };
	}
	return { sub: undefined, override, globals, rest: [] };
}

const GIT_ALLOWED_FLAGS = new Set([
	"--rebase",
	"--ff-only",
	"--no-rebase",
	"--tags",
	"-u",
	"--set-upstream",
	"-q",
	"--quiet",
	"-v",
]);
const REMOTE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const REF_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/**
 * Exception 3: `git push|pull|fetch` with no option before the subcommand, whose
 * every remaining token is an allowlisted flag or a plain name: at most one remote
 * (letters, digits, `_`, `-`) and one ref (no `:`, not `refs/`, not `+`). `--delete`,
 * `-d`, `--mirror`, `--prune`, `--force*`, `-f`, `--all` (but for fetch) and every
 * refspec with a colon are out.
 */
function isNamedRemoteGit(sub: string, rest: string[]): boolean {
	if (!NETWORK_GIT.has(sub)) return false;
	const operands: string[] = [];
	for (const x of rest) {
		if (!x.startsWith("-")) operands.push(x);
		else if (!(GIT_ALLOWED_FLAGS.has(x) || (x === "--all" && sub === "fetch"))) return false;
	}
	if (operands.length > 2) return false;
	const [remote, ref] = operands;
	if (remote !== undefined && !REMOTE_NAME_RE.test(remote)) return false;
	return ref === undefined || (REF_NAME_RE.test(ref) && !ref.startsWith("refs/"));
}

const GIT_READ_CONFIG_FLAGS = new Set([
	"--get",
	"--get-all",
	"--get-regexp",
	"--get-urlmatch",
	"-l",
	"--list",
]);
const PACKAGE_CONFIG_WRITES = new Set(["set", "delete", "edit", "unset"]);
const CONFIG_TOOLS = new Set(["npm", "yarn", "pnpm", "pip", "pip3"]);

/** Whether one command is risky by what it is: opaque, wrapped in sudo or ssh, or a risky verb that no exception clears. */
function isRiskyCmd(cmd: RealCommand, spanPiped: () => boolean): boolean {
	if (cmd.opaque || cmd.wrappers.some((w) => RISKY_WRAPPERS.has(w))) return true;
	let verb = verbOf(cmd);
	let args = cmd.words.slice(1);
	// `python -m pip install ...` is pip.
	if (
		/^python[\d.]*$/.test(verb) &&
		args[0] === "-m" &&
		(args[1] === "pip" || args[1] === "pip3")
	) {
		verb = args[1];
		args = args.slice(2);
	}
	const assigned = cmd.assigned;
	if (verb === "git") {
		const { sub, override, globals, rest } = gitSub(args);
		if (override) return true;
		// Any form of `git config` that does not read is a write (core.hooksPath, core.sshCommand, ...).
		if (sub === "config") return !rest.some((x) => GIT_READ_CONFIG_FLAGS.has(x));
		if (sub === undefined || !RISKY_SUBCOMMANDS.git?.has(sub)) return false;
		return assigned || globals || !isNamedRemoteGit(sub, rest);
	}
	if (RISKY_VERBS.has(verb)) return assigned || !isLoopbackOnly(verb, args, spanPiped);
	const operands = args.filter((x) => !x.startsWith("-"));
	if (
		CONFIG_TOOLS.has(verb) &&
		operands[0] === "config" &&
		PACKAGE_CONFIG_WRITES.has(operands[1] ?? "")
	)
		return true;
	const subs = RISKY_SUBCOMMANDS[verb];
	if (!subs) return false;
	const sub = operands[0];
	if (sub === undefined || !subs.has(sub)) return false;
	return assigned || !isManifestInstall(verb, args);
}

/**
 * Risky when a command carries an address the user never typed (or a malformed
 * one), whatever its verb, unless it is a check or a look; and, in the sections
 * Copy handoff emits, when it is a command the session never ran whose verb is
 * risky or whose text cannot be read. A segment the session ran exactly is never
 * risky. The pipe check is made once per span. A span counts when it is a shell
 * block or a `$ ` line, or when one of its commands has a command verb.
 */
function hasRiskyCommand(folded: string, index: Index, emitsHandoff: boolean): boolean {
	for (const span of commandSpans(folded, index.segCache)) {
		let piped: boolean | undefined;
		const spanPiped = () => {
			piped ??= hasPipeToShell(span.text);
			return piped;
		};
		for (const tokens of segmentsOf(span.text)) {
			const view = viewOf(tokens, index.segCache);
			if (index.records.segments.has(view.key)) continue;
			if (!span.structural && !view.cmds.some(isCommandCmd)) continue;
			const urls = urlFindings(view.key, index.typed, index.records, false);
			const addressed = urls.unexpected || urls.malformed;
			for (const cmd of view.cmds) {
				if (isBenignCmd(cmd)) continue;
				if (addressed) return true;
				if (emitsHandoff && isRiskyCmd(cmd, spanPiped) && isUnrecorded(view, index.records))
					return true;
			}
		}
	}
	return false;
}

// ── the rules together ───────────────────────────────────────────────────────

interface Index {
	typed: TypedUrls;
	records: RecordIndex;
	/** Command segments as the parser read them, once per scan. */
	segCache: Map<string, SegView>;
}

function indexOfContext(ctx: TripwireContext): Index {
	return {
		typed: indexTyped(ctx.userPromptUrls),
		records: indexRecords(ctx),
		segCache: new Map(),
	};
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
	if (emitsHandoff && hasUnrecordedCommand(folded, index)) {
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
		if (fetchAndRunInAnyOrder(fields.map((f) => fold(f, brailleAs)).join("\n"))) return true;
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
