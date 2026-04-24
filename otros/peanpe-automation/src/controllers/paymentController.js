const paymentService = require('../services/paymentService');
const logger = require('../utils/logger');
const { ApiError } = require('../utils/errorHandler');

// ============================================
// CONTROLADOR DE PAGOS
// ============================================

/**
 * Crear nuevo pago
 */
const createPayment = async (req, res, next) => {
  try {
    const { amount, description, clientPhone, clientName, clientEmail } = req.body;

    // Validaciones
    if (!amount || amount <= 0) {
      throw new ApiError(400, 'El monto debe ser mayor a 0');
    }

    if (!clientPhone) {
      throw new ApiError(400, 'El teléfono del cliente es requerido');
    }

    // Crear pago
    const payment = await paymentService.createPayment({
      amount,
      description,
      clientPhone,
      clientName,
      clientEmail,
      userId: req.user.id,
    });

    logger.info(`Pago creado: ${payment.id} por ${amount}€`);

    res.status(201).json({
      success: true,
      message: 'Pago creado exitosamente',
      data: payment,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener todos los pagos
 */
const getAllPayments = async (req, res, next) => {
  try {
    const { status, startDate, endDate, page = 1, limit = 20 } = req.query;

    const payments = await paymentService.getAllPayments({
      status,
      startDate,
      endDate,
      page: parseInt(page),
      limit: parseInt(limit),
      userId: req.user.id,
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
 * Obtener pago por ID
 */
const getPaymentById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const payment = await paymentService.getPaymentById(id);

    if (!payment) {
      throw new ApiError(404, 'Pago no encontrado');
    }

    res.json({
      success: true,
      data: payment,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener estado de pago
 */
const getPaymentStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    const status = await paymentService.getPaymentStatus(id);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cancelar pago
 */
const cancelPayment = async (req, res, next) => {
  try {
    const { id } = req.params;

    const payment = await paymentService.cancelPayment(id);

    logger.info(`Pago cancelado: ${id}`);

    res.json({
      success: true,
      message: 'Pago cancelado exitosamente',
      data: payment,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Reenviar notificación de pago
 */
const resendNotification = async (req, res, next) => {
  try {
    const { id } = req.params;

    await paymentService.resendNotification(id);

    logger.info(`Notificación reenviada para pago: ${id}`);

    res.json({
      success: true,
      message: 'Notificación reenviada exitosamente',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener estadísticas de pagos
 */
const getPaymentStats = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    const stats = await paymentService.getPaymentStats({
      startDate,
      endDate,
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

/**
 * Descargar reporte de pagos
 */
const downloadReport = async (req, res, next) => {
  try {
    const { startDate, endDate, format = 'csv' } = req.query;

    const report = await paymentService.generateReport({
      startDate,
      endDate,
      format,
      userId: req.user.id,
    });

    // Configurar headers para descarga
    const filename = `pagos_${new Date().toISOString().split('T')[0]}.${format}`;
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv' : 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.send(report);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createPayment,
  getAllPayments,
  getPaymentById,
  getPaymentStatus,
  cancelPayment,
  resendNotification,
  getPaymentStats,
  downloadReport,
};
