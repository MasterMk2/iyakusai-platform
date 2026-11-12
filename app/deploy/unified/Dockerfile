# Unified app (tasks, inbox, rental) for the app host. Build from the repository root:
#   docker build -f deploy/unified/Dockerfile -t iyakusai-app:<tag> .
# The image holds code only: no keys, accounts, names or ledgers (they are mounted, see compose.yaml).
FROM node:24.22.3-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
# The app runs as UID 1002: every shipped file must be readable whatever modes the source arrived with.
RUN chmod -R a+rX dist node_modules package.json

FROM node:24.22.3-bookworm-slim
# The base image's Debian packages lag behind the security updates, so take them at build time. The app runs
# `node` only: npm, npx, corepack and yarn are dropped from the runtime image (their bundled packages carry
# their own advisories and nothing here calls them). The vulnerability scan of 2026-11-12 found both.
RUN apt-get update && apt-get -y upgrade \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
# The commit the image was built from, so a running container can be traced back to main (docker inspect).
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.revision=$GIT_COMMIT \
      org.opencontainers.image.source=https://github.com/MasterMk2/iyakusai-platform
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
USER 1002:1002
EXPOSE 5178
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:5178/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/main.js"]
