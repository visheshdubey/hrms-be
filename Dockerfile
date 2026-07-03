FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Skip devDependencies (better-sqlite3 needs native build tools on Alpine)
RUN npm install --omit=dev

# Copy source code
COPY . .

# Expose the API port
EXPOSE 3000

# Start the application
CMD ["sh", "-c", "npx drizzle-kit push --force && npx tsx src/index.ts"]
