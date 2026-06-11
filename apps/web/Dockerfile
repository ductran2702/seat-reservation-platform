# Build context = repo root (see infra/docker-compose.yml).
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w @srp/web

COPY apps/web apps/web
RUN npm run build -w @srp/web

# Static SPA served by nginx; the edge nginx (infra/nginx) proxies / here.
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
