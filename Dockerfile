# BfW Holdings als Container. Die Datenbank (MongoDB Atlas) liegt außerhalb; alle Einstellungen kommen
# zur Laufzeit aus der .env des Servers (siehe deploy/docker-compose.yml) – im Image stehen keine Geheimnisse.
FROM node:26-slim

ENV NODE_ENV=production
WORKDIR /app

# erst nur die Paketlisten: diese Schicht bleibt im Cache, solange sich die Abhängigkeiten nicht ändern
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts

# nicht als root laufen
USER node

EXPOSE 3100
CMD ["node", "server.js"]
