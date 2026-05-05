# maxxChatBot — Manual de Instalación, Configuración y Uso

Chatbot inteligente con IA (Claude) para tu sitio web.
Multi-idioma · tarjetas de perfiles · tarifas · WhatsApp/Telegram · panel de gestión propio.

---

## Índice

1. [Requisitos previos](#1-requisitos-previos)
2. [Instalación del plugin](#2-instalación-del-plugin)
3. [Configuración inicial (una sola vez)](#3-configuración-inicial-una-sola-vez)
4. [Acceso al backoffice (panel de gestión)](#4-acceso-al-backoffice-panel-de-gestión)
5. [Configurar el sitio (datos, horario, saludo)](#5-configurar-el-sitio-datos-horario-saludo)
6. [Gestionar perfiles de chicas](#6-gestionar-perfiles-de-chicas)
7. [Ajustar tarifas](#7-ajustar-tarifas)
8. [Gestionar conversaciones (tickets) y KPIs](#8-gestionar-conversaciones-tickets-y-kpis)
9. [Probar el chatbot en tu web](#9-probar-el-chatbot-en-tu-web)
10. [Resolución de problemas](#10-resolución-de-problemas)
11. [Costes](#11-costes)
12. [Seguridad y buenas prácticas](#12-seguridad-y-buenas-prácticas)

---

## 1. Requisitos previos

- Sitio web con **WordPress 5.8+** y **PHP 7.4+**.
- Acceso de **administrador** a tu WordPress.
- Una **API Key de Anthropic (Claude)** — se consigue gratis en https://console.anthropic.com/settings/keys.
  - Coste estimado: ~$0.001 (un décimo de céntimo) por conversación. 100€ de saldo cubren decenas de miles de conversaciones.
- Un número de **WhatsApp** y/o **Telegram** de recepción donde recibir las reservas.

---

## 2. Instalación del plugin

1. Inicia sesión en tu WordPress: `https://tu-web.com/wp-admin/`.
2. Ve a **Plugins → Añadir nuevo → Subir plugin**.
3. Selecciona el archivo **`maxxChatBot.zip`** que recibiste.
4. Pulsa **Instalar ahora** y luego **Activar plugin**.

✅ Verás el plugin **maxxChatBot** activo en la lista.

---

## 3. Configuración inicial (una sola vez)

Esta parte sólo la hace el dueño/administrador, **una vez**.

1. En WordPress, ve a **Ajustes → maxxChatBot**.
2. Rellena:

| Campo | Qué poner |
|-------|-----------|
| **Activar chatbot** | ☑️ Marcado (mostrar el chat en la web). |
| **Idioma por defecto** | Español (o el que prefieras). |
| **Token admin (backoffice)** | Una contraseña segura, mínimo 8 caracteres. **Guárdala** — la usarán las recepcionistas. |
| **Anthropic API Key** | Pégala desde https://console.anthropic.com/settings/keys (empieza por `sk-ant-...`). |

3. Pulsa **Guardar**.
4. Pulsa el botón **🧪 Probar los 10 escenarios** para verificar que la IA responde correctamente.
   - Si todos los escenarios responden con texto natural → ✅ todo bien.
   - Si ves errores HTTP 401 → la API Key es incorrecta.
   - Si ves errores HTTP 429 → has agotado el saldo en Anthropic.

---

## 4. Acceso al backoffice (panel de gestión)

El backoffice es **independiente del panel de WordPress**: pueden entrar las recepcionistas sin tener cuenta de admin de WordPress.

### URL del backoffice

```
https://tu-web.com/chat-admin/
```

### Cómo entrar

1. Abre la URL en cualquier navegador (móvil o pc).
2. Introduce el **Token admin** que configuraste en el paso 3.
3. ☑️ Marca "Recuérdame (30 días)" si confías en el dispositivo.
4. Pulsa **Entrar**.

### Cómo salir

Pulsa el botón de **Logout** en la esquina, o ve a `https://tu-web.com/chat-admin/?logout=1`.

> 💡 **Tip**: Tras 10 intentos fallidos en 5 minutos, la IP queda bloqueada para evitar fuerza bruta.

---

## 5. Configurar el sitio (datos, horario, saludo)

Dentro del backoffice, en la pestaña **Configuración**:

### Identidad del local
- **Nombre del local**: ej. *"Mi Local Premium"*.
- **Logo del local**: sube una imagen JPG/PNG/WebP (cuadrada, recomendado 200×200).
- **WhatsApp recepción**: con código país, ej. `+34600123456`.
- **Telegram recepción**: usuario sin @, ej. `mi_local_oficial`.

### Horario y dirección
- **Horario (ES/EN/FR/IT)**: ej. *"Lunes a Domingo 10:00 - 02:00"*.
- **Dirección (ES/EN/FR/IT)**: ej. *"Calle Real 12, 28013 Madrid"*.
- **Cómo llegar**: instrucciones breves (metro, parking, etc.).

### Saludo del bot
- **Saludo (ES/EN/FR/IT)**: el primer mensaje que ve el cliente. Ej. *"Bienvenido a Mi Local 😘 ¿En qué te ayudamos?"*.

### Pulsa **Guardar configuración** al terminar.

---

## 6. Gestionar perfiles de chicas

En la pestaña **Chicas** del backoffice:

### Añadir una chica

1. Pulsa **+ Nueva chica**.
2. Rellena los datos:

| Campo | Descripción |
|-------|-------------|
| **Nombre** | Nombre artístico (ej. *Sophia*). |
| **Edad** | Número (sólo +18). |
| **Nacionalidad** | ej. *Española*, *Brasileña*. |
| **Descripción** | Frase corta atractiva (1–2 líneas). |
| **Foto** | Sube imagen JPG/PNG (mínimo 600×800). |
| **WhatsApp directo** | (Opcional) número propio si la cliente prefiere contacto directo. |
| **Servicios** | Lista separada por comas: ej. *GFE, Masajes, Cenas, Hotel*. |
| **Idiomas** | ES, EN, FR, IT, PT… |
| **Disponible hoy** | ☑️ Marcar para que aparezca como disponible. |
| **Salidas (outcall)** | ☑️ Si va a hotel/domicilio. |
| **Escort pareja** | ☑️ Si acepta servicios para pareja. |

3. Pulsa **Guardar**.

### Editar / desactivar / eliminar

- **Editar**: pulsa la chica → modifica → Guardar.
- **Desactivar**: desmarca *"Disponible hoy"* (no se borra, sólo deja de aparecer).
- **Eliminar**: botón 🗑️ — pide confirmación.

> 💡 **Tip diario**: cada mañana actualiza quién está *"Disponible hoy"*. Sólo las chicas marcadas aparecen en el chat.

---

## 7. Ajustar tarifas

En la pestaña **Tarifas** del backoffice:

1. Verás una tabla con filas tipo:

| Etiqueta ES | Etiqueta EN | Precio |
|-------------|-------------|--------|
| 1 hora | 1 hour | 150€ |
| 2 horas | 2 hours | 250€ |
| Noche completa | Full night | 500€ |
| Hotel/domicilio | Hotel/outcall | desde 200€ |

2. Edita los precios o añade nuevas filas con **+ Añadir tarifa**.
3. **Nota** (debajo): texto orientativo, ej. *"Precios orientativos. Consulta disponibilidad con recepción."*.
4. Pulsa **Guardar**.

---

## 8. Gestionar conversaciones (tickets) y KPIs

### Tickets (pestaña **Conversaciones**)

Cada conversación con un cliente queda guardada como un **ticket**:

- 🟢 **Abierto**: conversación activa (últimos 30 min).
- ⚪ **Cerrado**: sin actividad en >30 min.
- 🗑️ Se borran solos a los 4 días.

Para cada ticket puedes ver:
- Nombre del cliente (si lo dio).
- Idioma.
- Mensajes intercambiados.
- Resumen automático.

### KPIs (pestaña **Estadísticas**)

- 📊 Conversaciones por día.
- 🌍 Idiomas más usados.
- 🔥 Chicas más preguntadas.
- 💰 Tasa estimada de conversión.

---

## 9. Probar el chatbot en tu web

1. Abre tu web pública en una **ventana de incógnito** (para evitar caché).
2. A los 3 segundos, abajo a la derecha aparece la **burbuja flotante**.
3. Púlsala → elige idioma → escribe un nombre → **Continuar**.
4. Prueba los botones del menú:
   - **Escorts disponibles** → ¿aparecen las que marcaste?
   - **Tarifas** → ¿los precios son correctos?
   - **Horario** → ¿la dirección y horario salen bien?
   - **Reservar** → ¿lleva al WhatsApp correcto?
5. Escribe texto libre (ej. *"busco una rubia"*) → la IA debe responder de forma natural.

---

## 10. Resolución de problemas

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| El chat no aparece en la web | Plugin desactivado o caché | WP Admin → Plugins → comprobar activación. Vaciar caché. |
| Error HTTP 401 al probar IA | API Key incorrecta | Ajustes → maxxChatBot → pegar key correcta. |
| Error HTTP 429 | Saldo agotado en Anthropic | Añadir crédito en console.anthropic.com. |
| Las chicas no aparecen | Ninguna marcada como "Disponible hoy" | Backoffice → Chicas → marcar disponibles. |
| `/chat-admin/` da 404 | Permalinks no refrescados | WP Admin → Ajustes → Enlaces permanentes → Guardar. |
| WhatsApp lleva a número vacío | No configurado | Backoffice → Configuración → poner WhatsApp con `+34...`. |
| Pierde sesión cada vez | Cookie bloqueada | Revisar bloqueador de cookies del navegador. |

### Logs y diagnóstico

En **WP Admin → Ajustes → maxxChatBot** verás:
- Estado de la API Key (✓ configurada / ❌ no configurada).
- Último error de Claude (si hubo).
- Botón **🧪 Probar los 10 escenarios** para test rápido.

---

## 11. Costes

- **Plugin**: pago único acordado con el proveedor.
- **Anthropic API (Claude)**:
  - Modelo usado: **Claude Haiku 4.5** (rápido y barato).
  - Coste por conversación: ~**$0.001 USD** (≈ 0,1 céntimos).
  - Recarga mínima: $5 USD.
  - Estimación: 1.000 conversaciones ≈ $1 USD.
- **Hosting WordPress**: tu hosting actual, sin cambios.

---

## 12. Seguridad y buenas prácticas

✅ **Buenas prácticas**:
- Usa una contraseña token admin **fuerte** (mín. 12 caracteres).
- No compartas la API Key de Anthropic — si se filtra, **revócala** y genera una nueva en console.anthropic.com.
- Revisa los tickets cada día para detectar abusos o spam.
- Mantén WordPress y el plugin actualizados.

🛡️ **Lo que el plugin ya hace por ti**:
- Bloquea fuerza bruta en `/chat-admin/` (10 intentos / 5 min).
- Protección contra inyección de prompts (no se puede "jailbreakear" a la IA).
- Datos protegidos: la carpeta `data/` no es accesible desde web.
- Cookies seguras (HttpOnly, Secure, SameSite).
- CSP (Content Security Policy) activa en el panel admin.
- Sanitización de todo input de usuario.

⚠️ **Lo que NO debe hacer el bot** (ya está bloqueado):
- Revelar la API Key.
- Inventar chicas que no existen.
- Dar precios exactos por chat (deriva a recepción).
- Pedir el teléfono del cliente.
- Atender a menores de 18 (rechaza con educación).

---

## Soporte

Si tienes dudas o problemas:
1. Revisa primero la sección [Resolución de problemas](#10-resolución-de-problemas).
2. Mira el último error en **WP Admin → Ajustes → maxxChatBot**.
3. Contacta con el proveedor del plugin.

---

**Versión del plugin**: 5.4.1
**Modelo IA**: Claude Haiku 4.5 (Anthropic)
**Compatibilidad**: WordPress 5.8+ · PHP 7.4+
