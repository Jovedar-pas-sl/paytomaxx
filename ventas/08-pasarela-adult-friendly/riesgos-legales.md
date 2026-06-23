# Riesgos legales y regulatorios

> Este documento es de lectura obligatoria interna **antes** de prometer nada a un cliente, firmar contrato sub-merchant con Cecabank, o publicar landing comercial.
>
> Contiene incertidumbres reales no resueltas. No es marketing. No oculta nada.

---

## 1. La pregunta más importante: ¿qué somos legalmente?

España regula los servicios de pago bajo la **PSD2 (Directiva 2015/2366)**, transpuesta como **RDL 19/2018**. El **Banco de España** y **SEPBLAC** supervisan.

Modelos posibles para nuestro proyecto:

### Opción A — Introductor / business introducer / agente comercial puro

- **Qué hacemos:** presentamos clientes a Cecabank. El contrato sub-merchant es directo Cecabank ↔ cliente. Nuestra remuneración es comisión comercial / SaaS por el panel.
- **Riesgo regulatorio:** bajo, si no movemos fondos del cliente final ni del sub-merchant.
- **Trampa típica:** si las liquidaciones pasan por una cuenta nuestra antes de llegar al sub-merchant, ya no somos introductor, somos PSP de facto. Eso requiere licencia. Hay que diseñar el flujo para que **el dinero vaya de Cecabank directo al IBAN del sub-merchant** sin pasar por nosotros.
- **Estado:** hipótesis preferida para empezar. **NO confirmada con abogado.**

### Opción B — Agente de pago de un PSP autorizado

- **Qué hacemos:** somos agente registrado de Cecabank ante el Banco de España.
- **Pros:** figura clara, comunicable a clientes y adquirente.
- **Contras:** requiere alta como agente en el registro del Banco de España; proceso meses; Cecabank debe querer registrarnos como agente suyo (no es automático).

### Opción C — EMI propio (Entidad de Dinero Electrónico)

- **Qué hacemos:** licencia EMI Banco de España.
- **Capital mínimo:** **350.000 €**.
- **Tiempo:** 9-18 meses.
- **Útil cuando:** queremos liquidaciones a través de cuenta propia, emitir tarjetas, abrir IBANs.
- **Hoy:** **fuera de alcance** para el piloto.

### Opción D — Sub-distribuidor de un PSP existente

- **Qué hacemos:** revendemos un PSP español (MONEI, Bizum integrator) con marca blanca.
- **Pros:** rápido.
- **Contras:** dependencia total del PSP, márgenes finos.

**Bloqueante hasta semana 2 del roadmap:** **decisión asistida por abogado fintech.** No avanzar a contrato Cecabank ni a captación pública sin esto.

---

## 2. Quién responde de qué

### Frente al adquirente (Cecabank)

- El sub-merchant agreement es entre **Cecabank y el cliente final**, no entre Cecabank y nosotros. Nosotros somos figura intermedia (introductor o agente).
- Cecabank responde ante esquemas (Visa / Mastercard) por todo el portfolio agregado.
- Si un sub-merchant nuestro genera abuso o fraude que pone en riesgo el portfolio, Cecabank puede cerrarnos **todo** el grupo, no solo a ese cliente.

### Frente a Visa / Mastercard

- Programas de monitoring (Visa VAMP, Mastercard ECM) miden chargeback ratio del portfolio agregado.
- Umbrales históricos: 0,9 % chargeback ratio activa monitoring, multas a partir de cierto threshold.
- Riesgo: un sub-merchant con MCC 7273 mal gestionado puede pasar nuestro portfolio entero a monitoring.

### Frente a SEPBLAC

- AML/KYC del sub-merchant es responsabilidad del sujeto obligado.
- Quién es sujeto obligado depende de ADR-003 (figura legal nuestra):
  - Si introductor puro: el sujeto obligado es Cecabank y el sub-merchant.
  - Si agente de pago: somos co-responsables.
- Reporte transacciones sospechosas: canal vía Cecabank inicialmente; si somos agente, también nosotros directamente.

### Frente al cliente final del sub-merchant (consumidor)

- El consumidor compra al sub-merchant. Su relación contractual es con él.
- Devoluciones / chargebacks / reclamaciones de consumo (Ley General DCU): contra el sub-merchant.
- Nosotros aparecemos solo si Cecabank, sub-merchant y consumidor no resuelven y escala.

### Frente al cumplimiento sectorial del sub-merchant

- **Mayoría de edad** en servicios para adultos: responsabilidad del sub-merchant. Pedimos en KYB declaración + procedimiento documentado.
- **Licencia DGOJ** en juego: indispensable, no entramos sin ella.
- **Licencia Comisionado Mercado de Tabacos** en tabaco online: indispensable.
- **Licencia municipal** en clubes / ocio: indispensable.
- Si descubrimos que falsean licencia: suspensión inmediata + notificación Cecabank.

---

## 3. PCI-DSS

### SAQ A (escenario por defecto nuestro)

- El cliente paga en la página hosted de Cecabank.
- Ni nosotros ni el sub-merchant tocamos datos de tarjeta.
- Cumplimiento PCI: completar SAQ A anualmente. Es el más simple.
- Hosting estándar es suficiente con buenas prácticas (TLS 1.2+, secret management, logs sin PCI data).

### SAQ A-EP (si tokenizamos / personalizamos checkout)

- Si en el futuro hacemos checkout custom (no hosted), aumentamos a SAQ A-EP.
- Hosting tiene que ser PCI-DSS compliant (AWS con SAQ A-EP attestation, OVH PCI hosting).
- Pentest anual, escaneos ASV trimestrales.
- **Recomendación:** quedarnos en SAQ A todo lo posible. Solo subir si negocio lo exige.

### SAQ D (si almacenamos PAN)

- **Nunca.** No hay caso de uso justificado para almacenar PAN. Si aparece, decir no.

---

## 4. Aspectos legales del sub-merchant agreement

Cláusulas que nosotros (o Cecabank a través nuestra) **debemos** incluir:

- Declaración expresa del sector y MCC.
- Compromiso de licencias sectoriales vigentes.
- KYC del cliente final del sub-merchant.
- Política de mayoría de edad y verificación si aplica.
- Política de devoluciones publicada en la web del sub-merchant.
- Aceptación de monitoring de tasa de chargebacks.
- Reserva de garantía 5-10 % durante 90 días.
- Causas de suspensión inmediata (fraude, licencia caducada, abuso, no respuesta a KYB).
- Jurisdicción española.
- Protección de datos: nosotros somos encargado, sub-merchant es responsable. DPA firmado.

---

## 5. Riesgos específicos identificados

### Riesgo 1 — Cecabank cierra el portfolio entero

**Probabilidad:** media (alta si gestionamos mal el KYB).
**Impacto:** crítico — fin del negocio.
**Mitigación:** KYB serio, no transigir en licencias, monitorización tasa chargeback agresiva, política de exclusión rápida, mantener plan B activo.

### Riesgo 2 — Banco de España requiere licencia que no tenemos

**Probabilidad:** alta si operamos como agregador moviendo fondos sin licencia.
**Impacto:** crítico — sanción + cierre.
**Mitigación:** flujo diseñado para que nosotros **no toquemos fondos**; abogado fintech valida arquitectura antes de producción.

### Riesgo 3 — Sub-merchant comete fraude / lavado

**Probabilidad:** baja con KYB serio.
**Impacto:** alto — responsabilidad ante SEPBLAC, posible cierre Cecabank.
**Mitigación:** KYB documental + verificación cruzada + monitorización transaccional + reporte de sospecha en cuanto se detecte.

### Riesgo 4 — Cambio regulatorio (PSD3 / instant payments regulation)

**Probabilidad:** alta a 24-36 meses.
**Impacto:** medio — obliga a adaptaciones (verificación de payee, etc.).
**Mitigación:** suscribirse a alertas Banco de España, mantener arquitectura modular.

### Riesgo 5 — Esquema (Visa/Mastercard) cambia política sobre MCC adult

**Probabilidad:** baja a corto plazo, no es nuevo.
**Impacto:** crítico — puede eliminar viabilidad.
**Mitigación:** diversificar verticales (no quedarnos solo en adult), tener producto generalista.

### Riesgo 6 — Reputacional

**Probabilidad:** media — sector con stigma.
**Impacto:** medio — afecta hiring, partners bancarios, prensa.
**Mitigación:** posicionamiento fintech sobrio (no adult), comunicación pública responsable, clientes seleccionados.

### Riesgo 7 — Nosotros desaparecemos / quiebra

**Probabilidad:** baja-media en startup.
**Impacto:** alto para el cliente.
**Mitigación:** sub-merchant agreement Cecabank↔cliente directo; escrow del software del panel; documentación operativa exportable.

---

## 6. Lo que **no** vamos a hacer

- No movemos fondos del consumidor o del sub-merchant en cuentas nuestras sin licencia EMI.
- No prometemos tasas de aceptación que no podemos garantizar.
- No ocultamos al cliente que opera bajo Cecabank.
- No firmamos sub-merchant agreement sin licencia sectorial vigente.
- No trabajamos con cualquier MCC adult — ver ADR-004 en `DECISIONS.md`.
- No publicamos comercialización pública hasta haber completado validación legal (semana 2-3 del roadmap).

---

## 7. Lo que **sí** decimos al cliente

- "Esto requiere KYB serio. Si no lo pasáis, no operáis."
- "La tarifa puede subir si vuestra tasa de chargebacks sube."
- "Cecabank puede cerrar el contrato si hay incumplimiento. Nosotros no podemos forzar a Cecabank."
- "Vuestra responsabilidad sectorial (licencias, mayoría de edad, AML del cliente final) es vuestra. Nosotros somos la pasarela técnica."
- "Para salir del piloto cualquier día con 7 días de aviso, datos exportables."

---

## 8. Checklist antes de operar comercialmente

- [ ] Abogado fintech contratado y figura legal nuestra decidida.
- [ ] Documento legal del proyecto: contrato cliente-nuestro revisado.
- [ ] Sub-merchant agreement Cecabank revisado por abogado.
- [ ] Modelo flujo de fondos validado: no tocamos dinero.
- [ ] Política AML / KYB documentada.
- [ ] Procedimiento KYB del sub-merchant operativo.
- [ ] Procedimiento de monitorización transaccional operativo.
- [ ] Procedimiento de suspensión documentado.
- [ ] SAQ A completado.
- [ ] DPA con sub-merchants tipo redactado.
- [ ] Aviso legal, condiciones generales y política de privacidad publicadas.
- [ ] Política de devoluciones y disputas del operador publicada.
- [ ] Seguro de responsabilidad civil profesional contratado.

**Sin completar este checklist, no se firma con ningún cliente real.**
