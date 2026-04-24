# Maxxag Chat Widget

Chatbot inteligente para webs de acompañantes. Dark theme, multi-idioma, panel admin, aprendizaje automático.

**Webs:** maxxagvlc.com · maxxagemadrid.com · mansionbabylonmarbella.com

---

## Estructura

```
chatbot_maxxag/
├── backend/
│   ├── app.py          ← Servidor Flask (API)
│   ├── chatbot.py      ← Lógica de conversación
│   ├── config.py       ← Variables de entorno
│   ├── requirements.txt
│   └── data/
│       ├── girls.json      ← Perfiles de chicas
│       ├── config.json     ← Tarifas, horarios, textos
│       └── chat_logs.json  ← Logs para aprendizaje
├── widget/
│   ├── chat-widget.js  ← Widget JavaScript
│   ├── chat-widget.css ← Estilos dark theme
│   └── test.html       ← Página de prueba local
├── admin/
│   └── index.html      ← Panel de administración
├── wordpress/
│   └── maxxag-chat.php ← Plugin WordPress
└── .env.example
```

---

## Instalación rápida

### 1. Configurar entorno

```bash
cd chatbot_maxxag
cp .env.example .env
# Edita .env y pon tu ANTHROPIC_API_KEY y ADMIN_TOKEN
```

### 2. Instalar dependencias Python

```bash
cd backend
pip install -r requirements.txt
```

### 3. Arrancar el servidor

```bash
python app.py
# Servidor corriendo en http://localhost:5050
```

### 4. Probar el chat

Abre en el navegador: `widget/test.html`
(Asegúrate de que el servidor está corriendo)

### 5. Panel admin

Abre: `admin/index.html`
- Introduce la URL del servidor cuando pregunte
- Introduce tu ADMIN_TOKEN
- Gestiona chicas, disponibilidad y tarifas

---

## Instalar en WordPress

### Opción A — Plugin (recomendado)

1. Sube la carpeta `wordpress/maxxag-chat.php` a:
   `wp-content/plugins/maxxag-chat/maxxag-chat.php`

2. Activa el plugin en **WordPress Admin > Plugins**

3. Ve a **Ajustes > Maxxag Chat** y configura:
   - URL del servidor (ej: `https://tu-servidor.com:5050`)
   - Ciudad (`vlc`, `madrid`, o `marbella`)
   - Idioma por defecto

### Opción B — Código directo (sin plugin)

Añade esto al `functions.php` de tu tema:

```php
function maxxag_chat_widget() {
    $api = 'https://TU-SERVIDOR:5050';
    $city = 'vlc'; // o 'madrid' o 'marbella'
    echo '<link rel="stylesheet" href="' . $api . '/widget/chat-widget.css">';
    echo '<script src="' . $api . '/widget/chat-widget.js" data-api="' . $api . '" data-city="' . $city . '" data-lang="es" defer></script>';
}
add_action('wp_footer', 'maxxag_chat_widget');
```

---

## Gestión diaria de disponibilidad

1. Abre `admin/index.html`
2. Selecciona la ciudad
3. Activa/desactiva el toggle de cada chica
4. Se refleja al instante en el chat

---

## Funcionalidades del chat

| Opción | Descripción |
|--------|-------------|
| Escorts disponibles | Lista de chicas disponibles hoy con foto y WhatsApp |
| Horario / Cómo llegar | Horario y cómo llegar |
| Tarifas / Servicios | Tabla de precios |
| A hotel o domicilio | Info sobre salidas con botón WhatsApp |
| Reservar | Botón directo al WhatsApp de recepción |
| Escorts para pareja | Chicas especializadas en parejas |
| 🇬🇧 🇫🇷 🇮🇹 | Cambio de idioma |
| Contacto recepción | WhatsApp directo |
| Preguntas libres | Respuesta inteligente con Claude IA |

---

## Aprendizaje automático

El bot aprende de las conversaciones libres:

1. Desde el panel admin, click en **"Analizar conversaciones"**
2. Claude analiza las últimas 50 conversaciones
3. Sugiere y añade nuevas respuestas FAQ automáticamente
4. Se refleja al instante en futuras conversaciones

---

## Configuración por ciudad

Cada web tiene su propio:
- Nombre del bot y avatar
- WhatsApp de recepción
- Tarifas
- Horarios y dirección

Configura todo desde `backend/data/config.json` o desde el panel admin.

---

## Coste estimado

- Menú y perfiles: **0€** (datos del JSON, sin API)
- Preguntas libres: ~**0.001€** por pregunta (Claude Haiku)
- Estimado total: **2-5€/mes** con 500 chats/día

---

## Producción (deploy)

Para poner en producción necesitas:
1. Un servidor con Python (VPS, Railway, Render...)
2. Instalar con `pip install -r requirements.txt`
3. Usar Gunicorn: `gunicorn -w 4 app:app --bind 0.0.0.0:5050`
4. Poner nginx delante con SSL (HTTPS)
5. Apuntar el WordPress a la URL del servidor
