const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('./logger');
const { ApiError } = require('./errorHandler');

// ============================================
// UTILIDADES DE AUTENTICACIÓN
// ============================================

/**
 * Middleware de autenticación
 */
const authenticate = async (req, res, next) => {
  try {
    // Obtener token del header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ApiError(401, 'Token de autenticación requerido');
    }

    const token = authHeader.substring(7);

    // Verificar token
    const decoded = jwt.verify(token, config.jwt.secret);

    // Agregar usuario al request
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return next(new ApiError(401, 'Token inválido'));
    }
    if (error.name === 'TokenExpiredError') {
      return next(new ApiError(401, 'Token expirado'));
    }
    next(error);
  }
};

/**
 * Generar token JWT
 */
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    config.jwt.secret,
    {
      expiresIn: config.jwt.expiresIn,
    }
  );
};

/**
 * Verificar token sin middleware
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (error) {
    return null;
  }
};

/**
 * Middleware de autorización por rol
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'No autenticado'));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'No autorizado'));
    }

    next();
  };
};

module.exports = {
  authenticate,
  generateToken,
  verifyToken,
  authorize,
};
