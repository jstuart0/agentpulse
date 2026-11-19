# Releasing AgentPulse

A release is a version tag on a commit that `releases/release-data.json` already pins, a pair of container
images, a GitHub release, and a signed manifest on GitHub Pages that tells every install what the newest
version is. This page is for the maintainer. Nothing here runs unattended except the two workflows.

## Cutting a release

1. `bun run release:prepare 0.12.0` sets the version in `package.json`, `scripts/relay.ts` and
   `scripts/statusline.sh`. Set `severity` for the release in `releases/release-data.json` if it is a
   security fix. Open a PR; it is reviewed (CODEOWNERS) and merged with CI green.
2. `bun run release:pin 0.12.0 <merge commit sha>` writes `{"version", "commit"}` into
   `releases/release-data.json`. It refuses unless the commit is on `origin/main` and its `package.json`
   says that version. Open a PR; merge it. Which commit *is* release 0.12.0 is now a reviewed decision.
3. Tag the pinned commit and push the tag:
   `git tag -a v0.12.0 -m v0.12.0 <sha> && git push origin v0.12.0`.
4. `release.yml` runs. `preflight` checks the tag name, that it is annotated, that it is on main, that
   the version files agree, that the pin matches and that an active key exists, then runs lint, types,
   the architecture guards and the exclude and relay suites. `images` builds and pushes both images with
   provenance attestations. `publish` creates the GitHub release and starts `pages.yml`.
5. `pages.yml` builds the manifest from git objects, signs it and publishes it. Check it with
   `bun scripts/release/verify-published.ts`.

Image tags: `X.Y.Z` and `sha-<short>` always; `X.Y`, `X` and `latest` only for the highest stable tag, so
a backport never moves `latest`. A published `X.Y.Z` is never repointed: preflight refuses a version whose
image already exists from a different commit.

## Pulling a release

A PR sets `"pulled": true` and `"reason": "<code>"` on the entry in `releases/release-data.json`, and may
raise `minSupported`. The merge triggers `pages.yml`, which re-signs with a higher `seq`. A client that
has seen it can't be handed the earlier manifest. A client that never saw the pull can be handed the
pre-pull manifest by a hostile server for up to 10 days.

## How the manifest is signed, and what bounds it

`pages.yml` has three jobs:

- `manifest` has no secret. It builds the payload and runs the same checks the sign job will.
- `sign` runs in the `release-signing` environment, which holds `AGENTPULSE_RELEASE_SIGNING_KEY` and
  admits only the `main` branch. It runs no actions and checks out nothing: shell, `jq`, `openssl` and
  `git`. Every input reaches it through `env:`. It refuses unless the ref is `refs/heads/main`, the main
  tip is the commit being built, and the payload passes the schema, `sourceCommit`, freshness and
  `expiresAt = issuedAt + 10 days` checks.
- `deploy` has no signing secret. It verifies the signed envelope with `src/shared/release-keys.ts`, the
  same verifier clients use, before writing `site/releases/manifest.json`.

**`release-signing` has no required reviewer, on purpose.** The twice-weekly cron and every pull must
re-sign unattended; a waiting approval would let manifests go stale. What bounds signing instead is the
environment's branch policy, the main-tip check, the `sourceCommit` check, branch protection with
CODEOWNERS review on main, and the payload schema. Anyone who can merge to main can get any reviewed main
state signed. That is the accepted boundary.

A `sign` run that prints "superseded by <sha>" is green and signed nothing: a newer commit reached main
first, so this run dispatched `pages.yml` on main and left the signing to it. That is not an outage.

The cron (`17 4 * * 1,4`) keeps the 10-day manifest fresh. GitHub disables scheduled workflows after 60
days without repository activity. Installs then show "stale manifest" after 10 days and auto-update
pauses; that is visible and fails safe. Re-enable the cron under Actions, or push any commit.

Before the first release nothing is pinned, so `pages.yml` deploys the site without a manifest. Once a
release is pinned, a failed manifest build fails the run and the deploy is skipped, so a manifest is never
silently dropped from the site.

## Keys

`src/shared/release-keys.ts` lists the public keys clients trust. It ships empty. At the first release:

1. Create the `release-signing` environment with a deployment-branch policy of `main` only and no required
   reviewer. Then add the secret.
2. On an offline machine run `bun scripts/release/keygen.ts --out <directory outside the repo> --status active`
   and again with `--status standby`. The private halves stay off GitHub; the standby private key stays
   offline. Paste the printed public lines into `release-keys.ts` in a reviewed change.
3. Put the active private key into the `AGENTPULSE_RELEASE_SIGNING_KEY` secret of `release-signing`.
4. Turn on required CODEOWNERS review in branch protection for main.
5. Add a tag ruleset on `v*`: creation limited to the maintainer, update and delete forbidden, so a
   published tag can't be moved.
6. Give Actions write access to both GHCR packages.
7. Run `bun scripts/release/verify-published.ts --audit --repo <owner>/<repo>` after the first release. It
   verifies the live manifest and fails if the environment policy, the tag ruleset or branch protection is
   missing.

**Revocation** is the standby key's power only. Sign a manifest with the standby key whose
`revokedKeyIds` lists the old active key:
`bun scripts/release/sign-local.ts --key <standby.pem> --payload <payload.json> --out envelope.json`,
then run `pages.yml` by dispatch with the envelope as `signed_envelope`. `deploy` still verifies it. A
key can't revoke itself or its own signer, and an `active` key's `revokedKeyIds` is ignored. A release
then adds the new active key. Revocation protects only clients that have seen a revoking manifest; a fresh
or long-offline client still accepts the old key until it does.

Never commit a private key. `keygen.ts` refuses to write one inside the checkout, `write-site-manifest.ts`
refuses to publish a site that holds a private-key header, and the test key in
`src/shared/__fixtures__/release-test-key.json` signs nothing real.

## Do not change the Pages origin

Clients fetch the manifest from `https://jstuart0.github.io/agentpulse/releases/manifest.json`. Moving it
strands every installed client. Don't change it without a migration plan.

## Other workflows

`ci.yml`, `mcp-release.yml` and `codex-approvals-postgres.yml` still use tag-pinned actions. Pinning them
to commit SHAs is a follow-up; `release.yml` and `pages.yml` are pinned and `scripts/release/workflows.test.ts`
keeps them that way.
