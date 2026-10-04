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

/** Product names whose "TLD" is part of the name; accepted as names, not hosts (decision recorded in the test). */
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
	/** A shape no honest summary has: backslash or percent in the authority, `javascript:`, unparsable. */
	suspect: boolean;
	/** The token as written (lowercase, no scheme), for the ledger-path comparison. */
	token: string;
}

const LOOPBACK_HOSTS = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/;

/** Parses one candidate with the URL parser (a scheme is added when missing) and compares `hostname`. */
function parseCandidate(rawIn: string, hasScheme: boolean): Candidate | null {
	const raw = trimTrailingPunctuation(rawIn.slice(0, MAX_CANDIDATE));
	if (!raw) return null;
	const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	const authorityEnd = withoutScheme.search(/[/?#]/);
	const authority = authorityEnd === -1 ? withoutScheme : withoutScheme.slice(0, authorityEnd);
	if (!authority) return null;
	const suspect = /[\\%]/.test(authority);
	let url: URL;
	try {
		url = new URL(hasScheme ? raw : `http://${raw}`);
	} catch {
		return { host: authority.toLowerCase(), path: "", bare: !hasScheme, suspect: true, token: raw };
	}
	const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
	if (!host) return null;
	return {
		host,
		path: url.pathname.replace(/\/+$/, ""),
		bare: !hasScheme,
		suspect,
		token: withoutScheme.replace(/[?#].*$/, "").toLowerCase(),
	};
}

const tldOf = (host: string): string => host.slice(host.lastIndexOf(".") + 1);

function opaqueCandidate(raw: string): Candidate {
	return { host: raw.slice(0, 24).toLowerCase(), path: "", bare: false, suspect: true, token: raw };
}

function candidates(folded: string, includeBareHosts: boolean): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>();
	const push = (c: Candidate | null, hostOnly = false) => {
		if (!c) return;
		const id = `${c.host}${c.path}|${hostOnly}|${c.suspect}`;
		if (seen.has(id)) return;
		seen.add(id);
		out.push(c);
	};
	const bareAllowed = (c: Candidate | null): Candidate | null => {
		if (!c) return null;
		if (PRODUCT_NAMES.has(c.host)) return null;
		const tld = tldOf(c.host);
		const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(c.host);
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
 * past the cut is not seen here and raises `unexpected_url` (a warning, the
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

/** Verbs whose second word is a subcommand: `git push` and `git pull` are different commands. */
const SUBCOMMAND_VERBS = new Set([
	"git",
	"bun",
	"npm",
	"pnpm",
	"yarn",
	"docker",
	"kubectl",
	"cargo",
	"go",
	"pip",
	"pip3",
	"make",
	"gh",
	"helm",
	"terraform",
	"systemctl",
	"brew",
	"apt",
	"apt-get",
]);

/** Command words that make a code span or a "run ..." phrase read as a command. */
const COMMAND_VERBS = new Set([
	"curl",
	"wget",
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

/** Segments of a command line that name a command with arguments, as `[verb, rest...]` token lists. */
function segmentsOf(command: string): string[][] {
	return command
		.split(COMMAND_SPLIT_RE)
		.map((s) => squash(s).replace(/^\$ /, "").split(" "))
		.filter((tokens) => tokens.length > 0 && tokens[0] !== "");
}

/** Verbs whose `run` subcommand takes a script name: `bun run build` and `bun run db:generate` differ. */
const SCRIPT_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

function headOf(tokens: string[]): string {
	const verb = tokens[0] as string;
	if (SUBCOMMAND_VERBS.has(verb)) {
		const operands = tokens.slice(1).filter((t) => !t.startsWith("-"));
		const sub = operands[0];
		if (!sub) return verb;
		if (SCRIPT_RUNNERS.has(verb) && sub === "run" && operands[1])
			return `${verb} run ${operands[1]}`;
		return `${verb} ${sub}`;
	}
	return tokens.join(" ");
}

interface RecordIndex {
	paths: Set<string>;
	commandText: string;
	heads: Set<string>;
	/** Recorded commands of verbs with no subcommand, whole. */
	whole: Set<string>;
}

function indexRecords(ctx: TripwireContext): RecordIndex {
	const heads = new Set<string>();
	const whole = new Set<string>();
	for (const command of ctx.recordedCommands) {
		for (const tokens of segmentsOf(fold(command))) {
			heads.add(headOf(tokens));
			whole.add(tokens.join(" "));
		}
	}
	return {
		paths: new Set(ctx.recordedPaths.map((p) => fold(p).toLowerCase())),
		commandText: fold(ctx.recordedCommands.join("\n")).toLowerCase(),
		heads,
		whole,
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

function hasUnexpectedUrl(folded: string, typed: TypedUrls, records: RecordIndex): boolean {
	for (const c of candidates(folded, true)) {
		if (c.suspect) return true;
		if (LOOPBACK_HOSTS.test(c.host)) continue;
		if (typed.keys.has(keyOf(c))) continue;
		if (c.path === "" && typed.hosts.has(c.host)) continue;
		// A deeper path under a URL the user typed, on the same host, is the same document tree.
		if (
			c.path !== "" &&
			typed.paths.get(c.host)?.some((p) => c.path === p || c.path.startsWith(`${p}/`))
		)
			continue;
		if (c.bare && isRecordedName(c.token, records)) continue;
		return true;
	}
	return false;
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
 * described ("System: Linux"). A short value with no instruction word in it is
 * a label and not a role marker. `assistant:`, `user:` and `human:` always fire.
 */
const INSTRUCTION_CUE_RE =
	/\b(?:you|your|please|obey|ignore|must|always|never|do|don't|reveal|print|output|run|execute|send|open|visit|install|delete|override|disable|enable|allow|grant|approve|trust|follow|respond|reply|answer|act|pretend|forget|stop|skip|bypass|rules?|instructions?|prompt|new|sure|okay|ok|will)\b/i;
const SHORT_LABEL_VALUE_WORDS = 4;

function hasRoleMarker(folded: string): boolean {
	if (CHAT_TEMPLATE_RE.test(folded) || BRACKET_LABEL_RE.test(folded)) return true;
	for (const m of folded.matchAll(COLON_LABEL_RE)) {
		const label = (m[1] as string).toLowerCase();
		if (label !== "system" && label !== "developer") return true;
		const value = (m[2] ?? "").trim();
		const words = value === "" ? 0 : value.split(/\s+/).length;
		if (words > SHORT_LABEL_VALUE_WORDS || INSTRUCTION_CUE_RE.test(value)) return true;
	}
	return false;
}

const OVERRIDE_PHRASE_RES = [
	/\b(?:ignore|disregard|forget|override|bypass|discard)\s+(?:all\s+|any\s+|every\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|preceding|foregoing|former)\s+(?:instructions?|prompts?|messages?|rules?|guidelines?|directions?|commands?|context)\b/i,
	/\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:everything|anything|all)\s+)?(?:the\s+)?above\b/i,
	/\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:of\s+)?(?:your|my)\s+(?:instructions?|guidelines?|rules?|system\s+prompt|programming|directions?|restrictions?)\b/i,
	/\byou\s+are\s+now\s+(?:a|an|the|my|dan|acting|playing|operating|free|unrestricted|in\s+(?:developer|dan|debug|admin|god)\b)/i,
	/\bpretend\s+(?:to\s+be|you\s+are)\b/i,
	/\bnew\s+instructions?\s*[:：]/i,
	/\b(?:your|following|these)\s+new\s+instructions?\b/i,
	/\bfrom\s+now\s+on,?\s+(?:you|your|always|never|ignore|respond|reply|answer|say|obey|only|do\s+not|don't|must|every)\b/i,
];

// ── fetch and run ────────────────────────────────────────────────────────────

const FETCH_RE = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|git\s+clone)\b/i;

const INTERPRETER = String.raw`(?:python[\d.]*|node|perl|ruby|php|pwsh|powershell(?:\.exe)?)`;
const SHELL = String.raw`(?:(?:ba|z|da|k|c|tc|fi)?sh)`;
const WRAPPERS = String.raw`(?:(?:sudo|env|exec|command|nohup|time)(?:\s+(?:-\S+|\w+=\S+))*\s+)*`;
const BIN_DIR = String.raw`(?:/(?:usr/)?(?:local/)?s?bin/)?`;
const NOT_WORD = String.raw`(?![\w.-])`;
const NOT_JSON_TOOL = String.raw`(?!\s+-m\s+json\.tool\b)`;

/** A run step, in command position: after a separator, a backtick, `$(` or a line start. */
const RUN_STEP_RE = new RegExp(
	[
		String.raw`(?:^|[\n;&|(\`]|\$\()[ \t]*${WRAPPERS}${BIN_DIR}(?:`,
		`${SHELL}${NOT_WORD}|`,
		`${INTERPRETER}${NOT_WORD}${NOT_JSON_TOOL}|`,
		String.raw`chmod\s+(?:-\w+\s+)*\+x\b|source${NOT_WORD}|eval${NOT_WORD}|exec${NOT_WORD}|`,
		String.raw`base64\s+(?:-d|--decode|-D)\b|iex${NOT_WORD}`,
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

/** A fetch tool anywhere in the field, then a run step in command position anywhere after the first one. */
function fetchesAndRuns(folded: string): boolean {
	const fetch = FETCH_RE.exec(folded);
	if (!fetch) return false;
	return RUN_STEP_RE.test(folded.slice(fetch.index + fetch[0].length));
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
		const tokens = squash(m[1] as string).split(" ");
		if (tokens.length > 1 && COMMAND_VERBS.has(tokens[0] as string)) spans.push(m[1] as string);
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

function hasUnrecordedCommand(folded: string, records: RecordIndex): boolean {
	for (const span of commandSpans(folded)) {
		for (const tokens of segmentsOf(span)) {
			if (tokens.length < 2 || !COMMAND_VERBS.has(tokens[0] as string)) continue;
			if (isBenign(tokens)) continue;
			const verb = tokens[0] as string;
			const recorded = SUBCOMMAND_VERBS.has(verb)
				? records.heads.has(headOf(tokens))
				: [...records.whole].some(
						(w) => tokens.join(" ").startsWith(w) || w.startsWith(tokens.join(" ")),
					);
			if (!recorded) return true;
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

function scan(text: string, index: Index, checkCommands: boolean): SummarySuspectReason[] {
	const found = new Set(scanFolded(fold(text), index, checkCommands));
	if (text.includes("\u2800")) {
		for (const r of scanFolded(fold(text, " "), index, checkCommands)) found.add(r);
	}
	return SUMMARY_SUSPECT_REASONS.filter((reason) => found.has(reason));
}

function scanFolded(folded: string, index: Index, checkCommands: boolean): SummarySuspectReason[] {
	const reasons: SummarySuspectReason[] = [];
	if (hasRoleMarker(folded)) reasons.push("role_marker");
	if (OVERRIDE_PHRASE_RES.some((re) => re.test(folded))) reasons.push("override_phrase");
	if (hasUnexpectedUrl(folded, index.typed, index.records)) reasons.push("unexpected_url");
	if (hasPipeToShell(folded)) reasons.push("pipe_to_shell");
	if (checkCommands && hasUnrecordedCommand(folded, index.records)) {
		reasons.push("unrecorded_command");
	}
	return reasons;
}

/** Reason codes for one string. `checkCommands` is true for the handoff and next actions. */
export function checkText(
	text: string,
	ctx: TripwireContext,
	opts: { checkCommands?: boolean } = {},
): SummarySuspectReason[] {
	return scan(text, indexOfContext(ctx), opts.checkCommands === true);
}

/**
 * Every string field is scanned for every rule that runs on text; the
 * unrecorded-command rule runs on what the copy-handoff button emits (handoff
 * and next actions), since that is where a command is an instruction.
 */
export function runTripwire(summary: SessionSummary, ctx: TripwireContext): SummarySuspectReason[] {
	const index = indexOfContext(ctx);
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
	const handoff: string[] = [summary.handoff, ...summary.nextActions.map((i) => i.text)];
	const found = new Set<SummarySuspectReason>();
	for (const text of plain) for (const r of scan(text, index, false)) found.add(r);
	for (const text of handoff) for (const r of scan(text, index, true)) found.add(r);
	return SUMMARY_SUSPECT_REASONS.filter((reason) => found.has(reason));
}
