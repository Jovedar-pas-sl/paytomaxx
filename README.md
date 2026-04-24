# 🔧 SISTEMA ATM + WHATSAPP - Guía de Operación

## 📌 **Estructura del Proyecto (Simplificada)**

```
first_tries/
├── manual_browser/
│   └── app.py                  ← Servidor principal (Puerto 8889)
├── whatsapp_analyzer/          ← Análisis de chats
├── shared_db.json              ← Base de datos
├── STARTUP.bat                 ← Arranque automático
├── README.md                   ← Este archivo
└── ...
```

---

## 🚀 **ARRANQUE RÁPIDO**

### **Opción 1: Arranque Manual (Ahora)**
```bash
cd "C:\Users\mehdi\Documents\GitHub\first_tries"
.\STARTUP.bat
```
Abre 2 ventanas:
- Docker + Evolution API (puerto 8080)
- Servidor ATM Flask (puerto 8889)

### **Opción 2: Arranque Automático (Windows)**
```bash
.\make_autostart.bat
```
Ejecutar **una sola vez** como administrador. Luego se inicia automáticamente al abrir sesión.

---

## 🌐 **ACCESO A LA APLICACIÓN**

| Función | URL | Puerto |
|---------|-----|--------|
| **Soporte Técnico** | http://127.0.0.1:8889/incidencias | 8889 |
| **Sistema** | http://127.0.0.1:8889/sistema | 8889 |
| **Inventario** | http://127.0.0.1:8889/inventario | 8889 |
| **Evolution API** | http://localhost:8080 | 8080 |
| **Chatwoot** | http://localhost:3000 | 3000 |

---

## 🗂️ **ARCHIVOS CLAVE**

### ✅ Mantener
- `manual_browser/app.py` - Servidor principal
- `whatsapp_analyzer/` - Análisis de conversaciones
- `shared_db.json` - Base de datos de clientes/máquinas
- `manual_browser/manuales/` - PDFs técnicos

### ❌ Eliminar (No necesarias)
```bash
# Limpiar archivos innecesarios
del scraper_rapidprest.js
del open_firewall.bat
del theme_preview.html
del import_clients.py
del *.backup.json
```

---

## 🔧 **COMPONENTES ACTIVOS**

### 1️⃣ **Evolution API** (Puerto 8080)
```bash
Location: C:\Users\mehdi\Documents\GitHub\chatwoot
Container: chatwoot-evolution-api-1
Status: Activo (en Docker)
```
✅ Conecta con WhatsApp
✅ Proporciona chats en vivo
✅ API en puerto 8080

### 2️⃣ **Servidor ATM Flask** (Puerto 8889)
```bash
Location: C:\Users\mehdi\Documents\GitHub\first_tries\manual_browser
File: app.py
Status: Activo
```
✅ Interfaz web
✅ Análisis de errores
✅ Gestión de incidencias
✅ Carga de manuales

### 3️⃣ **WhatsApp Analyzer**
```bash
Location: C:\Users\mehdi\Documents\GitHub\first_tries\whatsapp_analyzer
Status: Activo (genera reportes)
```
✅ Descarga conversaciones
✅ Genera análisis con IA
✅ Reportes HTML y Markdown

---

## 📊 **FLUJO DE DATOS**

```
WhatsApp (Evolution API, puerto 8080)
        ↓
Flask Server (puerto 8889)
        ├── /incidencias → Chats + Análisis
        ├── /sistema     → Panel de control
        └── /inventario  → Inventario
        ↓
shared_db.json → Clientes, máquinas, incidencias
        ↓
whatsapp_analyzer → Procesa y genera reportes
```

---

## 🐧 **COMANDOS ÚTILES**

### Ver estado de Docker
```bash
cd "C:\Users\mehdi\Documents\GitHub\chatwoot"
docker-compose ps
```

### Detener servicios
```bash
# Docker
cd "C:\Users\mehdi\Documents\GitHub\chatwoot"
docker-compose down

# Servidor Flask (Ctrl+C en su ventana)
```

### Reiniciar todo
```bash
.\STARTUP.bat
```

### Logs de Flask
```bash
cd "C:\Users\mehdi\Documents\GitHub\first_tries\manual_browser"
py -3 app.py
```

---

## 🔍 **SOLUCIÓN DE PROBLEMAS**

### ❌ "No se conecta a Evolution API"
```bash
# Verificar que Docker está corriendo
docker ps | findstr evolution

# Si no aparece, iniciar manualmente
cd "C:\Users\mehdi\Documents\GitHub\chatwoot"
docker-compose up -d
```

### ❌ "Puerto 8889 en uso"
```bash
# Encontrar proceso usando puerto 8889
netstat -ano | findstr 8889

# Matar proceso (reemplazar PID)
taskkill /PID 12345 /F
```

### ❌ "Los chats no cargan"
1. Verificar que Evolution API esté en puerto 8080
2. Revisar que Chatwoot tiene conversaciones
3. Reiniciar Flask en 8889

---

## 📈 **PRÓXIMOS PASOS**

1. **Limpiar archivos innecesarios** → Eliminar los archivos listados en "Eliminar"
2. **Crear acceso directo** → Ejecutar `make_autostart.bat`
3. **Test final** → Acceder a http://127.0.0.1:8889/incidencias
4. **Monitorear logs** → Ver archivo `server.log`

---

## 📞 **SOPORTE**

- **Servidor**: http://127.0.0.1:8889
- **Docker**: Chatwoot en `C:\Users\mehdi\Documents\GitHub\chatwoot`
- **Logs**: `server.log` y `server_err.log`

---

**Última actualización**: 31/03/2026
