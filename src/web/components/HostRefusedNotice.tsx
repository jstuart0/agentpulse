import { useUserStore } from "../stores/user-store.js";

const FALLBACK_MESSAGE =
	"With authentication off, AgentPulse answers only on localhost, an IP address, or a name listed in PUBLIC_URL.";

/**
 * The full-page screen for a server that refuses this address while authentication is off (AGEN-92).
 * Every request would fail behind it, so it replaces the app. `location.host` is shown as text only.
 */
export function HostRefusedNotice() {
	const message = useUserStore((s) => s.hostRefusedMessage) ?? FALLBACK_MESSAGE;
	const port = window.location.port;
	return (
		<main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
			<h1 className="text-xl font-semibold text-foreground">This address isn't allowed</h1>
			<p className="text-sm text-foreground">{message}</p>
			<p className="text-sm text-muted-foreground">
				You opened AgentPulse at{" "}
				<code className="rounded bg-muted px-1">{window.location.host}</code>.
			</p>
			<p className="text-sm text-muted-foreground">
				Open AgentPulse at{" "}
				<code className="rounded bg-muted px-1">http://localhost{port ? `:${port}` : ""}</code>, or
				add this address to PUBLIC_URL on the server and restart it.
			</p>
		</main>
	);
}
