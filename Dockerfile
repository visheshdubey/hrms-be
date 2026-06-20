FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose the API port
EXPOSE 3000

# Start the application
CMD ["sh", "-c", "mkdir -p /app/data && npx drizzle-kit push && npx tsx src/index.ts"]
