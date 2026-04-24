const webhookService = require('../services/webhookService');
const logger = require('../utils/logger');
const config = require('../config');

// ============================================
// CONTROLADOR DE WEBHOOKS
// ============================================

/**
 * Manejar webhook de Peanpe Payments
 */
const handlePeanpeWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-peanpe-signature'];
    const timestamp = req.headers['x-peanpe-timestamp'];
    const payload = req.body;

    // Verificar firma del webhook
    if (!verifyPeanpeSignature(signature, timestamp, payload)) {
      logger.warn('Firma de webhook inválida');
      return res.status(401).json({
        success: false,
        message: 'Firma inválida',
      });
    }

    // Procesar webhook
    const result = await webhookService.handlePeanpeWebhook(payload);

    logger.info(`Webhook de Peanpe procesado: ${payload.event}`);

    res.json({
      success: true,
      message: 'Webhook procesado exitosamente',
      data: result,
    });
  } catch (error) {
    logger.error('Error procesando webhook de Peanpe:', error);
    res.status(500).json({
      success: false,
      message: 'Error procesando webhook',
    });
  }
};

/**
 * Verificar webhook (para WhatsApp, etc.)
 */
const verifyWebhook = async (req, res, next) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Verificar token
    if (mode === 'subscribe' && token === config.webhook.verifyToken) {
      logger.info('Webhook verificado exitosamente');
      res.status(200).send(challenge);
    } else {
      logger.warn('Token de verificación inválido');
      res.status(403).json({
        success: false,
        message: 'Token inválido',
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Manejar webhook de WhatsApp
 */
const handleWhatsAppWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    // Verificar que es un mensaje de WhatsApp
    if (payload.object !== 'whatsapp_business_account') {
      return res.status(400).json({
        success: false,
        message: 'Payload inválido',
      });
    }

    // Procesar mensajes
    const entries = payload.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field === 'messages') {
          const messages = change.value?.messages || [];
          for (const message of messages) {
            await webhookService.handleWhatsAppMessage(message);
          }
        }
      }
    }

    res.json({
      success: true,
      message: 'Webhook de WhatsApp procesado',
    });
  } catch (error) {
    logger.error('Error procesando webhook de WhatsApp:', error);
    res.status(500).json({
      success: false,
      message: 'Error procesando webhook',
    });
  }
};

/**
 * Manejar webhook de SMS (Twilio)
 */
const handleSMSWebhook = async (req, res, next) => {
  try {
    const { From, Body, MessageSid } = req.body;

    logger.info(`SMS recibido de ${From}: ${Body}`);

    // Procesar SMS
    await webhookService.handleSMSMessage({
      from: From,
      body: Body,
      messageSid: MessageSid,
    });

    // Twilio espera una respuesta vacía
    res.status(200).send('');
  } catch (error) {
    logger.error('Error procesando webhook de SMS:', error);
    res.status(500).send('');
  }
};

/**
 * Verificar firma de Peanpe
 */
const verifyPeanpeSignature = (signature, timestamp, payload) => {
  // TODO: Implementar verificación real de firma
  // Por ahora, solo verificar que existan los headers
  if (!signature || !timestamp) {
    return false;
  }

  // Verificar que el timestamp no sea muy antiguo (5 minutos)
  const currentTime = Math.floor(Date.now() / 1000);
  const webhookTime = parseInt(timestamp);
  if (Math.abs(currentTime - webhookTime) > 300) {
    return false;
  }

  // TODO: Verificar firma HMAC con config.peanpe.webhookSecret
  return true;
};

module.exports = {
  handlePeanpeWebhook,
  verifyWebhook,
  handleWhatsAppWebhook,
  handleSMSWebhook,
};
