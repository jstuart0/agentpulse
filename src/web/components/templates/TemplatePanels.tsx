import { Link } from "react-router-dom";
import type {
	AgentType,
	ApprovalPolicy,
	LaunchMode,
	LaunchRequest,
	LaunchRoutingPolicy,
	SandboxMode,
	SessionTemplate,
	SessionTemplateInput,
	SupervisorRecord,
	TemplatePreview,
} from "../../../shared/types.js";
import {
	approvalPolicies,
	type AgentFilter,
	formatLaunchTime,
	getHostCompatibility,
	launchModeLabels,
	sandboxModes,
} from "./utils.js";

export function TemplateListPanel({
	loading,
	templates,
	agentFilter,
	selectedId,
	onFilterChange,
	onSelectTemplate,
}: {
	loading: boolean;
	templates: SessionTemplate[];
	agentFilter: AgentFilter;
	selectedId: string | null;
	onFilterChange: (value: AgentFilter) => void;
	onSelectTemplate: (template: SessionTemplate) => void;
}) {
	return (
		<section className="rounded-lg border border-border bg-card p-4 space-y-4">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-sm font-semibold text-foreground">Templates</h2>
				<div className="flex gap-1 overflow-x-auto">
					{(["all", "claude_code", "codex_cli"] as AgentFilter[]).map((value) => (
						<button
							key={value}
							onClick={() => onFilterChange(value)}
							className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
								agentFilter === value
									? "bg-primary text-primary-foreground"
									: "bg-muted text-muted-foreground hover:text-foreground"
							}`}
						>
							{value === "all" ? "All" : value === "claude_code" ? "Claude" : "Codex"}
						</button>
					))}
				</div>
			</div>

			<div className="space-y-2">
				{loading ? (
					<div className="text-sm text-muted-foreground">Loading templates...</div>
				) : templates.length === 0 ? (
					<div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
						No templates yet. Save one from the editor to start building reusable session setups.
					</div>
				) : (
					templates.map((template) => (
						<button
							key={template.id}
							onClick={() => onSelectTemplate(template)}
							className={`w-full rounded-md border p-3 text-left transition-colors ${
								selectedId === template.id ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
							}`}
						>
							<div className="flex items-center justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate text-sm font-medium text-foreground">{template.name}</div>
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
							<div className="mt-2 truncate text-[11px] text-muted-foreground">{template.cwd}</div>
						</button>
					))
				)}
			</div>
		</section>
	);
}

export function TemplateEditorPanel(props: {
	selectedId: string | null;
	draft: SessionTemplateInput;
	envText: string;
	tagsText: string;
	launchMode: LaunchMode;
	routingPolicy: LaunchRoutingPolicy;
	targetSupervisorId: string;
	supervisors: SupervisorRecord[];
	compatibleHosts: Array<{
		supervisor: SupervisorRecord;
		compatibility: ReturnType<typeof getHostCompatibility>;
	}>;
	launchModeOptions: Array<{ value: LaunchMode; label: string; description: string }>;
	selectedLaunchMode?: { value: LaunchMode; label: string; description: string };
	saving: boolean;
	launching: boolean;
	statusMessage: string;
	canCreateLaunch: boolean;
	lastCreatedLaunch: LaunchRequest | null;
	onUpdateDraft: <K extends keyof SessionTemplateInput>(key: K, value: SessionTemplateInput[K]) => void;
	onSetEnvText: (value: string) => void;
	onSetTagsText: (value: string) => void;
	onSetLaunchMode: (value: LaunchMode) => void;
	onSetRoutingPolicy: (value: LaunchRoutingPolicy) => void;
	onSetTargetSupervisorId: (value: string) => void;
	onSave: () => void;
	onReset: () => void;
	onDelete: () => void;
	onDuplicate: () => void;
	onCreateLaunch: () => void;
}) {
	const {
		selectedId,
		draft,
		envText,
		tagsText,
		launchMode,
		routingPolicy,
		targetSupervisorId,
		supervisors,
		compatibleHosts,
		launchModeOptions,
		selectedLaunchMode,
		saving,
		launching,
		statusMessage,
		canCreateLaunch,
		lastCreatedLaunch,
		onUpdateDraft,
		onSetEnvText,
		onSetTagsText,
		onSetLaunchMode,
		onSetRoutingPolicy,
		onSetTargetSupervisorId,
		onSave,
		onReset,
		onDelete,
		onDuplicate,
		onCreateLaunch,
	} = props;

	return (
		<section className="rounded-lg border border-border bg-card p-4 space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="text-sm font-semibold text-foreground">{selectedId ? "Edit Template" : "Create Template"}</h2>
					<p className="text-xs text-muted-foreground mt-1">
						Saved templates define the launch contract AgentPulse hands to the supervisor.
					</p>
				</div>
				<div className="flex gap-2">
					{selectedId && (
						<>
							<button onClick={onDuplicate} className="rounded-md bg-muted px-3 py-2 text-xs text-foreground hover:bg-accent transition-colors">
								Duplicate
							</button>
							<button onClick={onDelete} className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400 hover:bg-red-500/20 transition-colors">
								Delete
							</button>
						</>
					)}
				</div>
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				<label className="space-y-1.5 text-sm">
					<span className="text-foreground">Name</span>
					<input value={draft.name} onChange={(e) => onUpdateDraft("name", e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" />
				</label>
				<label className="space-y-1.5 text-sm">
					<span className="text-foreground">Agent Type</span>
					<select value={draft.agentType} onChange={(e) => onUpdateDraft("agentType", e.target.value as AgentType)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
						<option value="codex_cli">Codex CLI</option>
						<option value="claude_code">Claude Code</option>
					</select>
				</label>
			</div>

			<label className="block space-y-1.5 text-sm">
				<span className="text-foreground">Description</span>
				<input value={draft.description ?? ""} onChange={(e) => onUpdateDraft("description", e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" placeholder="What this template is for" />
			</label>

			<label className="block space-y-1.5 text-sm">
				<span className="text-foreground">Working Directory</span>
				<input value={draft.cwd} onChange={(e) => onUpdateDraft("cwd", e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" placeholder="/absolute/path/to/project" />
			</label>

			<div className="grid gap-4 md:grid-cols-3">
				<label className="space-y-1.5 text-sm">
					<span className="text-foreground">Model</span>
					<input value={draft.model ?? ""} onChange={(e) => onUpdateDraft("model", e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" placeholder="Optional" />
				</label>
				<label className="space-y-1.5 text-sm">
					<span className="text-foreground">Approval Policy</span>
					<select
						value={draft.approvalPolicy ?? ""}
						onChange={(e) => onUpdateDraft("approvalPolicy", (e.target.value || null) as ApprovalPolicy | null)}
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
					>
						{approvalPolicies.map((value) => (
							<option key={value || "blank"} value={value}>{value || "Default"}</option>
						))}
					</select>
				</label>
				<label className="space-y-1.5 text-sm">
					<span className="text-foreground">Sandbox Mode</span>
					<select
						value={draft.sandboxMode ?? ""}
						onChange={(e) => onUpdateDraft("sandboxMode", (e.target.value || null) as SandboxMode | null)}
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
					>
						{sandboxModes.map((value) => (
							<option key={value || "blank"} value={value}>{value || "Default"}</option>
						))}
					</select>
				</label>
				<label className="space-y-1.5 text-sm">
					<span className="text-foreground">Launch Mode</span>
					<select value={launchMode} onChange={(e) => onSetLaunchMode(e.target.value as LaunchMode)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
						{launchModeOptions.map((option) => (
							<option key={option.value} value={option.value}>{option.label}</option>
						))}
					</select>
					<div className="mt-1 text-xs text-muted-foreground">{selectedLaunchMode?.description}</div>
				</label>
			</div>

			<label className="block space-y-1.5 text-sm">
				<span className="text-foreground">Routing Policy</span>
				<select value={routingPolicy} onChange={(e) => onSetRoutingPolicy(e.target.value as LaunchRoutingPolicy)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
					<option value="manual_target">Manual target</option>
					<option value="first_capable_host">First capable host</option>
				</select>
			</label>

			<label className="block space-y-1.5 text-sm">
				<span className="text-foreground">Target Host</span>
				<select value={targetSupervisorId} onChange={(e) => onSetTargetSupervisorId(e.target.value)} disabled={routingPolicy !== "manual_target"} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
					<option value="">{routingPolicy === "manual_target" ? "Select a host" : "Managed by routing policy"}</option>
					{supervisors.map((supervisor) => (
						<option key={supervisor.id} value={supervisor.id}>{supervisor.hostName} · {supervisor.status}</option>
					))}
				</select>
			</label>

			<div className="rounded-md border border-border bg-background/40 p-3">
				<div className="text-xs font-medium text-foreground">Host compatibility</div>
				<div className="mt-2 space-y-2">
					{compatibleHosts.map(({ supervisor, compatibility }) => (
						<div key={supervisor.id} className="rounded-md border border-border/70 px-3 py-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="font-medium text-foreground">{supervisor.hostName}</span>
								<span className={compatibility.ok ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400" : "rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] text-red-400"}>
									{compatibility.ok ? "compatible" : "blocked"}
								</span>
							</div>
							<div className="mt-1 text-muted-foreground">{supervisor.status} · {supervisor.platform} · {supervisor.arch}</div>
							<div className="mt-1 text-muted-foreground">
								{draft.agentType === "claude_code"
									? `Claude: ${supervisor.capabilities.executables?.claude?.resolvedPath || "Unavailable"}`
									: `Codex: ${supervisor.capabilities.executables?.codex?.resolvedPath || "Unavailable"}`}
							</div>
							{compatibility.errors.length > 0 && (
								<div className="mt-2 space-y-1 text-red-300">
									{compatibility.errors.map((error) => <div key={error}>{error}</div>)}
								</div>
							)}
							{compatibility.errors.length === 0 && compatibility.warnings.length > 0 && (
								<div className="mt-2 space-y-1 text-amber-300">
									{compatibility.warnings.map((warning) => <div key={warning}>{warning}</div>)}
								</div>
							)}
						</div>
					))}
				</div>
			</div>

			<label className="block space-y-1.5 text-sm">
				<span className="text-foreground">Base Instructions</span>
				<textarea value={draft.baseInstructions} onChange={(e) => onUpdateDraft("baseInstructions", e.target.value)} className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" placeholder="Persistent role, repo conventions, and execution rules" />
			</label>

			<label className="block space-y-1.5 text-sm">
				<span className="text-foreground">Task Prompt</span>
				<textarea value={draft.taskPrompt} onChange={(e) => onUpdateDraft("taskPrompt", e.target.value)} className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" placeholder="What the session should do when launched later" />
			</label>

			<div className="grid gap-4 md:grid-cols-2">
				<label className="block space-y-1.5 text-sm">
					<span className="text-foreground">Environment Variables</span>
					<textarea value={envText} onChange={(e) => onSetEnvText(e.target.value)} className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground" placeholder={"KEY=value\nANOTHER=value"} />
				</label>
				<div className="space-y-4">
					<label className="block space-y-1.5 text-sm">
						<span className="text-foreground">Tags</span>
						<input value={tagsText} onChange={(e) => onSetTagsText(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" placeholder="frontend, triage, repo-a" />
					</label>
					<label className="flex items-center gap-2 text-sm text-foreground">
						<input type="checkbox" checked={Boolean(draft.isFavorite)} onChange={(e) => onUpdateDraft("isFavorite", e.target.checked)} />
						Mark as favorite
					</label>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<button onClick={onSave} disabled={saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
					{saving ? "Saving..." : selectedId ? "Save Changes" : "Create Template"}
				</button>
				<button onClick={onReset} className="rounded-md bg-muted px-4 py-2 text-sm text-foreground hover:bg-accent transition-colors">Reset</button>
				<button onClick={onCreateLaunch} disabled={!canCreateLaunch || launching} className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed">
					{launching ? "Launching..." : "Create Launch Request"}
				</button>
				{statusMessage && <span className="text-xs text-muted-foreground">{statusMessage}</span>}
			</div>
			{lastCreatedLaunch && (
				<div className="rounded-md border border-border bg-background/50 px-3 py-2 text-xs">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<div className="font-medium text-foreground">
								Latest launch: {lastCreatedLaunch.status} · {launchModeLabels[lastCreatedLaunch.requestedLaunchMode]}
							</div>
							<div className="mt-1 text-muted-foreground">
								{formatLaunchTime(lastCreatedLaunch.createdAt)}
								{lastCreatedLaunch.error ? ` · ${lastCreatedLaunch.error}` : ""}
							</div>
						</div>
						<Link to={`/launches/${lastCreatedLaunch.id}`} className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent transition-colors">
							View launch
						</Link>
					</div>
				</div>
			)}
		</section>
	);
}

export function TemplatePreviewPanel({
	preview,
	previewError,
	connectedSupervisor,
	selectedSupervisor,
	effectiveLaunchSpec,
	recentLaunches,
}: {
	preview: TemplatePreview | null;
	previewError: string;
	connectedSupervisor: SupervisorRecord | undefined;
	selectedSupervisor: SupervisorRecord | null;
	effectiveLaunchSpec: Record<string, unknown> | null;
	recentLaunches: LaunchRequest[];
}) {
	return (
		<section className="rounded-lg border border-border bg-card p-4 space-y-4">
			<div>
				<h2 className="text-sm font-semibold text-foreground">Launch Preview</h2>
				<p className="text-xs text-muted-foreground mt-1">
					This is the normalized launch contract AgentPulse hands to the supervisor. The preview itself does not start anything.
				</p>
			</div>

			<div className="rounded-md border border-border bg-background/60 p-3 text-xs">
				<div className="font-medium text-foreground">
					{connectedSupervisor ? `Validated against ${selectedSupervisor?.hostName ?? connectedSupervisor.hostName}` : "No connected supervisor"}
				</div>
				<div className="mt-1 text-muted-foreground">
					{selectedSupervisor ? `Trusted roots: ${selectedSupervisor.trustedRoots.join(", ") || "none"}` : "Start the local supervisor before creating launch requests."}
				</div>
			</div>

			{previewError ? (
				<div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-300">{previewError}</div>
			) : preview ? (
				<div className="space-y-4">
					<div className="rounded-md border border-border bg-background/60 p-3">
						<div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Recommended command</div>
						<code className="block whitespace-pre-wrap break-all text-xs text-foreground">
							{preview.launchSpec.agentType === "claude_code" ? preview.guidance.claudeCode.command : preview.guidance.codexCli.command}
						</code>
					</div>

					<div className="grid gap-3">
						{[preview.guidance.claudeCode, preview.guidance.codexCli].map((item) => (
							<div key={item.label} className="rounded-md border border-border p-3">
								<div className="flex items-center justify-between gap-2">
									<div className="text-sm font-medium text-foreground">{item.label}</div>
									{item.recommended && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">Recommended</span>}
								</div>
								<code className="mt-2 block whitespace-pre-wrap break-all text-xs text-foreground">{item.command}</code>
								<ul className="mt-2 space-y-1 text-xs text-muted-foreground">
									{item.notes.map((note) => <li key={note}>- {note}</li>)}
								</ul>
							</div>
						))}
					</div>

					{preview.warnings.length > 0 && (
						<div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
							<div className="text-xs uppercase tracking-wide text-amber-400 mb-2">Warnings</div>
							<ul className="space-y-1 text-xs text-amber-200">
								{preview.warnings.map((warning) => <li key={warning}>- {warning}</li>)}
							</ul>
						</div>
					)}

					<div className="rounded-md border border-border bg-background/60 p-3">
						<div className="flex items-center justify-between gap-3 mb-2">
							<div className="text-xs uppercase tracking-wide text-muted-foreground">Normalized launch spec JSON</div>
							<button
								onClick={() => navigator.clipboard.writeText(JSON.stringify(effectiveLaunchSpec, null, 2))}
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
							<div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Recent launch requests</div>
							<div className="space-y-2">
								{recentLaunches.map((launch) => (
									<Link key={launch.id} to={`/launches/${launch.id}`} className="block rounded-md bg-background/60 px-3 py-2 text-xs transition-colors hover:bg-background">
										<div className="flex items-center justify-between gap-2">
											<span className="font-medium text-foreground">{launch.agentType === "claude_code" ? "Claude Code" : "Codex CLI"}</span>
											<div className="text-right">
												<span className="text-muted-foreground">{launch.status} · {launchModeLabels[launch.requestedLaunchMode]}</span>
												{formatLaunchTime(launch.createdAt) && <div className="mt-1 text-[10px] text-muted-foreground">{formatLaunchTime(launch.createdAt)}</div>}
											</div>
										</div>
										<div className="mt-1 break-all text-muted-foreground">{launch.cwd}</div>
										{launch.validationSummary && <div className="mt-1 text-muted-foreground">{launch.validationSummary}</div>}
										{launch.error && <div className="mt-1 text-red-300">{launch.error}</div>}
									</Link>
								))}
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="text-sm text-muted-foreground">Preview will appear as you edit the template.</div>
			)}
		</section>
	);
}

