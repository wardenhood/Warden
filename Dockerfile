# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY matcher/package.json matcher/
RUN cd matcher && npm install
COPY matcher/ matcher/
RUN cd matcher && npm run build

# Runtime stage
FROM node:20-alpine
WORKDIR /app

# Copy matcher
COPY --from=builder /app/matcher/dist ./matcher/dist
COPY --from=builder /app/matcher/node_modules ./matcher/node_modules
COPY --from=builder /app/matcher/abi ./matcher/abi

# Copy workspace
COPY workspace/package.json workspace/
RUN cd workspace && npm install
COPY workspace/ workspace/

# Copy static files
COPY web/ web/
COPY dashboard/ dashboard/

# Copy matcher src for MCP imports
COPY matcher/src/ matcher/src/

CMD cd workspace && node server.mjs
