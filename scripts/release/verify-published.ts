#!/usr/bin/env bun
/**
 * `bun scripts/release/verify-published.ts [--audit] --repo owner/name`
 *
 * Without `--audit`: fetches the live manifest from Pages through the same capped fetch clients use,
 * verifies it against the trust root in `src/shared/release-keys.ts`, and prints what `latest` is.
 * With `--audit`: reads the repository's settings through `gh api` and fails when a protection the
 * release design depends on is missing (the environment's branch policy and absence of a reviewer, the
 * tag ruleset forbidding update and delete, and CODEOWNERS review on main).
 */
import { fetchCapped } from "../../src/shared/capped-fetch.ts";
import { RELEASE_KEYS, type ReleaseKey } from "../../src/shared/release-keys.ts";
import { verifyManifest } from "../../src/shared/release-manifest.ts";

// One constant for the clients, the server check and this script, so the feed moves in one place.
import { MANIFEST_URL } from "../../src/shared/release-feed.js";
export { MANIFEST_URL };
const MAX_MANIFEST_BYTES = 32 * 1024;

export async function verifyPublished(options: {
	fetcher?: typeof fetchCapped;
	keys?: readonly ReleaseKey[];
	now?: number;
	url?: string;
}): Promise<
	{ ok: true; latest: string; seq: number; stale: boolean } | { ok: false; reason: string }
> {
	const fetched = await (options.fetcher ?? fetchCapped)(options.url ?? MANIFEST_URL, {
		deadlineMs: 15_000,
		maxBytes: MAX_MANIFEST_BYTES,
	});
	if (!fetched.ok) return { ok: false, reason: `could not fetch the manifest (${fetched.code})` };
	const verdict = await verifyManifest(fetched.body, {
		keys: options.keys ?? RELEASE_KEYS,
		revoked: new Set(),
		now: options.now ?? Date.now(),
		last: null,
	});
	if (!verdict.ok)
		return { ok: false, reason: `the published manifest does not verify (${verdict.code})` };
	return {
		ok: true,
		latest: verdict.manifest.latest,
		seq: verdict.manifest.seq,
		stale: verdict.stale,
	};
}

interface EnvironmentSnapshot {
	reviewers: number;
	customBranchPolicies: boolean;
	branchPolicies: string[];
}

export interface AuditSnapshot {
	/** The `release-signing` environment; null when it doesn't exist. */
	environment: EnvironmentSnapshot | null;
	/** The `github-pages` environment: only main may deploy the site and the manifest. */
	pagesEnvironment: EnvironmentSnapshot | null;
	/** Every ruleset: its target, the refs it covers, its rule types and how many bypass actors it has. */
	rulesets: { target: string; refs: string[]; rules: string[]; bypassActors: number }[];
	/** Branch protection of main; null when there is none. */
	mainProtection: { requireCodeOwnerReviews: boolean; enforceAdmins: boolean } | null;
}

const MAIN_REFS = new Set(["refs/heads/main", "~DEFAULT_BRANCH", "~ALL"]);

function onlyMain(env: EnvironmentSnapshot): boolean {
	return (
		env.customBranchPolicies && env.branchPolicies.length === 1 && env.branchPolicies[0] === "main"
	);
}

/** One finding per missing protection; empty means the audit passes. */
export function auditFindings(snapshot: AuditSnapshot): string[] {
	const findings: string[] = [];
	const env = snapshot.environment;
	if (!env) findings.push("environment release-signing does not exist");
	else {
		if (!onlyMain(env)) {
			findings.push(
				"environment release-signing must admit only the main branch (deployment-branch policy)",
			);
		}
		if (env.reviewers > 0) {
			findings.push(
				"environment release-signing has a required reviewer; the unattended cron re-sign would stall",
			);
		}
	}
	const pages = snapshot.pagesEnvironment;
	if (!pages) findings.push("environment github-pages does not exist");
	else if (!onlyMain(pages)) {
		findings.push(
			"environment github-pages must admit only the main branch (deployment-branch policy)",
		);
	}
	const tagRuleset = snapshot.rulesets.find(
		(r) => r.target === "tag" && r.refs.some((ref) => ref === "refs/tags/v*" || ref === "~ALL"),
	);
	if (!tagRuleset) findings.push("no tag ruleset covers refs/tags/v*");
	else {
		if (!tagRuleset.rules.includes("creation"))
			findings.push("the v* tag ruleset does not restrict creation");
		for (const rule of ["update", "deletion"]) {
			if (!tagRuleset.rules.includes(rule))
				findings.push(`the v* tag ruleset does not forbid ${rule}`);
		}
		if (tagRuleset.bypassActors > 0) findings.push("the v* tag ruleset has bypass actors");
	}
	for (const ruleset of snapshot.rulesets) {
		if (
			ruleset.target === "branch" &&
			ruleset.bypassActors > 0 &&
			ruleset.refs.some((ref) => MAIN_REFS.has(ref))
		) {
			findings.push("a ruleset covering main has bypass actors");
		}
	}
	if (!snapshot.mainProtection?.requireCodeOwnerReviews) {
		findings.push("branch protection on main does not require CODEOWNERS review");
	}
	if (snapshot.mainProtection && !snapshot.mainProtection.enforceAdmins) {
		findings.push("branch protection on main does not apply to administrators");
	}
	return findings;
}

function gh(args: string[]): unknown | null {
	const proc = Bun.spawnSync(["gh", "api", ...args], { stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0 ? JSON.parse(proc.stdout.toString()) : null;
}

function readEnvironment(repo: string, name: string): EnvironmentSnapshot | null {
	const env = gh([`repos/${repo}/environments/${name}`]) as {
		protection_rules?: { type: string }[];
		deployment_branch_policy?: { custom_branch_policies?: boolean } | null;
	} | null;
	if (!env) return null;
	const policies = gh([`repos/${repo}/environments/${name}/deployment-branch-policies`]) as {
		branch_policies?: { name: string }[];
	} | null;
	return {
		reviewers: (env.protection_rules ?? []).filter((p) => p.type === "required_reviewers").length,
		customBranchPolicies: env.deployment_branch_policy?.custom_branch_policies === true,
		branchPolicies: (policies?.branch_policies ?? []).map((p) => p.name),
	};
}

function readSnapshot(repo: string): AuditSnapshot {
	const list = (gh([`repos/${repo}/rulesets`]) as { id: number }[] | null) ?? [];
	const rulesets = list.flatMap(({ id }) => {
		const r = gh([`repos/${repo}/rulesets/${id}`]) as {
			target: string;
			conditions?: { ref_name?: { include?: string[] } };
			rules?: { type: string }[];
			bypass_actors?: unknown[];
		} | null;
		return r
			? [
					{
						target: r.target,
						refs: r.conditions?.ref_name?.include ?? [],
						rules: (r.rules ?? []).map((x) => x.type),
						bypassActors: (r.bypass_actors ?? []).length,
					},
				]
			: [];
	});
	const protection = gh([`repos/${repo}/branches/main/protection`]) as {
		required_pull_request_reviews?: { require_code_owner_reviews?: boolean };
		enforce_admins?: { enabled?: boolean };
	} | null;
	return {
		environment: readEnvironment(repo, "release-signing"),
		pagesEnvironment: readEnvironment(repo, "github-pages"),
		rulesets,
		mainProtection: protection && {
			requireCodeOwnerReviews:
				protection.required_pull_request_reviews?.require_code_owner_reviews === true,
			enforceAdmins: protection.enforce_admins?.enabled === true,
		},
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const repo = args[args.indexOf("--repo") + 1];
	let failed = false;
	const published = await verifyPublished({});
	if (published.ok)
		console.log(
			`published manifest verifies: latest ${published.latest}, seq ${published.seq}${published.stale ? " (stale)" : ""}`,
		);
	else {
		console.error(`verify-published: ${published.reason}`);
		failed = true;
	}
	if (args.includes("--audit")) {
		if (!args.includes("--repo") || !repo) {
			console.error("usage: bun scripts/release/verify-published.ts --audit --repo owner/name");
			process.exit(2);
		}
		const findings = auditFindings(readSnapshot(repo));
		for (const finding of findings) console.error(`audit: ${finding}`);
		if (findings.length === 0) console.log("audit: ok");
		else failed = true;
	}
	process.exit(failed ? 1 : 0);
}
