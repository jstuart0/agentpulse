import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
	AgentType,
	LaunchMode,
	LaunchRequest,
	LaunchRoutingPolicy,
	SessionTemplate,
	SessionTemplateInput,
	SupervisorRecord,
	TemplatePreview,
} from "../../shared/types.js";
import { api } from "../lib/api.js";
import { TemplateEditorPanel, TemplateListPanel, TemplatePreviewPanel } from "../components/templates/TemplatePanels.js";
import {
	createBlankTemplate,
	defaultLaunchModeForAgent,
	envToLines,
	type AgentFilter,
	getHostCompatibility,
	getLaunchModeOptions,
	parseEnvLines,
	parseTags,
	tagsToString,
} from "../components/templates/utils.js";

export function TemplatesPage() {
	const navigate = useNavigate();
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
	const [lastCreatedLaunch, setLastCreatedLaunch] = useState<LaunchRequest | null>(null);
	const [launching, setLaunching] = useState(false);
	const [launchMode, setLaunchMode] = useState<LaunchMode>(defaultLaunchModeForAgent("codex_cli"));
	const [routingPolicy, setRoutingPolicy] = useState<LaunchRoutingPolicy>("manual_target");
	const [targetSupervisorId, setTargetSupervisorId] = useState<string>("");

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
				launchMode,
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
		if (!getLaunchModeOptions(draft.agentType).some((option) => option.value === launchMode)) {
			setLaunchMode(defaultLaunchModeForAgent(draft.agentType));
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
			if (!targetSupervisorId && supervisorsRes.supervisors?.length) {
				setTargetSupervisorId(
					supervisorsRes.supervisors.find((item) => item.status === "connected")?.id ||
						supervisorsRes.supervisors[0].id,
				);
			}
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
		setLaunchMode(defaultLaunchModeForAgent(template.agentType));
	}

	function resetEditor(agentType: AgentType = draft.agentType) {
		setSelectedId(null);
		setDraft(createBlankTemplate(agentType));
		setEnvText("");
		setTagsText("");
		setStatusMessage("");
		setLaunchMode(defaultLaunchModeForAgent(agentType));
	}

	function updateDraft<K extends keyof SessionTemplateInput>(key: K, value: SessionTemplateInput[K]) {
		setDraft((current) => ({ ...current, [key]: value }));
	}

	async function handleSave() {
		setSaving(true);
		setStatusMessage("");
		setLastCreatedLaunch(null);
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
		if (routingPolicy === "manual_target" && !targetSupervisorId) {
			setStatusMessage("Select a target host or switch to first capable host routing.");
			return;
		}
		setLaunching(true);
		setStatusMessage("");
		try {
			const result = (await api.createLaunch({
				templateId: selectedId,
				requestedSupervisorId:
					routingPolicy === "manual_target" ? targetSupervisorId || undefined : undefined,
				routingPolicy,
				template: {
					...draft,
					env: parseEnvLines(envText),
					tags: parseTags(tagsText),
				},
				launchSpec: effectiveLaunchSpec ?? preview.launchSpec,
				requestedLaunchMode: launchMode,
			})) as { launchRequest: LaunchRequest; supervisor: SupervisorRecord };
			setLastCreatedLaunch(result.launchRequest);
			setStatusMessage(
				result.launchRequest.status === "validated" || result.launchRequest.status === "queued"
					? `Launch request created for ${result.supervisor.hostName}. Opening live launch detail…`
					: result.launchRequest.validationSummary ||
						result.launchRequest.error ||
						"Launch request rejected.",
			);
			await loadPhaseTwoData();
			navigate(`/launches/${result.launchRequest.id}`);
		} catch (error) {
			setStatusMessage(error instanceof Error ? error.message : "Launch validation failed.");
		} finally {
			setLaunching(false);
		}
	}

	const connectedSupervisor = supervisors.find((supervisor) => supervisor.status === "connected");
	const selectedSupervisor =
		supervisors.find((supervisor) => supervisor.id === targetSupervisorId) ?? connectedSupervisor ?? null;
	const compatibleHosts = supervisors.map((supervisor) => ({
		supervisor,
		compatibility: getHostCompatibility(draft, supervisor, launchMode),
	}));
	const firstCapableHost =
		compatibleHosts.find((candidate) => candidate.supervisor.status === "connected" && candidate.compatibility.ok)
			?.supervisor ?? null;
	const effectiveLaunchSpec = preview
		? {
				...preview.launchSpec,
				launchMode,
			}
		: null;
	const launchModeOptions = getLaunchModeOptions(draft.agentType);
	const selectedLaunchMode = launchModeOptions.find((option) => option.value === launchMode) ?? launchModeOptions[0];
	const canCreateLaunch =
		Boolean(preview) &&
		(routingPolicy !== "manual_target" || Boolean(targetSupervisorId));

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
							{routingPolicy === "manual_target"
								? selectedSupervisor
									? `Target host: ${selectedSupervisor.hostName}`
									: "No target host selected"
								: firstCapableHost
									? `Routing: first capable host (${firstCapableHost.hostName})`
									: "Routing: first capable host"}
						</span>
					</div>
				</div>

				<div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)_minmax(0,1fr)]">
					<TemplateListPanel
						loading={loading}
						templates={templates}
						agentFilter={agentFilter}
						selectedId={selectedId}
						onFilterChange={setAgentFilter}
						onSelectTemplate={loadIntoEditor}
					/>
					<TemplateEditorPanel
						selectedId={selectedId}
						draft={draft}
						envText={envText}
						tagsText={tagsText}
						launchMode={launchMode}
						routingPolicy={routingPolicy}
						targetSupervisorId={targetSupervisorId}
						supervisors={supervisors}
						compatibleHosts={compatibleHosts}
						launchModeOptions={launchModeOptions}
						selectedLaunchMode={selectedLaunchMode}
						saving={saving}
						launching={launching}
						statusMessage={statusMessage}
						canCreateLaunch={canCreateLaunch}
						lastCreatedLaunch={lastCreatedLaunch}
						onUpdateDraft={updateDraft}
						onSetEnvText={setEnvText}
						onSetTagsText={setTagsText}
						onSetLaunchMode={setLaunchMode}
						onSetRoutingPolicy={setRoutingPolicy}
						onSetTargetSupervisorId={setTargetSupervisorId}
						onSave={handleSave}
						onReset={() => resetEditor(draft.agentType)}
						onDelete={handleDelete}
						onDuplicate={() => {
							if (selectedId) void handleDuplicate(selectedId);
						}}
						onCreateLaunch={handleValidateLaunch}
					/>
					<TemplatePreviewPanel
						preview={preview}
						previewError={previewError}
						connectedSupervisor={connectedSupervisor}
						selectedSupervisor={selectedSupervisor}
						effectiveLaunchSpec={effectiveLaunchSpec}
						recentLaunches={recentLaunches}
					/>
				</div>
			</div>
		</div>
	);
}
