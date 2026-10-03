/**
 * Shared helpers for check-no-test-seam-leaks.ts: find exported
 * test-only seams declared in production code — a function or const whose
 * name ends in "ForTest" or "ForTests", declared directly or exported under
 * that name through an export list — and every place that uses one wrongly:
 * a reference from outside a test file or test-utils/, a call from a
 * production function in the seam's own file, or a production import of a
 * test-utils module (which could launder a seam past the first rule).
 *
 * Seams live in production files today (event-processor.ts's
 * _setPreInsertRaceHookForTest, ingest.ts's
 * _setEnqueueHookProcessingOverrideForTest, search/index.ts's
 * __resetSearchBackendForTests, and more) — this guard makes sure they, and
 * any future one, are only ever called from a test.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** A seam name: ends in ForTest or ForTests. */
const SEAM_NAME = String.raw`\w*ForTests?`;
const SEAM_NAME_EXACT_RE = new RegExp(`^${SEAM_NAME}$`);

/** `export [async] function|const|let|var <seam>` */
const TEST_SEAM_DECLARATION_RE = new RegExp(
	String.raw`export\s+(?:async\s+)?(?:function\s*\*?|const|let|var)\s+(${SEAM_NAME})\b`,
	"g",
);

/** `export { ... }`, `export type { ... }`, with or without `from "..."`. */
const EXPORT_LIST_RE = /export\s+(?:type\s+)?\{([^}]*)\}/g;

/** Names an export list exposes: `a`, `a as b` (the exported name is `b`), `type a`. */
function exportedNames(listBody: string): string[] {
	return listBody
		.split(",")
		.map((entry) => entry.replace(/\/\/.*$/gm, "").trim())
		.filter(Boolean)
		.map((entry) => {
			const withoutType = entry.replace(/^type\s+/, "");
			const renamed = withoutType.split(/\s+as\s+/);
			return (renamed[renamed.length - 1] ?? "").trim();
		});
}

/** Every distinct seam-named export declared in `content`. */
export function extractTestSeamExports(content: string): string[] {
	const names = new Set<string>();
	for (const match of content.matchAll(TEST_SEAM_DECLARATION_RE)) {
		names.add(match[1] as string);
	}
	for (const match of content.matchAll(EXPORT_LIST_RE)) {
		for (const name of exportedNames(match[1] as string)) {
			if (SEAM_NAME_EXACT_RE.test(name)) names.add(name);
		}
	}
	return [...names];
}

/** 1-based line numbers in `content` where `name` appears as a whole identifier. */
export function findIdentifierLines(content: string, name: string): number[] {
	const re = new RegExp(`\\b${name}\\b`);
	const lines = content.split("\n");
	const hits: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) hits.push(i + 1);
	}
	return hits;
}

/** A file whose references to a test seam are never a violation. */
export function isTestOnlyPath(relPath: string): boolean {
	return /\.(test|fixture)\.tsx?$/.test(relPath) || /(^|\/)test-utils\//.test(relPath);
}

async function* walkTs(dir: string): AsyncGenerator<string> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
			yield* walkTs(full);
		} else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
			yield full;
		}
	}
}

export interface SeamFile {
	rel: string;
	content: string;
}

/** Reads every .ts file under each root, relative to `repoRoot`. */
export async function loadTsFiles(repoRoot: string, roots: string[]): Promise<SeamFile[]> {
	const files: SeamFile[] = [];
	for (const root of roots) {
		for await (const filePath of walkTs(root)) {
			const rel = relative(repoRoot, filePath);
			files.push({ rel, content: await readFile(filePath, "utf8") });
		}
	}
	return files;
}

/**
 * `content` with every comment and string/template body replaced by spaces
 * (newlines kept), so a scan for identifiers and braces sees only code and
 * line numbers still match the original.
 */
export function blankCommentsAndStrings(content: string): string {
	let out = "";
	let i = 0;
	const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
	while (i < content.length) {
		const ch = content[i] as string;
		const next = content[i + 1];
		if (ch === "/" && next === "/") {
			while (i < content.length && content[i] !== "\n") out += blank(content[i++] as string);
		} else if (ch === "/" && next === "*") {
			out += "  ";
			i += 2;
			while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
				out += blank(content[i++] as string);
			}
			out += "  ";
			i += 2;
		} else if (ch === '"' || ch === "'" || ch === "`") {
			out += ch;
			i++;
			while (i < content.length && content[i] !== ch) {
				if (content[i] === "\\") {
					out += blank(content[i++] as string);
				}
				out += blank(content[i++] as string);
			}
			out += ch;
			i++;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

const TOP_LEVEL_DECLARATION_RE =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b|const\b|let\b|var\b|interface\b|type\b|enum\b)/;
const EXPORT_LIST_LINE_RE = /^export\s+(?:type\s+)?\{/;
const DECLARED_NAME_RE = /(?:function\s*\*?|const|let|var|class)\s+(\w+)/;

interface TopLevelBlock {
	name: string | null;
	startLine: number;
	lines: string[];
}

/** Splits code (comments/strings already blanked) into top-level declaration blocks by brace/paren depth. */
function topLevelBlocks(blanked: string): TopLevelBlock[] {
	const blocks: TopLevelBlock[] = [];
	let depth = 0;
	let current: TopLevelBlock | null = null;
	blanked.split("\n").forEach((line, index) => {
		if (depth === 0 && (TOP_LEVEL_DECLARATION_RE.test(line) || EXPORT_LIST_LINE_RE.test(line))) {
			const isExportList = EXPORT_LIST_LINE_RE.test(line);
			current = {
				name: isExportList ? null : (DECLARED_NAME_RE.exec(line)?.[1] ?? null),
				startLine: index + 1,
				lines: [],
			};
			if (isExportList) current.name = "<export list>";
			blocks.push(current);
		}
		current?.lines.push(line);
		for (const ch of line) {
			if (ch === "{" || ch === "(" || ch === "[") depth++;
			else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
		}
	});
	return blocks;
}

/**
 * Lines in a seam's defining file where an ordinary (non-seam) top-level
 * declaration refers to the seam: production code in the same file
 * calling the hole it poked for tests. A seam may refer to itself and to
 * another seam; an export list is the seam's declaration, not a use.
 */
function selfCallLines(content: string, seamName: string): Array<{ line: number; inside: string }> {
	const identifier = new RegExp(`\\b${seamName}\\b`);
	const hits: Array<{ line: number; inside: string }> = [];
	for (const block of topLevelBlocks(blankCommentsAndStrings(content))) {
		if (block.name === "<export list>") continue;
		if (block.name && SEAM_NAME_EXACT_RE.test(block.name)) continue;
		block.lines.forEach((line, offset) => {
			if (identifier.test(line)) {
				hits.push({ line: block.startLine + offset, inside: block.name ?? "top-level code" });
			}
		});
	}
	return hits;
}

/** `from "..."`, `import "..."` or `import("...")` whose specifier goes through a test-utils/ directory. */
const TEST_UTILS_IMPORT_RE =
	/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']((?:[^"']*\/)?test-utils\/[^"']*)["']/;

/**
 * Given the already-loaded file set, find:
 *  - every reference to a seam outside the seam's own defining file(s), a
 *    test file, or a test-utils/ directory;
 *  - every call to a seam from a non-seam declaration in its own defining
 *    file;
 *  - every import of a test-utils/ module from a production file.
 * One violation string per offending line.
 */
export function collectViolationsFromFiles(files: SeamFile[]): string[] {
	const seamDefiners = new Map<string, string[]>();
	for (const file of files) {
		if (isTestOnlyPath(file.rel)) continue; // a test file declaring a same-shaped helper isn't a seam under test here
		for (const name of extractTestSeamExports(file.content)) {
			const definers = seamDefiners.get(name) ?? [];
			definers.push(file.rel);
			seamDefiners.set(name, definers);
		}
	}

	const violations: string[] = [];
	for (const [name, definers] of seamDefiners) {
		for (const file of files) {
			if (isTestOnlyPath(file.rel)) continue;
			if (definers.includes(file.rel)) {
				for (const { line, inside } of selfCallLines(file.content, name)) {
					violations.push(
						`${file.rel}:${line}: production code ("${inside}") calls test-only seam "${name}" declared in the same file`,
					);
				}
				continue;
			}
			for (const lineNo of findIdentifierLines(file.content, name)) {
				violations.push(
					`${file.rel}:${lineNo}: references test-only seam "${name}" (defined in ${definers.join(", ")}) outside a test file or test-utils/`,
				);
			}
		}
	}

	for (const file of files) {
		if (isTestOnlyPath(file.rel)) continue;
		file.content.split("\n").forEach((line, index) => {
			if (/^\s*(\/\/|\*)/.test(line)) return;
			const specifier = TEST_UTILS_IMPORT_RE.exec(line)?.[1];
			if (specifier) {
				violations.push(
					`${file.rel}:${index + 1}: production code imports "${specifier}" — test-utils/ modules are for tests only`,
				);
			}
		});
	}
	return violations;
}

/** Walks `roots` under `repoRoot` and returns every violation found. */
export async function collectTestSeamViolations(
	repoRoot: string,
	roots: string[],
): Promise<string[]> {
	const files = await loadTsFiles(repoRoot, roots);
	return collectViolationsFromFiles(files);
}
