const logger = require('../utils/logger');
const notificationService = require('./notificationService');

// ============================================
// SERVICIO DE WEBHOOKS
// ============================================

/**
 * Manejar webhook de Peanpe Payments
 */
const handlePeanpeWebhook = async (payload) => {
  try {
    const { event, data } = payload;

    logger.info(`Webhook de Peanpe recibido: ${event}`);

    switch (event) {
      case 'payment.success':
        await handlePaymentSuccess(data);
        break;

      case 'payment.failed':
        await handlePaymentFailed(data);
        break;

      case 'payment.pending':
        await handlePaymentPending(data);
        break;

      case 'payment.refunded':
        await handlePaymentRefunded(data);
        break;

      case 'subscription.payment_success':
        await handleSubscriptionPaymentSuccess(data);
        break;

      case 'subscription.payment_failed':
        await handleSubscriptionPaymentFailed(data);
        break;

      default:
        logger.warn(`Evento de webhook no manejado: ${event}`);
    }

    return { processed: true, event };
  } catch (error) {
    logger.error('Error procesando webhook de Peanpe:', error);
    throw error;
  }
};

/**
 * Manejar pago exitoso
 */
const handlePaymentSuccess = async (data) => {
  try {
    const { payment_id, amount, customer, created_at } = data;

    logger.info(`Pago exitoso: ${payment_id} por ${amount}€`);

    // TODO: Actualizar estado en base de datos
    // await db.updatePayment(payment_id, { status: 'completed', completed_at: new Date() });

    // Notificar al freelancer
    await notificationService.notifyPaymentSuccess({
      paymentId: payment_id,
      amount: amount,
      customerName: customer.name,
      customerPhone: customer.phone,
      completedAt: created_at,
    });

    // Enviar recibo al cliente
    await notificationService.sendReceipt({
      customerEmail: customer.email,
      customerName: customer.name,
      amount: amount,
      paymentId: payment_id,
    });

    logger.info(`Notificaciones enviadas para pago: ${payment_id}`);
  } catch (error) {
    logger.error('Error manejando pago exitoso:', error);
    throw error;
  }
};

/**
 * Manejar pago fallido
 */
const handlePaymentFailed = async (data) => {
  try {
    const { payment_id, amount, customer, failure_reason } = data;

    logger.info(`Pago fallido: ${payment_id} - ${failure_reason}`);

    // TODO: Actualizar estado en base de datos
    // await db.updatePayment(payment_id, { status: 'failed', failure_reason });

    // Notificar al freelancer
    await notificationService.notifyPaymentFailed({
      paymentId: payment_id,
      amount: amount,
      customerName: customer.name,
      customerPhone: customer.phone,
      failureReason: failure_reason,
    });

    // Notificar al cliente
    await notificationService.notifyCustomerPaymentFailed({
      customerPhone: customer.phone,
      customerName: customer.name,
      amount: amount,
      failureReason: failure_reason,
    });

    logger.info(`Notificaciones enviadas para pago fallido: ${payment_id}`);
  } catch (error) {
    logger.error('Error manejando pago fallido:', error);
    throw error;
  }
};

/**
 * Manejar pago pendiente
 */
const handlePaymentPending = async (data) => {
  try {
    const { payment_id, amount, customer } = data;

    logger.info(`Pago pendiente: ${payment_id} por ${amount}€`);

    // TODO: Actualizar estado en base de datos
    // await db.updatePayment(payment_id, { status: 'pending' });

    // Notificar al freelancer
    await notificationService.notifyPaymentPending({
      paymentId: payment_id,
      amount: amount,
      customerName: customer.name,
      customerPhone: customer.phone,
    });

    logger.info(`Notificación enviada para pago pendiente: ${payment_id}`);
  } catch (error) {
    logger.error('Error manejando pago pendiente:', error);
    throw error;
  }
};

/**
 * Manejar pago reembolsado
 */
const handlePaymentRefunded = async (data) => {
  try {
    const { payment_id, amount, customer, refund_reason } = data;

    logger.info(`Pago reembolsado: ${payment_id} por ${amount}€`);

    // TODO: Actualizar estado en base de datos
    // await db.updatePayment(payment_id, { status: 'refunded', refund_reason });

    // Notificar al freelancer
    await notificationService.notifyPaymentRefunded({
      paymentId: payment_id,
      amount: amount,
      customerName: customer.name,
      customerPhone: customer.phone,
      refundReason: refund_reason,
    });

    logger.info(`Notificación enviada para pago reembolsado: ${payment_id}`);
  } catch (error) {
    logger.error('Error manejando pago reembolsado:', error);
    throw error;
  }
};

/**
 * Manejar pago de suscripción exitoso
 */
const handleSubscriptionPaymentSuccess = async (data) => {
  try {
    const { subscription_id, payment_id, amount, customer } = data;

    logger.info(`Pago de suscripción exitoso: ${subscription_id} - ${payment_id}`);

    // TODO: Actualizar estado en base de datos
    // await db.updateSubscriptionPayment(subscription_id, payment_id, { status: 'completed' });

    // Notificar al freelancer
    await notificationService.notifySubscriptionPaymentSuccess({
      subscriptionId: subscription_id,
      paymentId: payment_id,
      amount: amount,
      customerName: customer.name,
    });

    logger.info(`Notificación enviada para pago de suscripción: ${subscription_id}`);
  } catch (error) {
    logger.error('Error manejando pago de suscripción exitoso:', error);
    throw error;
  }
};

/**
 * Manejar pago de suscripción fallido
 */
const handleSubscriptionPaymentFailed = async (data) => {
  try {
    const { subscription_id, payment_id, amount, customer, failure_reason } = data;

    logger.info(`Pago de suscripción fallido: ${subscription_id} - ${failure_reason}`);

    // TODO: Actualizar estado en base de datos
    // await db.updateSubscriptionPayment(subscription_id, payment_id, { status: 'failed', failure_reason });

    // Notificar al freelancer
    await notificationService.notifySubscriptionPaymentFailed({
      subscriptionId: subscription_id,
      paymentId: payment_id,
      amount: amount,
      customerName: customer.name,
      failureReason: failure_reason,
    });

    // Notificar al cliente
    await notificationService.notifyCustomerSubscriptionFailed({
      customerPhone: customer.phone,
      customerName: customer.name,
      amount: amount,
      failureReason: failure_reason,
    });

    logger.info(`Notificaciones enviadas para pago de suscripción fallido: ${subscription_id}`);
  } catch (error) {
    logger.error('Error manejando pago de suscripción fallido:', error);
    throw error;
  }
};

/**
 * Manejar mensaje de WhatsApp
 */
const handleWhatsAppMessage = async (message) => {
  try {
    const { from, text, timestamp } = message;

    logger.info(`Mensaje de WhatsApp recibido de ${from}: ${text}`);

    // TODO: Procesar comando del mensaje
    // Ejemplo: "Cobrar 150€ a Juan Pérez"
    const command = parseWhatsAppCommand(text);

    if (command) {
      // TODO: Ejecutar comando
      logger.info(`Comando procesado: ${JSON.stringify(command)}`);
    }

    return { processed: true };
  } catch (error) {
    logger.error('Error procesando mensaje de WhatsApp:', error);
    throw error;
  }
};

/**
 * Manejar mensaje de SMS
 */
const handleSMSMessage = async (messageData) => {
  try {
    const { from, body, messageSid } = messageData;

    logger.info(`SMS recibido de ${from}: ${body}`);

    // TODO: Procesar SMS
    // Ejemplo: Confirmación de pago, respuesta a recordatorio, etc.

    return { processed: true };
  } catch (error) {
    logger.error('Error procesando SMS:', error);
    throw error;
  }
};

/**
 * Parsear comando de WhatsApp
 */
const parseWhatsAppCommand = (text) => {
  // TODO: Implementar parser de comandos
  // Ejemplos:
  // "Cobrar 150€ a Juan Pérez" → { action: 'create_payment', amount: 150, client: 'Juan Pérez' }
  // "Estado pago 123" → { action: 'check_status', paymentId: '123' }
  // "Recordar pago Juan" → { action: 'remind_payment', client: 'Juan' }

  const lowerText = text.toLowerCase();

  if (lowerText.includes('cobrar')) {
    // TODO: Extraer monto y cliente
    return { action: 'create_payment', raw: text };
  }

  if (lowerText.includes('estado')) {
    // TODO: Extraer ID de pago
    return { action: 'check_status', raw: text };
  }

  if (lowerText.includes('recordar')) {
    // TODO: Extraer cliente
    return { action: 'remind_payment', raw: text };
  }

  return null;
};

module.exports = {
  handlePeanpeWebhook,
  handleWhatsAppMessage,
  handleSMSMessage,
};
