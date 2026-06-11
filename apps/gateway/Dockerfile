# Build context = repo root (see infra/docker-compose.yml): the service shares
# the @srp/db and @srp/linkz-core TypeScript workspace packages, so the image
# is built from the monorepo and runs through tsx. Type safety is enforced by
# `npm run build` (tsc --noEmit) in CI, not at image build time.
# TODO(prod): bundle with esbuild into a self-contained dist/ and switch to a
# multi-stage runner with `npm ci --omit=dev` for a smaller image.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/linkz-core/package.json packages/linkz-core/
COPY apps/gateway/package.json apps/gateway/
RUN npm ci -w @srp/gateway

COPY packages packages
COPY apps/gateway apps/gateway
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["npx", "tsx", "apps/gateway/src/index.ts"]
