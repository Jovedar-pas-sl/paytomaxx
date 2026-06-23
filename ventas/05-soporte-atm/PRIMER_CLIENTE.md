# PRIMER CLIENTE — Operador ancla y outbound piloto

Documento operativo para cerrar al cliente ancla (operador actual con 50+ máquinas Fujitsu F53 ya en `shared_db.json`) y para abrir conversaciones con 10 operadores ATM en España.

---

## 1. Cliente ancla: contexto

Tenemos ya:

- Inventario digital de **50+ máquinas Fujitsu F53** en `shared_db.json`.
- Histórico de incidencias real reportado en `whatsapp_analyzer/reports/` (88 conversaciones analizadas en último informe).
- Manuales Fujitsu F53 indexados.
- Canal WhatsApp ya operativo (Evolution API + Chatwoot).
- Dashboard funcionando (`sistema_atm.html`).

**Lo que falta:** convertir esa relación informal en contrato con SLA, facturación mensual, KPIs medibles y proyección de crecimiento.

---

## 2. Guion para la reunión con el operador ancla

### 2.1 Apertura (5 min)
> "Llevamos meses dando soporte de hecho: cuando hay un atasco en RSR8 o un problema en Tropicana Cieza, lo resolvemos. Ya hay 88 conversaciones analizadas, ya hay un inventario digital, ya hay manuales. Lo que propongo es formalizar lo que ya hacemos en un contrato con SLA, factura mensual y un dashboard donde veas tú mismo qué estamos resolviendo."

### 2.2 Lo que cambia para él (10 min)
- **No cambia el día a día:** mismo canal WhatsApp, mismas personas atendiendo, misma calidad técnica.
- **Sí cambia:**
  - Factura mensual previsible en lugar de avisos sueltos por intervenciones.
  - SLA contractual — si fallamos, descuento o salida.
  - Dashboard accesible: él mira el estado de su flota cuando quiera.
  - Informe mensual con análisis (qué máquinas dan más problemas, qué patrones se repiten, qué mantenimiento preventivo conviene).
  - Mantenimiento preventivo programado: menos averías en hora punta.

### 2.3 Propuesta económica (10 min)
**Tarifa fundador para él** (50+ máquinas, ya cliente de facto):

| Concepto                       | Tarifa estándar | Tarifa fundador |
|--------------------------------|-----------------|-----------------|
| Tier Estándar (precio base)    | 55 €/máq/mes    | **42 €/máq/mes** |
| Intervención presencial extra  | 120 €           | **95 €**         |
| Mantenimiento preventivo extra | 80 €/máq/visita | **65 €**         |

Bloqueo de tarifa: **24 meses.**
Permanencia: **12 meses.**

Cálculo con 50 máquinas: **2.100 €/mes** = 25.200 €/año.
Comparado con el coste actual real que paga (a estimar con él en la reunión) — habitualmente ese coste oscila entre 30k-50k al año si suma técnicos puntuales + tiempo de máquina parada + descuadres no detectados.

### 2.4 Lo que pedimos a cambio (5 min)
- Firma de contrato a 12 meses.
- Domiciliación SEPA.
- Permiso para usarlo como caso de uso público (anónimo si lo prefiere).
- Una llamada quincenal el primer trimestre para ajustar SLAs reales a su operación.

### 2.5 Próximos pasos (5 min)
- Le mandamos contrato en 48h.
- Firma electrónica.
- Inicio facturación primer mes natural completo siguiente.
- Anuncio interno a sus encargados de locales (no cambia su flujo).

---

## 3. Manejo de objeciones específicas del ancla

### "Ya os pago lo que cobráis sin contrato. ¿Por qué firmar?"
> Porque sin contrato no podemos invertir en ti: no contratamos técnico de zona dedicado, no compramos manuales de las marcas que vas a ir incorporando, no metemos guardia 24/7. Y porque a ti te interesa el SLA escrito: el día que algo falle de verdad, hoy tu única garantía es la confianza personal. Mañana es un papel firmado.

### "El precio fundador me parece justo pero no quiero permanencia."
> Permanencia 6 meses en lugar de 12, manteniendo tarifa fundador. Si quieres salir, salida con 60 días de aviso. Es razonable porque la masa la construimos contigo.

### "¿Y si yo bajo de 50 máquinas?"
> El precio por máquina se mantiene. Si bajas de 30 máquinas, te subimos a la tarifa estándar (55 €). Si bajas de 10, salimos del contrato sin penalización porque ya no encajas en el modelo.

### "Si firmo ahora, ¿qué mejora ya en el mes 1?"
> Tres cosas concretas el primer mes:
> 1. Dashboard activo donde ves estado de cada máquina y cada incidencia abierta.
> 2. Informe mensual con análisis de las 88 conversaciones (mantenimiento preventivo basado en datos reales).
> 3. SLA escrito: si no te respondemos en X minutos, descuento.

---

## 4. Outbound: email a 10 operadores ATM en España

### 4.1 Perfil objetivo
- Operadores con **flota propia de 10-100 máquinas** (NO bancos, NO redes grandes tipo Euronet — esos tienen contrato OEM).
- Sectores prioritarios:
  - **Cash-in-shop / redes ATM privadas** (operadores independientes).
  - **Gasolineras** con cajero (Repsol, Cepsa, BP en franquicia).
  - **Ocio nocturno** con cajero propio (discotecas, locales de copas, after-hours).
  - **Hostelería** de alto volumen turístico (chiringuitos costa, hoteles independientes).
  - **Centros comerciales pequeños** con cajero propio.
  - **Salones de juego / bingos / casinos** privados.

### 4.2 Fuentes de leads
- Bases de datos sectoriales: **AEMER** (Asociación Española de Máquinas Recreativas), **FAEMCR**, **FACOMARE**.
- Búsqueda directa en Google Maps: "cajero automático [ciudad]" + verificar marca/modelo en fotos.
- LinkedIn Sales Navigator: filtro empresa "ATM operator" + tamaño 10-50 empleados España.
- Ferias del sector: **EXPO RECREATIVOS Madrid** (febrero), **OcioGame**.
- Referidos del cliente ancla (probablemente conoce a 3-5 colegas del sector).

### 4.3 Email frío — Versión A (corto, directo)

**Asunto:** Soporte técnico ATM con SLA — propuesta para [empresa]

**Cuerpo:**
> Hola [Nombre],
>
> Soy [Tu nombre], de [Empresa]. Damos soporte técnico gestionado a operadores de cajeros con flota propia (10-100 máquinas).
>
> Probablemente hoy resolvéis incidencias así: encargado del local llama, técnico va si está libre, factura por intervención. Con nosotros: canal WhatsApp dedicado, respuesta en minutos con SLA, intervención presencial bajo contrato. **Desde 39 €/máquina/mes.**
>
> En menos de un año hemos digitalizado todos los manuales técnicos de Fujitsu F53, integrado IA para diagnóstico instantáneo y montado red de técnicos en Madrid, Barcelona y Levante. Damos servicio a un operador con 50+ máquinas que firmará contrato este mes.
>
> ¿Te encaja una llamada de 20 minutos esta semana o la siguiente? Si después no te interesa, no te molestamos más.
>
> Saludos,
> [Tu nombre]
> [Teléfono] · [WhatsApp] · [Email]

### 4.4 Email frío — Versión B (con dato técnico que demuestra conocimiento)

**Asunto:** ¿Vuestros F53 también pierden "banderas" cada semana?

**Cuerpo:**
> Hola [Nombre],
>
> Vi que [empresa] opera cajeros [Fujitsu/Wincor/NCR — verificar antes]. Si trabajáis con F53, probablemente conocéis el problema de pérdida de banderas/flags que aparece en algunas máquinas: el cajero queda sin operar hasta reset manual.
>
> Tenemos protocolo documentado para resolverlo en remoto en menos de 5 minutos vía WhatsApp con el encargado del local, sin desplazar técnico. Y lo mismo para atascos de billetes, fallos del pinpad PAX IM30, problemas de comunicación con TPV, descuadres de dispensación.
>
> Damos soporte gestionado a operadores con 10-100 máquinas: retainer mensual + intervención presencial bajo SLA. Desde 39 €/máquina/mes.
>
> ¿Te llamo 15 minutos para enseñarte el dashboard que damos al cliente?
>
> [Firma]

### 4.5 Follow-up (a los 5 días sin respuesta)

**Asunto:** Re: Soporte técnico ATM (último intento)

**Cuerpo:**
> Hola [Nombre],
>
> Te escribí la semana pasada sobre soporte técnico para vuestra flota de cajeros. No quiero ser pesado: ¿es tema de momento (timing) o no encaja con vuestra operativa?
>
> Si no encaja, dímelo y te dejo en paz. Si es timing, te vuelvo a escribir en 3 meses.
>
> Saludos,
> [Tu nombre]

### 4.6 Plantilla de WhatsApp (cuando hay número)

> Hola [Nombre], soy [Tu nombre], te escribí hace unos días sobre soporte técnico para vuestros cajeros. ¿Te encaja una llamada rápida de 15 min esta semana? Si no te interesa, sin problema, me lo dices y no insisto.

---

## 5. Pipeline y métricas outbound

| Etapa                          | Conversión esperada | Volumen objetivo (mes 1) |
|--------------------------------|---------------------|--------------------------|
| Emails enviados                | —                   | 30                       |
| Respuesta (positiva o negativa)| 25%                 | 7-8                      |
| Discovery call agendada        | 50% de respuestas   | 4-5                      |
| Demo aceptada                  | 50% de discovery    | 2-3                      |
| Contrato firmado               | 50% de demos        | 1-2                      |

Stretch: **2 contratos firmados** además del ancla en los primeros 60 días.

---

## 6. Materiales que necesita el comercial

- [x] One-pager (en `SALES.md` sección 2).
- [x] Tiers y precios (`SALES.md` sección 1).
- [x] 10 objeciones (`SALES.md` sección 3).
- [ ] **Deck de 12 slides** → `pitch.md` (siguiente entregable).
- [ ] Demo en vídeo de 3 min mostrando manual_browser, WhatsApp ticket, dashboard.
- [ ] Caso de uso del cliente ancla anonimizado (post-firma).
- [ ] PDF de propuesta personalizable con datos del prospect.
