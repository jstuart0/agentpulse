/**
 * The "solo no-lockout" probe: for every API route, call it as each kind of
 * caller a single-operator install has and report the status it answers with.
 *
 * The statuses recorded in auth/base-route-statuses.ts came from running THIS
 * file against the app as it was before team mode existed (a checkout of the
 * main branch, in a scratch worktree), so the comparison has a real anchor
 * rather than a reading of what the handlers "should" do. It therefore imports
 * only what that checkout also has, and must keep doing so.
 *
 * Calls are made with an empty JSON body and every path parameter set to
 * "abc". The rows behind "abc" exist for the routes that act on one (a session
 * owned by the local user, a key, a host), and are put back before every call:
 * a route that deletes or revokes one can't change the answer for the next
 * caller, and the owner-or-admin checks of later work really run (they must all
 * be no-ops in solo, for every caller). A fresh login cookie is issued per call
 * so a route that signs the caller out can't change the answer either.
 */
import { eq } from "drizzle-orm";
import { createApiKey } from "../auth/api-key.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { apiKeys, sessions, supervisors } from "../db/schema/index.js";
import { SESSION_COOKIE_NAME, createUser, issueSession } from "../services/local-auth-service.js";

export const PROBE_CALLERS = [
	"localAdmin",
	"localUser",
	"ssoMember",
	"ownerlessManageKey",
	"authDisabled",
] as const;
export type ProbeCaller = (typeof PROBE_CALLERS)[number];

/**
 * Routes the probe never calls: ones that would make an outbound request
 * (telemetry) or change process-wide state (the drain endpoint), whatever the
 * caller. Prefix match on the path under /api/v1.
 */
const SKIPPED_PREFIXES = ["/internal/", "/telemetry/ping"];

const PREFIX = "/api/v1";
export const SSO_PROBE_SECRET = "route-probe-forwardauth-secret";

interface RouteLike {
	method: string;
	path: string;
}

/** Every distinct "METHOD /path" under /api/v1 that the probe calls, in registration order. */
export function probeRoutes(routes: readonly RouteLike[]): string[] {
	const seen = new Set<string>();
	const entries: string[] = [];
	for (const route of routes) {
		if (route.method === "ALL" || route.path.includes("*")) continue;
		if (!route.path.startsWith(`${PREFIX}/`)) continue;
		const path = route.path.slice(PREFIX.length);
		if (SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
		const entry = `${route.method} ${path}`;
		if (seen.has(entry)) continue;
		seen.add(entry);
		entries.push(entry);
	}
	return entries;
}

export interface ProbeIdentities {
	adminUserId: string;
	memberUserId: string;
	manageKey: string;
}

/** Creates the identities the callers use. Call once, on an empty identity state. */
export async function seedProbeIdentities(): Promise<ProbeIdentities> {
	const tag = crypto.randomUUID().slice(0, 8);
	const admin = await createUser({
		username: `probe-admin-${tag}`,
		password: "a-very-long-password-123",
		role: "admin",
	});
	const member = await createUser({
		username: `probe-user-${tag}`,
		password: "a-very-long-password-123",
		role: "user",
	});
	const { key } = await createApiKey(`probe-manage-${tag}`, ["manage"]);
	return { adminUserId: admin.id, memberUserId: member.id, manageKey: key };
}

const PROBE_ROW_ID = "abc";

/**
 * Puts the rows behind "abc" back: a session, an API key and a host, each
 * owned by the local user where the schema has an owner (the base checkout has
 * none; the extra field is simply ignored there).
 */
async function removeProbeRows(): Promise<void> {
	const db = getDb();
	await db.delete(sessions).where(eq(sessions.sessionId, PROBE_ROW_ID));
	await db.delete(apiKeys).where(eq(apiKeys.id, PROBE_ROW_ID));
	await db.delete(supervisors).where(eq(supervisors.id, PROBE_ROW_ID));
}

async function reseedProbeRows(ids: ProbeIdentities): Promise<void> {
	const db = getDb();
	const owner = { ownerUserId: ids.memberUserId };
	await removeProbeRows();
	await db.insert(sessions).values({
		sessionId: PROBE_ROW_ID,
		displayName: "probe session",
		agentType: "claude_code",
		status: "completed",
		...owner,
	} as typeof sessions.$inferInsert);
	await db.insert(apiKeys).values({
		id: PROBE_ROW_ID,
		name: "probe target key",
		keyHash: "probe-target-hash",
		keyPrefix: "ap_probe000",
		scopes: JSON.stringify(["ingest"]),
		...owner,
	} as typeof apiKeys.$inferInsert);
	await db.insert(supervisors).values({
		id: PROBE_ROW_ID,
		hostName: "probe host",
		platform: "linux",
		arch: "x64",
		version: "1.0.0",
		...owner,
	} as typeof supervisors.$inferInsert);
}

async function headersFor(caller: ProbeCaller, ids: ProbeIdentities): Promise<Headers> {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (caller === "localAdmin" || caller === "localUser") {
		const { token } = await issueSession({
			userId: caller === "localAdmin" ? ids.adminUserId : ids.memberUserId,
		});
		headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
	} else if (caller === "ssoMember") {
		headers.set(config.forwardauthHeader("username"), "probe-sso-member");
		headers.set(config.forwardauthHeader("uid"), "probe-sso-member-uid");
		headers.set(config.forwardauthHeader("verify"), SSO_PROBE_SECRET);
	} else if (caller === "ownerlessManageKey") {
		headers.set("Authorization", `Bearer ${ids.manageKey}`);
	}
	return headers;
}

type Fetcher = { request(path: string, init?: RequestInit): Response | Promise<Response> };

/**
 * The status each (route, caller) answers with. The forwardauth secret and the
 * DISABLE_AUTH switch are set for the duration and restored afterwards.
 */
export async function probeStatuses(
	app: Fetcher,
	routes: readonly string[],
	ids: ProbeIdentities,
	callers: readonly ProbeCaller[] = PROBE_CALLERS,
): Promise<Record<string, Partial<Record<ProbeCaller, number>>>> {
	const originalSecret = process.env.FORWARDAUTH_TRUST_SECRET;
	const originalDisableAuth = config.disableAuth;
	process.env.FORWARDAUTH_TRUST_SECRET = SSO_PROBE_SECRET;
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;

	const result: Record<string, Partial<Record<ProbeCaller, number>>> = {};
	try {
		for (const entry of routes) {
			const [method, template] = entry.split(" ");
			const path = `${PREFIX}${template.replace(/:[A-Za-z]+/g, "abc")}`;
			const statuses: Partial<Record<ProbeCaller, number>> = {};
			for (const caller of callers) {
				(config as Record<string, unknown>).disableAuth = caller === "authDisabled";
				await reseedProbeRows(ids);
				const hasBody = method !== "GET" && method !== "HEAD";
				const res = await app.request(path, {
					method,
					headers:
						caller === "authDisabled"
							? new Headers({ "Content-Type": "application/json" })
							: await headersFor(caller, ids),
					body: hasBody ? "{}" : undefined,
				});
				statuses[caller] = res.status;
			}
			result[entry] = statuses;
		}
	} finally {
		await removeProbeRows();
		(config as Record<string, unknown>).disableAuth = originalDisableAuth;
		if (originalSecret === undefined) {
			// biome-ignore lint/performance/noDelete: restoring an absent env var
			delete process.env.FORWARDAUTH_TRUST_SECRET;
		} else {
			process.env.FORWARDAUTH_TRUST_SECRET = originalSecret;
		}
		// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
		delete (config as Record<string, unknown>)._forwardauthTrustSecret;
	}
	return result;
}
