# Decisiones

Registro de decisiones de producto, negocio y arquitectura. Estilo ADR ligero: contexto, decisión, consecuencias.

---

## ADR-001 — Adquirente principal: Cecabank/Wipay

**Contexto:** necesitamos un adquirente español que tolere MCCs sensibles con sub-aggregation. Opciones evaluadas: Cecabank/Wipay, Banc Sabadell, Caixabank Comercio, Redsys vía banco emisor amigable, MONEI, Bizum integradores.

**Decisión:** Cecabank/Wipay como adquirente principal del piloto.

**Razones:**
- Integración técnica ya construida y en producción (NightPay `WipayAdapter`).
- Cecabank tiene reputación de tolerar MCCs que otros rechazan, caso a caso.
- Manual TPV Virtual 8.25 + Consulta Estado 4.0 son robustos y documentados.
- Soporte de webhook on-line, 3-D Secure, refunds nativos.

**Consecuencias:**
- Dependencia de adquirente único: si Cecabank rechaza nuestros MCCs, plan B obligatorio.
- Negociación de tarifa interna pendiente.
- Aún sin validación comercial formal con responsable Cecabank para sub-aggregation en MCCs sensibles.

**Estado:** **Provisional**. Confirmación en semana 1 del roadmap (ver `ROADMAP.md`).

---

## ADR-002 — Plan B de adquirencia

**Contexto:** riesgo de que Cecabank no acepte el modelo en MCCs sensibles, o que cambie política a mitad de operación.

**Decisión:** mantener pista B activa en paralelo. Orden de prioridad:

1. **Banc Sabadell merchant services** — buena tradición con sectores nicho, EUR local.
2. **Caixabank Comercio** — adquirente fuerte España, MCC más restrictivo pero negociable a volumen.
3. **MONEI** — PSP español moderno, multi-adquirente bajo el capó. Buen API. Soporte high-risk limitado pero abre conversación.
4. **Redsys vía banco emisor amigable** — todos los bancos españoles operan sobre Redsys; el adquirente decide la política, no Redsys. Útil si conseguimos un banco mediano dispuesto.
5. **Adquirente extranjero europeo** — Worldline EU, Adyen EU. Posible pero pierde la ventaja de "local".

**Consecuencias:** mantener 4-8 h/mes de exploración comercial paralela hasta consolidar Cecabank.

**Estado:** activo.

---

## ADR-003 — Figura legal nuestra

**Contexto:** la figura legal nuestra (introductor, agente de pago, EMI, PSP autorizado) condiciona todo: licencias, capital, responsabilidades, qué podemos contratar, cómo facturamos.

**Opciones:**

| Figura | Pros | Contras |
|---|---|---|
| Introductor / agregador no regulado | Rápido, sin licencia | Cecabank puede no aceptar, riesgo regulatorio |
| Agente de pago registrado | Más solidez ante adquirente | Requiere alta SEPBLAC y proceso meses |
| EMI propio | Máxima libertad | Capital mínimo 350 k €, 6-12 meses |
| Sub-distribuidor de un PSP existente | Más rápido | Dependencia total del PSP |

**Decisión:** **pendiente** hasta semana 2 del roadmap (validación legal con abogado fintech). Hipótesis de salida: empezar como introductor / Master Merchant si Cecabank lo permite; transitar a agente de pago en 12 meses si el negocio crece.

**Estado:** **NO DECIDIDA**. Bloqueante para producción.

---

## ADR-004 — MCCs que entran en el piloto

**Decisión:**

**Sí entran:**
- 7273 (servicios para adultos) si negocio constituido legalmente, licencia municipal vigente, KYB serio.
- 5969 (sex-shops online no-servicio).
- 5812 / 7299 (clubes privados, ocio nocturno premium).

**Caso a caso (validación adicional):**
- 7995 (juego) — solo si licencia DGOJ vigente.
- 5912 (CBD / cannabis legal) — solo si producto cumple normativa actual ES.
- 5993 (tabaco) — solo si estanco o e-commerce con licencia Comisionado Mercado de Tabacos.

**No entran:**
- Escorts independientes sin estructura societaria.
- Cam-sites sin verificación de edad robusta probada.
- Cualquier servicio cuya legalidad en España sea controvertida o esté en zona gris.
- Clientes que no superen un KYB básico.

**Razones:**
- Limitar exposición regulatoria del proyecto en su fase inicial.
- Maximizar probabilidad de aceptación por Cecabank.
- Sentido común reputacional.

**Estado:** activo.

---

## ADR-005 — Política de devoluciones y chargebacks

**Decisión:**

- **Refunds parciales y totales:** disponibles desde panel sub-merchant en un clic, hasta 180 días desde el cobro.
- **Chargebacks:** 25 € por chargeback recibido cargados al sub-merchant.
- **Umbrales tasa chargeback:**
  - < 0,5 %: normal.
  - 0,5 % – 0,7 %: aviso interno + revisión 3-D Secure y antifraude.
  - 0,7 % – 0,9 %: aviso formal al cliente + plan de acción.
  - > 0,9 % trimestral: revisión contractual, posible suspensión.
- **Reserva de garantía:** 5 – 10 % de volumen mensual durante 90 días, liberable según historial.

**Razones:** estos números son estándar high-risk. Adquirente impone tipo similares.

**Estado:** activo.

---

## ADR-006 — Stack técnico: reutilizar NightPay

**Decisión:** la pasarela aplicación es **NightPay con modo "PSP for hire"**.

- Multi-tenant ya implementado.
- Adapter `WipayAdapter` en producción.
- FSM de pago, webhook idempotente, circuit breaker, refunds: implementados.
- Falta construir: onboarding sub-merchant guiado, panel disputas, reporting fiscal, panel admin grupo.

**Alternativa rechazada:** construir desde cero o adoptar Apache Fineract / similar. Reinvertir en NightPay aprovecha 6+ meses de trabajo y mantiene un único codebase.

**Consecuencias:**
- NightPay deja de ser solo "cobro QR ocio nocturno" y pasa a ser plataforma de pagos multi-vertical. Hay que reflejarlo en branding interno y documentación.
- Tests y CI tienen que distinguir contextos (NightPay-ocio vs Adult-pasarela).

**Estado:** activo.

---

## ADR-007 — Branding del producto

**Contexto:** el producto necesita un nombre comercial sobrio (fintech, no adult).

**Opciones evaluadas:** Cecapay (conflicto con Cecabank), Iberipay, Adpay (mal), NocheCobra (NO, suena cripto cutre), Yieldpay, PorPay, Casalbero, Whitecollar Payments.

**Decisión:** **pendiente**. Naming a decidir en semana 4. Working name interno: `pasarela-08`. Para landing usar genérico **"Pasarela de Pago Adult-Friendly"** hasta tener nombre definitivo.

**Estado:** **NO DECIDIDA**.

---

## ADR-008 — KYB y AML del sub-merchant

**Decisión:**

- KYB del sub-merchant siempre nuestro, no delegable, antes de activar el contrato Cecabank.
- Documentos obligatorios:
  - Escritura de constitución + CIF.
  - Titularidad real (UBO) declarada y verificada.
  - Cuentas anuales del último ejercicio o declaración de actividad si < 1 año.
  - Licencia sectorial vigente (DGOJ / Comisionado Tabacos / municipal según caso).
  - Declaración responsable sobre destino de fondos y sector.
- Verificación cruzada con bases públicas (Registro Mercantil, BORME).
- Renovación anual de documentos sectoriales.
- Monitorización transaccional con umbrales por sub-merchant (semana 6 roadmap).
- Reporte SEPBLAC según figura legal final (ver ADR-003).

**Estado:** activo, pero detalle de procedimientos AML pendiente de ADR-003.
