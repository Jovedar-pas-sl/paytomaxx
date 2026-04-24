const subscriptionService = require('../services/subscriptionService');
const logger = require('../utils/logger');
const { ApiError } = require('../utils/errorHandler');

// ============================================
// CONTROLADOR DE SUSCRIPCIONES
// ============================================

/**
 * Crear nueva suscripción
 */
const createSubscription = async (req, res, next) => {
  try {
    const { clientId, amount, frequency, description, startDate } = req.body;

    // Validaciones
    if (!clientId) {
      throw new ApiError(400, 'El ID del cliente es requerido');
    }

    if (!amount || amount <= 0) {
      throw new ApiError(400, 'El monto debe ser mayor a 0');
    }

    if (!frequency) {
      throw new ApiError(400, 'La frecuencia es requerida');
    }

    // Crear suscripción
    const subscription = await subscriptionService.createSubscription({
      clientId,
      amount,
      frequency,
      description,
      startDate,
      userId: req.user.id,
    });

    logger.info(`Suscripción creada: ${subscription.id} por ${amount}€/${frequency}`);

    res.status(201).json({
      success: true,
      message: 'Suscripción creada exitosamente',
      data: subscription,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener todas las suscripciones
 */
const getAllSubscriptions = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const subscriptions = await subscriptionService.getAllSubscriptions({
      status,
      page: parseInt(page),
      limit: parseInt(limit),
      userId: req.user.id,
    });

    res.json({
      success: true,
      data: subscriptions,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener suscripción por ID
 */
const getSubscriptionById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const subscription = await subscriptionService.getSubscriptionById(id);

    if (!subscription) {
      throw new ApiError(404, 'Suscripción no encontrada');
    }

    res.json({
      success: true,
      data: subscription,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Actualizar suscripción
 */
const updateSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount, frequency, description } = req.body;

    const subscription = await subscriptionService.updateSubscription(id, {
      amount,
      frequency,
      description,
    });

    logger.info(`Suscripción actualizada: ${id}`);

    res.json({
      success: true,
      message: 'Suscripción actualizada exitosamente',
      data: subscription,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cancelar suscripción
 */
const cancelSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;

    const subscription = await subscriptionService.cancelSubscription(id);

    logger.info(`Suscripción cancelada: ${id}`);

    res.json({
      success: true,
      message: 'Suscripción cancelada exitosamente',
      data: subscription,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Pausar suscripción
 */
const pauseSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;

    const subscription = await subscriptionService.pauseSubscription(id);

    logger.info(`Suscripción pausada: ${id}`);

    res.json({
      success: true,
      message: 'Suscripción pausada exitosamente',
      data: subscription,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Reanudar suscripción
 */
const resumeSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;

    const subscription = await subscriptionService.resumeSubscription(id);

    logger.info(`Suscripción reanudada: ${id}`);

    res.json({
      success: true,
      message: 'Suscripción reanudada exitosamente',
      data: subscription,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener historial de pagos de suscripción
 */
const getSubscriptionPayments = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const payments = await subscriptionService.getSubscriptionPayments(id, {
      page: parseInt(page),
      limit: parseInt(limit),
    });

    res.json({
      success: true,
      data: payments,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Procesar pago manual de suscripción
 */
const processManualPayment = async (req, res, next) => {
  try {
    const { id } = req.params;

    const payment = await subscriptionService.processManualPayment(id);

    logger.info(`Pago manual procesado para suscripción: ${id}`);

    res.json({
      success: true,
      message: 'Pago procesado exitosamente',
      data: payment,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener estadísticas de suscripciones
 */
const getSubscriptionStats = async (req, res, next) => {
  try {
    const stats = await subscriptionService.getSubscriptionStats({
      userId: req.user.id,
    });

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createSubscription,
  getAllSubscriptions,
  getSubscriptionById,
  updateSubscription,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  getSubscriptionPayments,
  processManualPayment,
  getSubscriptionStats,
};
