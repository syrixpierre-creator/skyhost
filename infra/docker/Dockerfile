# syntax=docker/dockerfile:1.7
# Multi-target image for the SKYHOST control plane. Build context: repository root.
#   docker build -f infra/docker/Dockerfile --target api .
#   targets: api, worker, worker-screenshot, web

ARG NODE_IMAGE=node:22-bookworm-slim
# The worker needs git, ssh and CA certificates, which the full Debian-based image already ships.
ARG NODE_FULL_IMAGE=node:22-bookworm
ARG DOCKER_CLI_IMAGE=docker:28-cli
ARG NGINX_IMAGE=nginx:1.29-alpine

# ---------------------------------------------------------------------------------------------- build
# Behind a TLS-intercepting proxy, pass its CA as a build secret: --secret id=build_ca,src=/path/ca.pem
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=secret,id=build_ca,required=false --mount=type=cache,id=pnpm,target=/pnpm/store \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && corepack enable && corepack prepare --activate \
 && pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN pnpm --filter @skyhost/api run build \
 && pnpm --filter @skyhost/worker run build \
 && pnpm --filter @skyhost/cli run build \
 && pnpm --filter @skyhost/web exec vite build
# Runtime images get a flat, production-only node_modules: the bundles inline the @skyhost/* packages, so their
# third-party dependencies must be resolvable from the application directory.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --offline --prod --config.node-linker=hoisted \
 && mkdir -p apps/api/node_modules apps/worker/node_modules

# ---------------------------------------------------------------------------------------------- api
# PID 1 signal handling comes from `init: true` in docker-compose.yml.
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production SKYHOST_MIGRATIONS_DIR=/app/packages/db/migrations SKYHOST_DATA_DIR=/var/lib/skyhost
WORKDIR /app
RUN mkdir -p /var/lib/skyhost/objects && chown -R node:node /var/lib/skyhost
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]

# ---------------------------------------------------------------------------------------------- worker
# Builds and deploys talk to the Docker API through the socket proxy (DOCKER_HOST); user code never gets the socket.
FROM ${DOCKER_CLI_IMAGE} AS dockercli
FROM ${NODE_FULL_IMAGE} AS worker
ENV NODE_ENV=production SKYHOST_MIGRATIONS_DIR=/app/packages/db/migrations SKYHOST_DATA_DIR=/var/lib/skyhost SKYHOST_WORK_DIR=/var/lib/skyhost/work
WORKDIR /app
RUN mkdir -p /var/lib/skyhost/work /var/lib/skyhost/objects && chown -R node:node /var/lib/skyhost
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
USER node
CMD ["node", "apps/worker/dist/index.js"]

# ---------------------------------------------------------------------------------------------- screenshot worker
FROM worker AS worker-screenshot
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright SKYHOST_WORKER_ROLES=screenshot
RUN cd apps/worker && node node_modules/playwright/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*
USER node

# ---------------------------------------------------------------------------------------------- web
FROM ${NGINX_IMAGE} AS web
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY --from=build /app/apps/cli/dist/skyhost.js /usr/share/nginx/html/cli/skyhost.js
EXPOSE 8080
