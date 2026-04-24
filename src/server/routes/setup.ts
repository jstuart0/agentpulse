import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { config } from "../config.js";

const setup = new Hono();

// GET /setup.sh - Serve a self-contained install script
// Usage: curl -sSL https://your-server.com/setup.sh | bash
// Or:    curl -sSL https://your-server.com/setup.sh | bash -s -- --key ap_xxx
setup.get("/setup.sh", (c) => {
	// Detect the port from the request URL so hooks always point to localhost
	const requestHost = c.req.header("Host") || `localhost:${config.port}`;
	const requestPort = requestHost.includes(":")
		? requestHost.split(":")[1]
		: config.port.toString();
	const defaultLocalUrl = `http://localhost:${requestPort}`;

	const script = `#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────
#  AgentPulse - One-Command Hook Setup
#  Configures Claude Code + Codex CLI to report to AgentPulse
# ───────────────────────────────────────────────────

# Hooks MUST point to localhost -- Claude Code and Codex block
# HTTP hooks to remote/private IPs as a security measure.
HOOK_URL="${defaultLocalUrl}"
API_KEY=""

while [[ \$# -gt 0 ]]; do
  case \$1 in
    --key) API_KEY="\$2"; shift 2 ;;
    --url) HOOK_URL="\$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "  AgentPulse Setup"
echo "  ────────────────"
echo "  Hooks will point to: \$HOOK_URL"
echo ""

# ── Claude Code ──

CLAUDE_DIR="\$HOME/.claude"
CLAUDE_SETTINGS="\$CLAUDE_DIR/settings.json"
mkdir -p "\$CLAUDE_DIR"

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit")

HOOKS_JSON="{"
for i in "\${!EVENTS[@]}"; do
  EVENT="\${EVENTS[\$i]}"
  [[ \$i -gt 0 ]] && HOOKS_JSON+=","
  if [[ -n "\$API_KEY" ]]; then
    HOOKS_JSON+="\\"\$EVENT\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"Authorization\\":\\"Bearer \$API_KEY\\",\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
  else
    HOOKS_JSON+="\\"\$EVENT\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"allowedEnvVars\\":[\\"AGENTPULSE_API_KEY\\"],\\"headers\\":{\\"Authorization\\":\\"Bearer \\\\\$AGENTPULSE_API_KEY\\",\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
  fi
done
HOOKS_JSON+="}"

if [[ -f "\$CLAUDE_SETTINGS" ]] && command -v jq &>/dev/null; then
  jq --argjson hooks "\$HOOKS_JSON" '.hooks = (.hooks // {}) * \$hooks' "\$CLAUDE_SETTINGS" > "\$CLAUDE_SETTINGS.tmp"
  mv "\$CLAUDE_SETTINGS.tmp" "\$CLAUDE_SETTINGS"
elif [[ -f "\$CLAUDE_SETTINGS" ]] && command -v python3 &>/dev/null; then
  python3 -c "
import json, sys
with open('\$CLAUDE_SETTINGS') as f: s = json.load(f)
h = json.loads('''\$HOOKS_JSON''')
s.setdefault('hooks', {}).update(h)
with open('\$CLAUDE_SETTINGS', 'w') as f: json.dump(s, f, indent=2)
"
else
  echo '{"hooks":'\$HOOKS_JSON'}' > "\$CLAUDE_SETTINGS"
fi
echo "  ✓ Claude Code hooks configured"

# ── Codex CLI ──

CODEX_DIR="\$HOME/.codex"
mkdir -p "\$CODEX_DIR"

CODEX_EVENTS=("SessionStart" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop")
CODEX_HOOKS="["
for i in "\${!CODEX_EVENTS[@]}"; do
  [[ \$i -gt 0 ]] && CODEX_HOOKS+=","
  if [[ -n "\$API_KEY" ]]; then
    CODEX_HOOKS+="{\\"event\\":\\"\${CODEX_EVENTS[\$i]}\\",\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"Authorization\\":\\"Bearer \$API_KEY\\",\\"X-Agent-Type\\":\\"codex_cli\\"}}"
  else
    CODEX_HOOKS+="{\\"event\\":\\"\${CODEX_EVENTS[\$i]}\\",\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"X-Agent-Type\\":\\"codex_cli\\"}}"
  fi
done
CODEX_HOOKS+="]"

echo '{"hooks":'\$CODEX_HOOKS'}' > "\$CODEX_DIR/hooks.json"
if [[ -f "\$CODEX_DIR/config.toml" ]]; then
  grep -q "codex_hooks" "\$CODEX_DIR/config.toml" || echo -e "\\n[features]\\ncodex_hooks = true" >> "\$CODEX_DIR/config.toml"
else
  echo -e "[features]\\ncodex_hooks = true" > "\$CODEX_DIR/config.toml"
fi
echo "  ✓ Codex CLI hooks configured"

# ── Env vars ──

if [[ -n "\$API_KEY" ]]; then
  PROFILE="\$HOME/.zshrc"
  [[ "\$(basename "\$SHELL")" == "bash" ]] && PROFILE="\$HOME/.bashrc"
  if ! grep -q "AGENTPULSE_API_KEY" "\$PROFILE" 2>/dev/null; then
    echo "" >> "\$PROFILE"
    echo "# AgentPulse" >> "\$PROFILE"
    echo "export AGENTPULSE_API_KEY=\\"\$API_KEY\\"" >> "\$PROFILE"
    echo "export AGENTPULSE_URL=\\"\$HOOK_URL\\"" >> "\$PROFILE"
    echo "  ✓ Added env vars to \$PROFILE"
  fi
fi

# ── Verify ──

if curl -sf "\$HOOK_URL/api/v1/health" >/dev/null 2>&1; then
  echo "  ✓ Server reachable"
else
  echo "  ! Server not reachable at \$HOOK_URL"
fi

echo ""
echo "  Done! Open a new terminal and start a Claude Code or Codex session."
echo ""
`;

	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": "inline; filename=setup.sh",
		},
	});
});

// GET /install-local.sh - Serve the local Bun+SQLite installer
// Usage: curl -sSL http://localhost:3000/install-local.sh | bash
setup.get("/install-local.sh", (c) => {
	const requestHost = c.req.header("Host") || `localhost:${config.port}`;
	const requestPort = requestHost.includes(":")
		? requestHost.split(":")[1]
		: config.port.toString();
	const defaultLocalUrl = `http://localhost:${requestPort}`;
	const installScriptPath = join(import.meta.dir, "../../../scripts/install-local.sh");

	let script = readFileSync(installScriptPath, "utf-8");
	script = script.replace('PUBLIC_URL=""', `PUBLIC_URL="${defaultLocalUrl}"`);

	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": "inline; filename=install-local.sh",
		},
	});
});

// GET /install-local.ps1 - Serve the local Bun+SQLite installer for Windows
// Usage: irm http://localhost:3000/install-local.ps1 | iex
setup.get("/install-local.ps1", (c) => {
	const requestHost = c.req.header("Host") || `localhost:${config.port}`;
	const requestPort = requestHost.includes(":")
		? requestHost.split(":")[1]
		: config.port.toString();
	const defaultLocalUrl = `http://localhost:${requestPort}`;
	const installScriptPath = join(import.meta.dir, "../../../scripts/install-local.ps1");

	let script = readFileSync(installScriptPath, "utf-8");
	script = script.replace('[string]$PublicUrl = ""', `[string]$PublicUrl = "${defaultLocalUrl}"`);

	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": "inline; filename=install-local.ps1",
		},
	});
});

// GET /setup-relay.sh - Self-contained relay setup for remote server users
// Usage: curl -sSL https://your-server.com/setup-relay.sh | bash -s -- --key ap_xxx
setup.get("/setup-relay.sh", (c) => {
	const serverUrl = config.publicUrl || `https://${c.req.header("Host")}`;

	const script = `#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────────
#  AgentPulse Relay Setup (one command, no repo needed)
#
#  Installs a tiny relay on localhost that forwards hook events
#  to your remote AgentPulse server. Includes a LaunchAgent
#  so it auto-starts on login and restarts if it crashes.
#
#  Claude Code blocks hooks to remote IPs -- this relay solves that.
# ───────────────────────────────────────────────────────

REMOTE_URL="${serverUrl}"
API_KEY=""
PORT=4000

while [[ \$# -gt 0 ]]; do
  case \$1 in
    --key) API_KEY="\$2"; shift 2 ;;
    --port) PORT="\$2"; shift 2 ;;
    --url) REMOTE_URL="\$2"; shift 2 ;;
    *) shift ;;
  esac
done

REMOTE_URL="\${REMOTE_URL%/}"

echo ""
echo "  AgentPulse Relay Setup"
echo "  ──────────────────────"
echo "  Remote:  \$REMOTE_URL"
echo "  Local:   http://localhost:\$PORT"
echo ""

# ── Install Bun if needed ──

BUN_PATH=""
if command -v bun &>/dev/null; then
  BUN_PATH="\$(which bun)"
elif [[ -f "\$HOME/.bun/bin/bun" ]]; then
  BUN_PATH="\$HOME/.bun/bin/bun"
else
  echo "  Installing Bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  BUN_PATH="\$HOME/.bun/bin/bun"
fi
echo "  ✓ Bun: \$BUN_PATH"

# ── Install relay script ──

RELAY_DIR="\$HOME/.agentpulse"
mkdir -p "\$RELAY_DIR/logs"

cat > "\$RELAY_DIR/relay.ts" << 'INNER_EOF'
#!/usr/bin/env bun
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
const args = process.argv.slice(2);
let remoteUrl = "", port = 4000, apiKey = "";
const RELAY_FETCH_TIMEOUT_MS = 8000;
const RELAY_IDLE_TIMEOUT_S = 30;
const HOOK_RETRY_BASE_MS = 2000;
const HOOK_RETRY_MAX_MS = 60000;
const HOOK_RETRY_POLL_MS = 5000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i+1]) port = Number(args[++i]);
  else if (args[i] === "--key" && args[i+1]) apiKey = args[++i];
  else if (!args[i].startsWith("--")) remoteUrl = args[i].replace(/\\/$/, "");
}
if (!remoteUrl) { console.error("Usage: relay.ts <url> [--port N] [--key K]"); process.exit(1); }
async function fe(p:string){try{await access(p,constants.F_OK);return true}catch{return false}}
const relayDir = import.meta.dir;
const hookQueueDir = join(relayDir, "hook-queue");
const hookPendingDir = join(hookQueueDir, "pending");
const hookProcessingDir = join(hookQueueDir, "processing");
let queueRunning = false;
let queueTimer = null;
const relayState = {
  lastHookEnqueuedAt: null,
  lastHookForwardedAt: null,
  lastHookFailureAt: null,
  lastHookError: null,
  consecutiveHookFailures: 0,
};
async function ensureQueueDirs() {
  await mkdir(hookPendingDir, { recursive: true });
  await mkdir(hookProcessingDir, { recursive: true });
}
function nextBackoffMs(attempts:number) {
  return Math.min(HOOK_RETRY_MAX_MS, HOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}
function scheduleQueue(delayMs = 0) {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    queueTimer = null;
    void processHookQueue();
  }, delayMs);
}
async function forwardApiRequest(input:{ pathname:string; search:string; method:string; contentType:string; agentType?:string|null; body?:string }) {
  const headers = new Headers();
  headers.set("Content-Type", input.contentType || "application/json");
  if (apiKey) headers.set("Authorization", "Bearer " + apiKey);
  if (input.agentType) headers.set("X-Agent-Type", input.agentType);
  const res = await fetch(remoteUrl + input.pathname + input.search, {
    method: input.method,
    headers,
    body: input.method !== "GET" ? input.body : undefined,
    signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
  });
}
async function enqueueHook(req:Request, url:URL) {
  await ensureQueueDirs();
  const item = {
    id: crypto.randomUUID(),
    pathname: url.pathname,
    search: url.search,
    method: req.method,
    contentType: req.headers.get("Content-Type") || "application/json",
    agentType: req.headers.get("X-Agent-Type"),
    body: await req.text(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    lastError: null,
  };
  await writeFile(join(hookPendingDir, \`\${Date.now()}-\${item.id}.json\`), JSON.stringify(item), "utf-8");
  relayState.lastHookEnqueuedAt = item.createdAt;
  scheduleQueue();
  return item.id;
}
async function leaseNextHook() {
  await ensureQueueDirs();
  const fileNames = (await readdir(hookPendingDir)).filter((name) => name.endsWith(".json")).sort();
  const now = Date.now();
  for (const fileName of fileNames) {
    const pendingPath = join(hookPendingDir, fileName);
    try {
      const item = JSON.parse(await readFile(pendingPath, "utf-8"));
      if (Date.parse(item.nextAttemptAt) > now) continue;
      await rename(pendingPath, join(hookProcessingDir, fileName));
      return { fileName, item };
    } catch {
      try { await unlink(pendingPath); } catch {}
    }
  }
  return null;
}
async function processHookQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (true) {
      const leased = await leaseNextHook();
      if (!leased) break;
      try {
        await forwardApiRequest(leased.item);
        try { await unlink(join(hookProcessingDir, leased.fileName)); } catch {}
        relayState.lastHookForwardedAt = new Date().toISOString();
        relayState.lastHookError = null;
        relayState.consecutiveHookFailures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const updated = {
          ...leased.item,
          attempts: leased.item.attempts + 1,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + nextBackoffMs(leased.item.attempts + 1)).toISOString(),
        };
        await writeFile(join(hookPendingDir, leased.fileName), JSON.stringify(updated), "utf-8");
        try { await unlink(join(hookProcessingDir, leased.fileName)); } catch {}
        relayState.lastHookFailureAt = new Date().toISOString();
        relayState.lastHookError = message;
        relayState.consecutiveHookFailures += 1;
        scheduleQueue(nextBackoffMs(updated.attempts));
      }
    }
  } finally {
    queueRunning = false;
  }
}
async function queueDiagnostics() {
  await ensureQueueDirs();
  const pending = (await readdir(hookPendingDir)).filter((name) => name.endsWith(".json"));
  const processing = (await readdir(hookProcessingDir)).filter((name) => name.endsWith(".json"));
  return { pending: pending.length, processing: processing.length, ...relayState };
}
Bun.serve({
  port, hostname: "127.0.0.1", idleTimeout: RELAY_IDLE_TIMEOUT_S,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/health") return Response.json({ status: "ok", relay: true, remote: remoteUrl });
    if (url.pathname === "/api/v1/relay/diagnostics") {
      return Response.json({ status: "ok", relay: true, remote: remoteUrl, queue: await queueDiagnostics() });
    }
    // Handle agents-md locally (remote can't read local files)
    if (url.pathname === "/api/v1/agents-md" && req.method === "GET") {
      const pp = url.searchParams.get("path");
      if (!pp || pp.includes("..")) return Response.json({ error: "Invalid" }, { status: 400 });
      const files = [];
      for (const n of ["CLAUDE.md","AGENTS.md"]) {
        const fp = join(pp, n); const ex = await fe(fp);
        let c = ""; if (ex) try { c = await readFile(fp, "utf-8") } catch {}
        files.push({ name: n, path: fp, content: c, exists: ex });
      }
      return Response.json({ files, projectPath: pp });
    }
    if (url.pathname === "/api/v1/agents-md" && req.method === "PUT") {
      const { path: fp, content: c } = await req.json() as any;
      if (!fp || fp.includes("..")) return Response.json({ error: "Invalid" }, { status: 400 });
      const bn = fp.split("/").pop() || "";
      if (!["CLAUDE.md","AGENTS.md"].includes(bn)) return Response.json({ error: "Not allowed" }, { status: 400 });
      try { await writeFile(fp, c, "utf-8"); return Response.json({ ok: true }); } catch(e) { return Response.json({ error: String(e) }, { status: 500 }); }
    }
    if (url.pathname.startsWith("/api/v1/hooks")) {
      const queueId = await enqueueHook(req, url);
      return Response.json({ ok: true, relayed: false, queued: true, queueId });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await forwardApiRequest({
          pathname: url.pathname,
          search: url.search,
          method: req.method,
          contentType: req.headers.get("Content-Type") || "application/json",
          agentType: req.headers.get("X-Agent-Type"),
          body: req.method !== "GET" ? await req.text() : undefined,
        });
      } catch {
        return Response.json({ error: "Relay failed" }, { status: 502 });
      }
    }
    return Response.redirect(remoteUrl + url.pathname, 302);
  },
});
setInterval(() => { void processHookQueue(); }, HOOK_RETRY_POLL_MS);
void ensureQueueDirs().then(() => scheduleQueue(250));
console.log("AgentPulse Relay: localhost:" + port + " -> " + remoteUrl + " (queued hook forwarding)");
INNER_EOF

echo "  ✓ Relay script installed"

# ── macOS LaunchAgent ──

if [[ "\$(uname)" == "Darwin" ]]; then
  PLIST="\$HOME/Library/LaunchAgents/dev.agentpulse.relay.plist"
  mkdir -p "\$HOME/Library/LaunchAgents"

  ARGS_XML="    <string>\${BUN_PATH}</string>
    <string>\${RELAY_DIR}/relay.ts</string>
    <string>\${REMOTE_URL}</string>
    <string>--port</string>
    <string>\${PORT}</string>"

  if [[ -n "\$API_KEY" ]]; then
    ARGS_XML="\${ARGS_XML}
    <string>--key</string>
    <string>\${API_KEY}</string>"
  fi

  cat > "\$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agentpulse.relay</string>
  <key>ProgramArguments</key><array>
\${ARGS_XML}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>\${RELAY_DIR}/logs/relay.log</string>
  <key>StandardErrorPath</key><string>\${RELAY_DIR}/logs/relay.err</string>
  <key>WorkingDirectory</key><string>\${RELAY_DIR}</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "\$PLIST" 2>/dev/null || true
  launchctl load "\$PLIST"
  echo "  ✓ LaunchAgent installed (auto-starts on login)"
else
  # Linux: create a systemd user service
  SYSTEMD_DIR="\$HOME/.config/systemd/user"
  mkdir -p "\$SYSTEMD_DIR"

  KEY_ARG=""
  [[ -n "\$API_KEY" ]] && KEY_ARG="--key \$API_KEY"

  cat > "\$SYSTEMD_DIR/agentpulse-relay.service" << SYSTEMD_EOF
[Unit]
Description=AgentPulse Relay
After=network.target

[Service]
ExecStart=\${BUN_PATH} \${RELAY_DIR}/relay.ts \${REMOTE_URL} --port \${PORT} \${KEY_ARG}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SYSTEMD_EOF

  systemctl --user daemon-reload
  systemctl --user enable agentpulse-relay
  systemctl --user start agentpulse-relay
  echo "  ✓ systemd service installed (auto-starts on login)"
fi

# Wait for relay
sleep 2
if curl -sf "http://localhost:\${PORT}/api/v1/health" >/dev/null 2>&1; then
  echo "  ✓ Relay running on localhost:\$PORT"
else
  echo "  ! Relay may still be starting. Check logs: tail ~/.agentpulse/logs/relay.err"
fi

# ── Configure hooks ──

echo ""

# Claude Code
CLAUDE_DIR="\$HOME/.claude"
CLAUDE_SETTINGS="\$CLAUDE_DIR/settings.json"
mkdir -p "\$CLAUDE_DIR"

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit")
HOOKS_JSON="{"
for i in "\${!EVENTS[@]}"; do
  [[ \$i -gt 0 ]] && HOOKS_JSON+=","
  HOOKS_JSON+="\\"\${EVENTS[\$i]}\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"http://localhost:\${PORT}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
done
HOOKS_JSON+="}"

if [[ -f "\$CLAUDE_SETTINGS" ]] && command -v jq &>/dev/null; then
  jq --argjson hooks "\$HOOKS_JSON" '.hooks = (.hooks // {}) * \$hooks' "\$CLAUDE_SETTINGS" > "\${CLAUDE_SETTINGS}.tmp"
  mv "\${CLAUDE_SETTINGS}.tmp" "\$CLAUDE_SETTINGS"
elif [[ -f "\$CLAUDE_SETTINGS" ]] && command -v python3 &>/dev/null; then
  python3 -c "
import json
with open('\$CLAUDE_SETTINGS') as f: s = json.load(f)
s.setdefault('hooks', {}).update(json.loads('''\$HOOKS_JSON'''))
with open('\$CLAUDE_SETTINGS', 'w') as f: json.dump(s, f, indent=2)
"
else
  echo "{\\"hooks\\":\$HOOKS_JSON}" > "\$CLAUDE_SETTINGS"
fi
echo "  ✓ Claude Code hooks → localhost:\$PORT"

# Codex CLI
CODEX_DIR="\$HOME/.codex"
mkdir -p "\$CODEX_DIR"
CODEX_EVENTS=("SessionStart" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop")
CODEX_HOOKS="["
for i in "\${!CODEX_EVENTS[@]}"; do
  [[ \$i -gt 0 ]] && CODEX_HOOKS+=","
  CODEX_HOOKS+="{\\"event\\":\\"\${CODEX_EVENTS[\$i]}\\",\\"type\\":\\"http\\",\\"url\\":\\"http://localhost:\${PORT}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"X-Agent-Type\\":\\"codex_cli\\"}}"
done
CODEX_HOOKS+="]"
echo "{\\"hooks\\":\$CODEX_HOOKS}" > "\$CODEX_DIR/hooks.json"
if [[ -f "\$CODEX_DIR/config.toml" ]]; then
  grep -q "codex_hooks" "\$CODEX_DIR/config.toml" || echo -e "\\n[features]\\ncodex_hooks = true" >> "\$CODEX_DIR/config.toml"
else
  echo -e "[features]\\ncodex_hooks = true" > "\$CODEX_DIR/config.toml"
fi
echo "  ✓ Codex CLI hooks → localhost:\$PORT"

echo ""
echo "  Done! Open a new Claude Code or Codex session."
echo "  Dashboard: \$REMOTE_URL"
echo ""
echo "  Manage relay:"
if [[ "\$(uname)" == "Darwin" ]]; then
  echo "    Stop:  launchctl unload ~/Library/LaunchAgents/dev.agentpulse.relay.plist"
  echo "    Start: launchctl load ~/Library/LaunchAgents/dev.agentpulse.relay.plist"
else
  echo "    Stop:  systemctl --user stop agentpulse-relay"
  echo "    Start: systemctl --user start agentpulse-relay"
fi
echo "    Logs:  tail -f ~/.agentpulse/logs/relay.log"
echo ""
`;

	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": "inline; filename=setup-relay.sh",
		},
	});
});

export { setup };
