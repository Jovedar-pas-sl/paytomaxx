const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// ============================================
// RUTAS DE WEBHOOKS (Sin autenticación)
// ============================================

// Webhook de Peanpe Payments
router.post('/peanpe', webhookController.handlePeanpeWebhook);

// Webhook de verificación (para WhatsApp, etc.)
router.get('/verify', webhookController.verifyWebhook);

// Webhook de WhatsApp
router.post('/whatsapp', webhookController.handleWhatsAppWebhook);

// Webhook de SMS (Twilio)
router.post('/sms', webhookController.handleSMSWebhook);

// Health check de webhooks
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Webhooks activos',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
