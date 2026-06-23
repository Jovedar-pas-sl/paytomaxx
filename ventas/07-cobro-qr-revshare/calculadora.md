# calculadora — modelo financiero RevShare

Modelo de calculo paso a paso. **Todos los numeros sincronizados con `landing/index.html`
y `pitch.md`**. Si modificas uno, sincroniza los demas.

---

## Formula central

```
ComisionMensual = (VolumenMensualQR_EUR * Rate_pct) + (NumeroTransaccionesQR * FeeFijo_EUR)
```

Donde:
- `Rate_pct` = 0,008 / 0,010 / 0,015 segun tier (High-Vol / Estandar / Premium)
- `FeeFijo_EUR` = 0,08 € (high-vol) / 0,10 € (estandar y premium)

---

## Variantes por tier

### Plan ESTANDAR (1,0 % + 0,10 €)

| Vol mensual QR | Num transacciones | Comision % | Fee fijo | **Total/mes** |
|----------------|-------------------|------------|----------|---------------|
| 5.000 €        | 400               | 50,00 €    | 40,00 €  | **90,00 €**   |
| 10.000 €       | 800               | 100,00 €   | 80,00 €  | **180,00 €**  |
| 20.000 €       | 1.500             | 200,00 €   | 150,00 € | **350,00 €**  |
| 30.000 €       | 2.200             | 300,00 €   | 220,00 € | **520,00 €**  |
| 45.000 €       | 3.000             | 450,00 €   | 300,00 € | **750,00 €**  |
| 60.000 €       | 4.000             | 600,00 €   | 400,00 € | **1.000,00 €**|
| 80.000 €       | 5.500             | 800,00 €   | 550,00 € | **1.350,00 €**|

### Plan HIGH-VOLUME (0,8 % + 0,08 €, requiere compromiso 100k/mes)

| Vol mensual QR | Num transacciones | Comision % | Fee fijo | **Total/mes** |
|----------------|-------------------|------------|----------|---------------|
| 100.000 €      | 6.500             | 800,00 €   | 520,00 € | **1.320,00 €**|
| 150.000 €      | 8.000             | 1.200,00 € | 640,00 € | **1.840,00 €**|
| 250.000 €      | 12.000            | 2.000,00 € | 960,00 € | **2.960,00 €**|
| 400.000 €      | 18.000            | 3.200,00 € | 1.440,00 €| **4.640,00 €**|

A partir de 250k €/mes baja a 0,7 % (clausula over-volume).

### Plan PREMIUM (1,5 % + 0,10 €, soporte presencial)

| Vol mensual QR | Num transacciones | Comision % | Fee fijo | **Total/mes** |
|----------------|-------------------|------------|----------|---------------|
| 5.000 €        | 400               | 75,00 €    | 40,00 €  | **115,00 €**  |
| 10.000 €       | 800               | 150,00 €   | 80,00 €  | **230,00 €**  |
| 18.000 €       | 1.200             | 270,00 €   | 120,00 € | **390,00 €**  |
| 30.000 €       | 2.200             | 450,00 €   | 220,00 € | **670,00 €**  |

### Plan ESTANDAR ALTO VOLUMEN TX (1,3 % puro, sin fee fijo)

Para locales con ticket medio <10 €.

| Vol mensual QR | Num transacciones | Comision 1,3 % | Fee fijo | **Total/mes** |
|----------------|-------------------|----------------|----------|---------------|
| 5.000 €        | 1.000 (tm=5)      | 65,00 €        | 0 €      | **65,00 €**   |
| 10.000 €       | 2.500 (tm=4)      | 130,00 €       | 0 €      | **130,00 €**  |
| 20.000 €       | 4.000 (tm=5)      | 260,00 €       | 0 €      | **260,00 €**  |

Comparativa: con plan estandar (1 % + 0,10 €), 20.000 € en 4.000 tx serian
200 + 400 = 600 €. Aqui son 260 €. **Casi mitad de precio** para tickets pequeños.

---

## Break-even para NightPay

### Coste operativo estimado por cliente

| Concepto                              | Coste mensual |
|---------------------------------------|---------------|
| Server share (VPS Hetzner + monitor)  | 8 €           |
| Soporte (1 h/mes promedio @ 30 €/h)   | 30 €          |
| Generacion factura electronica        | 1 € (Facturae) |
| SEPA cobro (banco)                    | 2 €           |
| Procesado y reconciliacion (manual)   | 5 €           |
| Margen contingencia                   | 4 €           |
| **Total coste/cliente/mes**           | **50 €**      |

### Cliente break-even (cuando empezamos a ganar)

Plan estandar (1 % + 0,10 €):

```
ComisionMensual >= 50 €
(Volumen * 0,010) + (NumTx * 0,10) >= 50
```

Asumiendo ticket medio 15 €: NumTx = Volumen / 15

```
0,010 * V + (V/15) * 0,10 = 50
0,010 V + 0,00667 V = 50
0,01667 V = 50
V = 3.000 €/mes
```

**Break-even: 3.000 €/mes de volumen QR procesado.** Por debajo somos rentables.

Por eso el threshold operativo es **5.000 €/mes** (D1) — nos da margen ~30 €/mes
para crecer y absorber casos limite.

---

## Sensibilidad: que pasa si subimos un fee?

Subir el fee fijo de 0,10 a 0,12 € en plan estandar:

| Vol/mes | Tx          | Comision 1 % | Fee 0,12 € | Total mejor | Total peor |
|---------|-------------|--------------|------------|-------------|------------|
| 20k     | 1.500       | 200 €        | 180 €      | 350 € (0,10)| **380 € (+8 %)** |
| 45k     | 3.000       | 450 €        | 360 €      | 750 € (0,10)| **810 € (+8 %)** |

**Impacto:** +8 % ingresos sin tocar el 1 % titular. Riesgo: clientes con ticket
medio bajo se quejan. **Decision provisional:** no tocar el fee fijo hasta tener
5+ clientes activos y feedback real (D11 a revisar).

---

## Comparativa cross-tier para un mismo cliente

Sala que procesa 60.000 €/mes en 4.000 transacciones (ticket medio 15 €):

| Plan                         | Total/mes |
|------------------------------|-----------|
| Premium (1,5 % + 0,10 €)     | 1.300 €   |
| **Estandar (1,0 % + 0,10 €)**| **1.000 €** |
| High-Volume (0,8 % + 0,08 €) | 800 €     |
| SaaS competencia (Idea 01)   | ~349 €    |
| Caja vieja sin software      | 0 €       |

**Lectura comercial:** a 60k €/mes, RevShare ya es bastante mas caro que SaaS
fijo. Aqui el comercial DEBE ofrecer Idea 01 (SaaS) como upgrade. Solo se
queda en RevShare si el cliente explicitamente prefiere cero coste fijo.

---

## Caso peor: el cliente que no nos sale rentable

Ejemplo: bar con vol 4.500 €/mes en 350 transacciones (ticket medio ~13 €).

- Comision plan estandar: 45 + 35 = **80 €/mes**
- Coste operativo NightPay: **50 €/mes**
- Margen NightPay: **30 €/mes**

OK pero ajustado. Si baja a 3.000 €/mes:
- Comision: 30 + 25 = **55 €/mes**
- Margen: **5 €/mes**

Si baja a 2.000 €/mes:
- Comision: 20 + 17 = **37 €/mes**
- Margen: **-13 €/mes** (perdida)

Por eso D1 obliga revisar threshold a los 2 meses. Si el cliente esta <5k €/mes
sostenido, ofrecer SaaS o cancelar.

---

## ARPU objetivo y proyeccion

**ARPU target mes 6:** 500 €/cliente (lo que produce un cliente que procesa
~40-50k €/mes en plan estandar).

| Mes        | Clientes RevShare | ARPU avg | MRR esperado |
|------------|-------------------|----------|--------------|
| Mes 1      | 1                 | 600 €    | 600 €        |
| Mes 2      | 3                 | 550 €    | 1.650 €      |
| Mes 3      | 6                 | 500 €    | 3.000 €      |
| Mes 6      | 15                | 500 €    | 7.500 €      |
| Mes 12     | 35                | 550 €    | 19.250 €     |

Combinado con MRR de Idea 01 (SaaS fijo), proyeccion de revenue ocio nocturno a
12 meses queda en rango **35-50k €/mes**.

---

## Excel/Sheets

> No incluyo .xlsx aqui — el codigo HTML/JS en `landing/index.html` ya tiene la
> calculadora interactiva. Para producir un Sheets compartido al cliente,
> exportar la tabla de "Plan ESTANDAR" arriba a CSV y subirla.

CSV minimo a generar (`calc_export.csv`):

```csv
plan,volumen_eur,num_tx,comision_pct,fee_fijo,total_mes
estandar,5000,400,50,40,90
estandar,10000,800,100,80,180
estandar,20000,1500,200,150,350
estandar,30000,2200,300,220,520
estandar,45000,3000,450,300,750
estandar,60000,4000,600,400,1000
estandar,80000,5500,800,550,1350
highvol,100000,6500,800,520,1320
highvol,150000,8000,1200,640,1840
highvol,250000,12000,2000,960,2960
premium,5000,400,75,40,115
premium,10000,800,150,80,230
premium,18000,1200,270,120,390
```
