import {
	OPENCODE_G9B,
	buildOpenCodePluginFiles,
	openCodeEntries,
} from "../../shared/opencode-plugin.js";
import { useCopyFeedback } from "../hooks/useCopyFeedback.js";

/**
 * The OpenCode plugin files, as the installers write them (direct mode), for copying by hand. Loaded by a
 * dynamic import only when the OpenCode toggle is chosen: it carries both plugin texts, which are far larger
 * than the rest of the Setup page.
 */
export default function OpenCodePluginFiles({ serverUrl }: { serverUrl: string }) {
	const { copy } = useCopyFeedback();
	const files = buildOpenCodePluginFiles({ baseUrl: serverUrl, direct: true });
	const entries = openCodeEntries();
	return (
		<div className="space-y-4">
			{files.map((file) => {
				const entry = entries.find((e) => e.file === file.name);
				const gated = entry?.gated === true;
				return (
					<div key={file.name}>
						<h3 className="text-xs font-semibold text-foreground mb-1">
							<span className="font-mono">~/.config/opencode/plugins/{file.name}</span>{" "}
							<span className="text-muted-foreground font-normal">
								({entry?.line === "v1" ? "OpenCode 1.x" : "OpenCode 2.x"})
							</span>
						</h3>
						{entry && entry.file !== entry.entry && (
							<p className="text-[11px] text-muted-foreground mb-1">
								A folder named <span className="font-mono">{entry.entry}</span> holding this one
								file.
							</p>
						)}
						{gated && (
							<p className="text-[11px] text-muted-foreground mb-1">
								For OpenCode 1.x. Copy it only if{" "}
								<span className="font-mono">node_modules/@opencode-ai/plugin</span> already exists
								in your OpenCode config folder (
								<span className="font-mono">~/.config/opencode</span> on macOS and Linux,{" "}
								<span className="font-mono">%USERPROFILE%\.config\opencode</span> on Windows)
								{OPENCODE_G9B.foreignOpens === "yes"
									? ", or you already use another OpenCode 1.x plugin"
									: ""}
								. Otherwise OpenCode 1.x downloads its plugin SDK on its next start, and while it
								can&apos;t reach the package registry each start waits about 70 seconds. The setup
								command checks this for you.
							</p>
						)}
						<div className="relative">
							<pre className="bg-background border border-border rounded-md p-4 text-xs overflow-auto max-h-60">
								<code>{file.text}</code>
							</pre>
							<button
								type="button"
								onClick={() => void copy(file.text, "Plugin copied")}
								className="absolute top-2 right-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
							>
								Copy
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}
