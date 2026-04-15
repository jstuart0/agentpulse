import { Hono } from "hono";
import { readFile, writeFile, access } from "fs/promises";
import { join } from "path";
import { constants } from "fs";

const agentsMd = new Hono();

// Supported instruction file names, in priority order
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

// Find all instruction files in a project directory
async function findInstructionFiles(
	projectPath: string,
): Promise<{ name: string; path: string; exists: boolean }[]> {
	const results = [];
	for (const name of INSTRUCTION_FILES) {
		const filePath = join(projectPath, name);
		const exists = await fileExists(filePath);
		results.push({ name, path: filePath, exists });
	}
	// Also check .claude/ subdirectory for project-level settings
	const dotClaudeMd = join(projectPath, ".claude", "CLAUDE.md");
	if (await fileExists(dotClaudeMd)) {
		results.push({ name: ".claude/CLAUDE.md", path: dotClaudeMd, exists: true });
	}
	return results;
}

// GET /api/v1/agents-md?path=/path/to/project
// Returns the content of instruction files found in the project
agentsMd.get("/agents-md", async (c) => {
	const projectPath = c.req.query("path");

	if (!projectPath) {
		return c.json({ error: "Missing path query parameter" }, 400);
	}

	// Security: block path traversal
	if (projectPath.includes("..")) {
		return c.json({ error: "Invalid path" }, 400);
	}

	const files = await findInstructionFiles(projectPath);
	const result = [];

	for (const file of files) {
		if (file.exists) {
			try {
				const content = await readFile(file.path, "utf-8");
				result.push({
					name: file.name,
					path: file.path,
					content,
					exists: true,
				});
			} catch {
				result.push({ name: file.name, path: file.path, content: "", exists: true });
			}
		} else {
			result.push({ name: file.name, path: file.path, content: "", exists: false });
		}
	}

	return c.json({ files: result, projectPath });
});

// PUT /api/v1/agents-md
// Write content to an instruction file
agentsMd.put("/agents-md", async (c) => {
	const { path: filePath, content } = await c.req.json<{
		path: string;
		content: string;
	}>();

	if (!filePath || typeof content !== "string") {
		return c.json({ error: "Missing path or content" }, 400);
	}

	// Security: block path traversal and only allow known filenames
	if (filePath.includes("..")) {
		return c.json({ error: "Invalid path" }, 400);
	}

	const basename = filePath.split("/").pop() || "";
	if (!["CLAUDE.md", "AGENTS.md"].includes(basename)) {
		return c.json({ error: "Can only edit CLAUDE.md or AGENTS.md files" }, 400);
	}

	try {
		await writeFile(filePath, content, "utf-8");
		return c.json({ ok: true, path: filePath });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		return c.json({ error: `Failed to write file: ${message}` }, 500);
	}
});

// GET /api/v1/agents-md/snippet?type=claude_code
// Returns the appropriate snippet for the agent type
agentsMd.get("/agents-md/snippet", async (c) => {
	const agentType = c.req.query("type") || "claude_code";
	const serverUrl = c.req.query("server_url") || "";

	const sessionVar =
		agentType === "codex_cli" ? "CODEX_SESSION_ID" : "CLAUDE_SESSION_ID";
	const fileName = agentType === "codex_cli" ? "AGENTS.md" : "CLAUDE.md";

	const snippet = `## AgentPulse Status Reporting

When working on tasks, report your status every 3-5 tool uses by running:

\`\`\`bash
curl -s -X POST "\${AGENTPULSE_URL:-${serverUrl || "http://localhost:3000"}}/api/v1/hooks/status" \\
  -H "Authorization: Bearer \${AGENTPULSE_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"session_id": "'"\$${sessionVar}"'", "status": "<researching|implementing|testing|debugging|reviewing|documenting|planning|waiting>", "task": "<one-line description of current task>", "plan": ["done step", ">> current step", "pending step"]}'
\`\`\`

Use ">>" prefix for the current step in the plan array. Keep status updates concise.
Do NOT block on the curl response -- use it as a fire-and-forget status ping.`;

	return c.json({ snippet, fileName, agentType });
});

export { agentsMd };
