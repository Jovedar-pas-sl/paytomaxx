# MARCAS Y MODELOS SOPORTADOS

Documento técnico interno + comercial. Lo publicamos también en la landing en versión resumida.

---

## 1. Estado actual

### 1.1 Marca completamente soportada

#### Fujitsu

| Modelo                 | Estado     | Cobertura                      | Notas                                  |
|------------------------|------------|--------------------------------|----------------------------------------|
| **F53**                | ✅ Completo | L1 remoto, L2, presencial      | Manuales indexados, 50+ máquinas operadas, biblioteca técnica completa. Familiarizados con: stacker, dispensador, módulo aceptador, pinpad PAX IM30 integrado, comunicación Paytef. |

**Componentes Fujitsu F53 cubiertos:**
- Dispensador y stacker.
- Módulo aceptador de billetes.
- Impresora térmica del recibo/QR.
- Pinpad PAX IM30 (variante integrada).
- Sensores de presencia, sensor de papel, sensores de atasco.
- Pantalla táctil.
- Lector QR.
- Comunicación de red (TCP/IP, integración Paytef/TPV).
- Software de gestión y banderas/flags.

**Errores documentados con protocolo de resolución:**
- Pérdida de banderas/flags.
- Atascos en stacker (rodillos 1-4).
- Errores de dispensación (sobre/sub-dispensación).
- Pinpad desconectado.
- Pantalla bloqueante por QR no recogido.
- Errores de comunicación con backoffice.
- Discrepancias de saldo / conciliación.

---

### 1.2 Marca parcialmente soportada (limitada)

> Ninguna en el momento actual.

Si un cliente nos pregunta por una marca no listada como "Completo", la respuesta honesta es: **no la cubrimos todavía**. No vendemos "lo aprendemos sobre la marcha" — eso destruye credibilidad técnica.

---

### 1.3 Marca no soportada (no aceptamos contrato)

Todas las demás. Lista no exhaustiva:

- Wincor Nixdorf (todos los modelos).
- NCR (todos los modelos).
- Diebold / Diebold Nixdorf (todos los modelos).
- GRG Banking.
- Hyosung / Nautilus Hyosung.
- Triton.
- Cima.

---

## 2. Plan de ampliación

### 2.1 Prioridad por penetración en España (operadores independientes)

Orden de incorporación basado en presencia de mercado y disponibilidad de información técnica.

| Prio | Marca           | Modelos primarios                              | Justificación                                                              |
|------|-----------------|------------------------------------------------|----------------------------------------------------------------------------|
| 1    | **Wincor Nixdorf** | ProCash 280, ProCash 285, CINEO C2080         | Muy presente en redes ATM privadas españolas y entidades pequeñas.         |
| 2    | **NCR**         | SelfServ 22, SelfServ 32, SelfServ 84            | Histórico en banca pero también en operadores independientes.              |
| 3    | **Hyosung**     | MoniMax 5300, MoniMax 7600                       | Creciente en cash-in-shop y operadores low-cost.                           |
| 4    | **Diebold**     | Opteva 520, Opteva 720                           | Menos común pero presente en flotas heredadas.                             |
| 5    | **GRG Banking** | H22N, H68N                                       | Operadores que entraron vía proveedor chino, especialmente turismo costa.  |
| 6    | **Fujitsu F56** | F56                                              | Extensión natural de nuestro know-how F53.                                 |

### 2.2 Qué necesitamos para añadir una marca

Checklist por marca:

- [ ] Manual de servicio técnico (Service Manual) del fabricante en PDF.
- [ ] Manual de usuario / operación.
- [ ] Tabla de códigos de error documentada.
- [ ] Diagramas de despiece y referencia de componentes.
- [ ] Mínimo 2 técnicos subcontratados con experiencia previa demostrable en la marca.
- [ ] Acceso a foros sectoriales o documentación de la comunidad técnica.
- [ ] Validación interna: 20 consultas de prueba al sistema IA con respuestas técnicamente correctas.
- [ ] Protocolo escrito de las 5 incidencias más frecuentes para esa marca.

Solo cuando se cumple **todo lo anterior** la marca pasa a estado "Completo" y se publica como soportada.

### 2.3 Cómo conseguimos los manuales (legalmente)

Prioridad de fuentes:

1. **Cliente que ya tiene la máquina** — puede aportarnos su copia (uso interno, no redistribución pública).
2. **Distribuidor oficial o partner del fabricante** — algunos venden documentación técnica.
3. **Ex-técnicos del fabricante** que conservan documentación profesional.
4. **Compra de máquina de segunda mano** (algunos lotes incluyen documentación).
5. **Foros sectoriales** (con licencia clara cuando es posible).

**Lo que NO hacemos:**
- Distribuir manuales descargados de fuentes no claras.
- Subir manuales a sistemas accesibles públicamente.
- Usar manuales para clientes que no operan esa marca (uso por contrato, no reventa).

---

## 3. Política de comunicación al cliente

### 3.1 Si pregunta por marca soportada
> "Sí, [marca/modelo] está completamente cubierto. Te paso ficha técnica del servicio para ese modelo."

### 3.2 Si pregunta por marca **no** soportada
> "Hoy no cubrimos [marca/modelo]. Está en nuestro roadmap para [Q3/Q4]. Si tu flota es mayoritariamente [marca soportada], podemos firmar ahora con anexo de incorporación de [marca no soportada] cuando esté lista. Si tu flota es mayoritariamente [no soportada], te aviso en cuanto lo tengamos."

### 3.3 Si tiene flota mixta
> "Cubrimos lo que está en la columna ✅. El resto, podemos:
> (a) excluirlo del contrato y darle soporte solo a la parte cubierta;
> (b) incluirlo con cobertura limitada (solo presencial vía nuestra red de técnicos, sin SLA de respuesta L1) con descuento del 30%;
> (c) esperar a Q3/Q4 cuando la incorporemos completamente."

---

## 4. Estado del roadmap (a fecha 30 días post-lanzamiento)

| Marca           | Manual obtenido | Indexado IA | Técnicos zona | 20 consultas validadas | Estado público |
|-----------------|-----------------|-------------|---------------|------------------------|----------------|
| Fujitsu F53     | ✅              | ✅          | ✅            | ✅                     | ✅ Completo    |
| Wincor ProCash 280 | ⏳ Q3         | ⏳          | ⏳            | ⏳                     | ❌ No anunciado|
| NCR SelfServ 22 | ⏳ Q3            | ⏳          | ⏳            | ⏳                     | ❌ No anunciado|
| Resto           | —               | —           | —             | —                      | ❌             |

> Esta tabla se actualiza al cierre de cada mes y se publica en la landing.

---

## 5. Lista de exclusión explícita

Independientemente de la marca, **no cubrimos**:

- ATM bitcoin / criptomonedas (Lamassu, General Bytes, BitAccess, etc.). Otro perfil técnico.
- Cajeros automáticos integrados en oficinas bancarias multivendor (entornos heredados con software propietario del banco).
- Máquinas recreativas tipo B (tragaperras) ni cualquier máquina cuyo objetivo principal no sea dispensación de efectivo o cobro.
- Máquinas modificadas / fuera de especificación del fabricante.

---

## 6. Política con clientes nuevos

Durante el discovery se inventaria **cada máquina con marca, modelo, número de serie y ubicación**. Solo se firma contrato con anexo que liste cada máquina y su estado de cobertura.

Esto protege:
- Al cliente: sabe exactamente qué cubrimos.
- A nosotros: evitamos compromisos sobre máquinas para las que no podemos cumplir.
