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
COPY apps/payment-svc/package.json apps/payment-svc/
RUN npm ci -w @srp/payment-svc

COPY packages packages
COPY apps/payment-svc apps/payment-svc
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

ENV NODE_ENV=production
USER node
EXPOSE 3003
CMD ["npx", "tsx", "apps/payment-svc/src/index.ts"]
