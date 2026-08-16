FROM node:26-alpine AS build

WORKDIR /src

# Manifests first so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# `npm run build` is tsc --noEmit && vite build: a type error fails the image,
# not just CI.
RUN npm run build

# Caddy rather than nginx to match the reverse proxy already in the roadtrip
# stack, so there is one server config dialect across both deployments.
FROM caddy:2-alpine AS web

LABEL ca.floo.shotlab.managed="true" \
      ca.floo.shotlab.component="web"

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
