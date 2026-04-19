import { useState } from "react";

export function SetupPage() {
	const [apiKey, setApiKey] = useState("");
	const [serverUrl, setServerUrl] = useState(window.location.origin);
	const [agentType, setAgentType] = useState<"claude_code" | "codex_cli">("claude_code");

	const hookEvents =
		agentType === "claude_code"
			? ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "UserPromptSubmit"]
			: ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];

	const generateClaudeConfig = () => {
		const hooks: Record<string, unknown[]> = {};
		for (const event of hookEvents) {
			hooks[event] = [
				{
					matcher: "",
					hooks: [
						{
							type: "http",
							url: `${serverUrl}/api/v1/hooks`,
							async: true,
							allowedEnvVars: ["AGENTPULSE_API_KEY"],
							headers: {
								Authorization: "Bearer $AGENTPULSE_API_KEY",
								"X-Agent-Type": "claude_code",
							},
						},
					],
				},
			];
		}
		return JSON.stringify({ hooks }, null, 2);
	};

	const generateCodexConfig = () => {
		const hooks = hookEvents.map((event) => ({
			event,
			type: "http",
			url: `${serverUrl}/api/v1/hooks`,
			async: true,
			headers: {
				Authorization: `Bearer ${apiKey || "YOUR_API_KEY"}`,
				"X-Agent-Type": "codex_cli",
			},
		}));
		return JSON.stringify({ hooks }, null, 2);
	};

	const config = agentType === "claude_code" ? generateClaudeConfig() : generateCodexConfig();
	const configFile = agentType === "claude_code" ? "~/.claude/settings.json" : "~/.codex/hooks.json";

	return (
		<div className="p-3 md:p-6 max-w-3xl">
			<h1 className="text-xl md:text-2xl font-bold text-foreground mb-2">Setup</h1>
			<p className="text-sm text-muted-foreground mb-6">
				Configure your AI agents to report their activity to AgentPulse.
			</p>

			{/* Step 1: API Key */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">1</span>
					API Key
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					Enter the API key shown when you first started AgentPulse (check server logs).
				</p>
				<input
					type="text"
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
					placeholder="ap_..."
					className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
				/>
			</div>

			{/* Step 2: Agent Type */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">2</span>
					Agent Type
				</h2>
				<div className="flex flex-col sm:flex-row gap-2">
					<button
						onClick={() => setAgentType("claude_code")}
						className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
							agentType === "claude_code"
								? "border-primary bg-primary/10 text-primary"
								: "border-border text-muted-foreground hover:text-foreground"
						}`}
					>
						Claude Code
					</button>
					<button
						onClick={() => setAgentType("codex_cli")}
						className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
							agentType === "codex_cli"
								? "border-primary bg-primary/10 text-primary"
								: "border-border text-muted-foreground hover:text-foreground"
						}`}
					>
						Codex CLI
					</button>
				</div>
			</div>

			{/* Step 3: Configuration */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">3</span>
					Add to {configFile}
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					{agentType === "claude_code"
						? "Merge this into your Claude Code settings.json. If you already have hooks, add these entries to each event array."
						: "Save this as ~/.codex/hooks.json. Enable hooks in config.toml: [features] codex_hooks = true"}
				</p>
				<div className="relative">
					<pre className="bg-background border border-border rounded-md p-4 text-xs overflow-auto max-h-80">
						<code>{config}</code>
					</pre>
					<button
						onClick={() => navigator.clipboard.writeText(config)}
						className="absolute top-2 right-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						Copy
					</button>
				</div>
			</div>

			{agentType === "codex_cli" && (
				<div className="border border-border bg-card rounded-lg p-5 mb-4">
					<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
						<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">4</span>
						Codex Status Line
					</h2>
					<p className="text-xs text-muted-foreground mb-3">
						Codex 0.120.0+ can show the thread title in its built-in status line. In Codex, run
						{" "}<span className="font-mono text-foreground">/statusline</span> and enable
						{" "}<span className="font-mono text-foreground">thread-title</span>. Then run
						{" "}<span className="font-mono text-foreground">/rename &lt;session-name&gt;</span> to match the AgentPulse name.
					</p>
				</div>
			)}

			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						{agentType === "codex_cli" ? "5" : "4"}
					</span>
					Supervisor Enrollment
				</h2>
				<p className="text-xs text-muted-foreground">
					For orchestration and managed sessions, create host enrollment tokens on the
					{" "}<span className="font-mono text-foreground">Hosts</span> page. That issues a one-time
					token a machine can exchange for a persistent scoped supervisor credential. Use
					{" "}<span className="font-mono text-foreground">Rotate</span> to re-enroll a host and
					replace its credential, or <span className="font-mono text-foreground">Revoke</span> to
					cut off future supervisor access.
				</p>
			</div>

			{/* Step 4: Environment variable */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">{agentType === "codex_cli" ? "6" : "5"}</span>
					Set Environment Variable
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					Add this to your shell profile (~/.zshrc or ~/.bashrc):
				</p>
				<pre className="bg-background border border-border rounded-md p-3 text-xs overflow-x-auto">
					<code>export AGENTPULSE_API_KEY="{apiKey || "YOUR_API_KEY"}"</code>
				</pre>
			</div>

			{/* Step 5: CLAUDE.md snippet */}
			<div className="border border-border bg-card rounded-lg p-5">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">{agentType === "codex_cli" ? "7" : "6"}</span>
					Optional: Add Status Snippet to {agentType === "claude_code" ? "CLAUDE.md" : "AGENTS.md"}
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					Add this to your project's {agentType === "claude_code" ? "CLAUDE.md" : "AGENTS.md"} for semantic status reporting.
					This lets the agent tell the dashboard what it's working on.
				</p>
				<pre className="bg-background border border-border rounded-md p-3 text-xs overflow-auto max-h-40">
					<code>{`## AgentPulse Status Reporting
When working on tasks, report your status every 3-5 tool uses:
\`\`\`bash
curl -s -X POST "${serverUrl}/api/v1/hooks/status" \\
  -H "Authorization: Bearer \${AGENTPULSE_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"session_id":"'"\$${agentType === "claude_code" ? "CLAUDE_SESSION_ID" : "CODEX_SESSION_ID"}"'","status":"<status>","task":"<task>"}'
\`\`\``}</code>
				</pre>
			</div>
		</div>
	);
}
