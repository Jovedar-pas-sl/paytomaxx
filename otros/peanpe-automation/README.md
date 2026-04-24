# 🚀 Peanpe Automation - Sistema de Automatización de Pagos

Sistema completo para automatizar pagos con Peanpe Payments, reduciendo el proceso de 5 minutos a 30 segundos.

## 📋 Características

- ✅ **Pagos instantáneos** con tarjeta guardada
- ✅ **Webhooks** para notificaciones en tiempo real
- ✅ **WhatsApp Bot** con Evolution API
- ✅ **Chatwoot** para gestión de conversaciones
- ✅ **Pagos recurrentes** (suscripciones)
- ✅ **QR/NFC** para puntos de venta
- ✅ **Dashboard** para monitoreo
- ✅ **API REST** completa
- ✅ **Base de datos** PostgreSQL
- ✅ **Cache** Redis
- ✅ **Notificaciones** WhatsApp, Email (Resend)

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                    SISTEMA AUTOMATIZADO                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Evolution   │◄──►│   Backend    │◄──►│    Peanpe    │  │
│  │    API       │    │   Server     │    │   Payments   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                   │                   │           │
│         ▼                   ▼                   ▼           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Chatwoot   │    │  Webhooks    │    │    Resend    │  │
│  │              │    │  Handler     │    │   (Email)    │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Inicio Rápido

### 1. Instalar dependencias

```bash
cd peanpe-automation
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
# Editar .env con tus credenciales
```

### 3. Configurar base de datos

```bash
# Crear base de datos PostgreSQL
createdb peanpe_automation

# Ejecutar esquema
psql -U postgres -d peanpe_automation -f database/schema.sql
```

### 4. Iniciar servidor

```bash
# Desarrollo
npm run dev

# Producción
npm start
```

### 5. Verificar

```bash
curl http://localhost:3000/health
```

## 📁 Estructura del Proyecto

```
peanpe-automation/
├── src/
│   ├── config/           # Configuración
│   ├── controllers/      # Controladores de rutas
│   ├── services/         # Lógica de negocio
│   ├── models/           # Modelos de datos
│   ├── routes/           # Definición de rutas
│   ├── utils/            # Utilidades (logger, auth, etc.)
│   └── server.js         # Punto de entrada
├── database/
│   └── schema.sql        # Esquema de base de datos
├── public/               # Archivos estáticos
│   ├── css/
│   └── js/
├── views/                # Templates
├── tests/                # Tests
├── docs/                 # Documentación
├── .env.example          # Variables de entorno ejemplo
├── package.json          # Dependencias
└── README.md             # Este archivo
```

## 🔌 API Endpoints

### Pagos

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/payments` | Crear nuevo pago |
| GET | `/api/payments` | Obtener todos los pagos |
| GET | `/api/payments/:id` | Obtener pago por ID |
| GET | `/api/payments/:id/status` | Obtener estado de pago |
| POST | `/api/payments/:id/cancel` | Cancelar pago |
| POST | `/api/payments/:id/resend` | Reenviar notificación |
| GET | `/api/payments/stats/summary` | Obtener estadísticas |
| GET | `/api/payments/report/download` | Descargar reporte |

### Clientes

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/clients` | Crear cliente |
| GET | `/api/clients` | Obtener todos los clientes |
| GET | `/api/clients/:id` | Obtener cliente por ID |
| GET | `/api/clients/phone/:phone` | Obtener por teléfono |
| PUT | `/api/clients/:id` | Actualizar cliente |
| DELETE | `/api/clients/:id` | Eliminar cliente |
| GET | `/api/clients/:id/payments` | Historial de pagos |
| POST | `/api/clients/:id/cards` | Guardar tarjeta |
| GET | `/api/clients/:id/cards` | Obtener tarjetas |
| DELETE | `/api/clients/:id/cards/:cardId` | Eliminar tarjeta |

### Suscripciones

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/subscriptions` | Crear suscripción |
| GET | `/api/subscriptions` | Obtener todas |
| GET | `/api/subscriptions/:id` | Obtener por ID |
| PUT | `/api/subscriptions/:id` | Actualizar |
| POST | `/api/subscriptions/:id/cancel` | Cancelar |
| POST | `/api/subscriptions/:id/pause` | Pausar |
| POST | `/api/subscriptions/:id/resume` | Reanudar |
| GET | `/api/subscriptions/:id/payments` | Historial |
| POST | `/api/subscriptions/:id/process` | Procesar pago manual |
| GET | `/api/subscriptions/stats/summary` | Estadísticas |

### Webhooks

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/webhook/peanpe` | Webhook de Peanpe |
| GET | `/webhook/verify` | Verificar webhook |
| POST | `/webhook/whatsapp` | Webhook de WhatsApp |
| POST | `/webhook/sms` | Webhook de SMS |
| GET | `/webhook/health` | Health check |

## 🔐 Seguridad

- ✅ Autenticación JWT
- ✅ Verificación de firma de webhooks
- ✅ Rate limiting
- ✅ CORS configurado
- ✅ Helmet (seguridad HTTP)
- ✅ Encriptación de datos sensibles
- ✅ Logs de auditoría

## 📊 Mejoras Esperadas

| Métrica | Antes | Objetivo | Mejora |
|---------|-------|----------|--------|
| Tiempo de pago | ~5 min | ~30 seg | **90%** |
| Tasa conversión | 60% | 95% | **58%** |
| Errores | 15% | 2% | **87%** |
| Satisfacción | 3.2/5 | 4.8/5 | **50%** |

## 🛠️ Tecnologías

- **Backend:** Node.js + Express
- **Base de datos:** PostgreSQL
- **Cache:** Redis
- **WhatsApp:** Evolution API
- **Gestión conversaciones:** Chatwoot
- **Email:** Resend
- **Logs:** Winston
- **Testing:** Jest

## 📝 Próximos Pasos

- [ ] Configurar credenciales de Peanpe Payments
- [ ] Configurar Evolution API para WhatsApp
- [ ] Configurar Chatwoot
- [ ] Configurar Resend para emails
- [ ] Implementar base de datos real
- [ ] Crear dashboard web
- [ ] Testing completo
- [ ] Deploy a producción

## 🤝 Contribución

1. Fork el proyecto
2. Crea una rama (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## 📄 Licencia

MIT License - ver [LICENSE](LICENSE) para detalles.

## 📞 Contacto

- **Email:** tu@email.com
- **WhatsApp:** +34 600 000 000
- **Web:** https://tudominio.com

---

**Estado:** En desarrollo activo 🚧
