# --- Stage 1: Install dependencies ---
FROM node:22-alpine AS deps
WORKDIR /app
RUN npm install -g npm@11
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: Build the application ---
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client (needs prisma/schema.prisma on disk; already copied
# via COPY . . above). The postinstall hook covers fresh npm ci, but in this
# stage node_modules came from `deps` cache so we run it explicitly.
RUN npx prisma generate

# Build arguments become env vars at build time (required by Next.js at build)
# These are baked into the client bundle — only public-safe values here
ARG NEXT_PUBLIC_INSTANCE_NAME=""
ENV NEXT_PUBLIC_INSTANCE_NAME=$NEXT_PUBLIC_INSTANCE_NAME

ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Dummy secrets for build time — real values injected at runtime by entrypoint
ARG NEXTAUTH_SECRET=build-placeholder
ENV NEXTAUTH_SECRET=$NEXTAUTH_SECRET

RUN npm run build

# --- Stage 3: Production runner ---
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir -p /app/data && chown nextjs:nodejs /app/data

# Copy standalone server + static assets + public folder
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Ship the Prisma schema + migrations so `prisma migrate deploy` can run at
# startup, plus the prisma CLI for the entrypoint to invoke.
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma

# Copy entrypoint script
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
