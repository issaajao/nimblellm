# syntax=docker/dockerfile:1

# NimbleLLM gateway.
#
# Two stages: build with the full toolchain, then copy only the compiled output
# and production dependencies into a clean runtime image. The result carries no
# TypeScript, no test files, and no dev dependencies.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:26-alpine AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Reinstall without dev dependencies, to be copied into the runtime stage.
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:26-alpine AS runtime

# dumb-init reaps zombies and forwards SIGTERM, so graceful shutdown works when
# the container is PID 1.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    NIMBLE_PORT=8080 \
    NIMBLE_HOST=0.0.0.0

WORKDIR /app

# The node:alpine images already provide an unprivileged `node` user.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

EXPOSE 8080

# Hits the unauthenticated liveness endpoint; `/ready` would report unhealthy
# when no provider is configured, which is a configuration problem rather than
# a reason to restart the container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NIMBLE_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bin/nimblellm.js"]
