const express = require('express');
const router = express.Router();

// Importar rutas
const paymentRoutes = require('./payment');
const clientRoutes = require('./client');
const subscriptionRoutes = require('./subscription');

// Usar rutas
router.use('/payments', paymentRoutes);
router.use('/clients', clientRoutes);
router.use('/subscriptions', subscriptionRoutes);

// Ruta de información de la API
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API de Automatización Peanpe Payments',
    version: '1.0.0',
    endpoints: {
      payments: '/api/payments',
      clients: '/api/clients',
      subscriptions: '/api/subscriptions',
      webhooks: '/webhook',
    },
  });
});

module.exports = router;
