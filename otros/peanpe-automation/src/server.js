const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const logger = require('./utils/logger');
const routes = require('./routes');
const errorHandler = require('./utils/errorHandler');

// Crear aplicación Express
const app = express();

// ============================================
// MIDDLEWARE
// ============================================

// Seguridad
app.use(helmet());

// CORS
app.use(cors({
  origin: config.urls.frontend,
  credentials: true,
}));

// Logging de requests
app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));

// Parsear JSON
app.use(express.json({ limit: '10mb' }));

// Parsear URL-encoded
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Archivos estáticos
app.use(express.static('public'));

// ============================================
// RUTAS
// ============================================

// Ruta de salud
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.nodeEnv,
  });
});

// API routes
app.use('/api', routes);

// Webhook routes (sin autenticación)
app.use('/webhook', require('./routes/webhook'));

// ============================================
// MANEJO DE ERRORES
// ============================================

// 404 - Ruta no encontrada
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada',
    path: req.originalUrl,
  });
});

// Manejador de errores global
app.use(errorHandler);

// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT = config.port;

app.listen(PORT, () => {
  logger.info(`🚀 Servidor iniciado en puerto ${PORT}`);
  logger.info(`📊 Ambiente: ${config.nodeEnv}`);
  logger.info(`🔗 URL: http://localhost:${PORT}`);
  logger.info(`💚 Health check: http://localhost:${PORT}/health`);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = app;
