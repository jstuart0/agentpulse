#!/usr/bin/env bun
import { readFile, writeFile, access } from "fs/promises";
import { constants } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
let remoteUrl = "", port = 4000, apiKey = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i+1]) port = Number(args[++i]);
  else if (args[i] === "--key" && args[i+1]) apiKey = args[++i];
  else if (!args[i].startsWith("--")) remoteUrl = args[i].replace(/\/$/, "");
}
if (!remoteUrl) { console.error("Usage: relay.ts <url> [--port N] [--key K]"); process.exit(1); }

async function fileExists(p: string) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Handle agents-md locally since the remote server can't read local files
async function handleAgentsMdGet(url: URL): Promise<Response> {
  const projectPath = url.searchParams.get("path");
  if (!projectPath || projectPath.includes("..")) return Response.json({ error: "Invalid path" }, { status: 400 });

  const files = [];
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const filePath = join(projectPath, name);
    const exists = await fileExists(filePath);
    let content = "";
    if (exists) try { content = await readFile(filePath, "utf-8"); } catch {}
    files.push({ name, path: filePath, content, exists });
  }
  return Response.json({ files, projectPath });
}

async function handleAgentsMdPut(req: Request): Promise<Response> {
  const { path: filePath, content } = await req.json() as { path: string; content: string };
  if (!filePath || filePath.includes("..")) return Response.json({ error: "Invalid path" }, { status: 400 });
  const basename = filePath.split("/").pop() || "";
  if (!["CLAUDE.md", "AGENTS.md"].includes(basename)) return Response.json({ error: "Can only edit CLAUDE.md or AGENTS.md" }, { status: 400 });
  try {
    await writeFile(filePath, content, "utf-8");
    return Response.json({ ok: true, path: filePath });
  } catch (err) {
    return Response.json({ error: `Failed: ${err}` }, { status: 500 });
  }
}

async function handleAgentsMdSnippet(url: URL): Promise<Response> {
  const agentType = url.searchParams.get("type") || "claude_code";
  const serverUrl = url.searchParams.get("server_url") || "";
  const sessionVar = agentType === "codex_cli" ? "CODEX_SESSION_ID" : "CLAUDE_SESSION_ID";
  const snippet = `## AgentPulse Status Reporting\n\nWhen working on tasks, report your status every 3-5 tool uses by running:\n\n\`\`\`bash\ncurl -s -X POST "\${AGENTPULSE_URL:-${serverUrl || "http://localhost:3000"}}/api/v1/hooks/status" \\\n  -H "Authorization: Bearer \${AGENTPULSE_API_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"session_id": "'"\$${sessionVar}"'", "status": "<researching|implementing|testing|debugging|reviewing|documenting|planning|waiting>", "task": "<one-line description of current task>", "plan": ["done step", ">> current step", "pending step"]}'\n\`\`\``;
  return Response.json({ snippet, fileName: agentType === "codex_cli" ? "AGENTS.md" : "CLAUDE.md", agentType });
}

Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/api/v1/health") {
      return Response.json({ status: "ok", relay: true, remote: remoteUrl });
    }

    // Handle agents-md locally (remote server can't read local files)
    if (url.pathname === "/api/v1/agents-md") {
      if (req.method === "GET") return handleAgentsMdGet(url);
      if (req.method === "PUT") return handleAgentsMdPut(req);
    }
    if (url.pathname === "/api/v1/agents-md/snippet") {
      return handleAgentsMdSnippet(url);
    }

    // Forward everything else to remote
    if (url.pathname.startsWith("/api/")) {
      try {
        const headers = new Headers();
        headers.set("Content-Type", req.headers.get("Content-Type") || "application/json");
        if (apiKey) headers.set("Authorization", "Bearer " + apiKey);
        const at = req.headers.get("X-Agent-Type"); if (at) headers.set("X-Agent-Type", at);
        const body = req.method !== "GET" ? await req.text() : undefined;
        const res = await fetch(remoteUrl + url.pathname + url.search, {
          method: req.method, headers, body,
          signal: AbortSignal.timeout(10000),
        });
        return new Response(await res.text(), {
          status: res.status,
          headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
        });
      } catch {
        if (url.pathname.includes("/hooks")) return Response.json({ ok: true, relayed: false });
        return Response.json({ error: "Relay failed" }, { status: 502 });
      }
    }
    return Response.redirect(remoteUrl + url.pathname, 302);
  },
});
console.log(`AgentPulse Relay: localhost:${port} -> ${remoteUrl}`);
