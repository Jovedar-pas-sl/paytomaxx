require('dotenv').config();

module.exports = {
  // Servidor
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Base de datos
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    name: process.env.DB_NAME || 'peanpe_automation',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || '',
  },

  // Peanpe Payments
  peanpe: {
    apiKey: process.env.PEANPE_API_KEY,
    apiSecret: process.env.PEANPE_API_SECRET,
    apiUrl: process.env.PEANPE_API_URL || 'https://api.peanpe.com/v1',
    webhookSecret: process.env.PEANPE_WEBHOOK_SECRET,
  },

  // Evolution API (WhatsApp)
  evolution: {
    apiUrl: process.env.EVOLUTION_API_URL,
    apiKey: process.env.EVOLUTION_API_KEY,
    instanceName: process.env.EVOLUTION_INSTANCE_NAME,
  },

  // Chatwoot (WhatsApp/SMS)
  chatwoot: {
    apiUrl: process.env.CHATWOOT_API_URL,
    apiToken: process.env.CHATWOOT_API_TOKEN,
    accountId: process.env.CHATWOOT_ACCOUNT_ID,
    inboxId: process.env.CHATWOOT_INBOX_ID,
  },

  // Resend (Email)
  resend: {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || 'pagos@tudominio.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Tu Empresa',
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'tu_jwt_secret_aqui',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // URLs
  urls: {
    frontend: process.env.FRONTEND_URL || 'http://localhost:3000',
    backend: process.env.BACKEND_URL || 'http://localhost:3000',
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/app.log',
  },

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  // Webhooks
  webhook: {
    verifyToken: process.env.WEBHOOK_VERIFY_TOKEN || 'tu_verify_token_aqui',
  },
};
