# 一份 Dockerfile 產出兩個映像：backend（api 與 worker 共用）、web（nginx + 前端）
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm -w @acc/backend run build && npm -w @acc/frontend run build

FROM node:22-alpine AS backend
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --omit=dev --workspace=@acc/backend && npm cache clean --force
COPY --from=build /app/apps/backend/dist apps/backend/dist
COPY apps/backend/drizzle apps/backend/drizzle
ENV MIGRATIONS_DIR=/app/apps/backend/drizzle \
    MEDIA_DIR=/data/media \
    PORT=3000
WORKDIR /app/apps/backend
RUN mkdir -p /data/media && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/api.mjs"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
