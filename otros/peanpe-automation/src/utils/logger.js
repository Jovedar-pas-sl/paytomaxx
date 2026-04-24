const winston = require('winston');
const path = require('path');
const config = require('../config');

// Crear directorio de logs si no existe
const fs = require('fs');
const logDir = path.dirname(config.logging.file);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Formato personalizado para logs
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Formato para consola
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaStr}`;
  })
);

// Crear logger
const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports: [
    // Escribir a archivo
    new winston.transports.File({
      filename: config.logging.file,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Escribir errores a archivo separado
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

// En desarrollo, también mostrar en consola
if (config.nodeEnv !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

module.exports = logger;
