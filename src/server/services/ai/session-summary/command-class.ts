/**
 * AGEN-69: decides what a recorded shell command may send to the model
 * provider. Security-relevant and fail-closed: anything the classifier cannot
 * read as a clean validation command or an ordinary command is sent as status
 * only, and anything that reads a credential is sent as nothing at all.
 *
 * Steps (plan "The command classifier"):
 *   1 normalise: unwrap wrappers, split into segments, look inside `$(...)`,
 *     backticks, heredocs and `sh -c` strings;
 *   2 credential-reading in ANY segment withholds the whole command;
 *   3 a clean validation is shown with its output excerpt;
 *   4 otherwise a command with an unreadable construct is "not shown";
 *   5 everything else is ordinary.
 * Pure: no I/O, never throws (an internal error is "not shown").
 *
 * Reading is deliberately narrow (review P3-1): the command word of every
 * segment must be a plain name with nothing expanded or quoted, every word of
 * every segment is searched for credential paths, interpreters and wrappers
 * the code cannot read fail closed, and a validation's arguments must have a
 * strict shape. What may be sent of a command's OUTPUT is decided by the
 * ledger from `kind` and `masked`: an ordinary command never sends output.
 */
import { FAILURE_EXCERPT_VALIDATIONS, TOOL_INPUT_FIELD_SQL_CAP } from "./limits.js";

export type CommandClass =
	| { kind: "validation"; masked: boolean }
	| { kind: "withheld" }
	| { kind: "not_shown" }
	/** An `apply_patch` call: only the file names it names, never its body. */
	| { kind: "patch"; files: string[] }
	/** Sent as its text and its status only: no output of an ordinary command is ever sent. */
	| { kind: "ordinary" };

export type ValidationResult = "ok" | "failed" | "unknown";

// ── data ─────────────────────────────────────────────────────────────────────

const VIEWER_COMMANDS = new Set([
	"cat",
	"less",
	"more",
	"bat",
	"head",
	"tail",
	"sed",
	"awk",
	"grep",
	"jq",
	"strings",
	"xxd",
]);
/** Withheld when pointed at a credential file, though not "viewers" for the failure rule. */
const EXTRA_FILE_READERS = new Set([
	"source",
	".",
	"egrep",
	"fgrep",
	"rg",
	"tac",
	"nl",
	"od",
	"hexdump",
	"cut",
	"sort",
	"cp",
	"scp",
	"base64",
]);
const EXIT_MASKING_PIPE_CONSUMERS = new Set(["tail", "head", "grep", "tee"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const LEADING_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"do",
	"while",
	"until",
	"!",
	"{",
	"}",
]);
const JS_TOOL_RUNNERS = new Set(["npx", "bunx"]);
const JS_TOOLS = new Set(["vitest", "jest", "tsc", "biome", "eslint"]);
const SUDO_FLAGS_WITH_ARG = new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U"]);
const XARGS_FLAGS_WITH_ARG = new Set(["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a"]);
const DOCKER_EXEC_FLAGS_WITH_ARG = new Set([
	"-e",
	"--env",
	"-u",
	"--user",
	"-w",
	"--workdir",
	"--env-file",
	"-c",
]);
const SSH_FLAGS_WITH_ARG = new Set([
	"-i",
	"-p",
	"-l",
	"-o",
	"-F",
	"-J",
	"-L",
	"-R",
	"-D",
	"-b",
	"-c",
	"-e",
	"-m",
	"-S",
	"-w",
	"-E",
	"-B",
	"-Q",
]);
/** A segment that is only this closes a loop or branch; it runs nothing. */
const BLOCK_TERMINATORS = new Set(["fi", "done", "esac"]);
const MAX_UNWRAP_DEPTH = 8;
const MAX_SEGMENTS = 400;

/** Heads whose arguments run code or another program the classifier cannot read (fail closed). */
const UNREADABLE_HEADS = new Set([
	"node",
	"nodejs",
	"deno",
	"ruby",
	"perl",
	"php",
	"lua",
	"rscript",
	"r",
	"pwsh",
	"powershell",
	"powershell.exe",
	"cmd",
	"cmd.exe",
	"fish",
	"busybox",
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
	"source",
	".",
	"eval",
]);
const SYSTEM_BIN_DIRS = new Set([
	"/bin",
	"/usr/bin",
	"/usr/local/bin",
	"/sbin",
	"/usr/sbin",
	"/opt/homebrew/bin",
]);
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const PLAIN_HEAD_RE = /^[A-Za-z0-9_.+/-]+$/;
const CREDENTIAL_SPLIT_RE = /[\s=:,;<>@|&()'"\\]/;
const FLAG_RE = /^--?[A-Za-z][\w-]*(=[\w./,:@-]+)?$/;
const OPERAND_RE = /^[\w./@%+:-]+$/;
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm;
const PATCH_HEAD_RE = /^\s*(?:(?:shell|bash|sh)\s+(?:-\w+\s+)?['"]?)?(?:\S*\/)?apply_patch(?:\s|$)/;

// ── tokenising ───────────────────────────────────────────────────────────────

interface Word {
	value: string;
	raw: string;
}
interface Segment {
	words: Word[];
	/** The separator in front of this segment: `|`, `||`, `&&`, `;`, `&`, `\n`, or "" for the first. */
	sep: string;
}
interface Flags {
	subst: boolean;
	heredoc: boolean;
	evalCmd: boolean;
	base64Cmd: boolean;
	pythonC: boolean;
	nodeE: boolean;
	shDashC: boolean;
	/** A backslash before a name character outside quotes: Windows paths and word-splitting tricks. */
	oddEscape: boolean;
	unparseable: boolean;
}
interface Parsed {
	segments: Segment[];
	flags: Flags;
}

function newFlags(): Flags {
	return {
		subst: false,
		heredoc: false,
		evalCmd: false,
		base64Cmd: false,
		pythonC: false,
		nodeE: false,
		shDashC: false,
		oddEscape: false,
		unparseable: false,
	};
}

class Unparseable extends Error {}

/** Index of the `)` closing the `$(` whose body starts at `from`, quote-aware; -1 if none. */
function findClosingParen(text: string, from: number): number {
	let depth = 1;
	let single = false;
	let double = false;
	for (let i = from; i < text.length; i++) {
		const c = text[i] as string;
		if (single) {
			if (c === "'") single = false;
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (double) {
			if (c === '"') double = false;
			else if (c === "$" && text[i + 1] === "(") {
				depth++;
				i++;
			}
			continue;
		}
		if (c === "'") single = true;
		else if (c === '"') double = true;
		else if (c === "$" && text[i + 1] === "(") {
			depth++;
			i++;
		} else if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
}

/** Splits `text` into segments, recursing into substitutions. Throws Unparseable. */
function scan(text: string, depth: number, out: Parsed): void {
	if (depth > MAX_UNWRAP_DEPTH) throw new Unparseable("too deep");
	let words: Word[] = [];
	let value = "";
	let raw = "";
	let inWord = false;
	let sep = "";
	let pending: PendingHeredoc[] = [];

	const endWord = () => {
		if (inWord) {
			words.push({ value, raw });
			value = "";
			raw = "";
			inWord = false;
		}
	};
	const endSegment = (nextSep: string) => {
		endWord();
		if (words.length > 0) {
			out.segments.push({ words, sep });
			if (out.segments.length > MAX_SEGMENTS) throw new Unparseable("too many segments");
		}
		words = [];
		sep = nextSep;
	};
	const addChar = (c: string, rawText = c) => {
		value += c;
		raw += rawText;
		inWord = true;
	};
	const recurse = (inner: string) => {
		const sub = { segments: [] as Segment[], flags: out.flags };
		scan(inner, depth + 1, sub);
		for (const s of sub.segments) out.segments.push({ words: s.words, sep: ";" });
	};

	let i = 0;
	while (i < text.length) {
		const c = text[i] as string;

		if (c === "\\") {
			if (i + 1 >= text.length) throw new Unparseable("trailing backslash");
			if (/[A-Za-z0-9_.~/:-]/.test(text[i + 1] as string)) out.flags.oddEscape = true;
			addChar(text[i + 1] as string, c + text[i + 1]);
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = text.indexOf("'", i + 1);
			if (end === -1) throw new Unparseable("unbalanced quote");
			const body = text.slice(i + 1, end);
			if (body.includes("$(") || body.includes("`")) out.flags.subst = true;
			value += body;
			raw += text.slice(i, end + 1);
			inWord = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let body = "";
			let closed = false;
			while (j < text.length) {
				const d = text[j] as string;
				if (d === "\\" && j + 1 < text.length) {
					body += text[j + 1];
					j += 2;
					continue;
				}
				if (d === '"') {
					closed = true;
					break;
				}
				if (d === "$" && text[j + 1] === "(") {
					const close = findClosingParen(text, j + 2);
					if (close === -1) throw new Unparseable("unbalanced substitution");
					out.flags.subst = true;
					recurse(text.slice(j + 2, close));
					body += "$(…)";
					j = close + 1;
					continue;
				}
				if (d === "`") {
					const close = text.indexOf("`", j + 1);
					if (close === -1) throw new Unparseable("unbalanced backtick");
					out.flags.subst = true;
					recurse(text.slice(j + 1, close));
					body += "`…`";
					j = close + 1;
					continue;
				}
				body += d;
				j++;
			}
			if (!closed) throw new Unparseable("unbalanced quote");
			value += body;
			raw += text.slice(i, j + 1);
			inWord = true;
			i = j + 1;
			continue;
		}
		if (c === "$" && text[i + 1] === "(") {
			const close = findClosingParen(text, i + 2);
			if (close === -1) throw new Unparseable("unbalanced substitution");
			out.flags.subst = true;
			recurse(text.slice(i + 2, close));
			addChar("$(…)", text.slice(i, close + 1));
			i = close + 1;
			continue;
		}
		if (c === "`") {
			const close = text.indexOf("`", i + 1);
			if (close === -1) throw new Unparseable("unbalanced backtick");
			out.flags.subst = true;
			recurse(text.slice(i + 1, close));
			addChar("`…`", text.slice(i, close + 1));
			i = close + 1;
			continue;
		}
		if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
			out.flags.heredoc = true;
			let j = i + 2;
			let stripTabs = false;
			if (text[j] === "-") {
				stripTabs = true;
				j++;
			}
			while (text[j] === " " || text[j] === "\t") j++;
			let delimiter = "";
			const quote = text[j] === "'" || text[j] === '"' ? (text[j] as string) : "";
			if (quote) j++;
			while (j < text.length && /[A-Za-z0-9_.-]/.test(text[j] as string)) {
				delimiter += text[j];
				j++;
			}
			if (quote) {
				if (text[j] !== quote) throw new Unparseable("unbalanced heredoc delimiter");
				j++;
			}
			if (!delimiter) throw new Unparseable("heredoc without delimiter");
			pending.push({ delimiter, stripTabs });
			endWord();
			words.push({ value: "<<", raw: "<<" });
			i = j;
			continue;
		}
		if (c === "\n") {
			endSegment("\n");
			i++;
			for (const heredoc of pending) {
				let found = false;
				while (i <= text.length) {
					const nl = text.indexOf("\n", i);
					const line = nl === -1 ? text.slice(i) : text.slice(i, nl);
					i = nl === -1 ? text.length + 1 : nl + 1;
					const probe = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
					if (probe === heredoc.delimiter) {
						found = true;
						break;
					}
					const bodyWords = line
						.split(/\s+/)
						.filter(Boolean)
						.map((w) => ({ value: w, raw: w }));
					if (bodyWords.length > 0) out.segments.push({ words: bodyWords, sep: ";" });
					if (nl === -1) break;
				}
				if (!found) throw new Unparseable("unterminated heredoc");
			}
			pending = [];
			continue;
		}
		if (c === ";" || c === "(" || c === ")") {
			endSegment(";");
			i++;
			continue;
		}
		if (c === "&") {
			if (text[i + 1] === "&") {
				endSegment("&&");
				i += 2;
				continue;
			}
			if (text[i - 1] === ">" || text[i + 1] === ">") {
				addChar(c);
				i++;
				continue;
			}
			endSegment("&");
			i++;
			continue;
		}
		if (c === "|") {
			if (text[i + 1] === "|") {
				endSegment("||");
				i += 2;
				continue;
			}
			endSegment(text[i + 1] === "&" ? "|" : "|");
			i += text[i + 1] === "&" ? 2 : 1;
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			endWord();
			i++;
			continue;
		}
		addChar(c);
		i++;
	}
	if (pending.length > 0) throw new Unparseable("heredoc body missing");
	endSegment("");
}

function parse(text: string): Parsed {
	const out: Parsed = { segments: [], flags: newFlags() };
	try {
		scan(text, 0, out);
	} catch (error) {
		if (error instanceof Unparseable || error instanceof RangeError) {
			out.flags.unparseable = true;
			return out;
		}
		throw error;
	}
	return out;
}

// ── unwrapping ───────────────────────────────────────────────────────────────

interface Final {
	words: Word[];
	sep: string;
}

function baseName(token: string): string {
	const stripped = token.replace(/^\\/, "");
	const slash = stripped.lastIndexOf("/");
	return slash === -1 ? stripped : stripped.slice(slash + 1);
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function skipFlags(words: Word[], from: number, withArg: Set<string>): number {
	let i = from;
	while (i < words.length) {
		const v = (words[i] as Word).value;
		if (v === "--") {
			i++;
			break;
		}
		if (!v.startsWith("-") || v === "-") break;
		i += withArg.has(v) ? 2 : 1;
	}
	return i;
}

function joinRaw(words: Word[]): string {
	return words.map((w) => w.raw).join(" ");
}

/** Resolves a segment to the commands it really runs. Records wrapper flags. */
function unwrap(
	startWords: Word[],
	sep: string,
	flags: Flags,
	depth: number,
	finals: Final[],
): void {
	if (depth > MAX_UNWRAP_DEPTH) {
		flags.unparseable = true;
		return;
	}
	let words = startWords;
	for (let guard = 0; guard < 40; guard++) {
		let i = 0;
		while (i < words.length) {
			const v = (words[i] as Word).value;
			if (LEADING_KEYWORDS.has(v) || ASSIGNMENT_RE.test(v)) i++;
			else break;
		}
		words = words.slice(i);
		const head = words[0];
		if (!head) return;
		if (words.length === 1 && BLOCK_TERMINATORS.has(head.value)) return;
		const cmd = baseName(head.value);

		if (cmd === "sudo" || cmd === "doas") {
			words = words.slice(skipFlags(words, 1, SUDO_FLAGS_WITH_ARG));
			continue;
		}
		if (cmd === "env") {
			let j = 1;
			while (j < words.length) {
				const v = (words[j] as Word).value;
				if (v === "-u" || v === "-S" || v === "-C") j += 2;
				else if (v.startsWith("-") || ASSIGNMENT_RE.test(v)) j++;
				else break;
			}
			if (j >= words.length) {
				finals.push({ words: [head], sep });
				return;
			}
			words = words.slice(j);
			continue;
		}
		if (
			cmd === "nice" ||
			cmd === "time" ||
			cmd === "nohup" ||
			cmd === "command" ||
			cmd === "exec"
		) {
			words = words.slice(skipFlags(words, 1, new Set(["-n"])));
			continue;
		}
		if (cmd === "timeout") {
			let j = skipFlags(words, 1, new Set(["-s", "-k", "--signal", "--kill-after"]));
			if (j < words.length && /^\d/.test((words[j] as Word).value)) j++;
			if (words[j]?.value === "--") j++;
			words = words.slice(j);
			continue;
		}
		if (cmd === "xargs") {
			const j = skipFlags(words, 1, XARGS_FLAGS_WITH_ARG);
			if (j >= words.length) {
				finals.push({ words: [head], sep });
				return;
			}
			words = words.slice(j);
			continue;
		}
		if ((cmd === "docker" || cmd === "podman") && words[1]?.value === "exec") {
			const j = skipFlags(words, 2, DOCKER_EXEC_FLAGS_WITH_ARG);
			words = words.slice(j + 1);
			if (words.length === 0) {
				finals.push({ words: [head], sep });
				return;
			}
			continue;
		}
		if (cmd === "kubectl" && words.some((w) => w.value === "exec")) {
			const dash = words.findIndex((w) => w.value === "--");
			if (dash !== -1) {
				words = words.slice(dash + 1);
				if (words.length === 0) {
					finals.push({ words: [head], sep });
					return;
				}
				continue;
			}
		}
		if (cmd === "ssh") {
			const j = skipFlags(words, 1, SSH_FLAGS_WITH_ARG);
			const rest = words.slice(j + 1);
			if (rest.length === 0) {
				finals.push({ words: [head], sep });
				return;
			}
			recurseString(
				rest.length === 1 ? (rest[0] as Word).value : joinRaw(rest),
				sep,
				flags,
				depth,
				finals,
			);
			return;
		}
		if (SHELLS.has(cmd)) {
			const dashC = words.findIndex((w, idx) => idx > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.value));
			if (dashC !== -1) {
				flags.shDashC = true;
				const body = words
					.slice(dashC + 1)
					.find((w) => !w.value.startsWith("-") || w.value.includes(" "));
				if (!body) {
					flags.unparseable = true;
					return;
				}
				recurseString(body.value, sep, flags, depth, finals);
				return;
			}
		}
		if (cmd === "eval") flags.evalCmd = true;
		if (cmd === "base64") flags.base64Cmd = true;
		if (/^python[\d.]*$/.test(cmd) && words.some((w) => w.value === "-c")) flags.pythonC = true;
		if (cmd === "node" && words.some((w) => ["-e", "-p", "--eval", "--print"].includes(w.value)))
			flags.nodeE = true;
		finals.push({ words, sep });
		return;
	}
	flags.unparseable = true;
}

function recurseString(text: string, sep: string, flags: Flags, depth: number, finals: Final[]) {
	const inner = parse(text);
	mergeFlags(flags, inner.flags);
	for (const [index, segment] of inner.segments.entries()) {
		unwrap(segment.words, index === 0 ? sep : segment.sep, flags, depth + 1, finals);
	}
}

function mergeFlags(into: Flags, from: Flags): void {
	for (const key of Object.keys(into) as Array<keyof Flags>) into[key] = into[key] || from[key];
}

// ── credential reading ───────────────────────────────────────────────────────

const SECRET_WORD_RE = /token|password|passwd|credential|private|apikey|api_key/;
const CREDENTIAL_DIRS = [
	"/.ssh/",
	"/.aws/",
	"/.gnupg/",
	"/.config/gh/",
	"/.config/gcloud/",
	"/.azure/",
	"/.kube/",
];

/**
 * True when `token` names a file that holds credentials: by file name, by a
 * credential directory it sits in, or, when the token is path-shaped (or a bare
 * operand of a file reader), by a secret word in a path component.
 */
function isCredentialPath(token: string, bare = false): boolean {
	const path = token.toLowerCase().replace(/\/+$/, "");
	if (!path) return false;
	const base = path.slice(path.lastIndexOf("/") + 1);
	// A bare word such as `secret` or `credentials` in a commit message is prose; a name
	// counts when it is path-shaped, or is an operand of a file reader.
	const pathShaped = bare || path.includes("/") || path.includes(".");
	if (
		base.startsWith(".env") ||
		base === ".netrc" ||
		base === ".npmrc" ||
		base === ".pypirc" ||
		base === ".git-credentials" ||
		base === ".pgpass" ||
		base === ".my.cnf" ||
		base === ".s3cfg" ||
		base === ".vault-token" ||
		base === ".htpasswd" ||
		base.startsWith("id_rsa") ||
		base.startsWith("id_ed25519") ||
		base.startsWith("id_ecdsa") ||
		base.startsWith("id_dsa") ||
		/\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(base) ||
		base.includes(".tfstate") ||
		base.includes("kubeconfig") ||
		(pathShaped && base.startsWith("credentials")) ||
		(pathShaped && /(^|[._-])secrets?([._-]|$)/.test(base)) ||
		/(^|\/)config\/prod/.test(path) ||
		base.endsWith(".tfvars") ||
		base.endsWith(".tfvars.json") ||
		path.endsWith("/.kube/config") ||
		path === ".kube/config" ||
		path.endsWith(".git/config") ||
		path.endsWith(".docker/config.json") ||
		path.endsWith("gh/hosts.yml") ||
		path.endsWith("etc/shadow") ||
		path.endsWith("etc/gshadow")
	) {
		return true;
	}
	const inDirectory = `/${path}/`;
	if (CREDENTIAL_DIRS.some((d) => inDirectory.includes(d))) return true;
	if (pathShaped) return path.split("/").some((component) => SECRET_WORD_RE.test(component));
	return false;
}

/** The words of a word, split where a shell would see a separate path, on both its raw and cooked forms. */
function credentialTokens(word: Word): string[] {
	const tokens = new Set<string>();
	for (const form of [word.value, word.raw]) {
		for (const token of form.split(CREDENTIAL_SPLIT_RE)) if (token) tokens.add(token);
	}
	return [...tokens];
}

function isFileReader(cmd: string): boolean {
	return VIEWER_COMMANDS.has(cmd) || EXTRA_FILE_READERS.has(cmd);
}

/** The first operand and the one after it, skipping flags that carry no value. */
function operandsOf(args: string[]): string[] {
	return args.filter((a) => !a.startsWith("-"));
}

function readsCredentials(words: Word[]): boolean {
	const head = words[0];
	if (!head) return false;
	const cmd = baseName(head.value);
	const args = words.slice(1).map((w) => w.value);
	const rawText = joinRaw(words);
	const has = (...names: string[]) => names.every((n) => args.includes(n));
	const firstNonFlag = args.find((a) => !a.startsWith("-"));
	const bare = isFileReader(cmd);

	if (/\/proc\/[^\s]*\/environ/.test(rawText)) return true;
	for (const word of words) {
		if (credentialTokens(word).some((t) => isCredentialPath(t, bare))) return true;
	}
	switch (cmd) {
		case "printenv":
		case "env":
		case "doppler":
			return true;
		case "set":
			return args.length === 0;
		case "export":
			return args.length === 0 || args.includes("-p");
		case "declare":
		case "typeset":
			return args.length === 0 || args.some((a) => /^-[a-zA-Z]*[xp]/.test(a));
		case "echo":
		case "printf":
			// `$(` alone is a substitution (judged by its own segments and the fail-closed rule).
			if (/\$(?!\()/.test(rawText.slice(head.raw.length))) return true;
			break;
		case "base64":
			if (args.some((a) => /^-[A-Za-z]*[dD]/.test(a) || a === "--decode")) return true;
			break;
		case "security":
			if (args.some((a) => a.startsWith("find-"))) return true;
			break;
		case "op":
			if (args[0] === "read") return true;
			break;
		case "bw":
			if (args[0] === "get") return true;
			break;
		case "pass":
			if (args[0] === "show") return true;
			break;
		case "vault":
			if (args[0] === "read" || (args[0] === "kv" && args[1] === "get")) return true;
			break;
		case "gh":
			if (args[0] === "auth" && args[1] === "token") return true;
			break;
		case "gcloud":
			if (args.includes("auth") && args.some((a) => a.startsWith("print-"))) return true;
			break;
		case "az":
			if (args.includes("get-access-token")) return true;
			break;
		case "aws":
			if (has("secretsmanager", "get-secret-value")) return true;
			if (args.includes("ssm") && args.some((a) => a.startsWith("get-parameter"))) {
				if (args.includes("--with-decryption")) return true;
			}
			if (has("sts", "get-session-token")) return true;
			break;
		case "git":
			if (
				args.includes("config") &&
				args.some((a) => ["--get", "-l", "--list", "--get-all", "--get-regexp"].includes(a))
			)
				return true;
			if (gitSubcommand(args) === "remote") return true;
			break;
		case "docker":
		case "podman":
			if (args[0] === "inspect") return true;
			if (operandsOf(args)[0] === "compose" && args.includes("config")) return true;
			break;
		case "docker-compose":
			if (args.includes("config")) return true;
			break;
		case "kubectl":
			if (
				(args.includes("get") || args.includes("describe")) &&
				args.some((a) => /^secrets?(\/|$)/i.test(a))
			)
				return true;
			if (has("config", "view") && args.includes("--raw")) return true;
			break;
		case "terraform":
		case "tofu":
			if (firstNonFlag && ["output", "show", "state"].includes(firstNonFlag)) return true;
			break;
		default:
			break;
	}
	if (/^python[\d.]*$/.test(cmd) && args.includes("-c") && /environ|getenv/.test(rawText))
		return true;
	if (
		cmd === "node" &&
		args.some((a) => ["-e", "-p", "--eval", "--print"].includes(a)) &&
		/process\.env/.test(rawText)
	)
		return true;
	return false;
}

/** The git subcommand, past the global options (`-C <path>`, `-c k=v`, `--no-pager`, ...). */
function gitSubcommand(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (
			a === "-C" ||
			a === "-c" ||
			a === "--git-dir" ||
			a === "--work-tree" ||
			a === "--namespace"
		) {
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		return a;
	}
	return undefined;
}

// ── readability ──────────────────────────────────────────────────────────────

/** True when a segment's command word is something the classifier cannot read as plain. */
function isUnreadable(final: Final): boolean {
	const head = final.words[0];
	if (!head) return true;
	if (head.raw !== head.value || !PLAIN_HEAD_RE.test(head.value)) return true;
	const slash = head.value.lastIndexOf("/");
	if (slash !== -1 && !SYSTEM_BIN_DIRS.has(head.value.slice(0, slash) || "/")) return true;
	const cmd = baseName(head.value);
	if (isValidationCommand(final.words)) return false;
	const args = final.words.slice(1).map((w) => w.value);
	if (UNREADABLE_HEADS.has(cmd.toLowerCase()) || /^python[\d.]*$/.test(cmd) || SHELLS.has(cmd)) {
		return true;
	}
	if (
		cmd === "bun" &&
		(args[0] === "eval" || args.some((a) => ["-e", "--eval", "-p", "--print"].includes(a)))
	) {
		return true;
	}
	if (cmd === "find" && args.some((a) => FIND_EXEC_FLAGS.has(a))) return true;
	if (
		/^[gm]?awk$/.test(cmd) &&
		final.words.some((w) => /system\s*\(|\|\s*getline|"\s*\|/.test(w.raw))
	) {
		return true;
	}
	return false;
}

// ── validation ───────────────────────────────────────────────────────────────

/** Drops redirections (`> out.log`, `2>&1`, `&>f`, `< in`) so the arguments left are the tool's own. */
function withoutRedirects(words: Word[]): Word[] {
	const out: Word[] = [];
	for (let i = 0; i < words.length; i++) {
		const v = (words[i] as Word).value;
		if (/^(?:\d*|&)(?:>>?|<)&?[\d-]+$/.test(v)) continue;
		if (/^(?:\d*|&)(?:>>?|<)$/.test(v)) {
			i++;
			continue;
		}
		if (/^(?:\d*|&)(?:>>?|<)\S/.test(v)) continue;
		out.push(words[i] as Word);
	}
	return out;
}

/**
 * The flags a validation tool may carry, per tool (an ALLOWLIST: a flag that is
 * not here makes the command not a clean validation, so it is shown as an
 * ordinary command and never gets an output excerpt). A short-flag cluster
 * (`-ks`, `-j4`, `-pn`) is judged letter by letter: every letter must be a
 * no-value letter, or a value letter that ends the cluster.
 *
 * Each list is short on purpose and holds only flags that pick what runs or how
 * loudly it reports. Left out, always: anything that names a config, plugin,
 * reporter, output format, output file, makefile, working directory or
 * manifest, anything that prints a tool's internal state (`make -p`,
 * `tsc --showConfig`, `pytest --showlocals`), and anything that writes
 * (`--fix`, `--write`, `-o`, `--coverprofile`).
 */
interface FlagPolicy {
	long: ReadonlySet<string>;
	/** One-letter flags that take no value. */
	shortFlags: string;
	/** One-letter flags that take a value, attached (`-j4`) or as the next operand. */
	shortValue: string;
	/** Go style single-dash words (`-race`, `-count=1`). */
	singleDash?: ReadonlySet<string>;
	/** The only operands the tool may be given; undefined: any plain operand. */
	operands?: RegExp;
}

const flagSet = (list: string): ReadonlySet<string> => new Set(list.split(" "));

const FLAG_POLICIES = {
	// `-j N`, `-jN`, `-k`, `-s`, `--keep-going`, `--silent`: nothing else. `-p`, `-n`,
	// `-f`, `-C`, `-c...` print make's whole database or read another makefile.
	// Targets are test|check|lint (and the digits of `-j 4`): `make test install` runs install.
	make: {
		long: flagSet("keep-going silent"),
		shortFlags: "ks",
		shortValue: "j",
		operands: /^(?:test|check|lint|\d+)$/,
	},
	// `bun test`: reporting and selection only. `--preload` runs code; `--reporter` writes files.
	bunTest: {
		long: flagSet("bail timeout rerun-each coverage test-name-pattern only"),
		shortFlags: "",
		shortValue: "t",
	},
	// package scripts (`bun|npm|pnpm|yarn run X`, `npm test`): arguments reach an unknown tool, so only verbosity and exit behaviour.
	script: {
		long: flagSet("silent bail ci coverage runInBand if-present"),
		shortFlags: "s",
		shortValue: "",
	},
	// go test and go vet. `-exec`, `-vettool`, `-o`, `-coverprofile` run or write.
	go: {
		long: flagSet(""),
		shortFlags: "",
		shortValue: "",
		singleDash: flagSet("v race short failfast cover count run timeout p parallel shuffle"),
	},
	// `-p`, `-j`, `-F`, `-D`: package, jobs, feature, lint level. `--manifest-path` and `--config` are left out.
	cargo: {
		long: flagSet(
			"release all workspace all-targets all-features no-fail-fast lib bins tests quiet locked offline frozen package jobs features nocapture test-threads ignored exact show-output",
		),
		shortFlags: "q",
		shortValue: "pjFD",
	},
	// `-p` (load a plugin), `-c` (config file), `--rootdir`, `--showlocals` (prints variable values) are left out.
	pytest: {
		long: flagSet(
			"tb maxfail cov ignore deselect no-header lf last-failed ff failed-first durations strict-markers disable-warnings quiet verbose",
		),
		shortFlags: "qvx",
		shortValue: "kmnr",
	},
	tox: { long: flagSet("quiet verbose"), shortFlags: "qv", shortValue: "e" },
	// `--config` and `--reporter` are left out.
	jsTest: {
		long: flagSet("ci bail coverage silent runInBand passWithNoTests no-cache run"),
		shortFlags: "i",
		shortValue: "t",
	},
	// `-p`/`--project` (any file as the config; kept denied since round 2), `--showConfig`, `--listFiles`, `--generateTrace` and the emit flags are left out.
	tsc: {
		long: flagSet("noEmit pretty incremental skipLibCheck strict build"),
		shortFlags: "b",
		shortValue: "",
	},
	// `--write`, `--apply`, `--reporter`, `--config-path` are left out.
	biome: {
		long: flagSet(
			"max-diagnostics error-on-warnings no-errors-on-unmatched verbose colors diagnostic-level",
		),
		shortFlags: "",
		shortValue: "",
	},
	// `-f` and `--format` (the JSON form carries the source text), `--fix`, `-c`, `--plugin`, `--rulesdir` are left out.
	eslint: {
		long: flagSet("max-warnings quiet cache ext no-warn-ignored no-error-on-unmatched-pattern"),
		shortFlags: "",
		shortValue: "",
	},
	// `--output-format`, `--diff`, `--fix`, `--config` are left out. `--check` is `ruff format`'s validation.
	ruff: {
		long: flagSet("select ignore quiet no-cache check"),
		shortFlags: "q",
		shortValue: "",
	},
	// `--html-report` and the other report writers, `--config-file`, `--python-executable` are left out.
	mypy: {
		long: flagSet("strict ignore-missing-imports no-incremental no-error-summary"),
		shortFlags: "",
		shortValue: "",
	},
} satisfies Record<string, FlagPolicy>;

interface ValidationHead {
	/** The words that name the check: `bun test`, `bun run typecheck`, `tsc`, `go vet`. Fixed vocabulary. */
	label: string;
	policy: FlagPolicy;
}

const SCRIPT_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

function standaloneHead(cmd: string): ValidationHead | null {
	switch (cmd) {
		case "vitest":
		case "jest":
			return { label: cmd, policy: FLAG_POLICIES.jsTest };
		case "pytest":
			return { label: "pytest", policy: FLAG_POLICIES.pytest };
		case "tox":
			return { label: "tox", policy: FLAG_POLICIES.tox };
		case "tsc":
			return { label: "tsc", policy: FLAG_POLICIES.tsc };
		case "biome":
			return { label: "biome", policy: FLAG_POLICIES.biome };
		case "eslint":
			return { label: "eslint", policy: FLAG_POLICIES.eslint };
		case "ruff":
			return { label: "ruff", policy: FLAG_POLICIES.ruff };
		case "mypy":
			return { label: "mypy", policy: FLAG_POLICIES.mypy };
		default:
			return null;
	}
}

/** The check a segment runs and the flags it may carry; null when the segment is not a validation head. */
function validationHead(words: Word[]): ValidationHead | null {
	const head = words[0];
	if (!head) return null;
	const cmd = baseName(head.value);
	const args = words.slice(1).map((w) => w.value);
	if (JS_TOOL_RUNNERS.has(cmd)) {
		const tool = words[skipFlags(words, 1, new Set())];
		const name = tool ? baseName(tool.value) : "";
		return JS_TOOLS.has(name) ? standaloneHead(name) : null;
	}
	const standalone = standaloneHead(cmd);
	if (standalone) return standalone;
	if (SCRIPT_RUNNERS.has(cmd)) {
		if (cmd === "bun" && args[0] === "test") {
			return { label: "bun test", policy: FLAG_POLICIES.bunTest };
		}
		if (args[0] === "test") return { label: `${cmd} test`, policy: FLAG_POLICIES.script };
		const scripts =
			cmd === "bun"
				? ["check", "typecheck", "test", "build"]
				: ["test", "lint", "build", "typecheck", "check"];
		if (args[0] === "run" && scripts.includes(args[1] ?? "")) {
			return { label: `${cmd} run ${args[1]}`, policy: FLAG_POLICIES.script };
		}
		return null;
	}
	switch (cmd) {
		case "go":
			return args[0] === "test" || args[0] === "vet"
				? { label: `go ${args[0]}`, policy: FLAG_POLICIES.go }
				: null;
		case "cargo":
			return ["test", "check", "clippy", "build"].includes(args[0] ?? "")
				? { label: `cargo ${args[0]}`, policy: FLAG_POLICIES.cargo }
				: null;
		case "make":
			return ["test", "check", "lint"].includes(args[0] ?? "")
				? { label: `make ${args[0]}`, policy: FLAG_POLICIES.make }
				: null;
		default:
			return /^python[\d.]*$/.test(cmd) && args[0] === "-m" && args[1] === "pytest"
				? { label: "pytest", policy: FLAG_POLICIES.pytest }
				: null;
	}
}

/** True when a flag is on the tool's allowlist, a short-flag cluster letter by letter. */
function flagAllowed(flag: string, policy: FlagPolicy): boolean {
	if (flag.startsWith("--")) return policy.long.has(flag.slice(2).split("=")[0] as string);
	if (policy.singleDash?.has(flag.slice(1).split("=")[0] as string)) return true;
	if (flag.includes("=")) return false;
	const letters = flag.slice(1);
	for (let i = 0; i < letters.length; i++) {
		const letter = letters[i] as string;
		if (policy.shortFlags.includes(letter)) continue;
		if (policy.shortValue.includes(letter)) {
			const attached = letters.slice(i + 1);
			return attached === "" || (/^[\w.,:-]+$/.test(attached) && !isCredentialPath(attached));
		}
		return false;
	}
	return true;
}

/** Every argument has a plain shape: no quoting, no expansion, only flags on the tool's allowlist, no credential path. */
function validationArgsClean(words: Word[], policy: FlagPolicy): boolean {
	for (const w of withoutRedirects(words.slice(1))) {
		const v = w.value;
		if (w.raw !== v) return false;
		if (v === "--") continue;
		if (v.startsWith("-")) {
			if (!FLAG_RE.test(v) || !flagAllowed(v, policy)) return false;
			continue;
		}
		if (!OPERAND_RE.test(v) || isCredentialPath(v)) return false;
		if (policy.operands && !policy.operands.test(v)) return false;
	}
	return true;
}

function isValidationCommand(words: Word[]): boolean {
	const head = validationHead(words);
	return head !== null && validationArgsClean(words, head.policy);
}

const FILLER_DENIED_FLAG_RE =
	/^(?:-[A-Za-z]*[rRfF][A-Za-z]*|--(?:include|exclude|file|recursive|dereference-recursive|directories|follow|retry).*)$/;
const NUMERIC_RE = /^[+-]?\d+$/;

/** The shell would expand these (or this word is not a plain literal): never a filler operand. */
const EXPANDING_RE = /[*?[$~]/;

/** An operand the shell passes through unchanged and that has the plain shape of a pattern or file name. */
function plainOperand(word: Word | undefined): boolean {
	if (!word) return false;
	const v = word.value;
	return word.raw === v && OPERAND_RE.test(v) && !EXPANDING_RE.test(v) && !isCredentialPath(v);
}

/** A filter after a pipe that reads only its input: no file operand, no recursion, one pattern at most, every operand a plain literal. */
function isBenignPipeFiller(final: Final, cmd: string): boolean {
	if (final.sep !== "|") return false;
	const args = withoutRedirects(final.words.slice(1));
	let operands = 0;
	for (let i = 0; i < args.length; i++) {
		const v = (args[i] as Word).value;
		if (v.startsWith("-") && !NUMERIC_RE.test(v)) {
			if (FILLER_DENIED_FLAG_RE.test(v)) return false;
			if (cmd === "tee") continue;
			if (["-n", "-c", "-m", "-A", "-B", "-C"].includes(v)) {
				if (!NUMERIC_RE.test(args[i + 1]?.value ?? "x")) return false;
				i++;
			} else if (cmd === "grep" && v === "-e") {
				if (!plainOperand(args[i + 1])) return false;
				i++;
				operands++;
			}
			continue;
		}
		if (cmd === "head" || cmd === "tail") {
			if (!NUMERIC_RE.test(v)) return false;
		} else if (!plainOperand(args[i])) {
			return false;
		} else if (++operands > 1) {
			return false;
		}
	}
	return true;
}

function isBenignValidationFiller(final: Final): boolean {
	const head = final.words[0];
	if (!head) return false;
	const cmd = baseName(head.value);
	if (cmd === "cd") return true;
	if (cmd === "echo") return !joinRaw(final.words.slice(1)).includes("$");
	if (cmd === "true") return true;
	return EXIT_MASKING_PIPE_CONSUMERS.has(cmd) && isBenignPipeFiller(final, cmd);
}

function isExitMasking(final: Final): boolean {
	const head = final.words[0];
	if (!head) return false;
	const cmd = baseName(head.value);
	if (final.sep === "|" && EXIT_MASKING_PIPE_CONSUMERS.has(cmd)) return true;
	return cmd === "true" && (final.sep === ";" || final.sep === "||" || final.sep === "\n");
}

// ── public ───────────────────────────────────────────────────────────────────

/** Strings pass through; the Codex array form becomes its shell-quoted line. Null: not a command. */
function toCommandString(input: unknown): string | null {
	if (typeof input === "number" || typeof input === "boolean") return String(input);
	if (Array.isArray(input))
		return input.every((p) => typeof p === "string") ? quoteArray(input) : null;
	if (typeof input !== "string") return null;
	const trimmed = input.trim();
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
				return quoteArray(parsed as string[]);
			}
			return null;
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

function quoteArray(parts: string[]): string {
	return parts
		.map((p) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`))
		.join(" ");
}

/** The length the loader's SQL cut applies to: the stored text, or the JSON of an array given directly. */
function storedLength(input: unknown): number {
	const stored =
		typeof input === "string" ? input : Array.isArray(input) ? JSON.stringify(input) : "";
	return Array.from(stored).length;
}

export function classifyCommand(input: unknown): CommandClass {
	try {
		return classify(input);
	} catch {
		return { kind: "not_shown" };
	}
}

/** The `*** Add|Update|Delete File:` paths of a patch text; its body is never read. */
export function patchFilesOf(text: string): string[] {
	return [...text.matchAll(PATCH_FILE_RE)].map((m) => (m[1] as string).trim());
}

function classify(input: unknown): CommandClass {
	// A command as long as the SQL cut may have lost its end: never classified.
	if (storedLength(input) >= TOOL_INPUT_FIELD_SQL_CAP) return { kind: "not_shown" };
	const text = toCommandString(input);
	if (text === null || text === "") return { kind: "not_shown" };
	if (PATCH_HEAD_RE.test(text)) return { kind: "patch", files: patchFilesOf(text) };
	const parsed = parse(text);
	if (parsed.flags.unparseable) return { kind: "not_shown" };

	const flags = parsed.flags;
	const finals: Final[] = [];
	for (const segment of parsed.segments) unwrap(segment.words, segment.sep, flags, 0, finals);
	if (flags.unparseable) return { kind: "not_shown" };
	if (finals.length === 0) return { kind: "not_shown" };

	// Before unwrapping too: a wrapper's own flag value (`xargs -a .env`) is not in the final.
	const namesCredential = parsed.segments.some((seg) =>
		seg.words.some((w) => credentialTokens(w).some((t) => isCredentialPath(t))),
	);
	if (namesCredential || finals.some((f) => readsCredentials(f.words))) return { kind: "withheld" };

	const unreadable =
		flags.subst ||
		flags.heredoc ||
		flags.evalCmd ||
		flags.base64Cmd ||
		flags.pythonC ||
		flags.nodeE ||
		flags.oddEscape ||
		finals.some(isUnreadable);
	if (!unreadable) {
		const allowlisted = finals.filter((f) => isValidationCommand(f.words));
		const allClean = finals.every(
			(f) => isValidationCommand(f.words) || isBenignValidationFiller(f),
		);
		if (allowlisted.length > 0 && allClean) {
			return { kind: "validation", masked: finals.some(isExitMasking) };
		}
	}
	if (unreadable || flags.shDashC) return { kind: "not_shown" };
	return { kind: "ordinary" };
}

/**
 * The class of a clean validation command, such as `bun test` or `tsc`, for the
 * evidence fact: a server-chosen label, never the command text. Null when the
 * command is not a clean validation.
 */
export function validationClassOf(input: unknown): string | null {
	return validationLabelsOf(input)?.[0] ?? null;
}

/** The label of every validation segment of a command, in order; null when it has none. */
function validationLabelsOf(input: unknown): string[] | null {
	try {
		const text = toCommandString(input);
		if (text === null || text === "" || storedLength(input) >= TOOL_INPUT_FIELD_SQL_CAP)
			return null;
		const parsed = parse(text);
		if (parsed.flags.unparseable) return null;
		const finals: Final[] = [];
		for (const segment of parsed.segments)
			unwrap(segment.words, segment.sep, parsed.flags, 0, finals);
		const labels: string[] = [];
		for (const final of finals) {
			const head = validationHead(final.words);
			if (head && validationArgsClean(final.words, head.policy)) labels.push(head.label);
		}
		return labels.length > 0 ? labels : null;
	} catch {
		return null;
	}
}

/**
 * True when a failing validation may show an output excerpt: every validation in
 * the command is a test runner or a build (`FAILURE_EXCERPT_VALIDATIONS`). A lint,
 * format or type-check failure prints lines of the file it was pointed at.
 */
export function failureExcerptAllowed(input: unknown): boolean {
	const labels = validationLabelsOf(input);
	return labels?.every((l) => FAILURE_EXCERPT_VALIDATIONS.has(l)) === true;
}

// ── validation results ───────────────────────────────────────────────────────

const FAILURE_PATTERNS: RegExp[] = [
	/\bFAIL(ED|URES?)?\b/,
	/\b[1-9]\d* (fail|failed|failing|failures?)\b/i,
	/\b[1-9]\d* errors?\b/i,
	/\berror TS\d+/,
	/\bAssertionError\b/,
	/\bpanicked at\b/,
	/\bnpm ERR!/,
	/\bTraceback \(most recent call last\)/,
	/(^|\n)\s*(error|Error|ERROR)\b/,
	/[✗✘×]\s/u,
];
const PASS_PATTERNS: RegExp[] = [
	/\b[1-9]\d* pass(ed|ing)?\b/i,
	/\bFound 0 errors\b/,
	/\bTests?:.*\b[1-9]\d* passed\b/,
	/\btest result: ok\b/,
	/\bAll checks passed\b/i,
	/\bSuccess: no issues found\b/,
	/(^|\n)ok\s+\S+\s+[\d.]+s\b/,
	/\bNo fixes applied\b/,
	/\bno (errors|issues|problems) found\b/i,
	/\bCompiled successfully\b/i,
	/\bBuild succeeded\b/i,
];

/**
 * The result of a clean validation, from the FULL stored response (never the
 * excerpt): `failed` for a failure hook or pattern, `ok` only with a pass
 * pattern, an exit signal and no exit masking, otherwise `unknown`.
 * `noExitSignal` is a call that carries neither an exit code nor a failure
 * event (status `completed`): its text is attacker-controlled and cannot say it
 * passed, though a failure pattern in it still counts.
 */
export function validationResult(
	response: string | null | undefined,
	failedHook: boolean,
	masked: boolean,
	noExitSignal = false,
): ValidationResult {
	const text = response ?? "";
	if (failedHook || FAILURE_PATTERNS.some((p) => p.test(text))) return "failed";
	if (masked || noExitSignal) return "unknown";
	return PASS_PATTERNS.some((p) => p.test(text)) ? "ok" : "unknown";
}

const PASS_COUNT_RE = /\b([1-9]\d{0,5}) pass(?:ed|ing)?\b/i;
const FAIL_COUNT_RE = /\b(\d{1,6}) fail(?:ed|ing|ures?)?\b/i;

/**
 * A server-built `N pass, M fail` from the counts a pass output carried, never
 * the output's own text; null when no pass count was captured. The one thing a
 * passing validation sends.
 */
export function passSummaryLine(response: string | null | undefined): string | null {
	const text = response ?? "";
	const pass = PASS_COUNT_RE.exec(text)?.[1];
	if (!pass) return null;
	return `${pass} pass, ${FAIL_COUNT_RE.exec(text)?.[1] ?? "0"} fail`;
}
