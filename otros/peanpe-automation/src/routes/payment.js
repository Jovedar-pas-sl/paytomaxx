const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authenticate } = require('../utils/auth');

// ============================================
// RUTAS DE PAGOS
// ============================================

// Crear nuevo pago
router.post('/', authenticate, paymentController.createPayment);

// Obtener todos los pagos
router.get('/', authenticate, paymentController.getAllPayments);

// Obtener pago por ID
router.get('/:id', authenticate, paymentController.getPaymentById);

// Obtener estado de pago
router.get('/:id/status', authenticate, paymentController.getPaymentStatus);

// Cancelar pago
router.post('/:id/cancel', authenticate, paymentController.cancelPayment);

// Reenviar notificación de pago
router.post('/:id/resend', authenticate, paymentController.resendNotification);

// Obtener estadísticas de pagos
router.get('/stats/summary', authenticate, paymentController.getPaymentStats);

// Generar reporte de pagos
router.get('/report/download', authenticate, paymentController.downloadReport);

module.exports = router;
