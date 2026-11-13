# One image: the built UI plus the API, which serves both from one origin.
FROM node:20-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY --from=web /app/web/dist ./web/dist
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
