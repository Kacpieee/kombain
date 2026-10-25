# Worker kombain.pl — obraz produkcyjny (Bun + TS ze workspace)
FROM oven/bun:1

WORKDIR /app

# Workspace: root + pakiet DB + worker (bez Astro).
COPY package.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN bun install

WORKDIR /app/apps/worker
CMD ["bun", "src/index.ts"]
