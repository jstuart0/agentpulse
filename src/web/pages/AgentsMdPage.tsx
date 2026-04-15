import { useState, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";

interface InstructionFile {
	name: string;
	path: string;
	content: string;
	exists: boolean;
}

const BASE = "/api/v1";

export function AgentsMdPage() {
	const [projectPath, setProjectPath] = useState("");
	const [files, setFiles] = useState<InstructionFile[]>([]);
	const [activeFile, setActiveFile] = useState<InstructionFile | null>(null);
	const [editorContent, setEditorContent] = useState("");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
	const [snippet, setSnippet] = useState<string | null>(null);

	// Load files for a project path
	const loadFiles = useCallback(async () => {
		if (!projectPath.trim()) return;
		setLoading(true);
		setSaveStatus("idle");
		try {
			const res = await fetch(
				`${BASE}/agents-md?path=${encodeURIComponent(projectPath.trim())}`,
			);
			const data = await res.json();
			if (data.files) {
				setFiles(data.files);
				// Auto-select the first existing file, or first file if none exist
				const first = data.files.find((f: InstructionFile) => f.exists) || data.files[0];
				if (first) {
					setActiveFile(first);
					setEditorContent(first.content);
				}
			}
		} catch (err) {
			console.error("Failed to load files:", err);
		} finally {
			setLoading(false);
		}
	}, [projectPath]);

	// Save current file
	async function handleSave() {
		if (!activeFile) return;
		setSaving(true);
		setSaveStatus("idle");
		try {
			const res = await fetch(`${BASE}/agents-md`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: activeFile.path,
					content: editorContent,
				}),
			});
			const data = await res.json();
			if (data.ok) {
				setSaveStatus("saved");
				// Update local state
				setActiveFile({ ...activeFile, content: editorContent, exists: true });
				setFiles((prev) =>
					prev.map((f) =>
						f.path === activeFile.path
							? { ...f, content: editorContent, exists: true }
							: f,
					),
				);
				setTimeout(() => setSaveStatus("idle"), 2000);
			} else {
				setSaveStatus("error");
			}
		} catch {
			setSaveStatus("error");
		} finally {
			setSaving(false);
		}
	}

	// Load snippet
	async function loadSnippet() {
		try {
			const serverUrl = window.location.origin;
			const res = await fetch(
				`${BASE}/agents-md/snippet?type=claude_code&server_url=${encodeURIComponent(serverUrl)}`,
			);
			const data = await res.json();
			setSnippet(data.snippet);
		} catch {
			console.error("Failed to load snippet");
		}
	}

	// Insert snippet at cursor / end
	function insertSnippet() {
		if (!snippet) return;
		const separator = editorContent.endsWith("\n") ? "\n" : "\n\n";
		setEditorContent(editorContent + separator + snippet + "\n");
	}

	return (
		<div className="p-6 h-full flex flex-col">
			<div className="mb-4">
				<h1 className="text-2xl font-bold text-foreground mb-1">CLAUDE.md Editor</h1>
				<p className="text-sm text-muted-foreground">
					View and edit agent instruction files for your projects.
				</p>
			</div>

			{/* Project path input */}
			<div className="flex gap-2 mb-4">
				<input
					type="text"
					value={projectPath}
					onChange={(e) => setProjectPath(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && loadFiles()}
					placeholder="Enter project path (e.g. /Users/jaystuart/dev/agentpulse)"
					className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
				/>
				<button
					onClick={loadFiles}
					disabled={loading || !projectPath.trim()}
					className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
				>
					{loading ? "Loading..." : "Open"}
				</button>
			</div>

			{/* File tabs */}
			{files.length > 0 && (
				<div className="flex items-center gap-1 mb-3">
					{files.map((file) => (
						<button
							key={file.path}
							onClick={() => {
								setActiveFile(file);
								setEditorContent(file.content);
								setSaveStatus("idle");
							}}
							className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
								activeFile?.path === file.path
									? "bg-primary/10 text-primary border border-primary/30"
									: "text-muted-foreground hover:text-foreground border border-transparent"
							}`}
						>
							{file.name}
							{!file.exists && (
								<span className="ml-1 text-muted-foreground/50">(new)</span>
							)}
						</button>
					))}

					<div className="flex-1" />

					{/* Snippet button */}
					<button
						onClick={() => {
							if (snippet) {
								insertSnippet();
							} else {
								loadSnippet();
							}
						}}
						className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					>
						{snippet ? "Insert Snippet" : "Load AgentPulse Snippet"}
					</button>

					{/* Save button */}
					<button
						onClick={handleSave}
						disabled={saving || !activeFile}
						className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
							saveStatus === "saved"
								? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
								: saveStatus === "error"
									? "bg-red-500/20 text-red-400 border border-red-500/30"
									: "bg-primary text-primary-foreground hover:bg-primary/90"
						}`}
					>
						{saving
							? "Saving..."
							: saveStatus === "saved"
								? "Saved"
								: saveStatus === "error"
									? "Error"
									: "Save"}
					</button>
				</div>
			)}

			{/* Editor */}
			{activeFile ? (
				<div className="flex-1 min-h-0 rounded-lg border border-border overflow-hidden">
					<CodeMirror
						value={editorContent}
						onChange={(val) => setEditorContent(val)}
						extensions={[markdown()]}
						theme={oneDark}
						height="100%"
						className="h-full"
						basicSetup={{
							lineNumbers: true,
							foldGutter: true,
							highlightActiveLine: true,
						}}
					/>
				</div>
			) : files.length === 0 && !loading ? (
				<div className="flex-1 flex items-center justify-center text-muted-foreground">
					<div className="text-center">
						<svg
							className="w-12 h-12 mx-auto mb-3 opacity-30"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
								d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
							/>
						</svg>
						<p className="text-sm">
							Enter a project path above to view and edit its CLAUDE.md or AGENTS.md
						</p>
					</div>
				</div>
			) : null}

			{/* Snippet preview */}
			{snippet && (
				<div className="mt-3 rounded-lg border border-border bg-card p-4">
					<div className="flex items-center justify-between mb-2">
						<h3 className="text-xs font-semibold text-foreground">AgentPulse Snippet Preview</h3>
						<button
							onClick={() => setSnippet(null)}
							className="text-xs text-muted-foreground hover:text-foreground"
						>
							Dismiss
						</button>
					</div>
					<pre className="text-xs text-muted-foreground overflow-auto max-h-32 whitespace-pre-wrap">
						{snippet}
					</pre>
				</div>
			)}
		</div>
	);
}
