FROM node:22-slim AS build
WORKDIR /app
# Only used by `prisma generate` to resolve the config at build time; the client
# connects with the real DATABASE_URL at runtime via the pg driver adapter.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate
COPY --from=build /app/dist ./dist

EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://localhost:8080/v1/health || exit 1
CMD ["node", "dist/server.js"]