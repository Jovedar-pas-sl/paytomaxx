# Simulador de la pasarela Wipay (Cecabank) para DESARROLLO y pruebas.
# NO es para producción: acepta cualquier pago y no comprueba nada de verdad.
# En Dokploy no se despliega (ver docs/DOKPLOY-STEPS.md).
FROM node:22.23.3-alpine3.24
WORKDIR /app

# Instalación mínima standalone (sin workspace): los mocks no usan @nightpay/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./

# Sin root.
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server.ts"]
