# Primer cliente — plan de captación

## Estrategia

1. **Convertir Maxxag de "uso interno" a "cliente formalizado"** → da credibilidad, factura recurrente, y aprende el flujo de billing real con un cliente "amigo".
2. **3 betas externas** del mismo perímetro (casas con 3+ líneas, en España, sector legal adult-services) en los siguientes 60 días, con descuento 50 % a cambio de testimonio.
3. **Programa de referidos** desde el día 1 (10 % descuento permanente).

---

## Parte A — Convertir Maxxag a cliente formal

### Por qué tiene sentido

Maxxag ya está usando WA-Ops a diario en operaciones internas. Hoy es un coste oculto (yo lo mantengo gratis). Formalizar:
- Crea **una factura recurrente real** que valida el modelo de pricing
- Convierte a Maxxag en **caso de estudio público** ("una casa con 4 líneas usa esto desde hace X meses")
- Permite separar mentalmente "este es mi cliente" del "este es mi proyecto"
- Genera ingresos para reinvertir en desarrollo

### Guion conversación con Mehdi (dueño Maxxag)

> "Mehdi, hablamos de formalizar lo del dashboard. Lo que llevamos usando en Maxxag desde hace meses es exactamente lo que voy a empezar a vender a otras casas. Mi propuesta:
>
> 1. Maxxag pasa a ser **cliente número 1** con factura mensual normal.
> 2. Al ser fundador-cliente, te aplico **tarifa de socio fundador** indefinida: 50 % de Starter durante 24 meses → **75 €/línea/mes** en lugar de 149, y **setup 0 €** (ya está instalado).
> 3. A cambio, Maxxag aparece en mi web como caso de estudio (con tu permiso de qué se cuenta y qué no), y tú me das **5 testimonios cortos** que pueda usar comercialmente.
> 4. Lo gestiono yo igual que hasta ahora — no cambia nada operativamente. Lo único que cambia: tienes tu propia factura legal mensual, ves la subscripción en tu portal Stripe, y sabes que el servicio tiene continuidad incluso si yo me vuelvo a Tombuctú.
>
> Con 4 líneas son **300 €/mes**. Si en 24 meses Maxxag escala a 8 líneas, sigues a 75 €/línea aunque haya subido la tarifa pública. ¿Lo cerramos esta semana?"

### Pasos operativos

- [ ] Crear cuenta Stripe para casa Maxxag
- [ ] Generar contrato simple (PDF, 2 páginas): servicio, precio, RGPD, SLA, terminación
- [ ] Activar subscripción Starter Socio-Fundador (75 € × 4 líneas = 300 €/mes)
- [ ] Pedir a Mehdi 5 frases-testimonio en audio o texto (no piden datos reales de clientes, solo experiencia con la herramienta)
- [ ] Grabar **demo en vídeo (90 s)** con datos reales anonimizados del workspace Maxxag (caras blureadas, números tachados, mensajes redactados)

---

## Parte B — Email frío a otras casas

### Lista inicial (objetivo: 30 casas en 2 semanas)

Criterios:
- España, sector adult-services legal
- 3+ líneas WhatsApp visibles en su web o publicidad
- Tienen web activa (no solo perfiles redes)
- Idealmente en Madrid, Barcelona, Valencia, Marbella, Bilbao (replicar geografía Maxxag plugin)

### Email frío v1 — "el problema del móvil"

**Asunto:** Cómo Maxxag (Madrid) sacó WhatsApp de los móviles personales

---

> Hola [nombre del responsable si lo sabemos, "equipo" si no],
>
> Vi que [Nombre Casa] gestiona [N] números de WhatsApp entre [recepción/reservas/VIP]. Si funcionáis como la mayoría del sector, esos números están en móviles personales y no tenéis forma fácil de saber cuánto tarda cada recepcionista en contestar, qué clientes están calientes, ni quién es timewaster.
>
> Llevo 6 meses construyendo un dashboard web para resolver exactamente eso, y lo tengo funcionando 24/7 en una casa de Madrid (Maxxag — Mehdi puede confirmar si os interesa contrastar).
>
> En 90 segundos:
>
> 👉 [Link al vídeo demo]
>
> Si os parece interesante, ofrezco programa beta de 30 días a mitad de precio. Sin tarjeta hasta el día 1. Sin permanencia. Si en 30 días no veis valor, no continuáis y borramos todo de vuestro VPS.
>
> ¿Os llamo 15 minutos esta semana?
>
> — [Nombre]
> [WhatsApp directo] · [email]
> *Detrás del proyecto Maxxag Madrid/Marbella/Valencia/Ibiza*

---

### Email frío v2 — "el problema de los menores"

> *(Variante para casas conocidas por ser estrictas con cumplimiento)*
>
> Asunto: Detección automática de menores en vuestro inbox WhatsApp
>
> Hola,
>
> Una de las cosas que más me preocupó al construir un dashboard de WhatsApp para casas es que un menor entre en un chat y nadie lo detecte a tiempo. Por eso lo primero que añadimos al sistema fue una **IA que escanea cada conversación y dispara una alerta inmediata si detecta señales de menor de edad** (edad mencionada, lenguaje, contexto).
>
> Si os interesa cómo lo hacemos (sin reenviar nada a terceros, todo en vuestro propio servidor), llamo 15 min.
>
> [Link al vídeo demo + link a página técnica RGPD]

---

### Seguimiento (cadencia)

- Día 0: Email v1 o v2 según target
- Día 4: WhatsApp directo "te pasé un email el lunes, ¿te llegó?"
- Día 10: Email v2 (la otra variante)
- Día 21: Cierre — "última vez que escribo, si te interesa más adelante avísame"

Objetivo realista: **15 % open response, 5 % calls booked, 2 cierres de beta de 30 casas**.

---

## Parte C — Programa beta-tester

Para los 3 primeros clientes externos que firman antes de que la landing tenga signup automático:

**Oferta beta:**
- 30 días al 50 %: **Setup 250 €** + **75 €/línea/mes** (Starter)
- Día 31: tarifa normal salvo cancelación con 5 días de aviso
- Sin tarjeta hasta el día 1 (envío link Stripe Checkout día 28)
- **Soporte WhatsApp directo conmigo** durante la beta
- A cambio: pueden ser referencia llamable por futuros prospects y firmar testimonio escrito

**Compromisos por mi parte:**
- Setup en 48 h desde firma
- 1 sesión coaching de 30 min revisando con el dueño los primeros análisis (día 7)
- 1 informe de pre-cierre (día 25) con métricas reales del primer mes

**Selección:** máx 3 betas activas a la vez. Si llega un cuarto, va a lista de espera (genera escasez real, no fingida).

---

## Métricas a vigilar primer trimestre

- N° emails enviados / N° respuestas / N° calls / N° propuestas / N° cierres
- MRR mes 1, mes 2, mes 3
- Coste Claude por casa-mes (debe rondar 15-25 €, presupuesto incluido en tarifa)
- Tickets de soporte por casa-mes (cap mental: <8/mes; si más, hay un problema de producto)
- Churn 30/60/90 días
