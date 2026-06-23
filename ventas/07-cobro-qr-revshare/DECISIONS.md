# DECISIONS — registro de decisiones clave del modelo RevShare

Cada decision: contexto, opciones consideradas, decision tomada, razon, fecha.
Decisiones bloqueantes para commercial-launch en negrita.

---

## D1 — Threshold minimo de volumen para aceptar cliente RevShare **[BLOQUEANTE]**

**Contexto:** no queremos firmar locales que procesen <500 €/mes porque el coste
operacional (servidor, soporte, factura, gestion SEPA) no se cubre con la comision.

**Opciones:**
- A) Threshold absoluto 5.000 €/mes (rechazar si menos)
- B) Threshold soft 5.000 €/mes con periodo gracia 2 meses
- C) Sin threshold, aceptamos todo
- D) Threshold variable por tier (high=100k, estandar=10k, premium=5k)

**Decision:** **B — threshold soft 5.000 €/mes con periodo de gracia 2 meses**.

**Razon:**
- Cobertura realista de costes operacionales: ~50 €/mes/cliente (server share + soporte + factura electronica).
- Comision sobre 5k = 50 € + fee fijo ~20 € = 70 €/mes (cubre 50 € coste + 20 € margen minimo).
- 2 meses de gracia permite que locales pequeños o nuevos arranquen sin presion. Si tras 2 meses estan <5k, conversacion "te paso a SaaS 199 €/mes o cerramos cuenta".
- C eliminado porque comision sobre 1k = 10 €/mes; perdida operativa.
- D demasiado complejo, dificil de explicar al comercial.

**Fecha:** 2026-05-26.

---

## D2 — Clausula exit del contrato **[BLOQUEANTE]**

**Contexto:** el operador necesita sentir que puede irse sin penalizacion. Nosotros
necesitamos cubrir el coste de setup invisible (8-12 h trabajo onboarding tecnico).

**Opciones:**
- A) Exit libre desde dia 1 con 30 dias preaviso
- B) Permanencia 3 meses, despues exit con 30 dias preaviso
- C) Permanencia 6 meses, despues exit con 60 dias preaviso
- D) Sin permanencia pero penalizacion fija (300 €) si sale antes de mes 3

**Decision:** **B — permanencia 3 meses, despues exit con 30 dias preaviso, sin penalizacion**.

**Razon:**
- 3 meses cubren el coste de setup y nos dan tiempo a generar comision suficiente.
- Despues, libertad total (refuerza el mensaje de "cero riesgo").
- A elimina nuestra cobertura de setup; rechazado.
- C suena a permanencia tipo telefonica, mal recibido en ocio nocturno.
- D crea friccion contractual; el operador prefiere "tengo que estar 3 meses si o si" a "puedo salir pero pago 300 €".

**Fecha:** 2026-05-26.

---

## D3 — Que pasa si el local rinde poco (volumen <5k €/mes mantenido) **[BLOQUEANTE]**

**Contexto:** despues del periodo de gracia de 2 meses (ver D1), que hacemos
con clientes que no generan volumen suficiente para cubrir nuestro coste?

**Opciones:**
- A) Subir comision automatica a 2,0 % para cubrir coste
- B) Mover a SaaS fijo 199 €/mes (Idea 01)
- C) Cobrar fee minimo mensual de 80 € (top-up)
- D) Cancelar servicio con preaviso

**Decision:** **B primero, D como fallback**.

**Razon:**
- B mantiene relacion comercial, el cliente paga lo que necesita pagar, y mantiene servicio.
- Si rechaza B, D (cancelacion) con 30 dias preaviso, sin penalizacion para ninguna parte.
- A es trampa contractual y daña la imagen "cero coste fijo".
- C es la peor: top-up oculto que rompe el pitch.

**Implementacion:** clausula 3.4 del contrato: *"Si durante 3 meses consecutivos
post-periodo de gracia el volumen procesado es inferior a 5.000 €/mes, NightPay
puede proponer migracion a plan SaaS fijo o cancelar contrato con 30 dias preaviso."*

**Fecha:** 2026-05-26.

---

## D4 — Como medimos y reportamos transacciones (transparencia)

**Contexto:** la mayor objecion del cliente es "como se que no me cobras de mas".
Necesitamos transparencia absoluta y auditable.

**Opciones:**
- A) Dashboard con totales agregados mensuales
- B) Dashboard con detalle linea-a-linea + descarga CSV
- C) Dashboard linea-a-linea + cruce con `paytefAuthCode` en cada linea
- D) Dashboard + acceso API publica para auditoria externa

**Decision:** **C es el minimo. D como upgrade para tier high-volume**.

**Razon:**
- C es la diferencia: cada linea factura lleva el codigo de autorizacion Paytef. El cliente puede cruzar contra su propio backoffice de Paytef y validar.
- A es lo que hacen todos los SaaS y por eso desconfian. No basta.
- B sin el `paytefAuthCode` deja al cliente sin posibilidad real de cruzar.
- D opcional para clientes que tienen ERP integrado.

**Implementacion:**
- Cada `Settlement` row genera CSV con columnas: `txId, datetime, amount, paytefAuthCode, posUser, ticketId`.
- Dashboard tiene boton "descargar detalle del mes" y boton "auditar vs Paytef" (que abre Paytef en pestaña aparte si configuracion lo permite).
- Documentado en clausula 7 del contrato como derecho del cliente.

**Fecha:** 2026-05-26.

---

## D5 — Quien es el interlocutor: el operador o Paytef? **[BLOQUEANTE]**

**Contexto:** Paytef es el procesador de pagos. Nosotros somos un capa software
encima. El operador del local podria pensar que somos Paytef (confusion) o que
estamos coordinandonos con Paytef contra el (paranoia).

**Opciones:**
- A) NightPay es independiente, sin relacion contractual con Paytef. El operador firma con NightPay y separadamente con Paytef.
- B) NightPay tiene acuerdo de referido con Paytef (cobramos % adicional)
- C) NightPay es reseller de Paytef (paquete combinado)

**Decision:** **A — totalmente independientes**.

**Razon:**
- Clarisimo legalmente: si Paytef cambia condiciones, no nos afecta contractualmente.
- Cliente no nos puede demandar por cosas de Paytef.
- Posicionamiento comercial: "somos software, ellos son cobro" — limpio.
- B y C añaden conflicto de interes que daña la mensajeria de transparencia.

**Implementacion:**
- Clausula 1.3 del contrato: *"NightPay es proveedor independiente de servicios software. El procesamiento real del pago es responsabilidad de Paytef u otro PSP elegido por el cliente. NightPay no tiene relacion contractual con Paytef ni recibe comisiones de Paytef."*

**Fecha:** 2026-05-26.

---

## D6 — Acepta tarjeta no-QR? (cobro NFC en barra sin generar QR)

**Contexto:** el camarero puede tocar el PAX y cobrar directamente, sin generar
QR. ¿Esa transaccion entra en RevShare?

**Opciones:**
- A) Si, todas las transacciones procesadas via NightPay (con o sin QR) cuentan
- B) Solo las generadas por QR escaneado por cliente cuentan
- C) Solo las que pasan por el TPV camarero de NightPay cuentan

**Decision:** **C — solo lo que pasa por nuestro software cuenta**.

**Razon:**
- Si el camarero teclea importe directo en el PAX (sin abrir nuestro TPV), Paytef cobra pero no es transaccion nuestra. No facturamos. Justo.
- Si el camarero abre nuestro TPV y dispara cobro (con o sin QR), facturamos. Es nuestro software.
- B excluye un caso de uso valido (NFC en barra disparado por TPV camarero).
- A es trampa contractual: cobraria a cliente que no usa nuestro sistema.

**Implementacion:**
- Tag `processedBy=NIGHTPAY` en cada transaccion creada via nuestro TPV o web cliente.
- Settlement solo cuenta `WHERE processedBy='NIGHTPAY'`.
- Documentado clausula 4.2: *"NightPay factura unicamente las transacciones originadas por el software NightPay. Transacciones disparadas directamente en el PAX sin usar la interfaz NightPay no se incluyen."*

**Fecha:** 2026-05-26.

---

## D7 — Permitimos al cliente ver el codigo del frontend (clausula escrow)?

**Contexto:** algunos operadores grandes (grupos hosteleria) piden codigo en escrow
como condicion para firmar — si nosotros desaparecemos, ellos tienen el codigo.

**Opciones:**
- A) No, nunca
- B) Si, escrow notarial gratis para todos
- C) Si, escrow notarial opcional con +0,1 % comision
- D) Si, escrow gratuito solo para contratos >150k €/mes procesado

**Decision:** **C como base, D como descuento para grupos grandes**.

**Razon:**
- Escrow notarial cuesta 200-400 €/año + alta. Repartirlo en clientes que lo piden via 0,1 % adicional.
- D refuerza propuesta para grupos: te lo damos gratis si nos comprometes volumen.
- A bloquea contratos con grupos grandes que lo piden por compliance.
- B es regalar coste sin retorno (la mayoria no lo necesita).

**Implementacion:**
- Clausula 10 (opcional) del contrato: *"NightPay puede depositar copia del codigo fuente del frontend en notario o servicio de escrow homologado. Coste 0,1 % adicional sobre la comision mensual, o gratuito si el contrato supera 150.000 €/mes de volumen procesado."*

**Fecha:** 2026-05-26.

---

## D8 — Plazo de cobro de la factura mensual

**Contexto:** queremos cobrar rapido pero el operador del ocio nocturno tiene
cashflow irregular.

**Opciones:**
- A) SEPA Direct Debit el dia 5 del mes siguiente
- B) Transferencia a 15 dias desde factura
- C) Transferencia a 30 dias desde factura
- D) Mixto: SEPA dia 15, opcion transferencia a 30 dias

**Decision:** **D — operador elige al firmar**.

**Razon:**
- SEPA dia 15 reduce friccion (un debito y ya) y nos da liquidez en mes corriente.
- Transferencia 30 dias es alternativa para operadores que no quieren autorizar SEPA.
- A es agresivo, daña relacion.
- C unico daña nuestra liquidez.

**Implementacion:**
- En contrato, clausula 5.2 con seleccion: `[ ] SEPA dia 15 [ ] Transferencia 30 dias`.
- Factura electronica indica fecha de vencimiento segun opcion.
- Recargo por mora: +5 % tras 7 dias de impago, suspension del servicio a los 15 dias de mora.

**Fecha:** 2026-05-26.

---

## D9 — Aceptamos cambios de tier mid-contract?

**Contexto:** un cliente arranca en plan estandar (1,0 %) y a los 4 meses
procesa 120k €/mes — claramente high-volume. Le bajamos a 0,8 %?

**Opciones:**
- A) Si, downgrade automatico cuando se supere threshold 3 meses seguidos
- B) Si, pero cliente lo solicita explicitamente
- C) No, hasta renovacion anual

**Decision:** **A — downgrade automatico**.

**Razon:**
- Genera confianza: "no me estan cobrando de mas porque he crecido".
- Si lo descubre el cliente solo (B), se molesta al saber que pagaba de mas.
- C es agresivo y se gana el reproche.
- Implementacion sencilla en el motor de calculo.

**Implementacion:**
- Motor de liquidacion revisa cada mes: si `avg(3 ultimos meses) > 100k €` y tier actual = estandar, automaticamente baja a high-volume con notificacion al cliente.
- Documentado clausula 4.3.

**Fecha:** 2026-05-26.

---

## D10 — Pricing en tickets pequeños (sub-5 €)?

**Contexto:** en barra hay tickets de 4-6 € (una cerveza, una entrada de copa).
El fee fijo de 0,10 € es proporcionalmente alto (2 %!). Mata el caso de uso.

**Opciones:**
- A) Mantener fee fijo 0,10 € siempre
- B) Eliminar fee fijo en tickets <5 €
- C) Fee fijo solo en tickets >2 €
- D) Plan alternativo "tickets pequeños": 1,3 % puro sin fee fijo

**Decision:** **D como opcion comercial**.

**Razon:**
- Plan alternativo no rompe el pricing base (que es competitivo en tickets medios).
- Cliente con ticket medio <10 € (¡casi todo barra de discoteca!) pide D.
- A mata el use case en barra.
- B y C añaden complejidad al motor sin valor claro.

**Implementacion:**
- Plan "ESTANDAR ALTO VOLUMEN TX": 1,3 % puro, fee fijo 0 €.
- Disponible para clientes que documenten ticket medio <10 € (verifyamos primer mes y confirmamos).
- Si en el primer mes el ticket medio resulta ser >12 €, se les ofrece pasar a 1,0 % + 0,10 € (que les sale mas barato).

**Fecha:** 2026-05-26.

---

## Decisiones pendientes (no urgentes)

| Codigo | Tema | Bloqueante? | Owner | Fecha limite |
|--------|------|-------------|-------|--------------|
| D11 | ¿Aceptamos refunds parciales en el calculo? Si/No | No | tech | 2026-06-15 |
| D12 | ¿Multi-currency cuando el cliente cobra EUR vs USD? | No | tech | 2026-09-01 |
| D13 | ¿Whitelabel para reventa por terceros? | No | comercial | 2026-09-01 |
| D14 | ¿API publica para integraciones contables del operador? | No | tech | 2026-08-01 |
| D15 | ¿Cobramos por refunds (transaccion negativa)? | No | comercial | 2026-06-15 |
