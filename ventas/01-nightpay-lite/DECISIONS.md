# Decisiones clave NightPay Lite

> Decisiones tomadas el 2026-05-26 al construir la propuesta comercial.
> Formato: D-N · titulo · contexto · alternativas · decision · razon · revisita.

---

## D-1 · Pivote a "Lite sobre Paytef" en lugar de NightPay full

**Contexto:** NightPay (full) lleva 8 sprints, integra Wipay + Peanpe + Cecabank,
pero NO esta desplegado a publico y NO tiene credenciales reales activadas.
Cerrar primer cliente con full requiere 4-6 semanas mas de trabajo.

**Alternativas:**
- A) Lanzar NightPay full a Wipay/Peanpe productivo y vender enterprise 30k+.
- B) Pivote a Lite: aprovechar la integracion Paytef ya viva (company 76861, 50+
  maquinas en `shared_db.json`) y vender SaaS mensual.
- C) Esperar 6 meses a tener todo perfecto.

**Decision:** **B** — pivote Lite.

**Razon:** El monorepo ya tiene integracion Paytef cableada (commit `b52153f` para
Cecabank/Wipay, mas datos en `shared_db.json`). El cliente con PAX activo no necesita
nada mas que software encima. Reducir tiempo a primer euro de 6 semanas a 30 dias.

**Revisita:** Tras cerrar 3-5 clientes Lite, reactivar el upsell a NightPay full
con failover + wallet + entradas.

---

## D-2 · Pricing 3 tiers en lugar de 1 precio unico

**Contexto:** SaaS B2B nocturno con ICP heterogeneo (sala 500 vs cadena 5 locales).

**Alternativas:**
- A) Precio unico 299 €/mes para todos.
- B) 3 tiers (Starter / Pro / Enterprise) con diferenciacion clara.
- C) Pricing por volumen procesado puro (% sobre GMV).

**Decision:** **B** — 3 tiers.

**Razon:** Precio unico ahuyenta tanto al pequeno (caro) como al grande (no ven
valor diferencial). Tiers permite ancla psicologica (Enterprise = ancla alta,
Pro = "el razonable", Starter = "puerta de entrada"). Pricing % puro asusta a
duenos que ya odian la comision Paytef.

**Revisita:** A los 6 meses, con datos reales de churn por tier.

---

## D-3 · Cobrar setup one-shot agresivo (800-1.500 €)

**Contexto:** Muchas SaaS B2B no cobran setup para reducir friccion de cierre.

**Alternativas:**
- A) Setup gratis, todo en el mensual.
- B) Setup simbolico 200-300 €.
- C) Setup real 800-1.500 € que cubra el coste de onboarding presencial.

**Decision:** **C** — setup agresivo.

**Razon:** (1) El onboarding lleva 2-3 dias de trabajo real (config Paytef, alta
usuarios, formacion presencial). Si no lo cobras, lo regalas. (2) El setup
**filtra prospects no serios** — quien no paga 1.200 € no firma. (3) Es cash
inmediato vs cobro mensual a 30 dias.

**Mitigacion para clientes resistentes:** Devolucion 50% si no satisfecho en 30 dias.

**Revisita:** Si conversion call→firma cae <15%, evaluar setup mas bajo.

---

## D-4 · Permanencia 6 meses (no 12, no 0)

**Contexto:** El sector ocio nocturno tiene mortalidad alta. Cadena que cierra
es default de cliente.

**Alternativas:**
- A) Sin permanencia (mes a mes).
- B) 6 meses.
- C) 12 meses (estandar SaaS B2B).

**Decision:** **B** — 6 meses.

**Razon:** (1) 12 m ahuyenta a un duenoque ya tiene varias cuotas que no
controla; en ocio nocturno los 12 m suenan a "estafa SaaS". (2) Sin permanencia
hace que el churn sea brutal en agosto/enero (meses flojos). (3) 6 m **garantiza
ROI del setup** (setup 1.200 / 6 = 200 €/mes amortizado, encaja en mensualidad).

**Revisita:** Si conversion mejora con 3 m de permanencia, probar A/B.

---

## D-5 · No ofrecer free trial

**Contexto:** Free trial es estandar en SaaS, pero exige una UX self-service que
no tenemos (todavia) para ocio nocturno.

**Alternativas:**
- A) Free trial 14 dias completo.
- B) Demo en `demo.nightpay.app` con datos sinteticos (sin compromiso).
- C) Modo "primera noche solo" gratis (alto riesgo, alto soporte).

**Decision:** **B** — demo publica + sin trial.

**Razon:** (1) Free trial nocturno = noche real con clientes reales = nuestro
SLA debe estar al 100% con un prospect que no paga. Riesgo desproporcionado.
(2) El cierre se gana con demo en vivo + setup en 72 h, no con "pruebalo solo".
(3) Setup cobrado one-shot reemplaza la funcion de filtrado del trial.

**Revisita:** A los 12 meses, cuando self-onboarding sea bulletproof.

---

## D-6 · Vender 1-a-1 (no inbound puro, no enterprise consultivo)

**Contexto:** 3 modos de venta posibles para SaaS B2B nocturno.

**Alternativas:**
- A) Inbound puro (landing + ads + form contacto + venta self-serve).
- B) 1-a-1 outbound: lista ICP + email + call qualifier + demo + firma.
- C) Enterprise consultivo: 3-6 meses de pipeline por cliente, equipo dedicado.

**Decision:** **B** — outbound 1-a-1.

**Razon:** (1) ICP es small (sala individual) — no aguanta consultoria larga.
(2) Inbound puro requiere awareness que no tenemos. (3) `shared_db.json` ya
nos da una lista pre-cualificada de 50+ leads (clientes Paytef activos en
company 76861). La materia prima del outbound esta gratis ya.

**Revisita:** Si llegamos a 10 clientes, abrir inbound de soporte.

---

## D-7 · Landing minimalista inline-CSS (no framework, no JS pesado)

**Contexto:** Necesitamos una landing en `landing/index.html`. Hay 100 maneras de
hacerla.

**Alternativas:**
- A) Next.js / Astro / Framer.
- B) Tailwind + JS.
- C) HTML + CSS inline + un poco de JS vanilla, una sola pagina.

**Decision:** **C** — HTML estatico inline.

**Razon:** (1) La landing **no es la pieza que vende** — el cierre se gana en
demo 1-a-1. La landing solo es credibilidad y form de contacto. (2) Inline CSS
carga instantanea (<50 ms), 0 dependencias, 0 build, despliegue trivial a
cualquier hosting o incluso a Github Pages. (3) Eliminamos vector de seguridad
(0 deps = 0 CVEs). (4) Aprende-y-mantiene cualquier dev junior en 5 min.

**Revisita:** Cuando tengamos blog / casos de exito, migrar a Astro.

---

## Tabla resumen

| ID | Decision | Estado | Revisita |
|----|----------|--------|----------|
| D-1 | Pivote a Lite sobre Paytef | Firme | Tras 3-5 clientes |
| D-2 | 3 tiers Starter/Pro/Enterprise | Firme | 6 meses datos churn |
| D-3 | Setup one-shot 800-1.500 € | Firme | Si conv <15% bajar |
| D-4 | Permanencia 6 meses | Firme | A/B 3m si flojo |
| D-5 | Sin free trial | Firme | 12 m cuando self-onboard sea solido |
| D-6 | Venta 1-a-1 outbound | Firme | 10 clientes → abrir inbound |
| D-7 | Landing HTML estatico inline | Firme | Cuando haya blog/casos |
