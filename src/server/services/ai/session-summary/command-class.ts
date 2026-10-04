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
 */

export type CommandClass =
	| { kind: "validation"; masked: boolean }
	| { kind: "withheld" }
	| { kind: "not_shown" }
	/** `hasViewer`: a segment runs a file viewer, so a failure's output is never excerpted. */
	| { kind: "ordinary"; hasViewer: boolean };

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
const STANDALONE_VALIDATORS = new Set([
	"vitest",
	"jest",
	"pytest",
	"tox",
	"tsc",
	"biome",
	"eslint",
	"ruff",
	"mypy",
]);
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
const MAX_UNWRAP_DEPTH = 8;
const MAX_SEGMENTS = 400;

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
		if (!v.startsWith("-") || v === "-" || v === "--") break;
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

function isCredentialFile(token: string): boolean {
	const candidates = token.includes("=") ? [token, token.slice(token.indexOf("=") + 1)] : [token];
	return candidates.some((c) => {
		const path = c.toLowerCase().replace(/\/+$/, "");
		if (!path) return false;
		const base = path.slice(path.lastIndexOf("/") + 1);
		return (
			base.startsWith(".env") ||
			base === ".netrc" ||
			base === ".npmrc" ||
			base === ".pypirc" ||
			base === ".git-credentials" ||
			base.startsWith("id_rsa") ||
			base.startsWith("id_ed25519") ||
			base.startsWith("id_ecdsa") ||
			base.startsWith("id_dsa") ||
			base.endsWith(".pem") ||
			base.endsWith(".key") ||
			base === "kubeconfig" ||
			path.endsWith("/.kube/config") ||
			path === ".kube/config" ||
			base.startsWith("credentials") ||
			/(^|[._-])secrets?([._-]|$)/.test(base) ||
			/(^|\/)config\/prod/.test(path) ||
			base.endsWith(".tfvars") ||
			base.endsWith(".tfvars.json")
		);
	});
}

function readsCredentials(words: Word[]): boolean {
	const head = words[0];
	if (!head) return false;
	const cmd = baseName(head.value);
	const args = words.slice(1).map((w) => w.value);
	const rawText = joinRaw(words);
	const has = (...names: string[]) => names.every((n) => args.includes(n));
	const firstNonFlag = args.find((a) => !a.startsWith("-"));

	if (/\/proc\/[^\s]*\/environ/.test(rawText)) return true;
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
			return args.length === 0 || args.some((a) => a === "-x" || a === "-p" || a === "-xp");
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
			break;
		case "docker":
		case "podman":
			if (args[0] === "inspect") return true;
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

	if (VIEWER_COMMANDS.has(cmd) || EXTRA_FILE_READERS.has(cmd)) {
		if (args.some((a) => isCredentialFile(a))) return true;
	}
	for (const [index, w] of words.entries()) {
		if (w.value === "<" && words[index + 1] && isCredentialFile((words[index + 1] as Word).value))
			return true;
		if (/^<[^<]/.test(w.value) && isCredentialFile(w.value.slice(1))) return true;
	}
	return false;
}

// ── validation ───────────────────────────────────────────────────────────────

function isValidationCommand(words: Word[]): boolean {
	const head = words[0];
	if (!head) return false;
	const cmd = baseName(head.value);
	const args = words.slice(1).map((w) => w.value);
	if (JS_TOOL_RUNNERS.has(cmd)) {
		const j = skipFlags(words, 1, new Set());
		const tool = words[j];
		return tool !== undefined && JS_TOOLS.has(baseName(tool.value));
	}
	if (STANDALONE_VALIDATORS.has(cmd)) return true;
	switch (cmd) {
		case "bun":
			return (
				args[0] === "test" ||
				(args[0] === "run" && ["check", "typecheck", "test", "build"].includes(args[1] ?? ""))
			);
		case "npm":
		case "pnpm":
		case "yarn":
			return (
				args[0] === "test" ||
				(args[0] === "run" &&
					["test", "lint", "build", "typecheck", "check"].includes(args[1] ?? ""))
			);
		case "go":
			return args[0] === "test" || args[0] === "vet";
		case "cargo":
			return ["test", "check", "clippy", "build"].includes(args[0] ?? "");
		case "make":
			return ["test", "check", "lint"].includes(args[0] ?? "");
		default:
			return /^python[\d.]*$/.test(cmd) && args[0] === "-m" && args[1] === "pytest";
	}
}

function isBenignValidationFiller(final: Final): boolean {
	const head = final.words[0];
	if (!head) return false;
	const cmd = baseName(head.value);
	if (cmd === "cd") return true;
	if (cmd === "echo") return !joinRaw(final.words.slice(1)).includes("$");
	if (cmd === "true") return true;
	return EXIT_MASKING_PIPE_CONSUMERS.has(cmd);
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

export function classifyCommand(input: unknown): CommandClass {
	try {
		return classify(input);
	} catch {
		return { kind: "not_shown" };
	}
}

function classify(input: unknown): CommandClass {
	const text = toCommandString(input);
	if (text === null || text === "") return { kind: "not_shown" };
	const parsed = parse(text);
	if (parsed.flags.unparseable) return { kind: "not_shown" };

	const flags = parsed.flags;
	const finals: Final[] = [];
	for (const segment of parsed.segments) unwrap(segment.words, segment.sep, flags, 0, finals);
	if (flags.unparseable) return { kind: "not_shown" };
	if (finals.length === 0) return { kind: "not_shown" };

	if (finals.some((f) => readsCredentials(f.words))) return { kind: "withheld" };

	const unreadable =
		flags.subst ||
		flags.heredoc ||
		flags.evalCmd ||
		flags.base64Cmd ||
		flags.pythonC ||
		flags.nodeE;
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
	return {
		kind: "ordinary",
		hasViewer: finals.some((f) => VIEWER_COMMANDS.has(baseName(f.words[0]?.value ?? ""))),
	};
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
 * pattern and no exit masking, otherwise `unknown`.
 */
export function validationResult(
	response: string | null | undefined,
	failedHook: boolean,
	masked: boolean,
): ValidationResult {
	const text = response ?? "";
	if (failedHook || FAILURE_PATTERNS.some((p) => p.test(text))) return "failed";
	if (masked) return "unknown";
	return PASS_PATTERNS.some((p) => p.test(text)) ? "ok" : "unknown";
}

/**
 * Words a command contains when it MIGHT be a validation, as lowercase
 * substrings. The loader's SQL uses them to decide whether to read the full
 * response, so this list is a superset of the classifier's allowlist.
 */
export const COARSE_VALIDATION_TERMS: readonly string[] = [
	"test",
	"vitest",
	"jest",
	"pytest",
	"tox",
	"tsc",
	"biome",
	"eslint",
	"ruff",
	"mypy",
	"typecheck",
	"check",
	"lint",
	"build",
	"vet",
	"clippy",
];

/** The first line a pass pattern matched, capped (stub, replaced in the fix commit). */
export function passSummaryLine(_response: string | null | undefined): string | null {
	return null;
}
