FROM node:20-alpine
WORKDIR /app

# Instalación mínima standalone (sin workspace) — mocks no usan @nightpay/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./

EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
