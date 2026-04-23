import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ApiKeyInfo, LaunchRequest, SupervisorRecord } from "../../shared/types.js";
import { LabsBadge } from "../components/LabsBadge.js";
import { AiSettingsPanel } from "../components/settings/AiSettingsPanel.js";
import { LabsPanel } from "../components/settings/LabsPanel.js";
import { TelegramChannelPanel } from "../components/settings/TelegramChannelPanel.js";
import { api } from "../lib/api.js";
import { BROWSER_WS_PATH } from "../lib/paths.js";
import { type AppTheme, persistTheme, resolveInitialTheme } from "../lib/theme.js";
import { useUiPrefsStore } from "../stores/ui-prefs-store.js";
import { useLabsStore } from "../stores/labs-store.js";

const launchModeLabels = {
	headless: "Headless task",
	interactive_terminal: "Interactive terminal",
	managed_codex: "Managed Codex",
} as const;

export function SettingsPage() {
	const aiSettingsEnabled = useLabsStore((s) => s.isEnabled("aiSettingsPanel"));
	const telegramEnabled = useLabsStore((s) => s.isEnabled("telegramChannel"));
	const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
	const [newKeyName, setNewKeyName] = useState("");
	const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [theme, setTheme] = useState<AppTheme>(resolveInitialTheme());
	const [settings, setSettings] = useState<Record<string, unknown>>({});
	const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
	const [recentLaunches, setRecentLaunches] = useState<LaunchRequest[]>([]);

	// Fetch API keys and settings
	useEffect(() => {
		async function load() {
			try {
				const [keysRes, settingsRes, supervisorsRes, launchesRes] = await Promise.all([
					api.getApiKeys(),
					api.getSettings(),
					api.getSupervisors(),
					api.getLaunches(),
				]);
				setApiKeys(keysRes.keys || []);
				setSettings(settingsRes || {});
				setSupervisors(supervisorsRes.supervisors || []);
				setRecentLaunches((launchesRes.launches || []).slice(0, 5));
				if (settingsRes.theme === "dark" || settingsRes.theme === "light") {
					setTheme(settingsRes.theme);
					persistTheme(settingsRes.theme);
				}
			} catch (err) {
				console.error("Failed to load settings:", err);
			} finally {
				setLoading(false);
			}
		}
		load();
	}, []);

	// Create API key
	async function handleCreateKey() {
		if (!newKeyName.trim()) return;

		try {
			const data = await api.createApiKey(newKeyName.trim());

			if (data.key) {
				setNewKeyValue(data.key);
				setNewKeyName("");
				// Refresh key list
				const keysRes = await api.getApiKeys();
				setApiKeys(keysRes.keys || []);
			}
		} catch (err) {
			console.error("Failed to create key:", err);
		}
	}

	// Revoke API key
	async function handleRevokeKey(id: string) {
		try {
			await api.revokeApiKey(id);
			setApiKeys((prev) => prev.map((k) => (k.id === id ? { ...k, isActive: false } : k)));
		} catch (err) {
			console.error("Failed to revoke key:", err);
		}
	}

	// Toggle theme
	function handleThemeToggle() {
		const next: AppTheme = theme === "dark" ? "light" : "dark";
		setTheme(next);
		persistTheme(next);
		// Persist
		void api.saveSetting("theme", next).catch(() => {});
	}

	// Save a setting
	async function saveSetting(key: string, value: unknown) {
		try {
			await api.saveSetting(key, value);
			setSettings((prev) => ({ ...prev, [key]: value }));
		} catch (err) {
			console.error("Failed to save setting:", err);
		}
	}

	return (
		<div className="p-3 md:p-6 max-w-3xl">
			<h1 className="text-xl md:text-2xl font-bold text-foreground mb-2">Settings</h1>
			<p className="text-sm text-muted-foreground mb-6">
				Manage API keys, appearance, and dashboard configuration.
			</p>

			{/* Appearance */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6">
				<h2 className="text-sm font-semibold mb-3">Appearance</h2>
				<div className="flex items-center justify-between gap-4 mb-4">
					<div>
						<p className="text-sm text-foreground">Theme</p>
						<p className="text-xs text-muted-foreground">Toggle between dark and light mode</p>
					</div>
					<button
						onClick={handleThemeToggle}
						className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
						style={{
							backgroundColor: theme === "dark" ? "hsl(var(--primary))" : "hsl(var(--muted))",
						}}
					>
						<span
							className="inline-block h-4 w-4 rounded-full bg-card border border-border transition-transform"
							style={{ transform: theme === "dark" ? "translateX(24px)" : "translateX(4px)" }}
						/>
					</button>
				</div>
				<ProjectColorsToggle />
			</section>

			{/* Supervisor Status */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6">
				<h2 className="text-sm font-semibold mb-1">Local Supervisor</h2>
				<p className="text-xs text-muted-foreground mb-4">
					Phase 2 orchestration uses a local supervisor for capability reporting and launch
					validation. No sessions are launched yet.
				</p>

				{supervisors.length === 0 ? (
					<div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
						No supervisor registered. Run <code className="font-mono">bun run supervisor</code> to
						register this machine.
					</div>
				) : (
					<div className="space-y-3">
						{supervisors.map((supervisor) => (
							<div key={supervisor.id} className="rounded-md border border-border p-4">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div>
										<div className="text-sm font-medium text-foreground">{supervisor.hostName}</div>
										<div className="text-xs text-muted-foreground">
											{supervisor.platform} / {supervisor.arch} / v{supervisor.version}
										</div>
									</div>
									<span
										className={`rounded-full px-2 py-0.5 text-[10px] ${
											supervisor.status === "connected"
												? "bg-emerald-500/10 text-emerald-400"
												: supervisor.status === "stale"
													? "bg-amber-500/10 text-amber-400"
													: "bg-red-500/10 text-red-400"
										}`}
									>
										{supervisor.status}
									</span>
								</div>
								<div className="mt-3 grid gap-3 sm:grid-cols-2 text-xs text-muted-foreground">
									<div>
										<div className="font-medium text-foreground mb-1">Trusted roots</div>
										<div className="break-all">{supervisor.trustedRoots.join(", ") || "none"}</div>
									</div>
									<div>
										<div className="font-medium text-foreground mb-1">Capabilities</div>
										<div>
											{supervisor.capabilities.agentTypes.join(", ") || "none"} /{" "}
											{supervisor.capabilities.launchModes.join(", ") || "none"}
										</div>
									</div>
								</div>
							</div>
						))}
					</div>
				)}
			</section>

			{/* Launch Validation */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6">
				<h2 className="text-sm font-semibold mb-1">Recent Launch Validation</h2>
				<p className="text-xs text-muted-foreground mb-4">
					Validated launch requests are stored here before dispatch exists.
				</p>
				{recentLaunches.length === 0 ? (
					<div className="text-sm text-muted-foreground">
						No launch requests yet. Use the Templates page to validate one.
					</div>
				) : (
					<div className="space-y-2">
						{recentLaunches.map((launch) => (
							<Link
								key={launch.id}
								to={`/launches/${launch.id}`}
								className="block rounded-md border border-border p-3 transition-colors hover:bg-accent/40"
							>
								<div className="flex items-center justify-between gap-2">
									<div className="text-sm font-medium text-foreground">
										{launch.agentType === "claude_code" ? "Claude Code" : "Codex CLI"}
									</div>
									<span className="text-xs text-muted-foreground">
										{launch.status} · {launchModeLabels[launch.requestedLaunchMode]}
									</span>
								</div>
								<div className="mt-1 break-all text-xs text-muted-foreground">{launch.cwd}</div>
								{launch.validationSummary && (
									<div className="mt-1 text-xs text-muted-foreground">
										{launch.validationSummary}
									</div>
								)}
							</Link>
						))}
					</div>
				)}
			</section>

			{/* Session Configuration */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6">
				<h2 className="text-sm font-semibold mb-3">Session Configuration</h2>

				<div className="space-y-4">
					<div>
						<label className="text-sm text-foreground block mb-1">Idle Timeout (minutes)</label>
						<p className="text-xs text-muted-foreground mb-2">
							Sessions with no activity for this long are marked idle.
						</p>
						<input
							type="number"
							defaultValue={
								typeof settings.sessionIdleTimeoutMinutes === "number"
									? settings.sessionIdleTimeoutMinutes
									: 5
							}
							min={1}
							max={60}
							onBlur={(e) => saveSetting("sessionIdleTimeoutMinutes", Number(e.target.value))}
							className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>

					<div>
						<label className="text-sm text-foreground block mb-1">End Timeout (minutes)</label>
						<p className="text-xs text-muted-foreground mb-2">
							Sessions with no activity for this long are marked completed.
						</p>
						<input
							type="number"
							defaultValue={
								typeof settings.sessionEndTimeoutMinutes === "number"
									? settings.sessionEndTimeoutMinutes
									: 30
							}
							min={5}
							max={1440}
							onBlur={(e) => saveSetting("sessionEndTimeoutMinutes", Number(e.target.value))}
							className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>

					<div>
						<label className="text-sm text-foreground block mb-1">Event Retention (days)</label>
						<p className="text-xs text-muted-foreground mb-2">
							Events older than this are automatically cleaned up.
						</p>
						<input
							type="number"
							defaultValue={
								typeof settings.eventsRetentionDays === "number" ? settings.eventsRetentionDays : 30
							}
							min={1}
							max={365}
							onBlur={(e) => saveSetting("eventsRetentionDays", Number(e.target.value))}
							className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>
				</div>
			</section>

			{/* Labs */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6 relative">
				<div className="flex items-center gap-2 mb-1">
					<h2 className="text-sm font-semibold">Labs</h2>
					<LabsBadge />
				</div>
				<p className="text-xs text-muted-foreground mb-4">
					Experimental features. Toggles here hide the related nav items, tabs, and surfaces from
					the rest of the app. Defaults preserve what's already shipped.
				</p>
				<LabsPanel />
			</section>

			{/* AI watcher */}
			{aiSettingsEnabled && (
				<section className="border border-border bg-card rounded-lg p-5 mb-6 relative">
					<div className="flex items-center gap-2 mb-1">
						<h2 className="text-sm font-semibold">AI watcher</h2>
						<LabsBadge />
					</div>
					<p className="text-xs text-muted-foreground mb-4">
						Attach an LLM to any session. Watcher proposals require human approval.
					</p>
					<AiSettingsPanel />
				</section>
			)}

			{/* Telegram HITL channels */}
			{telegramEnabled && (
				<section className="border border-border bg-card rounded-lg p-5 mb-6 relative">
					<div className="flex items-center gap-2 mb-1">
						<h2 className="text-sm font-semibold">Telegram HITL channel</h2>
						<LabsBadge />
					</div>
					<p className="text-xs text-muted-foreground mb-4">
						Forward watcher HITL requests to a Telegram chat with inline Approve / Decline buttons.
						Enrolled channels can be assigned per session on the session AI tab.
					</p>
					<TelegramChannelPanel />
				</section>
			)}

			{/* API Keys */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6">
				<h2 className="text-sm font-semibold mb-1">API Keys</h2>
				<p className="text-xs text-muted-foreground mb-4">
					API keys authenticate hook events from Claude Code and Codex CLI.
				</p>

				{/* New key creation */}
				{newKeyValue && (
					<div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
						<p className="text-sm font-medium text-emerald-400 mb-1">New API key created</p>
						<p className="text-xs text-muted-foreground mb-2">
							Copy this key now -- it will not be shown again.
						</p>
						<div className="flex items-center gap-2">
							<code className="flex-1 rounded bg-background px-3 py-2 text-sm font-mono text-foreground border border-border">
								{newKeyValue}
							</code>
							<button
								onClick={() => {
									navigator.clipboard.writeText(newKeyValue);
								}}
								className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
							>
								Copy
							</button>
						</div>
						<button
							onClick={() => setNewKeyValue(null)}
							className="mt-2 text-xs text-muted-foreground hover:text-foreground"
						>
							Dismiss
						</button>
					</div>
				)}

				<div className="flex flex-col sm:flex-row gap-2 mb-4">
					<input
						type="text"
						value={newKeyName}
						onChange={(e) => setNewKeyName(e.target.value)}
						placeholder="Key name (e.g. macbook-hooks)"
						onKeyDown={(e) => e.key === "Enter" && handleCreateKey()}
						className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
					/>
					<button
						onClick={handleCreateKey}
						disabled={!newKeyName.trim()}
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						Create Key
					</button>
				</div>

				{/* Key list */}
				{loading ? (
					<div className="space-y-2">
						{[1, 2].map((i) => (
							<div key={i} className="h-12 bg-muted rounded animate-pulse" />
						))}
					</div>
				) : apiKeys.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4 text-center">
						No API keys yet. Create one above.
					</p>
				) : (
					<div className="space-y-2">
						{apiKeys.map((key) => (
							<div
								key={key.id}
								className={`flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between rounded-md border px-4 py-3 ${
									key.isActive
										? "border-border bg-background"
										: "border-border/50 bg-muted/30 opacity-60"
								}`}
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-foreground">{key.name}</span>
										{!key.isActive && (
											<span className="text-[10px] rounded bg-red-500/10 text-red-400 px-1.5 py-0.5">
												revoked
											</span>
										)}
									</div>
									<div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-0.5">
										<code className="text-xs text-muted-foreground font-mono">
											{key.keyPrefix}...
										</code>
										<span className="text-xs text-muted-foreground">
											Created {new Date(key.createdAt).toLocaleDateString()}
										</span>
										{key.lastUsedAt && (
											<span className="text-xs text-muted-foreground">
												Last used {new Date(key.lastUsedAt).toLocaleDateString()}
											</span>
										)}
									</div>
								</div>
								{key.isActive && (
									<button
										onClick={() => handleRevokeKey(key.id)}
										className="rounded-md px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
									>
										Revoke
									</button>
								)}
							</div>
						))}
					</div>
				)}
			</section>

			{/* Server Info */}
			<section className="border border-border bg-card rounded-lg p-5">
				<h2 className="text-sm font-semibold mb-3">Server Info</h2>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
					<div>
						<p className="text-muted-foreground text-xs">Version</p>
						<p className="font-medium">0.1.0</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">Public URL</p>
						<p className="font-medium break-all">{window.location.origin}</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">API Endpoint</p>
						<p className="font-mono text-xs break-all">{window.location.origin}/api/v1/hooks</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">WebSocket</p>
						<p className="font-mono text-xs break-all">
							{window.location.protocol === "https:" ? "wss:" : "ws:"}//
							{window.location.host}
							{BROWSER_WS_PATH}
						</p>
					</div>
				</div>
			</section>
		</div>
	);
}

function ProjectColorsToggle() {
	const enabled = useUiPrefsStore((s) => s.projectColors);
	const setProjectColors = useUiPrefsStore((s) => s.setProjectColors);
	return (
		<div className="flex items-center justify-between gap-4 border-t border-border pt-4">
			<div>
				<p className="text-sm text-foreground">Project color tint</p>
				<p className="text-xs text-muted-foreground">
					Tint session cards and tabs by working directory so multi-repo dashboards
					group visually at a glance.
				</p>
			</div>
			<button
				type="button"
				onClick={() => setProjectColors(!enabled)}
				className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
				style={{
					backgroundColor: enabled ? "hsl(var(--primary))" : "hsl(var(--muted))",
				}}
				aria-pressed={enabled}
			>
				<span
					className="inline-block h-4 w-4 rounded-full bg-card border border-border transition-transform"
					style={{ transform: enabled ? "translateX(24px)" : "translateX(4px)" }}
				/>
			</button>
		</div>
	);
}
