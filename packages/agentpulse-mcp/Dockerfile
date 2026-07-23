# syntax=docker/dockerfile:1
#
# Container image for the agentpulse-mcp streamable-HTTP server
# (2026-07-23-deliver-agentpulse-mcp-integration, Phase 4).
#
# BUILD CONTEXT IS THE REPO ROOT, NOT THIS DIRECTORY.
# thor's in-cluster kaniko build invokes this with
# `--context <repo-root> --dockerfile=packages/agentpulse-mcp/Dockerfile`, so
# every COPY source path below is relative to the repo root, never to this
# file's own directory. To reproduce the same shape locally:
#   docker build -f packages/agentpulse-mcp/Dockerfile -t agentpulse-mcp:local .
# (run from the repo root -- NOT from inside packages/agentpulse-mcp).
#
# Lockfile decision: this is a bun workspace package (root package.json
# declares `workspaces: ["packages/*"]`) but carries no bun.lock of its own
# -- only the repo root's bun.lock covers it. Rather than accept an unpinned
# scoped `bun install` inside packages/agentpulse-mcp (which would still be
# defensible, since both of this package's direct runtime deps -- the MCP
# SDK and zod -- are exact-pinned in its own package.json with no
# caret/tilde), we copy the root package.json + bun.lock in and run a
# `--filter=agentpulse-mcp --frozen-lockfile` install so the build fails
# loudly on any lockfile/package.json drift instead of silently resolving
# fresh versions.
#
# Node_modules layout (verified empirically against bun 1.3.12, and the
# reason this is NOT a naive single-directory COPY): a filtered workspace
# install does not vendor real files into
# packages/agentpulse-mcp/node_modules. It drops one real copy of every
# resolved package (direct AND transitive) into a shared store at
# /app/node_modules/.bun/<name>@<version>/node_modules/<name>, then:
#   - makes packages/agentpulse-mcp/node_modules/<name> a relative symlink
#     into the store for this package's DIRECT deps (@modelcontextprotocol,
#     zod);
#   - for a direct dep's own TRANSITIVE deps (the MCP SDK unconditionally
#     imports @hono/node-server, express, hono, jose, etc. from
#     server/streamableHttp.js even though we only use
#     StreamableHTTPServerTransport from that file), the store's own
#     per-package node_modules subfolder
#     (.bun/@modelcontextprotocol+sdk@1.29.0/node_modules/) carries a
#     SIBLING symlink farm for those. Node/Bun's default (symlink-realpath)
#     module resolution walks up from the SDK's real (post-symlink) install
#     location and finds that sibling folder -- it is never visible by
#     walking up from packages/agentpulse-mcp/node_modules alone.
# A prior version of this Dockerfile flattened only the top-level workspace
# symlinks (`cp -rL packages/agentpulse-mcp/node_modules`), which built
# cleanly but crashed at runtime with "Cannot find module
# '@hono/node-server'" -- the transitive symlink layer one level deeper was
# never touched. The fix below instead preserves BOTH node_modules trees
# (the root store, and the package-local symlink layer) with their original
# relative structure intact, exactly as bun produces and consumes them --
# proven by a `docker run --read-only` smoke test that exercises the actual
# /mcp code path (which is what pulls in @hono/node-server), not just
# /livez.

FROM oven/bun:1.3.12 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/agentpulse-mcp/package.json ./packages/agentpulse-mcp/package.json
RUN bun install --filter=agentpulse-mcp --frozen-lockfile --production

FROM oven/bun:1.3.12 AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/agentpulse-mcp/package.json ./packages/agentpulse-mcp/package.json
RUN bun install --filter=agentpulse-mcp --frozen-lockfile
COPY packages/agentpulse-mcp/tsconfig.json packages/agentpulse-mcp/tsconfig.build.json ./packages/agentpulse-mcp/
COPY packages/agentpulse-mcp/src ./packages/agentpulse-mcp/src
WORKDIR /app/packages/agentpulse-mcp
RUN bun run build

# Runtime deps only (SDK + zod + their transitive deps, no
# typescript/@types) -- the -slim variant has no bun install toolchain
# baggage beyond the bun binary itself.
FROM oven/bun:1.3.12-slim AS runner

# Reuse oven/bun's built-in non-root `bun` user (UID 1000) rather than
# fabricating a new one: it's the exact base image family agentpulse's own
# repo-root Dockerfile already runs as (see /Dockerfile at the repo root),
# so UID 1000 is an already-audited precedent in this repo, not a fresh
# guess. The k8s Deployment's runAsUser MUST be 1000 to match, or the pod
# fails to start.

# The store (deps' /app/node_modules) must land at the SAME absolute path
# it was resolved at -- the workspace-level symlinks below point into it
# with a relative path computed against that exact location.
COPY --chown=bun:bun --from=deps /app/node_modules /app/node_modules

WORKDIR /app/packages/agentpulse-mcp
COPY --chown=bun:bun --from=deps /app/packages/agentpulse-mcp/node_modules ./node_modules
COPY --chown=bun:bun --from=builder /app/packages/agentpulse-mcp/dist ./dist
# version.ts (compiled into dist/version.js) reads its own version via
# createRequire("../package.json") at runtime, resolved relative to
# dist/'s own location -- package.json must ship alongside dist/, not just
# be a build-time input.
COPY --chown=bun:bun packages/agentpulse-mcp/package.json ./package.json

ENV NODE_ENV=production
ENV MCP_HTTP_PORT=8000

USER bun

EXPOSE 8000

# serve-http is the streamable-HTTP subcommand added in Phase 1
# (packages/agentpulse-mcp/src/http.ts, wired from cli.ts). Config is
# entirely env-driven: AGENTPULSE_URL, AGENTPULSE_API_KEY,
# MCP_HTTP_BEARER_TOKEN (required, no default -- serveHttp() fails fast if
# unset), MCP_HTTP_PORT (defaulted above to 8000 to match /livez /readyz
# and the k8s probes/Service).
CMD ["bun", "run", "dist/cli.js", "serve-http"]
