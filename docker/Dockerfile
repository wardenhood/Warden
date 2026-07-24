# Stage 1: build matcher
FROM node:20-alpine AS matcher-builder
WORKDIR /app
COPY matcher/package.json matcher/package-lock.json* ./
RUN npm ci
COPY matcher/tsconfig.json ./
COPY matcher/src ./src
COPY matcher/abi ./abi
RUN npm run build

# Stage 2: matcher runtime
FROM node:20-alpine AS matcher
WORKDIR /app
COPY matcher/package.json matcher/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=matcher-builder /app/dist ./dist
COPY matcher/abi ./abi
CMD ["node", "dist/index.js"]

# Stage 3: workspace server
FROM node:20-alpine AS workspace
WORKDIR /app
COPY workspace/package.json ./
RUN npm install
COPY workspace/ ./
COPY web/ ../web/
COPY dashboard/public/ ../dashboard/public/
CMD ["node", "server.mjs"]
