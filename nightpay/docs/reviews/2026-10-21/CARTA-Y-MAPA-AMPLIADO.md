# Carta de referencia y mapa ampliado

Actualizado con la invitación de 20 € y el historial del camarero.

Se conservan las losetas por sección y las barras apiladas de las referencias aprobadas.

## Carta

En el panel → Carta → «Carta de referencia · productos y precios» se revisan y aplican
los 13 productos: Copa 10 €, Copa premium 14 €, Botella 120 €, Chupito 5 €,
Tabla ibérica 30 €, Ración del día 12 €, Entrada 15 €, Entrada VIP 30 €,
30 min 80 €, 45 min 100 €, 1 h 120 €, 2 h 220 € e Invitar a una copa 20 €.

Aplicar usa las rutas existentes de carta, sujetas a permisos del local. Añade lo
que falta y actualiza precio, duración y orden de las coincidencias únicas,
reactivándolas. Conserva otros productos. Los duplicados, packs e invitaciones con
el mismo nombre requieren revisión antes de aplicar. Un fallo parcial se informa;
reintentar consulta lo guardado y completa los productos pendientes. No se aplica
ningún precio al desplegar ni al abrir el panel. Si la carta está vacía, el bloque
de productos y precios aparece abierto para poder configurarla.

Las sugerencias de propinas se guardan por separado en Ajustes → Formas de cobro:
el botón «Usar propinas de 5 € y 10 €» prepara esos importes; «Guardar propinas»
los aplica. No se cambian los porcentajes ni las formas de cobro.

La app vuelve a consultar los productos al recuperar el foco o volver a estar
visible. Una carta vacía ofrece «Actualizar carta». La comprobación en Chromium
verifica que una pestaña con cero productos recoge un producto nuevo al volver.

## Mapa

Añade detalles de tarjeta, wallets y datáfono; recargas; recuentos por sección;
reparto del local/personal/comisiones; caja y banco; saldo y deudas; pagos hechos
y devoluciones. Se reutiliza el contrato existente del API, sin migraciones ni
cambios en cálculos de dinero o comisiones. Los datos desconocidos se muestran
como «No disponible», incluidos la tasa bancaria y los totales históricos ausentes.

«Banco» y «Caja esperada» describen lo calculado; no se promete un abono mañana
ni se presenta la caja esperada como un arqueo real. Se distinguen ventas,
recargas, deudas del periodo y deudas totales. Una noche congelada conserva su
información histórica.

## Validación

- 368 pruebas del panel y 322 del operador: todas aprobadas.
- Builds de producción de administración y operador: aprobados; ambos sirven HTML con HTTP 200 en puertos locales de comprobación.
- Controles de tipos de administración y operador: aprobados.
- Chromium con componentes reales y respuestas de API simuladas: se aplican 12
  productos y no se permite duplicarlos al repetir; 2 copas + tabla = 50 €;
  1 h = 120 €; detalle de habitación en recepción; mapa desplegable en móvil y
  escritorio sin desbordamiento ni errores JavaScript.
- No se modificaron datos ni aplicaciones de producción. El despliegue afecta a
  administración y operador; los productos se aplican después desde el panel.
