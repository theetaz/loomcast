# syntax=docker/dockerfile:1

# Loomcast production image: the api, which also serves the built web app.
# Build from the repository root (`.dockerignore` limits the context):
#   docker build -f infra/docker/app.Dockerfile -t loomcast:local .
# The image holds no secrets; configuration comes from the environment at run time.

ARG NODE_IMAGE=node:24-slim

# Node plus the pnpm version pinned by `packageManager` in package.json.
FROM ${NODE_IMAGE} AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_STORE=/pnpm/store
WORKDIR /repo
COPY package.json ./
RUN corepack enable pnpm && pnpm --version

FROM base AS build
# Download every locked package first, so this layer only changes with the lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir "$PNPM_STORE"
COPY . .
RUN pnpm install --frozen-lockfile --offline --store-dir "$PNPM_STORE" \
      --filter "@loomcast/api..." --filter "@loomcast/web..."
RUN pnpm --filter @loomcast/api --filter @loomcast/web run build
# Production dependencies of the api only; workspace packages are bundled into dist by tsdown.
# `pnpm fetch` above already checked the whole lockfile against the supply-chain policies, so the
# subset deploy writes is trusted rather than checked again over the network.
RUN pnpm --filter @loomcast/api deploy --prod --offline --trust-lockfile \
      --store-dir "$PNPM_STORE" /out

FROM ${NODE_IMAGE} AS runtime
# Nothing installs packages at run time, so the package managers are removed.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

ENV NODE_ENV=production \
    API_PORT=8790 \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app
# Everything is owned by root and read-only to the `node` user that runs the app.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
COPY --from=build /repo/packages/db/migrations ./migrations
# The deploy script extracts the compose project from the image it deploys.
COPY infra/compose ./infra/compose
COPY --chmod=0755 infra/docker/entrypoint.sh /usr/local/bin/loomcast-entrypoint

ARG LOOMCAST_GIT_SHA=unknown
ENV LOOMCAST_GIT_SHA=${LOOMCAST_GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/theetaz/loomcast" \
      org.opencontainers.image.title="loomcast" \
      org.opencontainers.image.description="Loomcast api and web app" \
      org.opencontainers.image.revision="${LOOMCAST_GIT_SHA}"

USER node
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/loomcast-entrypoint"]
CMD ["start"]
