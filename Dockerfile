FROM oven/bun:1.3.12 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.12 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.12-slim AS runner
WORKDIR /app

# Pre-create runtime-writable directories and hand them to the non-root
# bun user (UID 1000) before we drop privileges. Docker named-volume
# mounts inherit the image-directory ownership on first use, so this
# chown is what keeps /app/data writable after `USER bun`.
# On k8s the PVC mount ownership is governed by fsGroup: 1000 in the
# pod securityContext, which makes the mount group-writable by GID 1000.
RUN mkdir -p /app/data && chown -R bun:bun /app/data

COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun --from=builder /app/dist ./dist
COPY --chown=bun:bun --from=builder /app/src/server ./src/server
COPY --chown=bun:bun --from=builder /app/src/shared ./src/shared
COPY --chown=bun:bun --from=builder /app/scripts ./scripts
COPY --chown=bun:bun --from=builder /app/drizzle ./drizzle
COPY --chown=bun:bun --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Drop to non-root. oven/bun:1-slim ships a `bun` user at UID 1000.
USER bun

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["bun", "run", "src/server/index.ts"]
