# Roadmap — wa-ops + Sara + KPI (auditoría + mercado)

> Síntesis de una revisión multi-agente (auditoría interna del código + investigación de
> mercado: plataformas de venta por WhatsApp con IA, herramientas del sector, UX de inboxes).
> Negocio: agencia legal de acompañantes en España, multi-casa, captación por WhatsApp.

## 1. Estado actual

Sistema en producción y sólido: inbox multi-casa (WAHA + FastAPI/HTMX + Postgres + Redis),
recepcionista IA **Sara** (ES/EN/FR/IT, cierra reservas, off/copiloto/auto por número),
**analyzer** con skills por conversación + meta-análisis por casa, widget web por site, y
**sync site→DB cada 20 min** (chicas + tarifas reales). Donde brilla: **disciplina anti-ban**
(webhook solo encola, debounce 8s, re-check TOCTOU, no auto-pausa por su propio eco).

## 2. Huecos críticos (limitan resultados HOY)

1. **Anti-ban incompleto**: hay debounce por cliente, pero **no hay rate-limit agregado por número, ni tope diario, ni quiet-hours** (la columna `quiet_hours` de 0014 nunca se implementó). En números no oficiales esto es el principal vector de baneo, y un número baneado = leads perdidos al instante.
2. **Sara no envía fotos ni ubicación**: el prompt promete `send_photos`/`send_location` pero `waha_client.py` no los tiene. En el sector, "mándame fotos" es constante → la conversación muere donde un humano mandaría imagen. Techo de producto.
3. **Analyzer y agente desconectados**: el analyzer diagnostica (conv_probability, next_action, coaching) pero Sara **no lee nada de eso**. El mayor hueco de leverage.
4. **Sin follow-up de leads fríos / cotización abandonada**: se marca `next_action: follow_up` pero ningún job re-engancha. El warm-but-unclosed es el trabajo de mayor ROI y no tiene ni lista.
5. **El operador es ciego al estado de Sara en el inbox**: `agent_status`/`paused_risk`/borradores de copiloto no se ven por conversación (solo el toggle global). No se distingue burbuja bot vs humano ni hay botón "Enviar" para sugerencias.
6. **El dinero vive en informes IA de pago, no en métricas vivas**: funnel, revenue estimado, top-chicas, ROI por canal solo en `informe_detail` (snapshot que hay que pagar). La pestaña Métricas no tiene ingresos ni close-rate real (su "conversión" es `avg(conv_probability)`, una suposición).
7. **Sin memoria por cliente entre conversaciones ni cross-número**: un repetidor se trata como extraño en cada uno de los 8+ números. Fuga de conversión y de realismo.

## 3. Inspiración del mercado (robos concretos)

1. **Tarjetas "perfil de chica"** (foto+servicios+tarifa+disponibilidad) — alimentadas por el sync. Resuelve el techo de fotos.
2. **Recuperación de cotización abandonada** (Wati) — re-enganchar a quien recibió precio y no reservó.
3. **Links de depósito/pago en el chat** (Gupshup/Gallabox) — **aprovecha el trabajo ya hecho en NightPay/Redsys/Peanpe**: Sara cobra depósito → menos no-shows. Diferenciador sin competencia en el sector.
4. **Disponibilidad en tiempo real + "de tour"** (Tryst/Slixa, el feature más copiado del sector) — badges sobre los datos ya sincronizados.
5. **Lista negra compartida cross-casa** + reconocimiento de repetidor — extensión de las red-flags + DB multi-número. Activo que la competencia no tiene.
6. **Copiloto in-inbox**: sugerir/reescribir/resumir/traducir con un clic — Sara ya genera el borrador, falta el botón.
7. **Memoria persistente por cliente** (mem0/Zep, ~92% recall a una fracción de tokens) — hechos por cliente (chica preferida, idioma, presupuesto, no-shows) con decay.
8. **Lead score vivo → routing** (respond.io) — operacionalizar `conv_probability` como badge "hot" + orden del inbox.
9. **Cola "Needs review" + pills AUTO/COPILOTO/HUMANO por fila** (Intercom/Chatwoot).
10. **Transcripción de notas de voz (Whisper) + visión sobre imágenes entrantes** — entender "¿quién es esta?" y audios.

## 4. Roadmap priorizado

### Quick wins (<1 día c/u) — mejorar
| Item | Por qué | Tipo |
|---|---|---|
| **Rate-limit + tope diario + quiet-hours por número** (Redis) | Protege los números (anti-ban); barato | mejorar |
| **Estado de Sara en el inbox**: pill AUTO/COPILOTO/HUMANO + burbuja bot≠humano + botón "Enviar" en sugerencias copiloto | El operador deja de ir a ciegas; confianza | mejorar |
| **Cola "Needs review"** destacando `paused_risk` (separado de merge) | El bot dejó de atender → que se vea ya | mejorar |
| **Badge "hot lead"** usando `conv_probability` ya calculado | Enfoca al humano entre 8+ números | mejorar |

### Medio plazo (días)
| Item | Por qué | Tipo |
|---|---|---|
| **Envío de fotos + tarjetas de chica** (`sendImage`/`sendLocation` en waha_client) | Quita el techo #2; sube conversión brutal | añadir |
| **Follow-up de cotización abandonada** (job sobre `next_action: follow_up`) | El trabajo de mayor ROI hoy sin hacer | añadir |
| **Conectar analyzer→Sara**: inyectar `next_action`/`coaching`/`conv_probability` en el prompt | Leverage: las dos mitades por fin colaboran | mejorar |
| **Métricas vivas** (funnel + close-rate real + revenue + demanda por chica) en el panel | Saca el dinero de los informes de pago | mejorar |

### Apuestas grandes (semanas)
| Item | Por qué | Tipo |
|---|---|---|
| **Memoria por cliente cross-número** (hechos + decay) + reconocimiento de repetidor | Conversión + realismo; el hueco #7 | añadir |
| **Depósito/pago en el chat** (integrar NightPay/Redsys) | Cierre conversacional + cobro; diferenciador | añadir |
| **F3 calculadora de salida** (Valhalla + tarifa taxi, `servicio + taxi×1.20`) | Ya planeada; automatiza el precio de salida | añadir |
| **Notas de voz (Whisper) + visión** | Entiende audios/fotos entrantes | añadir |
| **Lista negra compartida cross-casa** | Screening; activo único | añadir |

## 5. Top 3 — por dónde empezar (mi recomendación)

1. **Anti-ban (rate-limit + quiet-hours por número).** Sin esto, un baneo borra leads de golpe en un número publicado. Es barato (Redis) y **protege toda la inversión**. Primero esto.
2. **Envío de fotos + tarjetas de chica.** Es el techo de producto #1: hoy las conversaciones mueren justo donde un humano manda una foto. Con el sync ya tenemos las fotos; falta el envío. Sube conversión más que ninguna otra cosa.
3. **Follow-up de cotización abandonada.** El lead tibio que recibió precio y no cerró es el ROI más alto que hoy no tiene ni lista. El analyzer ya lo detecta (`next_action: follow_up`); solo falta accionarlo (con cuidado anti-ban: 1 toque, no spam).

> Mención honorable: **visibilidad de Sara en el inbox** (quick win) es casi un must para operar con confianza con un cerrador autónomo en 8+ números.
