# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/telegram-bot/package.json apps/telegram-bot/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

RUN npm ci

COPY apps apps
COPY packages packages

RUN npm run build

FROM node:26-bookworm-slim AS production-dependencies

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/telegram-bot/package.json apps/telegram-bot/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make python3 \
  && npm ci --omit=dev \
  && apt-get purge -y --auto-remove g++ make python3 \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

FROM production-dependencies AS server

ARG BUILD_VERSION=0.0.0
ENV HOME_GALLERY_VERSION=${BUILD_VERSION}

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist

RUN mkdir -p /var/lib/home-gallery && chown node:node /var/lib/home-gallery

USER node
WORKDIR /app/apps/server
EXPOSE 3012

CMD ["node", "dist/main.js"]

FROM production-dependencies AS telegram-bot

COPY --from=build /app/apps/telegram-bot/dist apps/telegram-bot/dist
COPY --from=build /app/packages/api-client/dist packages/api-client/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist

USER node
WORKDIR /app/apps/telegram-bot

CMD ["node", "dist/main.js"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS gallery

COPY docker/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html

EXPOSE 8080

FROM nginxinc/nginx-unprivileged:1.29-alpine AS admin

COPY docker/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html

EXPOSE 8080
