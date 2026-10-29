# Unified app (tasks, inbox, rental) for the app host. Build from the repository root:
#   docker build -f deploy/unified/Dockerfile -t iyakusai-app:<tag> .
# The image holds code only: no keys, accounts, names or ledgers (they are mounted, see compose.yaml).
FROM node:24.20.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
# The app runs as UID 1002: every shipped file must be readable whatever modes the source arrived with.
RUN chmod -R a+rX dist node_modules package.json

FROM node:24.20.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
USER 1002:1002
EXPOSE 5178
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:5178/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/main.js"]
