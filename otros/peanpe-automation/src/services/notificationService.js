const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// ============================================
// SERVICIO DE NOTIFICACIONES
// ============================================

/**
 * Notificar pago exitoso al freelancer
 */
const notifyPaymentSuccess = async (data) => {
  try {
    const { paymentId, amount, customerName, customerPhone, completedAt } = data;

    const message = `✅ Pago recibido
💰 ${amount}€ de ${customerName}
📱 ${customerPhone}
🕐 Completado: ${new Date(completedAt).toLocaleString()}
🆔 ID: ${paymentId}`;

    // Enviar por WhatsApp (Evolution API)
    await sendWhatsAppMessage(config.evolution.instanceName, message);

    // Enviar por Chatwoot
    await sendChatwootMessage(message);

    logger.info(`Notificación de pago exitoso enviada: ${paymentId}`);
  } catch (error) {
    logger.error('Error enviando notificación de pago exitoso:', error);
  }
};

/**
 * Notificar pago fallido al freelancer
 */
const notifyPaymentFailed = async (data) => {
  try {
    const { paymentId, amount, customerName, customerPhone, failureReason } = data;

    const message = `❌ Pago fallido
💰 ${amount}€ de ${customerName}
📱 ${customerPhone}
⚠️ Motivo: ${failureReason}
🆔 ID: ${paymentId}`;

    // Enviar por WhatsApp (Evolution API)
    await sendWhatsAppMessage(config.evolution.instanceName, message);

    // Enviar por Chatwoot
    await sendChatwootMessage(message);

    logger.info(`Notificación de pago fallido enviada: ${paymentId}`);
  } catch (error) {
    logger.error('Error enviando notificación de pago fallido:', error);
  }
};

/**
 * Notificar pago pendiente al freelancer
 */
const notifyPaymentPending = async (data) => {
  try {
    const { paymentId, amount, customerName, customerPhone } = data;

    const message = `⏳ Pago pendiente
💰 ${amount}€ de ${customerName}
📱 ${customerPhone}
🆔 ID: ${paymentId}
🔗 Esperando confirmación del cliente...`;

    // Enviar por WhatsApp (Evolution API)
    await sendWhatsAppMessage(config.evolution.instanceName, message);

    logger.info(`Notificación de pago pendiente enviada: ${paymentId}`);
  } catch (error) {
    logger.error('Error enviando notificación de pago pendiente:', error);
  }
};

/**
 * Notificar pago reembolsado al freelancer
 */
const notifyPaymentRefunded = async (data) => {
  try {
    const { paymentId, amount, customerName, customerPhone, refundReason } = data;

    const message = `🔄 Pago reembolsado
💰 ${amount}€ a ${customerName}
📱 ${customerPhone}
⚠️ Motivo: ${refundReason}
🆔 ID: ${paymentId}`;

    // Enviar por WhatsApp (Evolution API)
    await sendWhatsAppMessage(config.evolution.instanceName, message);

    // Enviar por Chatwoot
    await sendChatwootMessage(message);

    logger.info(`Notificación de pago reembolsado enviada: ${paymentId}`);
  } catch (error) {
    logger.error('Error enviando notificación de pago reembolsado:', error);
  }
};

/**
 * Notificar pago de suscripción exitoso
 */
const notifySubscriptionPaymentSuccess = async (data) => {
  try {
    const { subscriptionId, paymentId, amount, customerName } = data;

    const message = `✅ Pago de suscripción recibido
💰 ${amount}€ de ${customerName}
🆔 Suscripción: ${subscriptionId}
🆔 Pago: ${paymentId}`;

    // Enviar por WhatsApp (Evolution API)
    await sendWhatsAppMessage(config.evolution.instanceName, message);

    logger.info(`Notificación de pago de suscripción enviada: ${subscriptionId}`);
  } catch (error) {
    logger.error('Error enviando notificación de pago de suscripción:', error);
  }
};

/**
 * Notificar pago de suscripción fallido
 */
const notifySubscriptionPaymentFailed = async (data) => {
  try {
    const { subscriptionId, paymentId, amount, customerName, failureReason } = data;

    const message = `❌ Pago de suscripción fallido
💰 ${amount}€ de ${customerName}
⚠️ Motivo: ${failureReason}
🆔 Suscripción: ${subscriptionId}
🆔 Pago: ${paymentId}`;

    // Enviar por WhatsApp (Evolution API)
    await sendWhatsAppMessage(config.evolution.instanceName, message);

    logger.info(`Notificación de pago de suscripción fallido enviada: ${subscriptionId}`);
  } catch (error) {
    logger.error('Error enviando notificación de pago de suscripción fallido:', error);
  }
};

/**
 * Notificar al cliente sobre pago fallido
 */
const notifyCustomerPaymentFailed = async (data) => {
  try {
    const { customerPhone, customerName, amount, failureReason } = data;

    const message = `Hola ${customerName},

Tu pago de ${amount}€ no pudo ser procesado.

Motivo: ${failureReason}

Por favor, intenta nuevamente o contacta con nosotros.

Gracias.`;

    // Enviar por Chatwoot
    await sendChatwootMessage(message, customerPhone);

    logger.info(`Notificación de pago fallido enviada al cliente: ${customerPhone}`);
  } catch (error) {
    logger.error('Error enviando notificación al cliente:', error);
  }
};

/**
 * Notificar al cliente sobre pago de suscripción fallido
 */
const notifyCustomerSubscriptionFailed = async (data) => {
  try {
    const { customerPhone, customerName, amount, failureReason } = data;

    const message = `Hola ${customerName},

El cobro de tu suscripción de ${amount}€ no pudo ser procesado.

Motivo: ${failureReason}

Por favor, actualiza tu método de pago o contacta con nosotros.

Gracias.`;

    // Enviar por Chatwoot
    await sendChatwootMessage(message, customerPhone);

    logger.info(`Notificación de suscripción fallida enviada al cliente: ${customerPhone}`);
  } catch (error) {
    logger.error('Error enviando notificación al cliente:', error);
  }
};

/**
 * Enviar recibo al cliente
 */
const sendReceipt = async (data) => {
  try {
    const { customerEmail, customerName, amount, paymentId } = data;

    // Enviar email con Resend
    await sendEmail(
      customerEmail,
      `Recibo de pago - ${amount}€`,
      `<h2>Recibo de Pago</h2>
       <p>Hola ${customerName},</p>
       <p>Tu pago de <strong>${amount}€</strong> ha sido procesado exitosamente.</p>
       <p>ID de pago: ${paymentId}</p>
       <p>Fecha: ${new Date().toLocaleString()}</p>
       <p>Gracias por tu confianza.</p>`
    );

    logger.info(`Recibo enviado a: ${customerEmail}`);
    return true;
  } catch (error) {
    logger.error('Error enviando recibo:', error);
  }
};

/**
 * Enviar mensaje por WhatsApp (Evolution API)
 */
const sendWhatsAppMessage = async (instanceName, message) => {
  try {
    const response = await axios.post(
      `${config.evolution.apiUrl}/message/sendText/${instanceName}`,
      {
        number: config.evolution.instanceName,
        text: message,
      },
      {
        headers: {
          'apikey': config.evolution.apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    logger.info(`Mensaje WhatsApp enviado via Evolution API`);
    return response.data;
  } catch (error) {
    logger.error('Error enviando mensaje WhatsApp via Evolution API:', error.response?.data || error.message);
    throw error;
  }
};

/**
 * Enviar mensaje por Chatwoot
 */
const sendChatwootMessage = async (message, contactPhone = null) => {
  try {
    const payload = {
      content: message,
      message_type: 'outgoing',
    };

    // Si se proporciona teléfono, crear o buscar contacto
    if (contactPhone) {
      // TODO: Implementar búsqueda/creación de contacto en Chatwoot
      payload.contact_identifier = contactPhone;
    }

    const response = await axios.post(
      `${config.chatwoot.apiUrl}/api/v1/accounts/${config.chatwoot.accountId}/conversations`,
      payload,
      {
        headers: {
          'api_access_token': config.chatwoot.apiToken,
          'Content-Type': 'application/json',
        },
      }
    );

    logger.info(`Mensaje enviado via Chatwoot`);
    return response.data;
  } catch (error) {
    logger.error('Error enviando mensaje via Chatwoot:', error.response?.data || error.message);
    throw error;
  }
};

/**
 * Enviar email con Resend
 */
const sendEmail = async (to, subject, html) => {
  try {
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: `${config.resend.fromName} <${config.resend.from}>`,
        to: [to],
        subject: subject,
        html: html,
      },
      {
        headers: {
          'Authorization': `Bearer ${config.resend.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    logger.info(`Email enviado a ${to} via Resend`);
    return response.data;
  } catch (error) {
    logger.error('Error enviando email via Resend:', error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  notifyPaymentSuccess,
  notifyPaymentFailed,
  notifyPaymentPending,
  notifyPaymentRefunded,
  notifySubscriptionPaymentSuccess,
  notifySubscriptionPaymentFailed,
  notifyCustomerPaymentFailed,
  notifyCustomerSubscriptionFailed,
  sendReceipt,
  sendWhatsAppMessage,
  sendChatwootMessage,
  sendEmail,
};
