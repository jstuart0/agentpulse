/**
 * Portable "ask for the API key without echoing it" for pasted shell snippets.
 *
 * - `read -s` is a bash/zsh/ksh extension, not POSIX (dash rejects it), so
 *   echo is switched off with `stty` instead.
 * - If echo can't be switched off on a terminal, the snippet refuses rather
 *   than show the key.
 * - The read happens in a command substitution: its traps and the saved
 *   terminal state (`stty -g`) never touch the user's own traps, and the
 *   whole snippet is a subshell, so the key variable and the export vanish
 *   with it instead of staying in the user's interactive shell.
 * - Ctrl-C (or a hangup) at the prompt exits the read at once, and the EXIT
 *   trap puts the terminal back exactly as it was.
 * - When stdin isn't a terminal (piped input) there is nothing to hide.
 * - Only [A-Za-z0-9._-] is accepted, so nothing typed can break out of the
 *   quoted value the snippets write into a file.
 */

const ALLOWED_KEY_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";

/** Assignment of the typed key to shell variable `varName`, input hidden. */
function hiddenKeyRead(varName: string): string {
	const refuseToShow =
		"Can't hide the key while you type it, so it won't be asked for here. Use the scripted form in the docs instead.";
	const steps = [
		"if [ -t 0 ]; then",
		`s=$(stty -g 2>/dev/null) && stty -echo 2>/dev/null || { echo "${refuseToShow}" >&2; exit 1; };`,
		"trap 'echo >&2; exit 130' INT TERM HUP;",
		`trap 'stty "$s" 2>/dev/null' EXIT;`,
		"fi;",
		"printf 'AgentPulse API key: ' >&2;",
		"IFS= read -r k;",
		"if [ -t 0 ]; then echo >&2; fi;",
		'printf %s "$k"',
	];
	return `${varName}=$(${steps.join(" ")})`;
}

/**
 * Ask for the key, check it, and only then run `onKey` (which can use
 * `$varName`). A cancelled or failed read, a blank answer and a key with
 * unexpected characters all print a clear message, write nothing and fail.
 * Everything runs in a subshell.
 */
export function withHiddenKey(varName: string, onKey: string, nothingDone: string): string {
	const refuse = (message: string) => `echo "${message}; ${nothingDone}" >&2; false`;
	return (
		`( ${hiddenKeyRead(varName)} && case "$${varName}" in ` +
		`'') ${refuse("No API key entered")};; ` +
		`*[!${ALLOWED_KEY_CHARACTERS}]*) ${refuse("The API key can only contain letters, digits, '.', '_' and '-'")};; ` +
		`*) ${onKey};; esac )`
	);
}
