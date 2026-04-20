/**
 * Phase 8 structured-metrics emitter. AgentPulse has no metrics
 * subsystem — logs are the only signal. Rather than introducing one,
 * we emit single-line JSON events with a stable `type: "ai_metric"`
 * prefix so downstream log shippers (Loki, Datadog, Splunk, Elastic,
 * etc.) can lift them into whatever metrics backend the operator
 * already runs.
 *
 * Optional OpenTelemetry export is gated behind AGENTPULSE_OTEL_ENDPOINT
 * and is intentionally best-effort — failures never crash the caller.
 */

import { env } from "node:process";

export type AiMetricEvent =
	| {
			name: "watcher_run_queued" | "watcher_run_claimed";
			sessionId: string;
			runId: string;
			attempt: number;
	  }
	| {
			name: "watcher_run_completed";
			sessionId: string;
			runId: string;
			outcome: "succeeded" | "failed" | "expired" | "cancelled";
			durationMs?: number;
			errorSubType?: string | null;
	  }
	| {
			name: "proposal_decision";
			sessionId: string;
			proposalId: string;
			decision: string;
			costCents: number;
			tokensIn: number;
			tokensOut: number;
	  }
	| {
			name: "hitl_resolved";
			sessionId: string;
			hitlId: string;
			openedAt: string;
			resolvedAt: string;
			latencyMs: number;
			action: "applied" | "declined" | "custom" | "timed_out" | "superseded";
	  }
	| {
			name: "classifier_snapshot";
			sessionId: string;
			health: string;
			reasonCode: string;
	  }
	| {
			name: "template_distilled" | "recommendation_shown";
			sessionId?: string;
			templateId?: string;
			accepted?: boolean;
	  };

export function emitAiMetric(event: AiMetricEvent): void {
	const payload = { type: "ai_metric", ts: new Date().toISOString(), ...event };
	// Plain console.log so whatever log collector is already configured
	// picks it up without us having to introduce a logger dependency.
	console.log(JSON.stringify(payload));
	if (env.AGENTPULSE_OTEL_ENDPOINT) void forwardToOtel(payload);
}

async function forwardToOtel(payload: Record<string, unknown>): Promise<void> {
	const endpoint = env.AGENTPULSE_OTEL_ENDPOINT;
	if (!endpoint) return;
	try {
		await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				// Minimal OTLP-shaped envelope — the intent is "pipe this into
				// an OTel collector", not "match the full spec"; operators
				// can shape it with an OTel collector pipeline.
				resource: { attributes: [{ key: "service.name", value: { stringValue: "agentpulse" } }] },
				scopeMetrics: [
					{
						scope: { name: "agentpulse.ai" },
						metrics: [
							{
								name: payload.name,
								description: "AgentPulse AI metric",
								sum: {
									aggregationTemporality: 2,
									isMonotonic: false,
									dataPoints: [
										{
											asInt: 1,
											timeUnixNano: String(Date.now() * 1_000_000),
											attributes: Object.entries(payload)
												.filter(([k]) => k !== "type" && k !== "ts" && k !== "name")
												.map(([k, v]) => ({
													key: k,
													value: { stringValue: String(v) },
												})),
										},
									],
								},
							},
						],
					},
				],
			}),
		});
	} catch {
		// OTel forwarding is best-effort. Never disrupt the caller.
	}
}
