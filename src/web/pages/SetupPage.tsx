import { useEffect, useId, useState } from "react";
import { useCopyFeedback } from "../hooks/useCopyFeedback.js";
import { api } from "../lib/api.js";
import {
	LOCAL_KEY_SCOPES,
	RELAY_KEY_NOTE,
	RELAY_KEY_SCOPES,
	REPLACE_LOCALHOST_NOTE,
	buildRelayCommand,
	isLoopbackHostname,
} from "../lib/onboarding.js";
import { useUserStore } from "../stores/user-store.js";

export function SetupPage() {
	const { copy } = useCopyFeedback();
	const [apiKey, setApiKey] = useState("");
	const serverUrl = window.location.origin;
	const [agentType, setAgentType] = useState<"claude_code" | "codex_cli">("claude_code");
	const disableAuth = useUserStore((s) => s.disableAuth);
	const [keys, setKeys] = useState<
		Array<{ id: string; name: string; keyPrefix: string; isActive: boolean }>
	>([]);
	const [keysLoaded, setKeysLoaded] = useState(false);
	const [keysError, setKeysError] = useState<string | null>(null);
	const [newKeyName, setNewKeyName] = useState("my-laptop");
	const [creatingKey, setCreatingKey] = useState(false);
	const [relayKey, setRelayKey] = useState<string | null>(null);
	const [creatingRelayKey, setCreatingRelayKey] = useState(false);
	const [codexNamesAgentpulse, setCodexNamesAgentpulse] = useState(false);
	const codexNamesHelpId = useId();

	useEffect(() => {
		if (disableAuth) {
			setKeysLoaded(true);
			return;
		}
		let cancelled = false;
		async function load() {
			try {
				const res = await api.getApiKeys();
				if (!cancelled) {
					setKeys(res.keys);
					setKeysLoaded(true);
				}
			} catch (err) {
				if (!cancelled) {
					setKeysError(err instanceof Error ? err.message : String(err));
					setKeysLoaded(true);
				}
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, [disableAuth]);

	async function handleCreateKey() {
		if (!newKeyName.trim()) return;
		setCreatingKey(true);
		try {
			// Hook-setup keys are ingest-only: they go into agent hook config and
			// must not carry management privileges. Use Settings to mint manage keys.
			const res = await api.createApiKey(newKeyName.trim(), LOCAL_KEY_SCOPES);
			setApiKey(res.key); // flow the raw key into the config blobs below
			const list = await api.getApiKeys().catch(() => ({ keys }));
			setKeys(list.keys ?? []);
		} catch (err) {
			setKeysError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreatingKey(false);
		}
	}

	async function handleCreateRelayKey() {
		setCreatingRelayKey(true);
		try {
			const res = await api.createApiKey(
				`${newKeyName.trim() || "my-laptop"}-relay`,
				RELAY_KEY_SCOPES,
			);
			setRelayKey(res.key);
			const list = await api.getApiKeys().catch(() => ({ keys }));
			setKeys(list.keys ?? []);
		} catch (err) {
			setKeysError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreatingRelayKey(false);
		}
	}

	const activeKeys = keys.filter((k) => k.isActive);
	// F167/F177: the key is never in the command (shell history, argv); the
	// installer asks for it, and only a key minted here is offered to paste.
	const relayCommand = buildRelayCommand({ serverUrl, codexNamesAgentpulse });

	const hookEvents =
		agentType === "claude_code"
			? [
					"SessionStart",
					"SessionEnd",
					"PreToolUse",
					"PostToolUse",
					"Stop",
					"SubagentStart",
					"SubagentStop",
					"TaskCreated",
					"TaskCompleted",
					"UserPromptSubmit",
					"PermissionRequest",
					"PermissionDenied",
					"Notification",
					"PreCompact",
					"PostCompact",
					"PostToolUseFailure",
				]
			: [
					"SessionStart",
					"PreToolUse",
					"PostToolUse",
					"UserPromptSubmit",
					"Stop",
					"SubagentStart",
					"SubagentStop",
					"PermissionRequest",
					"PreCompact",
					"PostCompact",
				];

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
	const configFile =
		agentType === "claude_code" ? "~/.claude/settings.json" : "~/.codex/hooks.json";

	return (
		<div className="p-3 md:p-6 max-w-3xl">
			<h1 className="text-xl md:text-2xl font-bold text-foreground mb-2">Setup</h1>
			<p className="text-sm text-muted-foreground mb-6">
				Configure your AI agents to report their activity to AgentPulse.
			</p>

			{/* Step 1: API Key */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						1
					</span>
					API Key
				</h2>

				{disableAuth ? (
					<p className="text-xs text-muted-foreground">
						This instance has <code className="font-mono text-foreground">DISABLE_AUTH=true</code>,
						so hooks don&apos;t need an API key. You can skip to step 2.
					</p>
				) : (
					<>
						<p className="text-xs text-muted-foreground mb-3">
							Mint one key per machine. Active keys are listed below for reference (only the prefix
							is stored — the full key is shown once at creation).
						</p>

						{keysLoaded && activeKeys.length > 0 && (
							<ul className="mb-3 space-y-1">
								{activeKeys.map((k) => (
									<li key={k.id} className="flex items-center gap-2 text-xs text-muted-foreground">
										<code className="font-mono text-foreground">{k.keyPrefix}…</code>
										<span>·</span>
										<span>{k.name}</span>
									</li>
								))}
							</ul>
						)}

						<div className="flex flex-col sm:flex-row gap-2 mb-3">
							<input
								type="text"
								value={newKeyName}
								onChange={(e) => setNewKeyName(e.target.value)}
								placeholder="Key name (e.g. macbook-pro)"
								className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
							/>
							<button
								type="button"
								onClick={handleCreateKey}
								disabled={creatingKey || !newKeyName.trim()}
								className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
							>
								{creatingKey ? "Creating…" : "Create new key"}
							</button>
						</div>

						<p className="text-[11px] text-muted-foreground mb-2">
							Or paste a key you already have so the config blobs below are ready to copy:
						</p>
						<input
							type="text"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder="ap_..."
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
						{apiKey?.startsWith("ap_") && (
							<p className="mt-2 text-[11px] text-emerald-400">
								✓ Key staged. It will appear in the config blobs below. Save it somewhere — it
								won&apos;t be shown again.
							</p>
						)}
						{keysError && (
							<p className="mt-2 text-xs text-red-400">Couldn&apos;t load keys: {keysError}</p>
						)}
					</>
				)}
			</div>

			{/* Remote relay: the alternative to the manual hook steps, for other machines */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2">
					Agents on other machines? Use the relay instead of the manual hook steps below
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					Claude Code only sends hooks to localhost, so on any other machine you install a small
					relay that forwards them here. It runs as a login service, points Claude Code and Codex
					CLI at it, and installs the statusline. Re-run it anytime to update.
				</p>

				{!disableAuth && (
					<div className="mb-3">
						<p className="text-xs text-amber-700 dark:text-amber-300 mb-2">{RELAY_KEY_NOTE}</p>
						{relayKey ? (
							<div>
								<p className="text-[11px] text-muted-foreground mb-1">
									Relay key created — save it, it won&apos;t be shown again. The installer asks for
									it; paste it there.
								</p>
								<div className="flex gap-2">
									<code className="flex-1 min-w-0 break-all bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground font-mono">
										{relayKey}
									</code>
									<button
										type="button"
										onClick={() => void copy(relayKey, "Relay key copied")}
										className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
									>
										Copy
									</button>
								</div>
							</div>
						) : (
							<button
								type="button"
								onClick={handleCreateRelayKey}
								disabled={creatingRelayKey}
								className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
							>
								{creatingRelayKey ? "Creating…" : "Mint relay key"}
							</button>
						)}
					</div>
				)}

				<div className="relative mb-3">
					<pre className="bg-background border border-border rounded-md p-3 pr-16 text-xs whitespace-pre-wrap break-all">
						<code>{relayCommand}</code>
					</pre>
					<button
						type="button"
						onClick={() => void copy(relayCommand, "Relay command copied")}
						className="absolute top-2 right-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						Copy
					</button>
				</div>
				{isLoopbackHostname(window.location.hostname) && (
					<p className="text-xs text-muted-foreground -mt-1 mb-3">{REPLACE_LOCALHOST_NOTE}</p>
				)}

				<label className="flex items-start gap-2 text-xs cursor-pointer">
					<input
						type="checkbox"
						checked={codexNamesAgentpulse}
						onChange={(e) => setCodexNamesAgentpulse(e.target.checked)}
						aria-describedby={codexNamesHelpId}
						className="mt-0.5 rounded border-input accent-primary"
					/>
					<span className="text-foreground">Use dashboard names in Codex too</span>
				</label>
				<p id={codexNamesHelpId} className="mt-1 pl-5 text-xs text-muted-foreground">
					Adds <code className="font-mono text-foreground">--codex-names agentpulse</code>. By
					default Codex&apos;s own thread names show on the dashboard. With this, dashboard names
					are written into Codex and replace its titles, renames made in Codex won&apos;t come back,
					and Codex sessions don&apos;t offer &ldquo;Use agent name&rdquo;.
				</p>
			</div>

			{/* Step 2: Agent Type */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						2
					</span>
					Agent Type
				</h2>
				<div className="flex flex-col sm:flex-row gap-2">
					<button
						type="button"
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
						type="button"
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
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						3
					</span>
					Add to {configFile}
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					{agentType === "claude_code"
						? "Merge this into your Claude Code settings.json. If you already have hooks, add these entries to each event array."
						: "Save this as ~/.codex/hooks.json. Hooks are enabled by default since codex-cli 0.124.0; [features] codex_hooks = true is a legacy-compat flag for older installs."}
				</p>
				<div className="relative">
					<pre className="bg-background border border-border rounded-md p-4 text-xs overflow-auto max-h-80">
						<code>{config}</code>
					</pre>
					<button
						type="button"
						onClick={() => void copy(config, "Hook config copied")}
						className="absolute top-2 right-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						Copy
					</button>
				</div>
			</div>

			{/* Step 4: Codex-only — Status Line integration */}
			{agentType === "codex_cli" && (
				<div className="border border-border bg-card rounded-lg p-5 mb-4">
					<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
						<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
							4
						</span>
						Status Line{" "}
						<span className="text-[10px] font-mono text-primary/60 bg-primary/8 px-1.5 py-0.5 rounded">
							Codex only
						</span>
					</h2>
					<p className="text-xs text-muted-foreground mb-3">
						Codex 0.120.0+ can show the thread title in its built-in status line. In Codex, run{" "}
						<span className="font-mono text-foreground">/statusline</span> and enable{" "}
						<span className="font-mono text-foreground">thread-title</span>. Then run{" "}
						<span className="font-mono text-foreground">/rename &lt;session-name&gt;</span> to match
						the AgentPulse name.
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
					For orchestration and managed sessions, create host enrollment tokens on the{" "}
					<span className="font-mono text-foreground">Hosts</span> page. That issues a one-time
					token a machine can exchange for a persistent scoped supervisor credential. Use{" "}
					<span className="font-mono text-foreground">Rotate</span> to re-enroll a host and replace
					its credential, or <span className="font-mono text-foreground">Revoke</span> to cut off
					future supervisor access.
				</p>
			</div>

			{/* Step 5 (Codex) / 4 (Claude): Environment variable */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						{agentType === "codex_cli" ? "6" : "5"}
					</span>
					Set Environment Variable
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					Add this to your shell profile (~/.zshrc or ~/.bashrc):
				</p>
				<pre className="bg-background border border-border rounded-md p-3 text-xs overflow-x-auto">
					<code>export AGENTPULSE_API_KEY="{apiKey || "YOUR_API_KEY"}"</code>
				</pre>
			</div>

			{/* Step 6 (Codex) / 5 (Claude): status snippet for CLAUDE.md / AGENTS.md */}
			<div className="border border-border bg-card rounded-lg p-5">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						{agentType === "codex_cli" ? "7" : "6"}
					</span>
					Optional: Add Status Snippet to {agentType === "claude_code" ? "CLAUDE.md" : "AGENTS.md"}
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					Add this to your project's {agentType === "claude_code" ? "CLAUDE.md" : "AGENTS.md"} for
					semantic status reporting. This lets the agent tell the dashboard what it's working on.
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
