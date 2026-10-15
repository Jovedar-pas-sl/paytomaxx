# Runbook P0: la pasarela de pago (Redsys / BBVA) no funciona

**Severidad**: P0 de noche, P1 de día.
**Objetivo**: alternativa de cobro en 5 min; avisar al banco en 15.

## Síntomas

- Los clientes no pueden pagar con el QR: error en la página de Redsys,
  tarda mucho o vuelve sin pagar.
- Telegram / **Incidencias**: varios cobros atascados seguidos.
- Métricas: `nightpay_circuit_state{provider="REDSYS"}` = 2 (cortado: el API
  deja de llamar a la pasarela un rato para no colgarse) y
  `nightpay_gateway_call_duration_seconds` disparado.

## Diagnóstico (2 min)

1. ¿Es la pasarela o somos nosotros?
   `https://api.paytomaxx.com/v1/health` → si da 503 o no responde, el
   problema es nuestro: [P1-db-overload.md](P1-db-overload.md) o
   [P0-vps-perdido.md](P0-vps-perdido.md).
2. Haz tú un cobro de 1 € con tu tarjeta. Si la página de Redsys no carga o
   da error SIS, es la pasarela.
3. **canales.redsys.es**: ¿entra? ¿salen operaciones recientes?
4. Métricas (con `METRICS_TOKEN`):
   `curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://api.paytomaxx.com/v1/metrics | grep -E 'nightpay_circuit_state|gateway_call'`

Redsys no tiene página pública de estado: si es la pasarela, llama al
soporte TPV de BBVA con el código de comercio (FUC).

## Mientras tanto: seguir cobrando

1. **Datáfono PAX** (Paytef) para quien pague con tarjeta, si el local lo
   tiene: es otra vía de cobro.
2. **Saldo**: los clientes con saldo cargado pueden seguir consumiendo (no
   pasa por el banco).
3. **Efectivo**, apuntado.
4. Dile a las chicas y a los encargados qué hacer (grupo del local).

## Cuando vuelva

- El corte del API (`circuit_state`) se cierra solo al cabo de un rato si la
  pasarela responde; no hay que reiniciar nada.
- Los cobros que se quedaron a medias: [P0-pagos-atascados.md](P0-pagos-atascados.md).
- Al día siguiente, cuadre en **Banco** de esa noche.

## Si el problema es nuestro (claves)

`REDSYS_SECRET_KEY`, `REDSYS_MERCHANT_CODE` o `REDSYS_TERMINAL` mal en
Dokploy → el banco rechaza la firma (SIS0042 y similares). Compara con lo que
dio BBVA, corrige en **nightpay-api → Environment** y **Deploy**.
