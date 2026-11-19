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

If a release run fails, use **Re-run failed jobs**, not a full re-run: `publish` is idempotent (it skips
creating a release that exists and always starts `pages.yml`), and a full re-run would rebuild images that
are already published. Only one release runs at a time (`concurrency: release`, never cancelled).

Before building the images, the `images` job recomputes the floating tags from the remote's current tags,
so a higher stable tag pushed while a release was building keeps `latest`.

**Pre-releases** (`vX.Y.Z-rc.1`): the images are built and tagged `X.Y.Z-rc.1` and `sha-<short>`, and the
GitHub release is created as a pre-release and not marked latest. No floating tags, and the manifest's
`latest` is never a pre-release. "Highest stable" is computed from the repository's own `v*` tags.

**Package visibility.** The `ghcr.io/jstuart0/agentpulse` and `-backup` packages must be public. Preflight
reads the revision label of an already-published image with `docker buildx imagetools inspect`, and every
install pulls them without a login. Preflight logs in with the job token (`packages: read`) as well. An
existing `X.Y.Z` image with no `org.opencontainers.image.revision` label is refused outright.

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
- `deploy` has no signing secret and runs only on `main` (a job condition and a first step that checks
  `$GITHUB_REF` before anything is checked out). It verifies the signed envelope with
  `src/shared/release-keys.ts`, the same verifier clients use, and compares it to the manifest that is
  live now before writing `site/releases/manifest.json`.
- `redispatch` holds only `actions: write` and runs when `sign` found itself superseded. The signing job's
  token has no permissions at all.

The `sign` job also fetches the live manifest (capped, https, no redirects) and refuses a `seq` below the
live one or more than 1000 above it; with no live manifest it caps `seq` at 1,000,000. It refuses to sign
with a key that the live manifest has revoked.

**`release-signing` has no required reviewer, on purpose.** The twice-weekly cron and every pull must
re-sign unattended; a waiting approval would let manifests go stale. What bounds signing instead is the
environment's branch policy, the main-tip check, the `sourceCommit` check, branch protection with
CODEOWNERS review on main, and the payload schema. Anyone who can merge to main can get any reviewed main
state signed. That is the accepted boundary.

**A pre-signed envelope deployed by `workflow_dispatch`** (`signed_envelope`) is judged against the live
manifest exactly as a client would judge it: a lower `seq`, an earlier `issuedAt`, or the same time with
different bytes is refused as a replay, and a key the live manifest revoked is out. The one exception is a
standby-signed envelope that revokes keys. If the live manifest can't be read (or doesn't verify) the
deploy is refused once any release is pinned. The disaster path is the `no_live` dispatch input
(`--no-live`): it skips the comparison, so use it only when the live manifest is gone or corrupt and you
have checked the envelope yourself.

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
   reviewer. Then add the secret. Give the `github-pages` environment a deployment-branch policy of `main`
   only as well, so no other branch can deploy the site or the manifest.
2. On an offline machine run `bun scripts/release/keygen.ts --out <directory outside the repo> --status active`
   and again with `--status standby`. The private halves stay off GitHub; the standby private key stays
   offline. Paste the printed public lines into `release-keys.ts` in a reviewed change.
3. Put the active private key into the `AGENTPULSE_RELEASE_SIGNING_KEY` secret of `release-signing`.
4. Turn on required CODEOWNERS review in branch protection for main.
5. Add a tag ruleset on `v*`: creation limited to the maintainer, update and delete forbidden, and no
   bypass actors, so a published tag can't be moved. Give main's branch protection no administrator
   bypass ("Do not allow bypassing the above settings") and no bypass actors on any ruleset covering main.
6. Give Actions write access to both GHCR packages.
7. Run `bun scripts/release/verify-published.ts --audit --repo <owner>/<repo>` after the first release. It
   verifies the live manifest and fails if the `release-signing` or `github-pages` environment policy, the tag
   ruleset (creation, update and delete, bypass actors), main's CODEOWNERS review or administrator bypass is
   not as described.

**Revocation** is the standby key's power only. Sign a manifest with the standby key whose
`revokedKeyIds` lists the old active key:
`bun scripts/release/sign-local.ts --key <standby.pem> --payload <payload.json> --out envelope.json`,
then run `pages.yml` by dispatch with the envelope as `signed_envelope`. `deploy` still verifies it. A
key can't revoke itself or its own signer, and an `active` key's `revokedKeyIds` is ignored. A release
then adds the new active key. Revocation protects only clients that have seen a revoking manifest; a fresh
or long-offline client still accepts the old key until it does.

**Revocation is only durable once the revoked key can't sign any more.** A revoked key that is still in the
CI secret or still listed as active in `release-keys.ts` can keep signing manifests that look valid to a
fresh client. Rotate the CI secret and `release-keys.ts` (new active key, old key out of the secret)
before, or together with, the standby revoking dispatch, and only then dispatch it.

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
