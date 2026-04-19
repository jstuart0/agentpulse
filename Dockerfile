FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app

RUN mkdir -p /app/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/server ./src/server
COPY --from=builder /app/src/shared ./src/shared
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["bun", "run", "src/server/index.ts"]
