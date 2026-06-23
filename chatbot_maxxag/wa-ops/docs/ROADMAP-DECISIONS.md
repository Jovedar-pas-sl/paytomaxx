# Decisiones de las features del roadmap (sesión 2026-06-16)

Spec acordado con el cliente para las features pendientes. Construcción: una a una
(workflow + revisión + deploy). Ver también [ROADMAP-IDEAS.md](ROADMAP-IDEAS.md) y
[SPEC-AGENT-WHATSAPP.md](SPEC-AGENT-WHATSAPP.md).

## A) Visibilidad en el inbox + avisos en panel  (workflow escrito, listo para lanzar)
- **Pills por conversación**: `⏸ RIESGO` (rojo, lo más visible) / `HUMANO` / `AUTO` / `COPILOTO` — según `wa_number.mode` + `conversation.agent_status`.
- **Burbujas bot ≠ humano** en la vista de conversación (agent_generated).
- **Badge 🔥 hot-lead**: `conv_probability ≥ 0.7` (umbral alto), y **se ordenan ARRIBA** en la lista.
- **Botón "Enviar" 1-clic** en las sugerencias de copiloto (envía + persiste agent_generated=TRUE + ack del alert).
- **Aviso panel** (contador + **sonido**): suena SOLO en **lead caliente (≥0.7)** y **pausa por seguridad (paused_risk)**. (Copiloto-pendiente y desconexión → badge sin sonido.)

## B) #3 Follow-up de cotización abandonada
- Dispara a **~30-45 min** de silencio del cliente.
- **Texto: lo redacta la IA libre** (tono Sara, según contexto de esa conversación).
- Reglas (todas): **máx 1 por cliente** · **solo si hubo precio/oferta concreta** · **nunca si entró un humano** (paused_human) · **solo en franja 12:00-05:00**.
- Cuenta contra el **anti-ban** (es un envío auto: gate + pace + record).

## C) Memoria por cliente
- Recuerda **idioma** + **chica(s) preferida(s)**.
- Scope: **solo dentro del mismo número** (no cruza números).
- Uso **silencioso** (no dice que recuerda).
- **Caduca a ~90 días** sin contacto.

## D) Analyzer → Sara
- **Pista suave**: inyectar la `next_action` sugerida como hint en el prompt; Sara decide si la sigue.

## E) F3 — Calculadora de salida (outcall)
- Ubicación del cliente: **PIN de WhatsApp** (Sara lo pide: "mándame tu ubicación 📍").
- Ruta/distancia: **Valhalla** self-host, **ida y vuelta**.
- Taxi: **tarifa oficial de cada ciudad** (bajada + €/km + €/min), con **tarifa nocturna** cuando aplique.
- **Precio = servicio_salida (fijo por casa) + taxi × 1.20**, **redondeado a 10€**.
- Servicio base de salida: **empezar con el de la web** ("a hotel/domicilio") via sync, **editable**.
- (Sin tope de distancia ni mínimo de salida por ahora.)
