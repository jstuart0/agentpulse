import { useDbFingerprintStore } from "../stores/db-fingerprint-store.js";

const DEPLOY_DOCS_URL =
	"https://github.com/jstuart0/agentpulse#production--multi-replica-with-postgres";

/**
 * Persistent warning shown whenever this browser session has observed the
 * dashboard talking to more than one backing database — the signature of a
 * multi-instance SQLite deployment (SQLite is single-instance only; see
 * README "Production / multi-replica with Postgres"). Rendered in Layout
 * so it's visible regardless of which page the operator is on.
 */
export function DbSplitWarningBanner() {
	const splitDetected = useDbFingerprintStore((s) => s.splitDetected);
	if (!splitDetected) return null;

	return (
		<div
			role="alert"
			className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300 md:px-6"
		>
			This dashboard is talking to more than one AgentPulse database. AgentPulse on SQLite supports
			a single server instance — scale to one replica or set DATABASE_URL to use Postgres. Hosts,
			sessions and settings will look inconsistent until then.{" "}
			<a
				href={DEPLOY_DOCS_URL}
				target="_blank"
				rel="noreferrer"
				className="font-medium underline hover:text-amber-200"
			>
				Deployment docs
			</a>
		</div>
	);
}
