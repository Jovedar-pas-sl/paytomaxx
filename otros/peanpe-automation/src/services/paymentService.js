const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { ApiError } = require('../utils/errorHandler');

// ============================================
// SERVICIO DE PAGOS
// ============================================

/**
 * Crear nuevo pago
 */
const createPayment = async (paymentData) => {
  try {
    const { amount, description, clientPhone, clientName, clientEmail, userId } = paymentData;

    // Crear pago en Peanpe
    const peanpeResponse = await axios.post(
      `${config.peanpe.apiUrl}/payments`,
      {
        amount: amount,
        currency: 'EUR',
        description: description || 'Pago',
        customer: {
          name: clientName,
          phone: clientPhone,
          email: clientEmail,
        },
        metadata: {
          user_id: userId,
          created_by: 'automation_system',
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${config.peanpe.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const peanpePayment = peanpeResponse.data;

    // TODO: Guardar en base de datos
    const payment = {
      id: generateId(),
      peanpe_payment_id: peanpePayment.id,
      amount: amount,
      currency: 'EUR',
      description: description,
      client_name: clientName,
      client_phone: clientPhone,
      client_email: clientEmail,
      status: 'pending',
      payment_link: peanpePayment.payment_url,
      created_at: new Date().toISOString(),
      user_id: userId,
    };

    logger.info(`Pago creado en Peanpe: ${peanpePayment.id}`);

    return payment;
  } catch (error) {
    logger.error('Error creando pago:', error.response?.data || error.message);
    throw new ApiError(500, 'Error creando pago en Peanpe');
  }
};

/**
 * Obtener todos los pagos
 */
const getAllPayments = async (filters) => {
  try {
    const { status, startDate, endDate, page, limit, userId } = filters;

    // TODO: Implementar consulta a base de datos
    // Por ahora, retornar datos de ejemplo
    const payments = [
      {
        id: '1',
        peanpe_payment_id: 'pay_123',
        amount: 150.00,
        currency: 'EUR',
        description: 'Diseño web',
        client_name: 'Juan Pérez',
        client_phone: '+34612345678',
        status: 'completed',
        payment_link: 'https://peanpe.com/pay/abc123',
        created_at: '2026-04-01T10:00:00Z',
        completed_at: '2026-04-01T10:05:00Z',
      },
    ];

    return {
      data: payments,
      pagination: {
        page: page,
        limit: limit,
        total: payments.length,
        pages: Math.ceil(payments.length / limit),
      },
    };
  } catch (error) {
    logger.error('Error obteniendo pagos:', error);
    throw new ApiError(500, 'Error obteniendo pagos');
  }
};

/**
 * Obtener pago por ID
 */
const getPaymentById = async (id) => {
  try {
    // TODO: Implementar consulta a base de datos
    // Por ahora, retornar datos de ejemplo
    return {
      id: id,
      peanpe_payment_id: 'pay_123',
      amount: 150.00,
      currency: 'EUR',
      description: 'Diseño web',
      client_name: 'Juan Pérez',
      client_phone: '+34612345678',
      status: 'completed',
      payment_link: 'https://peanpe.com/pay/abc123',
      created_at: '2026-04-01T10:00:00Z',
      completed_at: '2026-04-01T10:05:00Z',
    };
  } catch (error) {
    logger.error('Error obteniendo pago:', error);
    throw new ApiError(500, 'Error obteniendo pago');
  }
};

/**
 * Obtener estado de pago
 */
const getPaymentStatus = async (id) => {
  try {
    // TODO: Consultar estado en Peanpe
    return {
      id: id,
      status: 'completed',
      updated_at: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Error obteniendo estado de pago:', error);
    throw new ApiError(500, 'Error obteniendo estado de pago');
  }
};

/**
 * Cancelar pago
 */
const cancelPayment = async (id) => {
  try {
    // TODO: Cancelar en Peanpe
    logger.info(`Pago cancelado: ${id}`);
    return {
      id: id,
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Error cancelando pago:', error);
    throw new ApiError(500, 'Error cancelando pago');
  }
};

/**
 * Reenviar notificación de pago
 */
const resendNotification = async (id) => {
  try {
    // TODO: Implementar reenvío de notificación
    logger.info(`Notificación reenviada para pago: ${id}`);
    return true;
  } catch (error) {
    logger.error('Error reenviando notificación:', error);
    throw new ApiError(500, 'Error reenviando notificación');
  }
};

/**
 * Obtener estadísticas de pagos
 */
const getPaymentStats = async (filters) => {
  try {
    const { startDate, endDate, userId } = filters;

    // TODO: Implementar consulta a base de datos
    return {
      total_payments: 10,
      total_amount: 1500.00,
      completed_payments: 8,
      pending_payments: 2,
      failed_payments: 0,
      average_amount: 150.00,
    };
  } catch (error) {
    logger.error('Error obteniendo estadísticas:', error);
    throw new ApiError(500, 'Error obteniendo estadísticas');
  }
};

/**
 * Generar reporte de pagos
 */
const generateReport = async (filters) => {
  try {
    const { startDate, endDate, format, userId } = filters;

    // TODO: Implementar generación de reporte
    const report = 'Fecha,Monto,Cliente,Estado\n2026-04-01,150.00,Juan Pérez,Completado';

    return report;
  } catch (error) {
    logger.error('Error generando reporte:', error);
    throw new ApiError(500, 'Error generando reporte');
  }
};

/**
 * Generar ID único
 */
const generateId = () => {
  return `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

module.exports = {
  createPayment,
  getAllPayments,
  getPaymentById,
  getPaymentStatus,
  cancelPayment,
  resendNotification,
  getPaymentStats,
  generateReport,
};
