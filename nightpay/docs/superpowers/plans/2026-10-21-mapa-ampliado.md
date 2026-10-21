# Mapa A ampliado Implementation Plan

> **For agentic workers:** Use subagent-driven-development task-by-task.

**Goal:** Ampliar el mapa A con detalles reales, periodos y etiquetas fieles al origen de los datos.
**Architecture:** Componentes pequeños y helpers puros sobre MoneyMap existente; conservar datos congelados. Sin cambios de cálculo financiero ni nuevas consultas de movimientos que el agregado no identifica.
**Tech Stack:** React/Next, contratos existentes, CSS tokens OxioCard, Vitest.

Diseño aprobado: [especificación](../specs/2026-10-21-carta-mapa-design.md).

- [ ] Leer contratos y tests existentes; escribir pruebas rojas para nuevo modelo de detalles, desconocidos, negativos y Z.
- [ ] Construir helpers del resumen y detalles: recargas, reparto, caja, obligaciones, pagos hechos, pendientes, devoluciones y costes conocidos.
- [ ] Conservar totales firmados. Etiquetas: movimiento de tarjeta, variación de saldo del periodo, saldo real si disponible, parte del local sin promesa de beneficio neto.
- [ ] Añadir reparto y detalles desplegables accesibles, recuentos y porcentajes por sección; no esconder ceros/negativos relevantes.
- [ ] Separar salidas hechas de pendientes y no llamar «al cerrar» a una obligación de un Z ya cerrado.
- [ ] Mostrar from/to/generatedAt y estado congelado/actualización/error con datos previos.
- [ ] Selector esta noche/periodo personalizado con fechas validadas y la consulta from/to existente; evitar carreras al cambiar filtros y que fallos borren datos válidos.
- [ ] Reutilizar vista en NightMoneyMap sin habilitar filtros que cambien el Z ni fichas actuales como si fueran históricas.
- [ ] CSS móvil/escritorio en claro y oscuro, barras A, sin desbordamiento y respeto a reduced-motion.
- [ ] Tests focalizados, tipos/lint, revisión semántica independiente y verificación visual headless de estados representativos.
