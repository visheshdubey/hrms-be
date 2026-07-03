FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json .npmrc ./

# Production deps only — no native sqlite (Postgres only in prod)
RUN npm ci --omit=dev

# Copy source code
COPY . .

EXPOSE 3000

# Migrations run in CI/setup; start API only (drizzle push can hang on large shared DBs)
CMD ["npx", "tsx", "src/index.ts"]
