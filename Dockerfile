# Build the client, then ship only what the server needs to run it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# PORT is deliberately NOT set here. Hosts inject their own (Render picks one at
# runtime), and an ENV in the image is one more thing that can disagree with it.
# server/index.mjs falls back to 8099 when nothing is set, which is what a plain
# `docker run` gets.

# Production deps only: vite is a devDependency and is not needed at runtime.
# three, @dimforge/rapier3d-compat and ws are — the server runs the same
# simulation code as the browser.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY src ./src
COPY server ./server

EXPOSE 8099
CMD ["node", "server/index.mjs"]
