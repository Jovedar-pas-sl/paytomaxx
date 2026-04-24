# Guia de Instalacion — Maxxag Chat Plugin

## Requisitos

- WordPress 5.0+
- PHP 7.4+
- Hosting Linux con Apache o Nginx
- API Key de Anthropic (Claude AI) — https://console.anthropic.com/

---

## Paso 1: Subir el plugin

Cada web tiene su ZIP personalizado:

| Web | Archivo ZIP |
|-----|------------|
| maxxagevlc.com | `maxxag-chat-vlc.zip` |
| maxxagemadrid.com | `maxxag-chat-madrid.zip` |
| mansionbabylonmarbella.com | `maxxag-chat-marbella.zip` |

1. Entra en **WordPress Admin** de tu web
2. Ve a **Plugins -> Anadir nuevo -> Subir plugin**
3. Selecciona el ZIP correspondiente a tu web
4. Click **Instalar ahora**
5. Click **Activar**

---

## Paso 2: Configurar

1. Ve a **Ajustes -> Maxxag Chat**
2. Rellena los campos:

| Campo | Que poner |
|-------|-----------|
| Activar chatbot | Marcado (checkbox) |
| Idioma por defecto | Espanol (o el que prefieras) |
| Token admin | Un token seguro para el backoffice (minimo 8 caracteres). Ejemplo: `MiTokenSecreto2026!` |
| Anthropic API Key | Tu clave de Anthropic: `sk-ant-api03-...` |

3. Click **Guardar**

---

## Paso 3: Permisos de escritura

El plugin necesita escribir en la carpeta `data/` para guardar chicas, tarifas y conversaciones.

### Por FTP:
- Navega a `wp-content/plugins/maxxag-chat/data/`
- Click derecho -> Permisos -> Pon **755** en la carpeta y **644** en los archivos JSON

### Por SSH:
```bash
chmod -R 755 /var/www/TU-DOMINIO/public_html/wp-content/plugins/maxxag-chat/data/
chmod 644 /var/www/TU-DOMINIO/public_html/wp-content/plugins/maxxag-chat/data/*.json
```

Cambia `TU-DOMINIO` por tu dominio real (ej: `maxxagevlc.com`).

---

## Paso 4: Verificar que funciona

### El chat:
1. Abre tu web en una ventana de incognito
2. Espera 3 segundos — el chat se abre automaticamente
3. Elige un idioma
4. Prueba los botones: Escorts disponibles, Tarifas, etc.
5. Escribe algo libre (ej: "hola") — debe responder con Claude AI

### Si el chat NO aparece:
- Verifica que el plugin esta **activado** (Plugins -> busca "Maxxag Chat")
- Verifica que esta **habilitado** (Ajustes -> Maxxag Chat -> checkbox marcado)
- Abre la consola del navegador (F12 -> Console) y busca errores en rojo
- Verifica que la API REST funciona: abre `https://TU-WEB.com/wp-json/maxxag/v1/config` en el navegador — debe devolver JSON

### Si Claude no responde (texto libre):
- Verifica la API key en Ajustes -> Maxxag Chat
- Verifica que tienes credito en https://console.anthropic.com/
- El bot mostrara un mensaje amable de fallback si la API falla

---

## Paso 5: Gestionar chicas y tarifas (Backoffice)

### Acceder al backoffice:
1. WordPress Admin -> **Ajustes -> Maxxag Chat**
2. Click **Abrir backoffice**
3. URL del servidor: `https://TU-WEB.com/wp-json/maxxag/v1`
4. Token: el que pusiste en el paso 2
5. Click **Entrar**

### Anadir una chica:
1. Backoffice -> **Chicas** -> **Anadir chica**
2. Rellena: nombre, edad, nacionalidad, descripcion, URL foto, WhatsApp
3. Marca "Disponible hoy" si esta trabajando
4. Guardar

### Editar tarifas:
1. Backoffice -> **Tarifas**
2. Edita los precios en la tabla
3. Puedes anadir filas (+Anadir fila) o eliminar (X)
4. Click **Guardar cambios**

### Configuracion del local:
1. Backoffice -> **Configuracion**
2. Edita: nombre del local, logo, WhatsApp, Telegram, horario, direccion
3. Guardar

### Ver conversaciones:
1. Backoffice -> **Conversaciones** — historial de chats
2. Backoffice -> **Dashboard** — mapa de calor de demanda por chica

---

## Paso 6: Configuracion avanzada (Nginx)

Si tu hosting usa **Nginx** (no Apache), anade esto al bloque `server` de tu configuracion:

```nginx
# Bloquear acceso a datos del chatbot
location ~* /wp-content/plugins/maxxag-chat/(data|admin)/ {
    deny all;
    return 403;
}
```

Luego reinicia Nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Estructura del plugin

```
wp-content/plugins/maxxag-chat/
├── maxxag-chat.php      <- Plugin principal
├── api.php              <- Endpoints REST API
├── chatbot.php          <- Logica del bot (menus, respuestas)
├── claude.php           <- Conexion con Claude AI
├── data/
│   ├── config.json      <- Tarifas, horario, saludos
│   ├── girls.json       <- Perfiles de chicas
│   ├── chat_logs.json   <- Historial de conversaciones
│   ├── tickets.json     <- Tickets de conversacion
│   ├── .htaccess        <- Proteccion Apache
│   └── index.php        <- Proteccion Nginx/directa
├── widget/
│   ├── chat-widget.js   <- Widget del chat (frontend)
│   └── chat-widget.css  <- Estilos (personalizado por web)
└── admin/
    └── index.html       <- Panel de gestion (backoffice)
```

---

## API Endpoints

Todos accesibles en `https://TU-WEB.com/wp-json/maxxag/v1/`

### Publicos (sin auth):
| Metodo | Ruta | Funcion |
|--------|------|---------|
| POST | `/chat` | Enviar/recibir mensajes del chat |
| GET | `/girls` | Lista de chicas (con filtros) |
| GET | `/config` | Configuracion publica (tarifas, horario) |

### Admin (requiere header `X-Admin-Token`):
| Metodo | Ruta | Funcion |
|--------|------|---------|
| GET | `/admin/girls` | Todas las chicas |
| POST | `/admin/girl` | Crear/editar chica |
| DELETE | `/admin/girl/{id}` | Eliminar chica |
| POST | `/admin/toggle` | Cambiar disponibilidad |
| GET/POST | `/admin/config` | Leer/editar configuracion |
| POST | `/admin/learn` | Analisis IA de conversaciones |
| GET | `/admin/logs` | Historial de chats |
| GET | `/admin/heatmap` | Mapa de calor de demanda |
| GET | `/admin/tickets` | Lista de tickets |
| GET | `/admin/ticket/{id}` | Detalle de un ticket |

---

## Costes

| Concepto | Coste |
|----------|-------|
| Plugin | Gratis |
| Hosting | Lo que ya pagas |
| Claude AI (texto libre) | ~0.001 EUR por pregunta |
| Menus y botones | 0 EUR (datos locales) |
| Estimado mensual | 2-5 EUR con 500 chats/dia |

---

## Soporte

Si algo no funciona:

1. **Chat no aparece**: Ajustes -> Maxxag Chat -> verificar que esta activado
2. **Error 403 en API**: Permisos de la carpeta `data/` (ver Paso 3)
3. **Claude no responde**: Verificar API key y credito en Anthropic
4. **Backoffice no entra**: Verificar token y URL (`https://TU-WEB.com/wp-json/maxxag/v1`)
5. **Errores en consola**: F12 -> Console -> copiar el error rojo

---

## Desinstalar

1. WordPress Admin -> Plugins -> Maxxag Chat -> **Desactivar**
2. Click **Borrar**
3. Los datos (chicas, tarifas, conversaciones) se eliminan con el plugin
