/**
 * StatCard — reusable KPI tile used by DashboardPage and DigestPage.
 *
 * Props:
 *   label  — short descriptor rendered above the value
 *   value  — the primary number or string
 *   sub    — optional secondary line below the value (DashboardPage usage)
 *   tone   — optional color override: "warn" (amber) or "danger" (red).
 *            Default is "default" (foreground color). DigestPage uses this
 *            to flag blocked / stuck counts.
 */
export function StatCard({
	label,
	value,
	sub,
	tone = "default",
}: {
	label: string;
	value: string | number;
	sub?: string;
	tone?: "default" | "warn" | "danger";
}) {
	const toneClass =
		tone === "warn" ? "text-amber-300" : tone === "danger" ? "text-red-300" : "text-foreground";
	return (
		<div className="rounded-lg border border-border bg-card p-4">
			<p className="text-xs text-muted-foreground mb-1">{label}</p>
			<p className={`text-2xl font-bold ${toneClass}`}>{value}</p>
			{sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
		</div>
	);
}
