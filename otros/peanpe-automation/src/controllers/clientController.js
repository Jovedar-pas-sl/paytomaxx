const clientService = require('../services/clientService');
const logger = require('../utils/logger');
const { ApiError } = require('../utils/errorHandler');

// ============================================
// CONTROLADOR DE CLIENTES
// ============================================

/**
 * Crear nuevo cliente
 */
const createClient = async (req, res, next) => {
  try {
    const { name, phone, email, notes } = req.body;

    // Validaciones
    if (!name) {
      throw new ApiError(400, 'El nombre del cliente es requerido');
    }

    if (!phone) {
      throw new ApiError(400, 'El teléfono del cliente es requerido');
    }

    // Crear cliente
    const client = await clientService.createClient({
      name,
      phone,
      email,
      notes,
      userId: req.user.id,
    });

    logger.info(`Cliente creado: ${client.id} - ${client.name}`);

    res.status(201).json({
      success: true,
      message: 'Cliente creado exitosamente',
      data: client,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener todos los clientes
 */
const getAllClients = async (req, res, next) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;

    const clients = await clientService.getAllClients({
      search,
      page: parseInt(page),
      limit: parseInt(limit),
      userId: req.user.id,
    });

    res.json({
      success: true,
      data: clients,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener cliente por ID
 */
const getClientById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const client = await clientService.getClientById(id);

    if (!client) {
      throw new ApiError(404, 'Cliente no encontrado');
    }

    res.json({
      success: true,
      data: client,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener cliente por teléfono
 */
const getClientByPhone = async (req, res, next) => {
  try {
    const { phone } = req.params;

    const client = await clientService.getClientByPhone(phone);

    if (!client) {
      throw new ApiError(404, 'Cliente no encontrado');
    }

    res.json({
      success: true,
      data: client,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Actualizar cliente
 */
const updateClient = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, email, notes } = req.body;

    const client = await clientService.updateClient(id, {
      name,
      phone,
      email,
      notes,
    });

    logger.info(`Cliente actualizado: ${id}`);

    res.json({
      success: true,
      message: 'Cliente actualizado exitosamente',
      data: client,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Eliminar cliente
 */
const deleteClient = async (req, res, next) => {
  try {
    const { id } = req.params;

    await clientService.deleteClient(id);

    logger.info(`Cliente eliminado: ${id}`);

    res.json({
      success: true,
      message: 'Cliente eliminado exitosamente',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener historial de pagos de cliente
 */
const getClientPayments = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const payments = await clientService.getClientPayments(id, {
      page: parseInt(page),
      limit: parseInt(limit),
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
 * Guardar tarjeta de cliente
 */
const saveCard = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { cardToken, cardLastFour, cardBrand } = req.body;

    const card = await clientService.saveCard(id, {
      cardToken,
      cardLastFour,
      cardBrand,
    });

    logger.info(`Tarjeta guardada para cliente: ${id}`);

    res.status(201).json({
      success: true,
      message: 'Tarjeta guardada exitosamente',
      data: card,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Obtener tarjetas de cliente
 */
const getClientCards = async (req, res, next) => {
  try {
    const { id } = req.params;

    const cards = await clientService.getClientCards(id);

    res.json({
      success: true,
      data: cards,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Eliminar tarjeta de cliente
 */
const deleteCard = async (req, res, next) => {
  try {
    const { id, cardId } = req.params;

    await clientService.deleteCard(id, cardId);

    logger.info(`Tarjeta eliminada: ${cardId} del cliente: ${id}`);

    res.json({
      success: true,
      message: 'Tarjeta eliminada exitosamente',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createClient,
  getAllClients,
  getClientById,
  getClientByPhone,
  updateClient,
  deleteClient,
  getClientPayments,
  saveCard,
  getClientCards,
  deleteCard,
};
