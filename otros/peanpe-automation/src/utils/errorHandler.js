const logger = require('./logger');
const config = require('../config');

// Clase personalizada para errores de la API
class ApiError extends Error {
  constructor(statusCode, message, isOperational = true, stack = '') {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// Manejador de errores global
const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log del error
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  // Error de validación de Joi
  if (err.isJoi) {
    const message = err.details.map((detail) => detail.message).join(', ');
    error = new ApiError(400, message);
  }

  // Error de JSON malformado
  if (err.type === 'entity.parse.failed') {
    error = new ApiError(400, 'JSON malformado');
  }

  // Error de base de datos
  if (err.code === '23505') {
    // Unique violation
    error = new ApiError(409, 'Registro duplicado');
  }

  if (err.code === '23503') {
    // Foreign key violation
    error = new ApiError(400, 'Referencia inválida');
  }

  // Error de conexión a base de datos
  if (err.code === 'ECONNREFUSED') {
    error = new ApiError(503, 'Servicio no disponible');
  }

  // Respuesta por defecto
  const statusCode = error.statusCode || 500;
  const message = error.message || 'Error interno del servidor';

  res.status(statusCode).json({
    success: false,
    message: message,
    ...(config.nodeEnv === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
module.exports.ApiError = ApiError;
