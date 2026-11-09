# syntax=docker/dockerfile:1
# Multi-stage production image for tomola. Complete deployment acceptance checks in docs/deploy.md before inviting members.
# Stages:
#   base: Node 26 and pnpm via corepack, matching package.json's packageManager version.
#   build: installs development dependencies too, then `pnpm build` (React Router server/client builds, Paraglide messages and the Markdown worker).
#   prod-deps: production dependencies only. tsx is a production dependency for entrypoint migrations and pnpm invite.
#   runtime: production dependencies, build output, migrations and operational scripts only. docker-entrypoint.sh runs as non-root user node.
# Startup: docker-entrypoint.sh checks configuration and generated language counts with scripts/check-startup.ts before scripts/migrate.ts (without corepack or pnpm), then
# `node server.ts`: Node executes server.ts directly after stripping types.
# Permissions: code and node_modules remain root-owned (no --chown). Runtime user node can read but not write them, preventing code replacement even if the app is compromised.
# No writable directory needed: data goes to DATABASE_URL PostgreSQL, temporary files to /tmp. If a writable location becomes necessary, give node ownership only of that location.

ARG NODE_VERSION=26
ARG NODE_IMAGE_DIGEST=sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
ARG PNPM_VERSION=12.16.1
ARG COREPACK_VERSION=0.36.0

FROM node:${NODE_VERSION}-bookworm-slim@${NODE_IMAGE_DIGEST} AS base
ARG PNPM_VERSION
ARG COREPACK_VERSION
# Node 26 no longer ships Corepack, so install a pinned version first.
# Put Corepack's cache where a non-root user can read it. Preparing pnpm 12 installs its wrapper only; warm the native binary in this shared base layer too.
# The build and prod-deps layers are not inherited by runtime, so downloading the binary only during their installs leaves operational commands dependent on the network.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm --version && chmod -R a+rX /opt/corepack
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Paraglide loads the locked plugins from node_modules; compilation needs no network after dependency installation.
RUN --network=none pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM base AS figure-fonts
# Keep the Regular and Bold faces used for figure labels, with their licenses.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-cjk && \
    mkdir /font-files /font-licenses && \
    cp /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf /usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc /usr/share/fonts/truetype/noto/NotoSans-Bold.ttf /usr/share/fonts/truetype/noto/NotoSansThai-Bold.ttf /font-files/ && \
    cp /usr/share/doc/fonts-noto-core/copyright /font-licenses/noto-core-copyright && \
    cp /usr/share/doc/fonts-noto-cjk/copyright /font-licenses/noto-cjk-copyright

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig && rm -rf /var/lib/apt/lists/*
COPY --from=figure-fonts /font-files/ /usr/local/share/fonts/figure-labels/
COPY --from=figure-fonts /font-licenses/ /usr/share/doc/figure-fonts/
RUN fc-cache -f
ARG REVISION=unknown
# Operational scripts use the version and production dependencies already installed in the image. Do not select another pnpm or reinstall dependencies at runtime.
ENV NODE_ENV=production \
    TOMOLA_OPERATOR_DIR=/operator \
    REVISION=${REVISION} \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    PORT=3000 \
    COREPACK_ENABLE_NETWORK=0 \
    PNPM_CONFIG_PM_ON_FAIL=ignore \
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
COPY --from=prod-deps /app/node_modules ./node_modules
# Includes build/markdown: the production worker never loads TypeScript sources.
COPY --from=build /app/build ./build
# Operational scripts (pnpm db:migrate, pnpm invite, etc.) import app/ code; tsx resolves the ~/ alias from tsconfig.json.
# app/paraglide is generated during build and untracked, so copy it from the build stage.
COPY --from=build /app/app ./app
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY eval ./eval
# Initial glossary entries for `docker compose exec app pnpm glossary:import docs/drafts/glossary-initial.yaml`. .dockerignore restores only this file from docs.
COPY docs/drafts/glossary-initial.yaml ./docs/drafts/glossary-initial.yaml
COPY server.ts ./server.ts
COPY server ./server
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh
USER node
EXPOSE 3000
# Health check: server /healthz, without DB access.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
