# node:22-alpine, pinned by digest so the proxy image is reproducible.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
COPY --from=build /src/dist/proxy/server.cjs /app/server.cjs
USER node
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["node", "/app/server.cjs"]
