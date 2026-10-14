FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./

EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
