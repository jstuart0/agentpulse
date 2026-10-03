# Hook runtime observations: cwd, env inheritance, and header behavior

Empirical notes on how Codex CLI, GitHub Copilot CLI, and Claude Code actually behave when a
hook fires — gathered by exercising each real CLI in an isolated `HOME` (and, for Codex,
`CODEX_HOME`; for Claude Code, `CLAUDE_CONFIG_DIR`), pointed at a loopback-only (`127.0.0.1`)
stub standing in for each CLI's own model backend so no request left the machine. No real
`~/.codex`, `~/.claude`, `~/.copilot`, or `~/.agentpulse` was touched; every stub server and
temp directory was torn down afterward.

**Environment**: macOS 26.3 (BuildVersion 25D125), Darwin 25.3.0.

- Codex CLI **0.145.0** (`/opt/homebrew/bin/codex`)
- GitHub Copilot CLI **1.0.82** (`/opt/homebrew/bin/copilot`)
- Claude Code **2.1.286** (`/opt/homebrew/bin/claude`)

## How this was measured

- **Codex**: isolated `CODEX_HOME`/`HOME`; `config.toml`'s `model_provider` pointed at a local
  stub server emulating the Responses API (`wire_api = "chat"`, the older Chat Completions
  shape, is rejected outright on 0.145.0 with `wire_api = "chat" is no longer supported`, so the
  stub answers `/v1/responses` with a `response.completed` SSE event instead). A throwaway
  `async:false` `SessionStart` command hook wrote `pwd -P` and
  `${AGENTPULSE_SKIP:-unset}` to a capture file. Ran
  `codex exec --dangerously-bypass-hook-trust --skip-git-repo-check -C <tmp-workdir> "say hi"`
  with `AGENTPULSE_SKIP=1`, stdin closed.
- **Copilot**: isolated `HOME` (Copilot has no `CODEX_HOME`-equivalent override; it always
  reads `$HOME/.copilot`). BYOK env vars (`COPILOT_PROVIDER_BASE_URL`,
  `COPILOT_PROVIDER_WIRE_API=completions`, `COPILOT_MODEL`) pointed at a second local stub
  server emulating the OpenAI Chat Completions shape — BYOK mode also skips GitHub
  authentication entirely (`copilot help providers`). A `sessionStart` command hook (the global
  `~/.copilot/hooks/agentpulse.json` shape) did the same capture. Ran
  `copilot -p "say hi" --allow-all-tools --allow-all-paths --allow-all-urls` from inside the
  target directory (no flag equivalent to Codex's `-C` was found in `--help`), with
  `AGENTPULSE_SKIP=1`, stdin closed.
- **Claude Code**: isolated `HOME`/`CLAUDE_CONFIG_DIR`; `ANTHROPIC_BASE_URL` pointed at a third
  local stub server emulating the Messages API, with a project-scoped `.claude/settings.json`
  registering HTTP hooks (`{"type":"http", "allowedEnvVars":["AGENTPULSE_SKIP"],
  "headers":{"X-AgentPulse-Skip":"$AGENTPULSE_SKIP"}}`) whose `url` pointed at the stub's
  `/v1/hooks` endpoint, which recorded the received request headers to a file. Ran
  `claude -p "say hi" --dangerously-skip-permissions` with stdin closed, once with
  `AGENTPULSE_SKIP` unset and once with it set to `1`.

A post-run check confirmed none of the four real config directories listed above were modified
(mtimes predate the run; a content grep for the stub ports/markers this exercise used, against
the real `~/.claude/settings*.json`, found nothing).

## Findings

### Hook process cwd matches the session's working directory (Codex, Copilot)

- Codex: the `SessionStart` hook's `pwd -P` output was byte-identical to the realpath of the
  `-C`-targeted directory.
- Copilot: the `sessionStart` hook's `pwd -P` output was byte-identical to the realpath of the
  directory `copilot` was launched from.
- Both hook commands are spawned as ordinary child processes of the agent CLI, inheriting the
  parent's current working directory unmodified — neither CLI remaps or sandboxes it.

### Env var inheritance into the hook process (Codex, Copilot)

- Codex: the hook's `${AGENTPULSE_SKIP:-unset}` read back `1` when the CLI was launched with
  `AGENTPULSE_SKIP=1`.
- Copilot: same result, same mechanism.
- Both hook commands inherit the launching process's environment unmodified — neither CLI
  filters, remaps, or sandboxes it. `AGENTPULSE_SKIP=1 codex …` and `AGENTPULSE_SKIP=1
  copilot …` both reached the hook subprocess's environment verbatim, with no fallback or
  special-casing needed on either side.

### Claude Code's header value for an unset allowed env var

With `AGENTPULSE_SKIP` unset in the process environment but listed in a hook's
`allowedEnvVars`, the `X-AgentPulse-Skip` header arrived as an **empty string** (`""`) — never
absent, and never the literal, unexpanded `$AGENTPULSE_SKIP` — on every hook event tested. With
`AGENTPULSE_SKIP=1` set, the same header arrived as `"1"`. Observed on `UserPromptSubmit`,
`Stop`, and `SessionEnd`.

### Claude Code does not fire an HTTP hook for `SessionStart`

On this Claude Code version, configuring an HTTP-type hook for `SessionStart` never results in
a request: the debug log reports `Skipping HTTP hook <url> — HTTP hooks are not supported for
SessionStart`, unconditionally — not tied to non-interactive (`-p`) mode, and decided before any
model call is attempted. `UserPromptSubmit`, `Stop`, and `SessionEnd` HTTP hooks all fired
normally, each carrying the header behavior described above.

### Not measured: a non-loopback Claude Code HTTP hook

Whether Claude Code actually attempts delivery to a non-loopback URL (as opposed to being
restricted to `localhost`) was not tested here, since observing that honestly requires letting
Claude Code attempt a real connection to an address outside this exercise's control — which its
"stay fully loopback, no network side effects" constraint ruled out. This remains open and
should be revisited under conditions that permit it (e.g. a controlled receiving endpoint the
tester owns).

## How the hook command is run, and what the command is built around

What is **measured here** and what is **read from the agents' published source and docs** are kept
apart; nothing in the second list was exercised against a real agent.

### Measured on this machine

- A `-lc` login shell on macOS puts the system directories ahead of anything a caller put first
  in `PATH` (`/usr/libexec/path_helper` runs from the system profile), for `zsh -lc` and
  `bash -lc` alike. A test that wants a stub `curl` to win cannot rely on `PATH` order under a
  login shell: `scripts/hook-command-login-shell.test.ts` runs the real `curl` against a receiver
  on a random loopback port instead.
- The generated hook command was run as one argument to `zsh -lc`, `bash -lc`, `sh -c`,
  `dash -c` and `bash --posix -c`, in a throwaway home with no profile files, and behaves the
  same in all of them (sent, excluded, invalid rules, skip variable). The exclusion check is a
  separate script run as `/bin/sh <script>`, never the login shell.

### Read from source and docs (not exercised here)

- Codex runs a command hook as `<the session's shell> -lc <string>`, so on macOS the hook text is
  parsed by zsh and the profile files are read for every hook.
- Codex hook timeout is 600 s by default, but 1 s (maximum 3 s) for `SessionEnd` and `Interrupt`;
  it waits for the command's stdout and stderr to close, so the redirect that detaches the
  background work is load-bearing, and the parent must exit immediately.
- Codex's trust hash covers the hook definition including the command string, not any script the
  command runs. A changed command is skipped until approved again, per entry. This is why the
  check lives in one installed script: the approval screen shows a short command, and changing
  the check does not ask for twelve new approvals. The cost, accepted: the script's content is not
  covered by that approval, which is why the command only runs it when the script and its
  directory are owned by the user and writable by nobody else.
- A command that passes through `cmd.exe` on Windows is limited to 8,191 characters.
- Unconfirmed: how Codex renders a long multi-line command on its review screen; whether literal
  tab, carriage-return or byte-order-mark bytes survive its trust normalisation (the command
  carries none: it builds the trim set with `printf` and keeps the invisible characters in the
  installed script); Copilot's exact shell invocation and whether it accepts a multi-line
  `bash` string; the macOS argument-size limit.
