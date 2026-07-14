FROM node:22-bookworm-slim

WORKDIR /app

# Outils de build pour better-sqlite3 (si pas de binaire précompilé dispo)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV LUSINE_DATA_DIR=/app/data

EXPOSE 3200

CMD ["node", "server/index.js"]
