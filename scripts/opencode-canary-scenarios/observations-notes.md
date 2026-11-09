## Reading of the stop gates

- **G9 reads `stop`.** On 1.19.5, a plugin file in `$XDG_CONFIG_HOME/opencode/plugins/` makes a cold first run wait about 72 s when the network is blocked (a run with no plugin takes about 2 s; 2.2.6 with a plugin takes about 2 s). The run then finishes normally and loads the plugin. The plan says to stop and re-plan when a first run stalls offline, so the observations test fails on purpose until the plan is revised.
- **What the stall is.** On 1.x, a populated plugin directory makes OpenCode try to install its plugin SDK (`@opencode-ai/plugin`) into the config directory. An early run in this phase, before the network profile existed, opened about 15 sockets, all to one public host on port 443 (the package registry). With the registry unreachable, no `package.json` or `node_modules` is written and the run waits out a timeout. Pointing `NPM_CONFIG_REGISTRY` / `BUN_CONFIG_REGISTRY` at a closed loopback port made no difference (72 s again), so those variables are not what 1.x reads.
- **Caveat.** "Network blocked" is the sandbox profile refusing the connection. A machine that is really offline fails at DNS and could behave differently. That wasn't measured, and can't be here (the canary may not disconnect the machine).
- **G1 and G2 read `pass`.** Both lines load a global plugin from `$XDG_CONFIG_HOME/opencode/plugins/`. A flat file of the other line's style is logged only in the log file on both lines, never on the terminal of `opencode run`. 1.x does not load a plugin directory at all (it's silent); 2.x loads one. So the flat layout (P4 option A) holds; the directory layout (option C) would not work on 1.x.

## What the harness does because of what was measured

- Every OpenCode child runs under `sandbox-exec` with a profile that refuses all outbound traffic except loopback and unix sockets (`NETWORK_PROFILE`). A bare 1.19.5 run reached the package registry on its own, so sampling sockets and failing afterwards was not enough.
- 1.x places that aren't measuring G9 get a warm config directory (a clone of the `package.json` and `node_modules` an earlier online run installed), so they don't wait out the stall on every run. G9 itself uses a cold one.
- The sandbox accepts three extra variable names beyond `PROBE_*`/`STUB_*`/`AGENTPULSE_SKIP`: `NPM_CONFIG_REGISTRY` and `BUN_CONFIG_REGISTRY` (loopback URLs only) and `OPENCODE_SERVER_PASSWORD`/`_USERNAME` (to drive a served instance over HTTP).

## Limits of the safety checks

- Four OpenCode directories (`~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`) are compared whole before and after each scenario and each run: they must stay absent. The exclude rules, the gate script, the hook key file and the Claude and Codex settings files are compared by content hash. No entry in `~/.agentpulse`, `~/.claude` or `~/.codex` may be named `opencode`.
- Beyond that, those three homes can't be compared whole: the user's own Claude, Codex and supervisor write to them while a run is going (measured: files change within 15 s with no canary running). Their churn is reported as a count, not judged.
- The unset-XDG default (`~/.config` on macOS) was not run: the sandbox refuses an unset XDG variable. XDG_CONFIG_HOME is honoured and nothing was created under the sandbox HOME.
- A TUI session, Linux and Windows were not measured.
