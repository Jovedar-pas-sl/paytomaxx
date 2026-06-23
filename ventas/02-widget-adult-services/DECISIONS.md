# DECISIONS — Decisiones tecnicas y comerciales

> Registro de decisiones importantes y su razon. Si en el futuro alguien (yo mismo en 6 meses) cuestiona "por que se hizo asi", aqui esta la respuesta.

---

## D-001 — Stack: Flask + Claude Haiku, no migracion a otro framework

**Fecha:** mes 0 (heredado)

**Decision:** mantener Flask + Claude Haiku como hoy.

**Por que:**
- Ya esta en produccion en 3 webs facturando
- Coste de IA muy bajo (2-5 EUR/mes con 500 chats/dia)
- Claude Haiku es lo bastante bueno para catalogo cerrado
- Migrar a Node/FastAPI/Go ahora es ganas de romper cosas sin valor

**Cuando reconsiderar:**
- Si Anthropic sube precios x3 o discontinua Haiku
- Si necesitamos streaming en respuestas (Flask sync no escala bien)
- Si llegamos a 50+ clientes y la latencia es problema

---

## D-002 — Cobro por SEPA, no Stripe ni PayPal

**Fecha:** mes 0

**Decision:** todos los cobros recurrentes a clientes adult-services se hacen via SEPA recibo domiciliado. Stripe y PayPal estan prohibidos para nuestro lado (los rechazarian igual si se enteran del sector).

**Por que:**
- Stripe rechaza adult-services explicitamente en sus terminos
- PayPal congela cuentas que detecta del sector con retencion de 180 dias
- SEPA es un esquema bancario europeo, no un PSP privado, no aplica censura sectorial
- Costes SEPA: aprox 0,15-0,40 EUR por cobro, irrelevante a 199 EUR/mes

**Implementacion:**
- Mandato SEPA Core (consumidor) o B2B (empresa) firmado por escrito
- Cuenta empresa con capacidad emisora SEPA (Caixabank, Bankinter Empresa, Cecabank)
- Fichero XML pain.008.001.02 generado mensualmente
- Sin permanencia obligatoria, baja con 30 dias preaviso

**Plan B:**
- Transferencia bancaria mensual manual si el cliente no firma mandato
- Bizum empresa para casos puntuales (pero no recurrente)

**Cuando reconsiderar:**
- Cuando llegamos a 30+ clientes, considerar pasarela tipo GoCardless (que esta especializada en SEPA)

---

## D-003 — Modelo multi-tenant: BD compartida, datos por carpeta

**Fecha:** semana 1 del roadmap

**Decision:** un solo backend Flask sirviendo a N clientes. Cada cliente tiene su carpeta `data/clients/<client_id>/` con su catalogo, su config, sus logs.

**Por que:**
- Simple: no hay que provisionar VPS por cliente
- Barato: 1 servidor de 20 EUR/mes aguanta 30-50 clientes
- Migrable: si un cliente necesita servidor dedicado (plan Premium), copiamos su carpeta y le damos su VPS

**Anti-decision (lo que NO hacemos):**
- NO usamos PostgreSQL multi-tenant con row-level security. Es overkill ahora.
- NO usamos contenedores por cliente. Demasiada infra para tan pocos clientes.
- NO encriptamos los JSON por defecto. Estan en servidor cifrado y eso es suficiente. Si un cliente exige cifrado por fichero, add-on.

**Cuando reconsiderar:**
- 30+ clientes: migrar a PostgreSQL con RLS
- Si entra una casa con requisitos GDPR especiales (ISO 27001 etc.): servidor dedicado obligatorio

---

## D-004 — Idiomas iniciales: ES, EN, FR, IT

**Fecha:** mes 0 (heredado)

**Decision:** los 4 idiomas core son ES, EN, FR, IT.

**Por que:**
- ES: obvio
- EN: extranjeros (americanos, ingleses, holandeses, escandinavos)
- FR: franceses en Catalunya y Costa del Sol
- IT: italianos en toda la costa, especialmente Marbella y Mallorca

**Add-ons disponibles (50 EUR/mes cada uno):**
- DE: alemanes Costa del Sol y Mallorca
- RU: clientela rusa premium (Marbella, Moscu hace decadas que mando turismo)
- AR: clientela del Golfo en Marbella

**Anti-decision:**
- NO incluimos chino mandarin / japones por defecto. Mercado existe pero requiere localizacion cultural profunda, no solo traduccion. Bajo demanda.

---

## D-005 — Aprendizaje automatico: solo para FAQ, no para tarifas

**Fecha:** mes 0

**Decision:** el aprendizaje automatico del bot (analizar conversaciones y sugerir respuestas nuevas) se aplica SOLO a la base de FAQ. Tarifas y catalogo de chicas NO se aprenden automaticamente, los edita siempre el humano del cliente.

**Por que:**
- Si la IA "aprende" que ayer alguien pago 200 EUR y lo mete como tarifa por defecto, la lia
- Las tarifas son responsabilidad del cliente: cualquier error es responsabilidad nuestra si la IA improviso
- Las FAQ (donde aparcar, si aceptamos tarjeta, etc.) si pueden ser dinamicas sin riesgo

**Implementacion:**
- Boton "Analizar conversaciones" en panel admin
- Sugiere FAQs nuevas, el humano aprueba con un click
- Tarifas y chicas: editables solo en panel, JSON versionado, audit log

---

## D-006 — Estetica del widget: tonos oscuros con acento de la casa

**Fecha:** mes 0

**Decision:** el widget tiene tema oscuro por defecto (negro/grafito con acento color marca de la casa). Sin emojis automaticos. Tipografia serif para nombres y sans-serif para cuerpo.

**Por que:**
- El sector usa estetica nocturna premium (oscuro, oro, burdeos, plata)
- Los emojis en bots tipo Tidio quedan infantil y rompen la marca
- Tipografia con personalidad: serif transmite premium

**Estandar visual:**
- Background widget: #0d0d10 (negro suave)
- Acento por defecto: #c9a96e (oro mate)
- Texto: #e8e8e8 (no blanco puro)
- Hover: opacidad/escala, no neon

**Anti-decision:**
- NO ofrecemos tema light por defecto. Si un cliente lo pide, custom.
- NO usamos avatares estilo "asistente virtual con gafas". El widget es el bot de la casa, no un personaje.

---

## D-007 — Marca / nombre comercial del producto

**Fecha:** semana 4 del roadmap

**Decision:** el producto comercial no se llama "Maxxag Chat". Eso es la implementacion para Maxxag. Necesitamos marca propia.

**Opciones evaluadas:**
- **Hostia Chat** — provocador, memorable, sector compatible. Riesgo: bromas faciles, no escalable a otros mercados.
- **Nocturna AI** — premium, ambiguo, escalable. Recomendado.
- **Velvet Widget** — visual, premium, en ingles. Riesgo: ingles puede sonar a SaaS generico.
- **Salon Bot** — claro, descriptivo, sin gracia.

**Decision provisional:** **Nocturna AI** o variante. Confirmar tras testing en landing.

**Dominio a registrar:** nocturna.ai, nocturna-widget.com, o similar.

---

## D-008 — Politica de soporte: WhatsApp del fundador hasta 10 clientes

**Fecha:** mes 0

**Decision:** mientras tengamos menos de 10 clientes activos, el soporte va al WhatsApp del fundador directamente. No ticket system, no zendesk, no helpdesk.

**Por que:**
- Velocidad de respuesta como ventaja competitiva (las casas estan acostumbradas a soporte lento)
- Cada conversacion de soporte es feedback de producto gratis
- 10 clientes = unos 5-15 tickets/semana, manejable a mano

**Cuando cambiar:**
- 10+ clientes: empezar a usar HelpScout, Plain.com o similar
- 20+ clientes: contratar soporte L1 part-time

---

## D-009 — Backup y retencion de datos

**Fecha:** semana 2 del roadmap

**Decision:**
- Backup diario de `data/clients/` a S3 / Backblaze B2
- Retencion: 30 dias de copias diarias + 12 meses de copias mensuales
- Logs de conversacion: 90 dias en BD, despues solo metricas agregadas (anonimas)
- Si cliente se da de baja: export en JSON entregado + borrado completo a los 30 dias

**Por que:**
- GDPR obliga a politica de retencion explicita
- 90 dias en bruto es suficiente para aprendizaje y debugging
- Anonimizar despues protege a los clientes y a nosotros

---

## D-010 — Lo que NO vamos a construir nunca

Por disciplina anti-feature-creep:

- **NO** sistema de pagos del cliente final (eso es proyecto 08)
- **NO** integracion con sistemas de cita medica / sanitaria
- **NO** modo "anonimo" donde el cliente final pueda registrarse (privacidad complicada)
- **NO** marketplace o portal de anuncios (eso es Slumi y similares)
- **NO** verificacion de chicas (no es nuestro rol)
- **NO** firma electronica de contratos cliente-chica (legal complejo)

Si un cliente lo pide, le pasamos contacto del proyecto/proveedor que lo haga, pero nosotros no lo construimos.

---

## D-011 — Estrategia anti-fraude IA

**Fecha:** semana 3 del roadmap

**Decision:** prevenir 3 vectores de ataque conocidos en chatbots IA:

1. **Prompt injection:** un cliente final intenta que el bot diga barbaridades. Mitigacion: system prompt con guardrails, blocklist de patrones de injection, escalado automatico a humano si detectamos intento.
2. **Token drain:** alguien spamea el bot para inflar la factura IA del cliente. Mitigacion: rate limit por IP (60 mensajes/hora), cuota mensual con corte automatico, cache de respuestas frecuentes.
3. **Exfiltracion de catalogo:** competidor pregunta tarifas/catalogo masivamente. Mitigacion: rate limit, captcha invisible si detectamos patron sospechoso, ofuscacion parcial (no responder catalogo completo en 1 mensaje).

---

## D-012 — Garantia 30 dias: solo aplicable a setup, no a IA consumida

**Fecha:** mes 0

**Decision:** la garantia de 30 dias devuelve la cuota mensual si no hay mejora en conversaciones de WhatsApp. Pero el coste real de la IA consumida durante el periodo no se devuelve (lo absorbemos nosotros como coste de adquisicion).

**Por que:**
- Si devolviesemos todo perderiamos dinero en cliente que prueba y se va
- Si no devolviesemos nada, no habria garantia real
- Compromiso: devolvemos lo que el cliente pago (cuota), pero no compensamos el coste IA porque eso es nuestro

**Limite:** si el cliente consume mas del 200% de la cuota (6.000 conversaciones en plan Pro), la garantia se anula porque entendemos que el widget si funciono.
