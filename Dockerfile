FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json .npmrc ./

# Production deps only — no native sqlite (Postgres only in prod)
RUN npm ci --omit=dev

# Copy source code
COPY . .

EXPOSE 3000

CMD ["sh", "-c", "npx drizzle-kit push --force && npx tsx src/index.ts"]
