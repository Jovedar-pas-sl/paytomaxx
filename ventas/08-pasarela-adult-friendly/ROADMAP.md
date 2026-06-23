# Roadmap — 6 a 10 semanas hasta primer cliente real

> **Hito 0 antes que nada:** sin validación legal y comercial con Cecabank en MCCs sensibles, el negocio no existe. Las semanas 1-3 son go / no-go.

---

## Semana 1 — Validación comercial con Cecabank (CRÍTICO)

- [ ] Solicitar reunión con responsable comercial de Wipay / Cecabank que cubra TPV Virtual high-risk.
- [ ] Preparar dossier:
  - [ ] Lista de MCCs que queremos cubrir, con volúmenes esperados realistas
  - [ ] Modelo de sub-aggregation (¿podemos ser agregador? ¿necesitamos figura PSP?)
  - [ ] Ejemplos de 3 sub-merchants tipo (Maxxag VLC, Maxxag MAD, Mansion Babylon)
- [ ] Preguntas concretas a hacer y dejar por escrito:
  - [ ] ¿Aceptáis MCC 7273 / 7299 / 5967 / 5969 / 5993 con KYB serio?
  - [ ] ¿Aceptáis nuestra figura como agregador no-EMI (introductor)?
  - [ ] ¿O nos exigís constituirnos como agente de pago / EMI?
  - [ ] ¿Existe modelo de "Master Merchant" con sub-cuentas operativas?
  - [ ] ¿Cuál es el coste interno % por MCC?
  - [ ] ¿Cuáles son los SLAs de onboarding por sub-merchant?
  - [ ] ¿Reserva de garantía mínima exigida y plazo de liberación?
- [ ] Documentar respuesta en `DECISIONS.md`.

**Salida go/no-go.** Si Cecabank no acepta sub-aggregation para nuestros MCCs y no tenemos capacidad de constituirnos como agente de pago / EMI en plazo razonable, ir a plan B (otros adquirentes: Banc Sabadell, Caixabank Comercio, Redsys vía banco emisor amigable, o PSP español como MONEI / Bizum integrators).

---

## Semana 2 — Validación legal con abogado fintech

- [ ] Contratar 4-6 h de abogado fintech especializado en regulación PSD2 / SEPBLAC / Banco de España.
- [ ] Preguntas obligatorias:
  - [ ] ¿Nuestro rol legal con el modelo elegido? (introductor, agente de pago, EMI, PSP autorizado)
  - [ ] ¿Necesitamos licencia del Banco de España?
  - [ ] ¿Quién es el responsable AML/KYC ante SEPBLAC: nosotros, el sub-merchant o Cecabank?
  - [ ] ¿Cómo redactar el sub-merchant agreement de forma que nos blinde frente al cliente final?
  - [ ] Modelo de contrato cliente-nuestro: ¿prestación de servicio técnico o agregación de pagos?
  - [ ] Responsabilidad sobre chargebacks fraudulentos.
  - [ ] Responsabilidad sobre cumplimiento sectorial del cliente (ej. mayoría de edad en MCC adult).
- [ ] Borrador de contrato cliente-nuestro revisado por el abogado.
- [ ] Borrador de aviso legal, condiciones generales y política de privacidad.
- [ ] Documentar en `riesgos-legales.md`.

---

## Semana 3 — Decisión go/no-go + Plan B si aplica

- [ ] Reunión interna con outputs de semanas 1 y 2.
- [ ] Decisión documentada en `DECISIONS.md`:
  - [ ] ¿Vamos con Cecabank? ¿En qué figura legal?
  - [ ] ¿O pivotamos a otro adquirente español?
  - [ ] ¿O posponemos hasta consolidar licencia?
- [ ] Si **NO-GO con Cecabank**: contactar (en paralelo) Banc Sabadell / Caixabank Comercio / Redsys / MONEI. Repetir validación rápida.
- [ ] Si **GO**: avanzar al bloque de producto.

---

## Semana 4-5 — Producto: panel comercial y onboarding

- [ ] Aprovechar NightPay como base (multi-tenant, sub-merchants, Wipay adapter ya hecho).
- [ ] Construir / habilitar:
  - [ ] Onboarding form sub-merchant (datos KYB, alta documentación, firma e-sign)
  - [ ] Panel admin: alta, suspensión, reglas antifraude por sub-merchant
  - [ ] Panel sub-merchant: cobros, refunds, exportaciones, conciliación
  - [ ] Webhooks salientes hacia ERP del cliente
  - [ ] Reporting fiscal (CSV + asiento contable opcional)
- [ ] Tests de integración end-to-end con cuenta de pruebas Cecabank.

---

## Semana 6 — KYC/AML interno y compliance

- [ ] Definir procedimiento KYB del sub-merchant (checklist documentos, validación):
  - [ ] Escritura constitución, CIF, titularidad real (UBO)
  - [ ] Cuentas anuales o declaración de actividad
  - [ ] Licencias sectoriales (DGOJ si juego, registro Comisionado Tabacos si tabaco, licencia municipal si club)
  - [ ] Acta antecedentes penales administradores (si aplica)
- [ ] Procedimiento AML para el sub-merchant (formación, manual, designación SBLC interno si aplica)
- [ ] Procedimiento de monitorización transaccional (umbrales, alertas, reporte SEPBLAC vía Cecabank o directo según figura legal)
- [ ] Política de prevención de fraude.
- [ ] Procedimiento de gestión de disputas y chargebacks.

---

## Semana 7 — Panel disputas y devoluciones

- [ ] Flujo de disputa entrante (notificación adquirente → ticket interno).
- [ ] Recogida de evidencias (recibo, IP, fingerprint, 3-D Secure result, comunicaciones cliente).
- [ ] Plazos automáticos y notificaciones.
- [ ] Botón de refund desde panel sub-merchant con doble confirmación.
- [ ] Estadística de tasa de chargebacks por sub-merchant + alerta a 0,5 %, 0,7 %, 0,9 %.

---

## Semana 8 — Hosting PCI-DSS y seguridad

- [ ] Confirmar SAQ A (hosted checkout puro). Si sí, hosting estándar es suficiente con buenas prácticas.
- [ ] Si SAQ A-EP por tokenización: hosting PCI compliant (AWS con SAQ A-EP attestation, OVH PCI, Linode no aplica).
- [ ] Pentest externo del panel (mínimo OWASP Top 10).
- [ ] Revisión de logging, secret management, rotación de claves.
- [ ] CSP, HSTS, security headers correctos.
- [ ] Revisión `security.md` global.

---

## Semana 9 — Primer cliente piloto

- [ ] Cerrar piloto a 90 días con Maxxag VLC (ver `PRIMER_CLIENTE.md`).
- [ ] Firma contrato sub-merchant Cecabank.
- [ ] Onboarding técnico (URL checkout, webhook, panel).
- [ ] Primera transacción real en producción con importes bajos.
- [ ] Monitorización intensiva primeras 2 semanas.

---

## Semana 10 — Segundos clientes y feedback loop

- [ ] Onboarding Maxxag MAD y Mansion Babylon Marbella.
- [ ] Recoger feedback estructurado del piloto.
- [ ] Iterar precio y producto.
- [ ] Definir embudo de captación frío para sector (ver `PRIMER_CLIENTE.md`).
- [ ] Decidir si abrir comercialización pública o seguir cerrado un trimestre más.

---

## Hitos de salida

| Semana | Hito | Decisión |
|---|---|---|
| 3 | Cecabank acepta / no acepta | Go / No-Go o Plan B |
| 5 | Producto base completo | Ready para piloto |
| 6 | KYC/AML/compliance documentado | Apto operativo |
| 9 | Primer cobro real piloto | Validación negocio |
| 10 | 3 clientes activos | Listos para escalar |
