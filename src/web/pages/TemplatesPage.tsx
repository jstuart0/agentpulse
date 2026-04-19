import { useEffect, useState } from "react";
import type {
	AgentType,
	ApprovalPolicy,
	LaunchMode,
	LaunchRequest,
	SandboxMode,
	SessionTemplate,
	SessionTemplateInput,
	SupervisorRecord,
	TemplatePreview,
} from "../../shared/types.js";
import { api } from "../lib/api.js";

type AgentFilter = "all" | AgentType;

const approvalPolicies: Array<ApprovalPolicy | ""> = [
	"",
	"default",
	"suggest",
	"auto",
	"manual",
	"untrusted",
	"on-failure",
];

const sandboxModes: Array<SandboxMode | ""> = [
	"",
	"default",
	"workspace-write",
	"read-only",
	"danger-full-access",
];

function createBlankTemplate(agentType: AgentType = "codex_cli"): SessionTemplateInput {
	return {
		name: "New template",
		description: "",
		agentType,
		cwd: "",
		baseInstructions: "",
		taskPrompt: "",
		model: "",
		approvalPolicy: null,
		sandboxMode: null,
		env: {},
		tags: [],
		isFavorite: false,
	};
}

function parseEnvLines(raw: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex <= 0) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		const value = trimmed.slice(eqIndex + 1).trim();
		if (key) env[key] = value;
	}
	return env;
}

function envToLines(env: Record<string, string>) {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

function tagsToString(tags: string[]) {
	return tags.join(", ");
}

function parseTags(raw: string) {
	return raw
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

export function TemplatesPage() {
	const [templates, setTemplates] = useState<SessionTemplate[]>([]);
	const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<SessionTemplateInput>(createBlankTemplate());
	const [envText, setEnvText] = useState("");
	const [tagsText, setTagsText] = useState("");
	const [preview, setPreview] = useState<TemplatePreview | null>(null);
	const [previewError, setPreviewError] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [statusMessage, setStatusMessage] = useState("");
	const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
	const [recentLaunches, setRecentLaunches] = useState<LaunchRequest[]>([]);
	const [launching, setLaunching] = useState(false);
	const [launchMode, setLaunchMode] = useState<LaunchMode>("managed_codex");

	useEffect(() => {
		loadTemplates();
	}, [agentFilter]);

	useEffect(() => {
		loadPhaseTwoData();
	}, []);

	useEffect(() => {
		const timeout = setTimeout(async () => {
			if (!draft.cwd.trim()) {
				setPreview(null);
				setPreviewError("");
				return;
			}
			const body = {
				...draft,
				env: parseEnvLines(envText),
				tags: parseTags(tagsText),
			};
			try {
				const result = (await api.previewTemplate(body)) as TemplatePreview;
				setPreview(result);
				setPreviewError("");
			} catch (error) {
				setPreview(null);
				setPreviewError(error instanceof Error ? error.message : "Preview unavailable");
			}
		}, 250);

		return () => clearTimeout(timeout);
	}, [draft, envText, tagsText]);

	useEffect(() => {
		if (draft.agentType === "claude_code" && launchMode === "managed_codex") {
			setLaunchMode("interactive_terminal");
		}
	}, [draft.agentType, launchMode]);

	async function loadTemplates() {
		setLoading(true);
		try {
			const result = (await api.getTemplates(
				agentFilter === "all" ? undefined : { agent_type: agentFilter },
			)) as { templates: SessionTemplate[] };
			setTemplates(result.templates);
			if (selectedId) {
				const matching = result.templates.find((template) => template.id === selectedId);
				if (!matching) {
					setSelectedId(null);
				}
			}
		} finally {
			setLoading(false);
		}
	}

	async function loadPhaseTwoData() {
		try {
			const [supervisorsRes, launchesRes] = await Promise.all([
				api.getSupervisors() as Promise<{ supervisors: SupervisorRecord[] }>,
				api.getLaunches() as Promise<{ launches: LaunchRequest[] }>,
			]);
			setSupervisors(supervisorsRes.supervisors ?? []);
			setRecentLaunches((launchesRes.launches ?? []).slice(0, 5));
		} catch (error) {
			console.error("Failed to load orchestration status", error);
		}
	}

	function loadIntoEditor(template: SessionTemplate) {
		setSelectedId(template.id);
		setDraft({
			name: template.name,
			description: template.description ?? "",
			agentType: template.agentType,
			cwd: template.cwd,
			baseInstructions: template.baseInstructions,
			taskPrompt: template.taskPrompt,
			model: template.model ?? "",
			approvalPolicy: template.approvalPolicy,
			sandboxMode: template.sandboxMode,
			env: template.env,
			tags: template.tags,
			isFavorite: template.isFavorite,
		});
		setEnvText(envToLines(template.env));
		setTagsText(tagsToString(template.tags));
		setStatusMessage("");
		setLaunchMode(template.agentType === "codex_cli" ? "managed_codex" : "interactive_terminal");
	}

	function resetEditor(agentType: AgentType = draft.agentType) {
		setSelectedId(null);
		setDraft(createBlankTemplate(agentType));
		setEnvText("");
		setTagsText("");
		setStatusMessage("");
		setLaunchMode(agentType === "codex_cli" ? "managed_codex" : "interactive_terminal");
	}

	function updateDraft<K extends keyof SessionTemplateInput>(key: K, value: SessionTemplateInput[K]) {
		setDraft((current) => ({ ...current, [key]: value }));
	}

	async function handleSave() {
		setSaving(true);
		setStatusMessage("");
		const payload = {
			...draft,
			env: parseEnvLines(envText),
			tags: parseTags(tagsText),
		};
		try {
			if (selectedId) {
				const result = (await api.updateTemplate(selectedId, payload)) as {
					template: SessionTemplate;
				};
				loadIntoEditor(result.template);
				await loadTemplates();
				setStatusMessage("Template updated.");
			} else {
				const result = (await api.createTemplate(payload)) as {
					template: SessionTemplate;
				};
				loadIntoEditor(result.template);
				await loadTemplates();
				setStatusMessage("Template created.");
			}
		} catch (error) {
			setStatusMessage(error instanceof Error ? error.message : "Save failed.");
		} finally {
			setSaving(false);
		}
	}

	async function handleDelete() {
		if (!selectedId) return;
		if (!confirm("Delete this template?")) return;
		try {
			await api.deleteTemplate(selectedId);
			resetEditor();
			await loadTemplates();
			setStatusMessage("Template deleted.");
		} catch (error) {
			setStatusMessage(error instanceof Error ? error.message : "Delete failed.");
		}
	}

	async function handleDuplicate(templateId: string) {
		try {
			const result = (await api.duplicateTemplate(templateId)) as {
				template: SessionTemplate;
			};
			loadIntoEditor(result.template);
			await loadTemplates();
			setStatusMessage("Template duplicated.");
		} catch (error) {
			setStatusMessage(error instanceof Error ? error.message : "Duplicate failed.");
		}
	}

	async function handleValidateLaunch() {
		if (!preview) return;
		setLaunching(true);
		setStatusMessage("");
		try {
			const result = (await api.createLaunch({
				templateId: selectedId,
				template: {
					...draft,
					env: parseEnvLines(envText),
					tags: parseTags(tagsText),
				},
				launchSpec: effectiveLaunchSpec ?? preview.launchSpec,
				requestedLaunchMode: launchMode,
			})) as { launchRequest: LaunchRequest; supervisor: SupervisorRecord };
			setStatusMessage(
				result.launchRequest.status === "validated"
					? `Launch request created for ${result.supervisor.hostName}.`
					: result.launchRequest.validationSummary || "Launch request rejected.",
			);
			await loadPhaseTwoData();
		} catch (error) {
			setStatusMessage(error instanceof Error ? error.message : "Launch validation failed.");
		} finally {
			setLaunching(false);
		}
	}

	const connectedSupervisor = supervisors.find((supervisor) => supervisor.status === "connected");
	const effectiveLaunchSpec = preview
		? {
				...preview.launchSpec,
				launchMode,
			}
		: null;

	return (
		<div className="p-3 md:p-6">
			<div className="max-w-7xl space-y-6">
				<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
					<div>
						<h1 className="text-xl md:text-2xl font-bold text-foreground">
							Session Templates
						</h1>
						<p className="text-sm text-muted-foreground mt-1 max-w-2xl">
							Define reusable Claude Code and Codex session setups. Launch requests are
							executed automatically when a connected supervisor can claim them.
						</p>
					</div>
					<div className="flex flex-col items-start gap-2 md:items-end">
						<button
							onClick={() => resetEditor()}
							className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
						>
							New Template
						</button>
						<span className="text-xs text-muted-foreground">
							{connectedSupervisor
								? `Supervisor connected: ${connectedSupervisor.hostName}`
								: "No connected supervisor"}
						</span>
					</div>
				</div>

				<div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)_minmax(0,1fr)]">
					<section className="rounded-lg border border-border bg-card p-4 space-y-4">
						<div className="flex items-center justify-between gap-2">
							<h2 className="text-sm font-semibold text-foreground">Templates</h2>
							<div className="flex gap-1 overflow-x-auto">
								{(["all", "claude_code", "codex_cli"] as AgentFilter[]).map((value) => (
									<button
										key={value}
										onClick={() => setAgentFilter(value)}
										className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
											agentFilter === value
												? "bg-primary text-primary-foreground"
												: "bg-muted text-muted-foreground hover:text-foreground"
										}`}
									>
										{value === "all"
											? "All"
											: value === "claude_code"
												? "Claude"
												: "Codex"}
									</button>
								))}
							</div>
						</div>

						<div className="space-y-2">
							{loading ? (
								<div className="text-sm text-muted-foreground">Loading templates...</div>
							) : templates.length === 0 ? (
								<div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
									No templates yet. Save one from the editor to start building reusable
									session setups.
								</div>
							) : (
								templates.map((template) => (
									<button
										key={template.id}
										onClick={() => loadIntoEditor(template)}
										className={`w-full rounded-md border p-3 text-left transition-colors ${
											selectedId === template.id
												? "border-primary bg-primary/5"
												: "border-border hover:bg-accent"
										}`}
									>
										<div className="flex items-center justify-between gap-2">
											<div className="min-w-0">
												<div className="truncate text-sm font-medium text-foreground">
													{template.name}
												</div>
												<div className="mt-1 text-[11px] text-muted-foreground">
													{template.agentType === "claude_code" ? "Claude Code" : "Codex CLI"}
												</div>
											</div>
											{template.isFavorite && (
												<span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
													Favorite
												</span>
											)}
										</div>
										<div className="mt-2 truncate text-[11px] text-muted-foreground">
											{template.cwd}
										</div>
									</button>
								))
							)}
						</div>
					</section>

					<section className="rounded-lg border border-border bg-card p-4 space-y-4">
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div>
								<h2 className="text-sm font-semibold text-foreground">
									{selectedId ? "Edit Template" : "Create Template"}
								</h2>
								<p className="text-xs text-muted-foreground mt-1">
									Saved templates define the launch contract AgentPulse hands to the
									supervisor.
								</p>
							</div>
							<div className="flex gap-2">
								{selectedId && (
									<>
										<button
											onClick={() => handleDuplicate(selectedId)}
											className="rounded-md bg-muted px-3 py-2 text-xs text-foreground hover:bg-accent transition-colors"
										>
											Duplicate
										</button>
										<button
											onClick={handleDelete}
											className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400 hover:bg-red-500/20 transition-colors"
										>
											Delete
										</button>
									</>
								)}
							</div>
						</div>

						<div className="grid gap-4 md:grid-cols-2">
							<label className="space-y-1.5 text-sm">
								<span className="text-foreground">Name</span>
								<input
									value={draft.name}
									onChange={(e) => updateDraft("name", e.target.value)}
									className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								/>
							</label>
							<label className="space-y-1.5 text-sm">
								<span className="text-foreground">Agent Type</span>
								<select
									value={draft.agentType}
									onChange={(e) =>
										updateDraft("agentType", e.target.value as AgentType)
									}
									className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								>
									<option value="codex_cli">Codex CLI</option>
									<option value="claude_code">Claude Code</option>
								</select>
							</label>
						</div>

						<label className="block space-y-1.5 text-sm">
							<span className="text-foreground">Description</span>
							<input
								value={draft.description ?? ""}
								onChange={(e) => updateDraft("description", e.target.value)}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								placeholder="What this template is for"
							/>
						</label>

						<label className="block space-y-1.5 text-sm">
							<span className="text-foreground">Working Directory</span>
							<input
								value={draft.cwd}
								onChange={(e) => updateDraft("cwd", e.target.value)}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								placeholder="/absolute/path/to/project"
							/>
						</label>

						<div className="grid gap-4 md:grid-cols-3">
							<label className="space-y-1.5 text-sm">
								<span className="text-foreground">Model</span>
								<input
									value={draft.model ?? ""}
									onChange={(e) => updateDraft("model", e.target.value)}
									className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
									placeholder="Optional"
								/>
							</label>
							<label className="space-y-1.5 text-sm">
								<span className="text-foreground">Approval Policy</span>
								<select
									value={draft.approvalPolicy ?? ""}
									onChange={(e) =>
										updateDraft(
											"approvalPolicy",
											(e.target.value || null) as ApprovalPolicy | null,
										)
									}
									className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								>
									{approvalPolicies.map((value) => (
										<option key={value || "blank"} value={value}>
											{value || "Default"}
										</option>
									))}
								</select>
							</label>
							<label className="space-y-1.5 text-sm">
								<span className="text-foreground">Sandbox Mode</span>
								<select
									value={draft.sandboxMode ?? ""}
									onChange={(e) =>
										updateDraft(
											"sandboxMode",
											(e.target.value || null) as SandboxMode | null,
										)
									}
									className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								>
									{sandboxModes.map((value) => (
										<option key={value || "blank"} value={value}>
											{value || "Default"}
										</option>
									))}
								</select>
							</label>
							<label className="space-y-1.5 text-sm">
								<span className="text-foreground">Launch Mode</span>
								<select
									value={launchMode}
									onChange={(e) => setLaunchMode(e.target.value as LaunchMode)}
									className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								>
									<option value="interactive_terminal">Interactive terminal</option>
									{draft.agentType === "codex_cli" && (
										<option value="managed_codex">Managed Codex</option>
									)}
								</select>
							</label>
						</div>

						<label className="block space-y-1.5 text-sm">
							<span className="text-foreground">Base Instructions</span>
							<textarea
								value={draft.baseInstructions}
								onChange={(e) => updateDraft("baseInstructions", e.target.value)}
								className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								placeholder="Persistent role, repo conventions, and execution rules"
							/>
						</label>

						<label className="block space-y-1.5 text-sm">
							<span className="text-foreground">Task Prompt</span>
							<textarea
								value={draft.taskPrompt}
								onChange={(e) => updateDraft("taskPrompt", e.target.value)}
								className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
								placeholder="What the session should do when launched later"
							/>
						</label>

						<div className="grid gap-4 md:grid-cols-2">
							<label className="block space-y-1.5 text-sm">
								<span className="text-foreground">Environment Variables</span>
								<textarea
									value={envText}
									onChange={(e) => setEnvText(e.target.value)}
									className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
									placeholder={"KEY=value\nANOTHER=value"}
								/>
							</label>
							<div className="space-y-4">
								<label className="block space-y-1.5 text-sm">
									<span className="text-foreground">Tags</span>
									<input
										value={tagsText}
										onChange={(e) => setTagsText(e.target.value)}
										className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
										placeholder="frontend, triage, repo-a"
									/>
								</label>
								<label className="flex items-center gap-2 text-sm text-foreground">
									<input
										type="checkbox"
										checked={Boolean(draft.isFavorite)}
										onChange={(e) => updateDraft("isFavorite", e.target.checked)}
									/>
									Mark as favorite
								</label>
							</div>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<button
								onClick={handleSave}
								disabled={saving}
								className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
							>
								{saving ? "Saving..." : selectedId ? "Save Changes" : "Create Template"}
							</button>
							<button
								onClick={() => resetEditor(draft.agentType)}
								className="rounded-md bg-muted px-4 py-2 text-sm text-foreground hover:bg-accent transition-colors"
							>
								Reset
							</button>
							<button
								onClick={handleValidateLaunch}
								disabled={!preview || launching || !connectedSupervisor}
								className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{launching ? "Launching..." : "Create Launch Request"}
							</button>
							{statusMessage && (
								<span className="text-xs text-muted-foreground">{statusMessage}</span>
							)}
						</div>
					</section>

					<section className="rounded-lg border border-border bg-card p-4 space-y-4">
						<div>
							<h2 className="text-sm font-semibold text-foreground">Launch Preview</h2>
							<p className="text-xs text-muted-foreground mt-1">
								This is the normalized launch contract AgentPulse hands to the
								supervisor. The preview itself does not start anything.
							</p>
						</div>

						<div className="rounded-md border border-border bg-background/60 p-3 text-xs">
							<div className="font-medium text-foreground">
								{connectedSupervisor
									? `Validated against ${connectedSupervisor.hostName}`
									: "No connected supervisor"}
							</div>
							<div className="mt-1 text-muted-foreground">
								{connectedSupervisor
									? `Trusted roots: ${connectedSupervisor.trustedRoots.join(", ") || "none"}`
									: "Start the local supervisor before creating launch requests."}
							</div>
						</div>

						{previewError ? (
							<div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-300">
								{previewError}
							</div>
						) : preview ? (
							<div className="space-y-4">
								<div className="rounded-md border border-border bg-background/60 p-3">
									<div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
										Recommended command
									</div>
									<code className="block whitespace-pre-wrap break-all text-xs text-foreground">
										{preview.launchSpec.agentType === "claude_code"
											? preview.guidance.claudeCode.command
											: preview.guidance.codexCli.command}
									</code>
								</div>

								<div className="grid gap-3">
									{[
										preview.guidance.claudeCode,
										preview.guidance.codexCli,
									].map((item) => (
										<div key={item.label} className="rounded-md border border-border p-3">
											<div className="flex items-center justify-between gap-2">
												<div className="text-sm font-medium text-foreground">
													{item.label}
												</div>
												{item.recommended && (
													<span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
														Recommended
													</span>
												)}
											</div>
											<code className="mt-2 block whitespace-pre-wrap break-all text-xs text-foreground">
												{item.command}
											</code>
											<ul className="mt-2 space-y-1 text-xs text-muted-foreground">
												{item.notes.map((note) => (
													<li key={note}>- {note}</li>
												))}
											</ul>
										</div>
									))}
								</div>

								{preview.warnings.length > 0 && (
									<div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
										<div className="text-xs uppercase tracking-wide text-amber-400 mb-2">
											Warnings
										</div>
										<ul className="space-y-1 text-xs text-amber-200">
											{preview.warnings.map((warning) => (
												<li key={warning}>- {warning}</li>
											))}
										</ul>
									</div>
								)}

								<div className="rounded-md border border-border bg-background/60 p-3">
									<div className="flex items-center justify-between gap-3 mb-2">
										<div className="text-xs uppercase tracking-wide text-muted-foreground">
											Normalized launch spec JSON
										</div>
										<button
											onClick={() =>
												navigator.clipboard.writeText(
													JSON.stringify(effectiveLaunchSpec, null, 2),
												)
											}
											className="rounded-md bg-muted px-2.5 py-1 text-[11px] text-foreground hover:bg-accent transition-colors"
										>
											Copy JSON
										</button>
									</div>
									<pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-foreground">
										{JSON.stringify(effectiveLaunchSpec, null, 2)}
									</pre>
								</div>

								{recentLaunches.length > 0 && (
									<div className="rounded-md border border-border p-3">
										<div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
											Recent launch requests
										</div>
										<div className="space-y-2">
											{recentLaunches.map((launch) => (
												<div
													key={launch.id}
													className="rounded-md bg-background/60 px-3 py-2 text-xs"
												>
													<div className="flex items-center justify-between gap-2">
														<span className="font-medium text-foreground">
															{launch.agentType === "claude_code"
																? "Claude Code"
																: "Codex CLI"}
														</span>
														<span className="text-muted-foreground">
															{launch.status} · {launch.requestedLaunchMode}
														</span>
													</div>
													<div className="mt-1 break-all text-muted-foreground">
														{launch.cwd}
													</div>
													{launch.validationSummary && (
														<div className="mt-1 text-muted-foreground">
															{launch.validationSummary}
														</div>
													)}
												</div>
											))}
										</div>
									</div>
								)}
							</div>
						) : (
							<div className="text-sm text-muted-foreground">
								Preview will appear as you edit the template.
							</div>
						)}
					</section>
				</div>
			</div>
		</div>
	);
}
