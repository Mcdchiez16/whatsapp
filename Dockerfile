# Build Stage
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Production Stage
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app /app

# Install dependencies for Baileys/Pino if necessary
# Note: Baileys is quite light, node-slim is usually enough.

EXPOSE 3001

# Environment variables (to be set in host)
# SUPABASE_URL=...
# SUPABASE_KEY=...
# PORT=3001

CMD ["npm", "start"]
