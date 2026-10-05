import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { toast } from "sonner";
import type { LaunchRequest, SupervisorRecord } from "../../shared/types.js";
import { LabsBadge } from "../components/LabsBadge.js";
import { AccountPanel } from "../components/settings/AccountPanel.js";
import { AdminSettingsGroup } from "../components/settings/AdminSettingsGroup.js";
import { AiSettingsPanel } from "../components/settings/AiSettingsPanel.js";
import { ApiKeysPanel } from "../components/settings/ApiKeysPanel.js";
import { LabsPanel } from "../components/settings/LabsPanel.js";
import { SettingsSection } from "../components/settings/SettingsSection.js";
import { TeamPanel } from "../components/settings/TeamPanel.js";
import { TelegramChannelPanel } from "../components/settings/TelegramChannelPanel.js";
import { WorkspacesPanel } from "../components/settings/WorkspacesPanel.js";
import { useOwnershipUi } from "../hooks/useOwnershipUi.js";
import { describeApiError } from "../lib/api-errors.js";
import { type ApiKeyRow, api } from "../lib/api.js";
import { BROWSER_WS_PATH } from "../lib/paths.js";
import {
	type AppTheme,
	getStoredTheme,
	persistTheme,
	resolveInitialTheme,
	themeToApply,
} from "../lib/theme.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useUiPrefsStore } from "../stores/ui-prefs-store.js";
import { useUserStore } from "../stores/user-store.js";
import { panelAnchorId, panelToReveal } from "./settings-panels.js";
import {
	type FetchStatus,
	type SettingsSectionId,
	sectionLoad,
	settingsSectionOrder,
} from "./settings-view-state.js";

const launchModeLabels = {
	headless: "Headless task",
	interactive_terminal: "Interactive terminal",
	managed_codex: "Managed Codex",
} as const;

export function SettingsPage() {
	const aiSettingsEnabled = useLabsStore((s) => s.isEnabled("aiSettingsPanel"));
	const telegramEnabled = useLabsStore((s) => s.isEnabled("telegramChannel"));
	const ui = useOwnershipUi();
	const isLocalAccount = useUserStore((s) => s.user?.source === "local");
	const location = useLocation();
	const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
	const [loading, setLoading] = useState(true);
	// A fetch that failed is not an empty answer: each section knows which it has.
	const [keysStatus, setKeysStatus] = useState<FetchStatus>("loading");
	const [settingsStatus, setSettingsStatus] = useState<FetchStatus>("loading");
	const [supervisorsStatus, setSupervisorsStatus] = useState<FetchStatus>("loading");
	const [theme, setTheme] = useState<AppTheme>(resolveInitialTheme());
	const [settings, setSettings] = useState<Record<string, unknown>>({});
	// Bumped when a save is refused, so an uncontrolled field snaps back to the saved value.
	const [fieldResetCount, setFieldResetCount] = useState(0);
	const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
	const [recentLaunches, setRecentLaunches] = useState<LaunchRequest[]>([]);
	// Version: prefer live health endpoint; fall back to build-time constant.
	const [serverVersion, setServerVersion] = useState<string>(
		import.meta.env.VITE_APP_VERSION ?? "—",
	);

	const reloadKeys = useCallback(async () => {
		try {
			setApiKeys((await api.getApiKeys()).keys || []);
			setKeysStatus("ok");
		} catch (err) {
			console.error("Failed to load keys:", err);
			setKeysStatus((status) => (status === "ok" ? "ok" : "failed"));
		}
	}, []);

	const reloadSupervisors = useCallback(async () => {
		try {
			setSupervisors((await api.getSupervisors()).supervisors || []);
			setSupervisorsStatus("ok");
		} catch (err) {
			console.error("Failed to load supervisors:", err);
			setSupervisorsStatus((status) => (status === "ok" ? "ok" : "failed"));
		}
	}, []);

	const reloadSettings = useCallback(async () => {
		setSettingsStatus("loading");
		try {
			setSettings((await api.getSettings()) || {});
			setSettingsStatus("ok");
		} catch (err) {
			console.error("Failed to load settings:", err);
			setSettingsStatus("failed");
		}
	}, []);

	// Fetch API keys and settings. Each answers on its own: one refusal must
	// not blank the rest of the page.
	useEffect(() => {
		async function load() {
			const [keysRes, settingsRes, supervisorsRes, launchesRes, healthRes] =
				await Promise.allSettled([
					api.getApiKeys(),
					api.getSettings(),
					api.getSupervisors(),
					api.getLaunches(),
					api.getHealth(),
				]);
			if (keysRes.status === "fulfilled") setApiKeys(keysRes.value.keys || []);
			setKeysStatus(keysRes.status === "fulfilled" ? "ok" : "failed");
			setSettingsStatus(settingsRes.status === "fulfilled" ? "ok" : "failed");
			setSupervisorsStatus(supervisorsRes.status === "fulfilled" ? "ok" : "failed");
			if (settingsRes.status === "fulfilled") {
				setSettings(settingsRes.value || {});
				const choice = themeToApply({
					perBrowser: ui.themeIsPerBrowser,
					stored: getStoredTheme(),
					server: settingsRes.value?.theme,
				});
				if (choice) {
					setTheme(choice.theme);
					if (choice.persist) persistTheme(choice.theme);
				}
			}
			if (supervisorsRes.status === "fulfilled") {
				setSupervisors(supervisorsRes.value.supervisors || []);
			}
			if (launchesRes.status === "fulfilled") {
				setRecentLaunches((launchesRes.value.launches || []).slice(0, 5));
			}
			if (healthRes.status === "fulfilled" && healthRes.value.version) {
				setServerVersion(healthRes.value.version);
			}
			for (const result of [keysRes, settingsRes, supervisorsRes, launchesRes, healthRes]) {
				if (result.status === "rejected") console.error("Failed to load settings:", result.reason);
			}
			setLoading(false);
		}
		load();
	}, [ui.themeIsPerBrowser]);

	// ?panel=account and ?panel=team open that section: scroll to it and put
	// focus on its heading, once the page has loaded.
	useEffect(() => {
		if (loading) return;
		const panel = panelToReveal(location.search, {
			account: isLocalAccount,
			ai: aiSettingsEnabled,
		});
		if (!panel) return;
		const heading = document.getElementById(panelAnchorId(panel))?.querySelector("h2");
		heading?.scrollIntoView({ block: "start" });
		heading?.focus({ preventScroll: true });
	}, [loading, location.search, isLocalAccount, aiSettingsEnabled]);

	// Toggle theme. In team mode the choice is this browser's own: writing the
	// shared setting would change everyone's screen.
	function handleThemeToggle() {
		const next: AppTheme = theme === "dark" ? "light" : "dark";
		setTheme(next);
		persistTheme(next);
		if (!ui.themeIsPerBrowser) void api.saveSetting("theme", next).catch(() => {});
	}

	// Save a setting
	async function saveSetting(key: string, value: unknown) {
		// Never write from the defaults a failed load left on screen.
		if (settingsStatus !== "ok") return;
		try {
			await api.saveSetting(key, value);
			setSettings((prev) => ({ ...prev, [key]: value }));
		} catch (err) {
			toast.error(describeApiError(err, "Couldn't save that setting. Try again."));
			setFieldResetCount((n) => n + 1);
		}
	}

	const settingsLoad = sectionLoad(settingsStatus, "the settings");
	const sections: Record<SettingsSectionId, ReactNode> = {
		appearance: (
			<>
				<section className="border border-border bg-card rounded-lg p-5 mb-6">
					<h2 className="text-sm font-semibold mb-3">Appearance</h2>
					<div className="flex items-center justify-between gap-4 mb-4">
						<div>
							<p className="text-sm text-foreground">Theme</p>
							<p className="text-xs text-muted-foreground">Toggle between dark and light mode</p>
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={theme === "dark"}
							aria-label="Dark mode"
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
			</>
		),
		supervisor: (
			<>
				<section className="border border-border bg-card rounded-lg p-5 mb-6">
					<h2 className="text-sm font-semibold mb-1">Local Supervisor</h2>
					<p className="text-xs text-muted-foreground mb-4">
						Phase 2 orchestration uses a local supervisor for capability reporting and launch
						validation. No sessions are launched yet.
					</p>

					{supervisorsStatus === "failed" ? (
						<div
							role="alert"
							className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-400"
						>
							Couldn't load supervisors.{" "}
							<button
								type="button"
								onClick={() => void reloadSupervisors()}
								className="min-h-[44px] font-medium underline md:min-h-0"
							>
								Retry
							</button>
						</div>
					) : supervisors.length === 0 ? (
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
											<div className="text-sm font-medium text-foreground">
												{supervisor.hostName}
											</div>
											<div className="text-xs text-muted-foreground">
												{supervisor.platform} / {supervisor.arch} / v{supervisor.version}
											</div>
										</div>
										<span
											className={`rounded-full px-2 py-0.5 text-[10px] ${
												supervisor.status === "connected"
													? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
													: supervisor.status === "stale"
														? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
														: "bg-red-500/10 text-red-600 dark:text-red-400"
											}`}
										>
											{supervisor.status}
										</span>
									</div>
									<div className="mt-3 grid gap-3 sm:grid-cols-2 text-xs text-muted-foreground">
										<div>
											<div className="font-medium text-foreground mb-1">Trusted roots</div>
											<div className="break-all">
												{supervisor.trustedRoots.join(", ") || "none"}
											</div>
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
			</>
		),
		launches: (
			<>
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
			</>
		),
		"session-config": (
			<>
				<section className="border border-border bg-card rounded-lg p-5 mb-6">
					<h2 className="text-sm font-semibold mb-3">Session Configuration</h2>

					<AdminSettingsGroup locked={ui.adminSettingsLocked}>
						{settingsLoad.showError && (
							<p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">
								{settingsLoad.message}{" "}
								<button
									type="button"
									onClick={() => void reloadSettings()}
									className="min-h-[44px] font-medium underline md:min-h-0"
								>
									Retry
								</button>
							</p>
						)}
						<fieldset disabled={settingsLoad.inputsDisabled} className="m-0 min-w-0 border-0 p-0">
							<div className="space-y-4">
								<div>
									<label
										htmlFor="setting-idle-timeout"
										className="text-sm text-foreground block mb-1"
									>
										Idle Timeout (minutes)
									</label>
									<p className="text-xs text-muted-foreground mb-2">
										Sessions with no activity for this long are marked idle.
									</p>
									<input
										id="setting-idle-timeout"
										key={`setting-idle-timeout-${fieldResetCount}`}
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
									<label
										htmlFor="setting-end-timeout"
										className="text-sm text-foreground block mb-1"
									>
										End Timeout (minutes)
									</label>
									<p className="text-xs text-muted-foreground mb-2">
										Sessions with no activity for this long are marked completed.
									</p>
									<input
										id="setting-end-timeout"
										key={`setting-end-timeout-${fieldResetCount}`}
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
									<label
										htmlFor="setting-event-retention"
										className="text-sm text-foreground block mb-1"
									>
										Event Retention (days)
									</label>
									<p className="text-xs text-muted-foreground mb-2">
										Disabled by default (0). When set to a positive number of days, events older
										than that are periodically and permanently deleted.
									</p>
									<input
										id="setting-event-retention"
										key={`setting-event-retention-${fieldResetCount}`}
										type="number"
										defaultValue={
											typeof settings.eventsRetentionDays === "number"
												? settings.eventsRetentionDays
												: 0
										}
										min={0}
										max={365}
										onBlur={(e) => {
											const parsed = Number(e.target.value);
											const current =
												typeof settings.eventsRetentionDays === "number"
													? settings.eventsRetentionDays
													: 0;
											// Only write when the operator actually changed the value — a
											// blur with no edit must never turn retention on (or off) as a
											// side effect of tabbing through the form.
											if (!Number.isFinite(parsed) || parsed < 0 || parsed === current) return;
											saveSetting("eventsRetentionDays", Math.floor(parsed));
										}}
										className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
									/>
								</div>
							</div>
						</fieldset>
					</AdminSettingsGroup>
				</section>
			</>
		),
		labs: (
			<>
				<SettingsSection
					panel="labs"
					title="Labs"
					description="Experimental features. Toggles here hide the related nav items, tabs, and surfaces from the rest of the app. Defaults preserve what's already shipped."
				>
					<AdminSettingsGroup locked={ui.adminSettingsLocked}>
						<LabsPanel />
					</AdminSettingsGroup>
				</SettingsSection>
			</>
		),
		ai: (
			<>
				{aiSettingsEnabled && (
					<SettingsSection
						panel="ai"
						title="AI watcher"
						description="Attach an LLM to any session. Watcher proposals require human approval."
					>
						<AdminSettingsGroup locked={ui.adminSettingsLocked}>
							<AiSettingsPanel />
						</AdminSettingsGroup>
					</SettingsSection>
				)}
			</>
		),
		workspaces: (
			<>
				<section className="border border-border bg-card rounded-lg p-5 mb-6">
					<h2 className="text-sm font-semibold mb-1">Workspaces</h2>
					<p className="text-xs text-muted-foreground mb-4">
						Where AgentPulse creates fresh directories when you say "new" in Ask. Settings here
						apply to scratch workspaces only — your existing project paths are unaffected.
					</p>
					<AdminSettingsGroup locked={ui.adminSettingsLocked}>
						<WorkspacesPanel />
					</AdminSettingsGroup>
				</section>
			</>
		),
		telegram: (
			<>
				{telegramEnabled && (
					<section className="border border-border bg-card rounded-lg p-5 mb-6 relative">
						<div className="flex items-center gap-2 mb-1">
							<h2 className="text-sm font-semibold">Telegram HITL channel</h2>
							<LabsBadge />
						</div>
						<p className="text-xs text-muted-foreground mb-4">
							Forward watcher HITL requests to a Telegram chat with inline Approve / Decline
							buttons. Enrolled channels can be assigned per session on the session AI tab.
						</p>
						<AdminSettingsGroup locked={ui.adminSettingsLocked}>
							<TelegramChannelPanel />
						</AdminSettingsGroup>
					</section>
				)}
			</>
		),
		team: (
			<>
				<TeamPanel
					apiKeys={apiKeys}
					supervisors={supervisors}
					onKeysChanged={() => void reloadKeys()}
					onSupervisorsChanged={() => void reloadSupervisors()}
				/>
			</>
		),
		keys: (
			<>
				<ApiKeysPanel
					apiKeys={apiKeys}
					status={keysStatus}
					setApiKeys={setApiKeys}
					reloadKeys={reloadKeys}
				/>
			</>
		),
		account: (
			<>
				{isLocalAccount && (
					<section
						id={panelAnchorId("account")}
						aria-labelledby="settings-account-heading"
						className="border border-border bg-card rounded-lg p-5 mb-6"
					>
						<h2
							id="settings-account-heading"
							tabIndex={-1}
							className="text-sm font-semibold mb-1 focus:outline-none"
						>
							Account
						</h2>
						<p className="text-xs text-hint mb-4">
							Change the password you sign in with. You'll stay signed in on this browser.
						</p>
						<AccountPanel />
					</section>
				)}
			</>
		),
		server: (
			<>
				<section className="border border-border bg-card rounded-lg p-5">
					<h2 className="text-sm font-semibold mb-3">Server Info</h2>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
						<div>
							<p className="text-muted-foreground text-xs">Version</p>
							<p className="font-medium">{serverVersion}</p>
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
								{`${window.location.protocol === "https:" ? "wss" : "ws"}://`}
								{window.location.host}
								{BROWSER_WS_PATH}
							</p>
						</div>
					</div>
				</section>
			</>
		),
	};

	return (
		<div className="p-3 md:p-6 max-w-3xl">
			<h1 className="text-xl md:text-2xl font-bold text-foreground mb-2">Settings</h1>
			<p className="text-sm text-muted-foreground mb-6">
				Manage API keys, appearance, and dashboard configuration.
			</p>

			{settingsSectionOrder(ui.showTeamCopy).map((id) => (
				<Fragment key={id}>{sections[id]}</Fragment>
			))}
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
					Tint session cards and tabs by working directory so multi-repo dashboards group visually
					at a glance.
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
