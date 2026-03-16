FROM node:22-bookworm-slim

# Install system dependencies (Playwright Chromium + Xvfb for headed mode)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

WORKDIR /app

# Install Node dependencies first (layer cache)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Install Playwright Chromium and its system dependencies
RUN npx playwright install chromium --with-deps

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Ensure data directory exists
RUN mkdir -p /opt/openclaw/data

CMD ["node", "dist/index.js"]
