const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { authenticate } = require('../utils/auth');

// ============================================
// RUTAS DE CLIENTES
// ============================================

// Crear nuevo cliente
router.post('/', authenticate, clientController.createClient);

// Obtener todos los clientes
router.get('/', authenticate, clientController.getAllClients);

// Obtener cliente por ID
router.get('/:id', authenticate, clientController.getClientById);

// Obtener cliente por teléfono
router.get('/phone/:phone', authenticate, clientController.getClientByPhone);

// Actualizar cliente
router.put('/:id', authenticate, clientController.updateClient);

// Eliminar cliente
router.delete('/:id', authenticate, clientController.deleteClient);

// Obtener historial de pagos de cliente
router.get('/:id/payments', authenticate, clientController.getClientPayments);

// Guardar tarjeta de cliente
router.post('/:id/cards', authenticate, clientController.saveCard);

// Obtener tarjetas de cliente
router.get('/:id/cards', authenticate, clientController.getClientCards);

// Eliminar tarjeta de cliente
router.delete('/:id/cards/:cardId', authenticate, clientController.deleteCard);

module.exports = router;
