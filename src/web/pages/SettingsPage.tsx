import { useEffect, useState } from "react";
import type { ApiKeyInfo } from "../../shared/types.js";

const BASE = "/api/v1";

export function SettingsPage() {
	const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
	const [newKeyName, setNewKeyName] = useState("");
	const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [theme, setTheme] = useState<"dark" | "light">(
		document.documentElement.classList.contains("dark") ? "dark" : "light",
	);
	const [settings, setSettings] = useState<Record<string, unknown>>({});

	// Fetch API keys and settings
	useEffect(() => {
		async function load() {
			try {
				const [keysRes, settingsRes] = await Promise.all([
					fetch(`${BASE}/api-keys`).then((r) => r.json()),
					fetch(`${BASE}/settings`).then((r) => r.json()),
				]);
				setApiKeys(keysRes.keys || []);
				setSettings(settingsRes || {});
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
			const res = await fetch(`${BASE}/api-keys`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: newKeyName.trim() }),
			});
			const data = await res.json();

			if (data.key) {
				setNewKeyValue(data.key);
				setNewKeyName("");
				// Refresh key list
				const keysRes = await fetch(`${BASE}/api-keys`).then((r) => r.json());
				setApiKeys(keysRes.keys || []);
			}
		} catch (err) {
			console.error("Failed to create key:", err);
		}
	}

	// Revoke API key
	async function handleRevokeKey(id: string) {
		try {
			await fetch(`${BASE}/api-keys/${id}`, { method: "DELETE" });
			setApiKeys((prev) => prev.map((k) => (k.id === id ? { ...k, isActive: false } : k)));
		} catch (err) {
			console.error("Failed to revoke key:", err);
		}
	}

	// Toggle theme
	function handleThemeToggle() {
		const next = theme === "dark" ? "light" : "dark";
		setTheme(next);
		document.documentElement.classList.toggle("dark", next === "dark");
		// Persist
		fetch(`${BASE}/settings`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "theme", value: next }),
		}).catch(() => {});
	}

	// Save a setting
	async function saveSetting(key: string, value: unknown) {
		try {
			await fetch(`${BASE}/settings`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key, value }),
			});
			setSettings((prev) => ({ ...prev, [key]: value }));
		} catch (err) {
			console.error("Failed to save setting:", err);
		}
	}

	return (
		<div className="p-6 max-w-3xl">
			<h1 className="text-2xl font-bold text-foreground mb-2">Settings</h1>
			<p className="text-sm text-muted-foreground mb-6">
				Manage API keys, appearance, and dashboard configuration.
			</p>

			{/* Appearance */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6">
				<h2 className="text-sm font-semibold mb-3">Appearance</h2>
				<div className="flex items-center justify-between">
					<div>
						<p className="text-sm text-foreground">Theme</p>
						<p className="text-xs text-muted-foreground">Toggle between dark and light mode</p>
					</div>
					<button
						onClick={handleThemeToggle}
						className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
						style={{ backgroundColor: theme === "dark" ? "hsl(var(--primary))" : "hsl(var(--muted))" }}
					>
						<span
							className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
							style={{ transform: theme === "dark" ? "translateX(24px)" : "translateX(4px)" }}
						/>
					</button>
				</div>
			</section>

			{/* Session Configuration */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6">
				<h2 className="text-sm font-semibold mb-3">Session Configuration</h2>

				<div className="space-y-4">
					<div>
						<label className="text-sm text-foreground block mb-1">
							Idle Timeout (minutes)
						</label>
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
							onBlur={(e) =>
								saveSetting("sessionIdleTimeoutMinutes", Number(e.target.value))
							}
							className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>

					<div>
						<label className="text-sm text-foreground block mb-1">
							End Timeout (minutes)
						</label>
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
							onBlur={(e) =>
								saveSetting("sessionEndTimeoutMinutes", Number(e.target.value))
							}
							className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>

					<div>
						<label className="text-sm text-foreground block mb-1">
							Event Retention (days)
						</label>
						<p className="text-xs text-muted-foreground mb-2">
							Events older than this are automatically cleaned up.
						</p>
						<input
							type="number"
							defaultValue={
								typeof settings.eventsRetentionDays === "number"
									? settings.eventsRetentionDays
									: 30
							}
							min={1}
							max={365}
							onBlur={(e) =>
								saveSetting("eventsRetentionDays", Number(e.target.value))
							}
							className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>
				</div>
			</section>

			{/* API Keys */}
			<section className="border border-border bg-card rounded-lg p-5 mb-6">
				<h2 className="text-sm font-semibold mb-1">API Keys</h2>
				<p className="text-xs text-muted-foreground mb-4">
					API keys authenticate hook events from Claude Code and Codex CLI.
				</p>

				{/* New key creation */}
				{newKeyValue && (
					<div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
						<p className="text-sm font-medium text-emerald-400 mb-1">
							New API key created
						</p>
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

				<div className="flex gap-2 mb-4">
					<input
						type="text"
						value={newKeyName}
						onChange={(e) => setNewKeyName(e.target.value)}
						placeholder="Key name (e.g. macbook-hooks)"
						onKeyDown={(e) => e.key === "Enter" && handleCreateKey()}
						className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
								className={`flex items-center justify-between rounded-md border px-4 py-3 ${
									key.isActive
										? "border-border bg-background"
										: "border-border/50 bg-muted/30 opacity-60"
								}`}
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-foreground">
											{key.name}
										</span>
										{!key.isActive && (
											<span className="text-[10px] rounded bg-red-500/10 text-red-400 px-1.5 py-0.5">
												revoked
											</span>
										)}
									</div>
									<div className="flex items-center gap-3 mt-0.5">
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
				<div className="grid grid-cols-2 gap-3 text-sm">
					<div>
						<p className="text-muted-foreground text-xs">Version</p>
						<p className="font-medium">0.1.0</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">Public URL</p>
						<p className="font-medium">{window.location.origin}</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">API Endpoint</p>
						<p className="font-mono text-xs">{window.location.origin}/api/v1/hooks</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">WebSocket</p>
						<p className="font-mono text-xs">
							{window.location.protocol === "https:" ? "wss:" : "ws:"}//
							{window.location.host}/api/v1/ws
						</p>
					</div>
				</div>
			</section>
		</div>
	);
}
