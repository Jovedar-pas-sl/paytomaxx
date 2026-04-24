const express = require('express');
const router = express.Router();
const subscriptionController = require('../controllers/subscriptionController');
const { authenticate } = require('../utils/auth');

// ============================================
// RUTAS DE SUSCRIPCIONES
// ============================================

// Crear nueva suscripción
router.post('/', authenticate, subscriptionController.createSubscription);

// Obtener todas las suscripciones
router.get('/', authenticate, subscriptionController.getAllSubscriptions);

// Obtener suscripción por ID
router.get('/:id', authenticate, subscriptionController.getSubscriptionById);

// Actualizar suscripción
router.put('/:id', authenticate, subscriptionController.updateSubscription);

// Cancelar suscripción
router.post('/:id/cancel', authenticate, subscriptionController.cancelSubscription);

// Pausar suscripción
router.post('/:id/pause', authenticate, subscriptionController.pauseSubscription);

// Reanudar suscripción
router.post('/:id/resume', authenticate, subscriptionController.resumeSubscription);

// Obtener historial de pagos de suscripción
router.get('/:id/payments', authenticate, subscriptionController.getSubscriptionPayments);

// Procesar pago manual de suscripción
router.post('/:id/process', authenticate, subscriptionController.processManualPayment);

// Obtener estadísticas de suscripciones
router.get('/stats/summary', authenticate, subscriptionController.getSubscriptionStats);

module.exports = router;
