/**
 * A deliberately tiny evaluator for the few PowerShell statements the hook
 * command builders in scripts/install-local.ps1 are made of, so the parity test
 * can compare what those functions BUILD with the generator's text without a
 * PowerShell host. It understands exactly:
 *
 *   $name = "double-quoted string"            ($var and $script:Var interpolation;
 *                                              `" `$ `n `` escapes)
 *   $name = "str" + $var + 'str'              (concatenation)
 *   $name = if ($Flag) { expr } else { expr }
 *   if ($Name -eq "text") { $name = expr }
 *   $name = $name.Replace('hole', expr)       ($var, $script:Var, '...' arguments)
 *
 * Anything else inside a function body (other than `param(...)`, comments and
 * the one known base-URL validation block) makes it throw, so a change to the
 * function that leaves the subset fails the test loudly instead of being
 * skipped. It also throws on the constructs it would otherwise read differently
 * from PowerShell: a `$( )` subexpression or a doubled quote inside a
 * double-quoted string, a `${braced}` name, a variable followed by a colon
 * other than `$script:`, and a boolean turned into text (PowerShell prints
 * True/False). It never executes PowerShell and is not a PowerShell
 * implementation.
 */

export type PsValue = string | boolean;

/** The one base-URL validation block the evaluator skips (it is a throw, not a value); anything else there is refused. */
const KNOWN_BASE_URL_VALIDATION = `  if ($BaseUrl -notmatch '^https?://([A-Za-z0-9.-]+|\\[[0-9A-Fa-f:]+\\])(:[0-9]{1,5})?$') {
    throw "invalid AgentPulse base URL for a hook command: $BaseUrl"
  }
`;
type Scope = Record<string, PsValue>;

/** The body of `function <name> { ... }` (brace-balanced, ignoring braces inside string literals). */
export function psFunctionBody(source: string, name: string): string {
	const start = source.indexOf(`function ${name} {`);
	if (start === -1) throw new Error(`function ${name} not found`);
	let depth = 0;
	let i = source.indexOf("{", start);
	const bodyStart = i + 1;
	let quote: string | null = null;
	for (; i < source.length; i++) {
		const ch = source[i] as string;
		if (quote) {
			if (ch === "`") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "#") {
			// a comment (outside every string): skip to the end of the line
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) return source.slice(bodyStart, i);
		}
	}
	throw new Error(`unterminated function ${name}`);
}

function lookup(scope: Scope, name: string): PsValue {
	if (!(name in scope)) throw new Error(`undefined PowerShell variable $${name}`);
	return scope[name] as PsValue;
}

/** A value as text. A boolean is refused: PowerShell would print True/False, not true/false. */
function asText(value: PsValue, name: string): string {
	if (typeof value === "boolean") {
		throw new Error(
			`boolean $${name} turned into text: PowerShell prints True/False, which this evaluator does not model`,
		);
	}
	return value;
}

function interpolate(raw: string, scope: Scope): string {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i] as string;
		if (ch === "`") {
			const next = raw[++i] as string;
			out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
			continue;
		}
		if (ch === "$") {
			if (raw[i + 1] === "(") {
				throw new Error(
					"a $( ) subexpression inside a double-quoted string is outside the evaluator's subset",
				);
			}
			if (raw[i + 1] === "{") {
				throw new Error(
					"a braced ${name} variable inside a double-quoted string is outside the evaluator's subset",
				);
			}
			const m = /^\$((?:script:)?[A-Za-z_][A-Za-z0-9_]*)/.exec(raw.slice(i));
			if (m) {
				const after = raw[i + (m[0] as string).length];
				if (after === ":") {
					throw new Error(
						`$${m[1]} followed by a colon is a scope or drive reference in PowerShell; only $script: is modelled`,
					);
				}
				out += asText(lookup(scope, m[1] as string), m[1] as string);
				i += (m[0] as string).length - 1;
				continue;
			}
		}
		out += ch;
	}
	return out;
}

/** Splits `a + b + c` at top-level plus signs (outside string literals). */
function splitPlus(expr: string): string[] {
	const parts: string[] = [];
	let quote: string | null = null;
	let current = "";
	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i] as string;
		if (quote) {
			current += ch;
			if (ch === "`") current += expr[++i] as string;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "+") {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	parts.push(current.trim());
	return parts;
}

export function evalExpr(expr: string, scope: Scope): string {
	return splitPlus(expr)
		.map((term) => {
			if (term.startsWith('"') && term.endsWith('"') && term.length >= 2) {
				const inner = term.slice(1, -1);
				if (inner.replace(/`./g, "").includes('""')) {
					throw new Error(
						"a doubled quote inside a double-quoted string is outside the evaluator's subset",
					);
				}
				return interpolate(inner, scope);
			}
			if (term.startsWith("'") && term.endsWith("'")) return term.slice(1, -1).replace(/''/g, "'");
			const v = /^\$((?:script:)?[A-Za-z_][A-Za-z0-9_]*)$/.exec(term);
			if (v) return asText(lookup(scope, v[1] as string), v[1] as string);
			throw new Error(`PowerShell expression outside the evaluator's subset: ${term}`);
		})
		.join("");
}

/** Runs the statements of a builder function body against `scope` (arguments plus `script:Name` values) and returns the final scope. */
export function runPsBuilder(body: string, scope: Scope): Scope {
	const out: Scope = { ...scope };
	// Drop the param block, comments and the base-URL validation (a throw, not a value). The
	// validation is dropped only when it is exactly the one this was written against.
	const validation = /if \(\$BaseUrl -notmatch [\s\S]*?\n {2}\}\n/.exec(body);
	if (validation && `  ${validation[0]}` !== KNOWN_BASE_URL_VALIDATION) {
		throw new Error(
			"the base-URL validation differs from the one the evaluator skips; it would no longer be checked",
		);
	}
	const text = body
		.replace(/param\([\s\S]*?\n {2}\)\n/, "")
		.replace(/^\s*#.*$/gm, "")
		.replace(/if \(\$BaseUrl -notmatch [\s\S]*?\n {2}\}\n/, "");
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] as string).trim();
		if (!line) continue;

		let m = /^\$(\w+) = if \(\$(\w+)\) \{\s*(.*?)\s*\} else \{\s*(.*?)\s*\}$/.exec(line);
		if (m) {
			out[m[1] as string] = evalExpr(
				out[m[2] as string] ? (m[3] as string) : (m[4] as string),
				out,
			);
			continue;
		}
		// the multi-line form: `$name = if ($Flag) {` ... `} else {` ... `}`
		m = /^\$(\w+) = if \(\$(\w+)\) \{$/.exec(line);
		if (m) {
			const whenTrue = (lines[++i] as string).trim();
			if ((lines[++i] as string).trim() !== "} else {") throw new Error("unexpected if/else shape");
			const whenFalse = (lines[++i] as string).trim();
			if ((lines[++i] as string).trim() !== "}") throw new Error("unexpected if/else shape");
			out[m[1] as string] = evalExpr(out[m[2] as string] ? whenTrue : whenFalse, out);
			continue;
		}
		m = /^if \(\$(\w+) -eq "([^"]*)"\) \{$/.exec(line);
		if (m) {
			const inner = (lines[++i] as string).trim();
			if ((lines[++i] as string).trim() !== "}") throw new Error("unexpected if shape");
			const assign = /^\$(\w+) = (.+)$/.exec(inner);
			if (!assign) throw new Error(`unsupported statement in an if block: ${inner}`);
			if (out[m[1] as string] === m[2])
				out[assign[1] as string] = evalExpr(assign[2] as string, out);
			continue;
		}
		m = /^\$(\w+) = \$\1\.Replace\('([^']*)', (.+)\)$/.exec(line);
		if (m) {
			const target = String(lookup(out, m[1] as string));
			out[m[1] as string] = target.split(m[2] as string).join(evalExpr(m[3] as string, out));
			continue;
		}
		m = /^\$(\w+) = (.+)$/.exec(line);
		if (m) {
			out[m[1] as string] = evalExpr(m[2] as string, out);
			continue;
		}
		if (/^return \$(\w+)$/.test(line)) continue;
		throw new Error(`PowerShell statement outside the evaluator's subset: ${line}`);
	}
	return out;
}
