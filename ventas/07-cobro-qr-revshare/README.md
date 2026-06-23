# Cobro QR Revenue Share — NightPay sin coste mensual

> Despliegue de NightPay (QR + NFC + admin + TPV camarero) **gratis** en el local;
> el dueno paga **solo un porcentaje de cada transaccion QR/NFC procesada**. Cero
> SaaS, cero setup, cero hardware. Solo se cobra cuando el local cobra.

---

## El modelo en un parrafo

Instalamos el stack NightPay completo sobre el PAX/Paytef que el local ya tiene.
**No facturamos ni un euro hasta que el local procese su primera transaccion QR
o NFC por nuestro sistema.** A partir de ahi, cada cobro pasa por nuestro motor
de liquidacion (auditable, exportable) y a fin de mes el local paga **1,0 % + 0,10 €
por transaccion** sobre el volumen que **nosotros** hemos procesado (no sobre el
volumen total de caja, solo sobre lo que pase por NightPay). Es el modelo Stripe
aplicado a software de caja para ocio nocturno: cero riesgo para el local, upside
alineado para nosotros.

---

## Comparativa visual vs SaaS competencia

| Concepto                  | Glovo Pay / Yoigo POS | NightPay Lite (Idea 01) | **NightPay RevShare (aqui)** |
|---------------------------|-----------------------|--------------------------|------------------------------|
| Setup inicial             | 600-1.500 €           | 0-500 €                  | **0 €**                      |
| Cuota mensual fija        | 89-249 €              | 199-349 €                | **0 €**                      |
| Coste por transaccion QR  | 0,3-0,9 % + IVA       | 0,0 % (incluido)         | **1,0 % + 0,10 €**           |
| Permanencia               | 12-24 meses           | 12 meses                 | **3 meses minimos**          |
| Riesgo financiero local   | Alto (CAPEX + OPEX)   | Medio (OPEX fijo)        | **Cero (solo paga si cobra)**|
| Break-even local @50k €/mes| Nunca rentable       | ~150 €/mes ahorro        | ~600 €/mes coste variable    |

**Lectura comercial:** debajo de 40k €/mes procesado, RevShare es **mas barato**
para el local que cualquier SaaS. Por encima de 80k €/mes, SaaS fijo es mas
rentable para el local — pero seguimos siendo competitivos por **cero capex,
cero riesgo, cero permanencia**.

---

## Payout flow (como llega el dinero a nuestra cuenta)

```
[Cliente final] --paga QR/NFC--> [Paytef/Cecabank] --liquida T+1--> [Cuenta del local]
                                                                          |
                                                                          |  (fin de mes)
                                                                          v
                              [Motor liquidacion NightPay] ---factura--> [Local nos paga]
                                          ^
                                          |
                                          +-- log inmutable de transacciones
                                              (firmadas, exportables, auditables)
```

1. **El dinero NUNCA pasa por nuestras cuentas.** Cobra Paytef, liquida al local. Punto.
2. NightPay registra cada transaccion firmada y con `paytefAuthCode`.
3. El **dia 1 de cada mes**, el motor de liquidacion calcula `sum(amount * 0.010) + (count * 0.10) €` del mes anterior.
4. Emitimos **factura electronica** al operador con detalle linea-a-linea (cada
   ticket, cada timestamp, cada auth code de Paytef cruzado).
5. Operador paga por **SEPA Direct Debit B2B** (mandato firmado en onboarding,
   ver `contrato.md`) o transferencia a 15 dias.

**Cero discusion sobre el dinero** — todo viene del log inmutable que el operador
puede auditar contra su propio backoffice de Paytef.

---

## Por que esto funciona ahora

1. **El stack ya existe** — el monorepo `nightpay/` lleva 50+ PAX en produccion
   (ver `../../shared_db.json`). Marginal cost de añadir un local nuevo es <1 h.
2. **Existe un grupo natural de leads** — todos los que dijeron "no" a Idea 01
   por el coste fijo. Aqui no hay coste fijo. La objecion desaparece.
3. **El competidor tipico (Glop, Cuiner, Revo) cobra fijo** — somos los unicos en
   ocio nocturno que ofrecemos revshare puro sin hardware proprio.
4. **El operador no nos puede demandar por "tu software no me hace ventas"** porque
   nosotros tampoco facturamos si no hay ventas. Perfecta alineacion de intereses.

---

## Tracción y prueba

- **50+ PAX activos** en `../../shared_db.json` con `paytefDeviceStatus = Conectado`.
- **99 tests E2E verdes** (`../../nightpay/STATUS.md`).
- **Integracion real Paytef + Cecabank/Wipay** (commits `b52153f`, `8e7bbd9`).
- **Primer cliente piloto pre-comprometido:** locales del mismo grupo donde ya
  hay maquinas (ver `PRIMER_CLIENTE.md`).

---

## Cuando NO ofrecer este modelo

| Situacion local                          | Recomendacion comercial      |
|------------------------------------------|------------------------------|
| Vol QR estimado <10k €/mes               | Vender Idea 01 a 199 €/mes   |
| Vol QR estimado 10-40k €/mes             | **RevShare 1,0 %** (aqui)    |
| Vol QR estimado 40-100k €/mes            | RevShare 0,8 % con compromiso|
| Vol QR estimado >100k €/mes              | Plan custom + soporte 24/7   |
| Grupo con >5 locales                     | Plan multi-venue exclusividad|

---

## Estructura de esta carpeta

```
07-cobro-qr-revshare/
├── README.md            <- estas aqui
├── SALES.md             <- 3 estructuras de pricing, 1-pager, 10 objeciones
├── ROADMAP.md           <- checklist 2 semanas
├── PRIMER_CLIENTE.md    <- guion para reabordar leads de Idea 01
├── pitch.md             <- deck 10-12 slides foco financiero
├── DECISIONS.md         <- decisiones clave (threshold, contrato, exit)
├── calculadora.md       <- modelo de calculo break-even
└── landing/
    └── index.html       <- landing 1-pagina con calculadora
```

---

## Contacto interno

- **Dueno comercial:** ainhoanochesdeverano@gmail.com
- **Stack tecnico:** `../../nightpay/` (monorepo, 50+ PAX activos)
- **Idea hermana SaaS:** `../01-nightpay-lite/` (fallback comercial al reves)
- **Pasarela pago:** Paytef company `76861` + Cecabank/Wipay (commit `b52153f`)
