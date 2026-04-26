import { useEffect, useState } from "react";
import type { Project, ProjectInput } from "../../shared/types.js";
import { ProjectCard } from "../components/projects/ProjectCard.js";
import { ProjectForm } from "../components/projects/ProjectForm.js";
import { api } from "../lib/api.js";

type Panel = "none" | "create" | "edit";

export function ProjectsPage() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
	const [loading, setLoading] = useState(true);
	const [panel, setPanel] = useState<Panel>("none");
	const [editing, setEditing] = useState<Project | null>(null);
	const [saving, setSaving] = useState(false);
	const [formError, setFormError] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
	const [deleting, setDeleting] = useState(false);

	async function loadProjects() {
		try {
			const result = await api.listProjects();
			setProjects(result.projects);
		} catch {
			// ignore
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void loadProjects();
	}, []);

	useEffect(() => {
		if (projects.length === 0) return;
		const counts: Record<string, number> = {};
		Promise.all(
			projects.map(async (p) => {
				try {
					const result = await api.getProjectSessions(p.id);
					counts[p.id] = result.total;
				} catch {
					counts[p.id] = 0;
				}
			}),
		).then(() => setSessionCounts({ ...counts }));
	}, [projects]);

	function openCreate() {
		setEditing(null);
		setFormError("");
		setPanel("create");
	}

	function openEdit(project: Project) {
		setEditing(project);
		setFormError("");
		setPanel("edit");
	}

	function closePanel() {
		setPanel("none");
		setEditing(null);
		setFormError("");
	}

	async function handleSave(input: ProjectInput) {
		setSaving(true);
		setFormError("");
		try {
			if (panel === "edit" && editing) {
				await api.updateProject(editing.id, input);
			} else {
				await api.createProject(input);
			}
			await loadProjects();
			closePanel();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Failed to save project");
		} finally {
			setSaving(false);
		}
	}

	async function handleDelete() {
		if (!deleteTarget) return;
		setDeleting(true);
		try {
			await api.deleteProject(deleteTarget.id);
			await loadProjects();
		} catch {
			// ignore
		} finally {
			setDeleting(false);
			setDeleteTarget(null);
		}
	}

	const panelTitle = panel === "edit" ? "Edit project" : "New project";

	return (
		<div className="p-6">
			<div className="mx-auto max-w-5xl">
				<div className="flex items-center justify-between mb-6">
					<div>
						<h1 className="text-xl font-semibold text-foreground">Projects</h1>
						<p className="text-sm text-muted-foreground mt-0.5">
							Group sessions by working directory.
						</p>
					</div>
					<button
						type="button"
						onClick={openCreate}
						className="flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
					>
						<svg
							className="w-4 h-4"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth={1.5}
						>
							<path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
						</svg>
						New project
					</button>
				</div>

				<div className="flex gap-6">
					{/* Project grid */}
					<div className="flex-1 min-w-0">
						{loading ? (
							<div className="grid gap-4 md:grid-cols-2">
								{[1, 2, 3].map((i) => (
									<div
										key={i}
										className="h-32 animate-pulse rounded-lg border border-border bg-card"
									/>
								))}
							</div>
						) : projects.length === 0 ? (
							<div className="rounded-lg border border-border bg-card p-10 text-center">
								<p className="text-muted-foreground text-sm">No projects yet.</p>
								<p className="text-muted-foreground text-xs mt-1">
									Create a project to group sessions by working directory.
								</p>
								<button
									type="button"
									onClick={openCreate}
									className="mt-4 rounded border border-primary/40 px-4 py-2 text-sm text-primary hover:bg-primary/10 transition-colors"
								>
									Create your first project
								</button>
							</div>
						) : (
							<div className="grid gap-4 md:grid-cols-2">
								{projects.map((project) => (
									<ProjectCard
										key={project.id}
										project={project}
										sessionCount={sessionCounts[project.id]}
										onEdit={openEdit}
										onDelete={setDeleteTarget}
									/>
								))}
							</div>
						)}
					</div>

					{/* Side panel */}
					{panel !== "none" && (
						<div className="w-80 flex-shrink-0">
							<div className="rounded-lg border border-border bg-card p-5">
								<div className="flex items-center justify-between mb-4">
									<h2 className="text-sm font-semibold text-foreground">{panelTitle}</h2>
									<button
										type="button"
										onClick={closePanel}
										className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
									>
										<svg
											className="w-4 h-4"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											strokeWidth={1.5}
										>
											<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
										</svg>
									</button>
								</div>
								<ProjectForm
									initial={editing}
									onSave={handleSave}
									onCancel={closePanel}
									saving={saving}
									error={formError}
								/>
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Delete confirmation dialog */}
			{deleteTarget && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
					<div className="rounded-lg border border-border bg-card p-6 w-full max-w-sm mx-4 shadow-xl">
						<h3 className="text-sm font-semibold text-foreground mb-2">Delete project</h3>
						<p className="text-sm text-muted-foreground mb-1">
							Delete <span className="text-foreground font-medium">{deleteTarget.name}</span>?
						</p>
						<p className="text-xs text-muted-foreground mb-5">
							Sessions will no longer be linked to this project, but they will not be deleted.
						</p>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={handleDelete}
								disabled={deleting}
								className="flex-1 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
							>
								{deleting ? "Deleting…" : "Delete project"}
							</button>
							<button
								type="button"
								onClick={() => setDeleteTarget(null)}
								disabled={deleting}
								className="rounded border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
