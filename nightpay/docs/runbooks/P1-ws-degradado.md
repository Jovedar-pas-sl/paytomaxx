# Runbook P1: pantallas que no se actualizan solas (tiempo real)

**Severidad**: P1 (se puede cobrar; las pantallas no se refrescan solas).
**Objetivo**: 15 min.

## Síntomas

- El TPV o la app de la chica no pasan a «Pagado» hasta recargar la página.
- En el navegador (consola) errores de `socket.io` / WebSocket.
- Métrica `nightpay_ws_connections_active` a 0 con el local abierto.

## Diagnóstico (5 min)

1. `https://api.paytomaxx.com/v1/health` → ¿`"redis":"ok"`? El tiempo real
   usa Redis: si falla, ver Redis en Dokploy (`nightpay-redis` → Logs).
2. **Cloudflare → Network → WebSockets: On**. Si alguien lo apagó, los
   sockets caen a *polling* o no conectan.
3. Las webs se construyeron con `NEXT_PUBLIC_WS_URL=wss://api.paytomaxx.com`
   (Build Arg). Si se cambió de dominio sin **Rebuild**, apuntan al viejo.
4. Métricas (con `METRICS_TOKEN`):
   `curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://api.paytomaxx.com/v1/metrics | grep nightpay_ws_connections_active`

## Acciones

- Redis caído → Deploy de `nightpay-redis`, luego Redeploy de `nightpay-api`.
- Empezó con el último despliegue → **Dokploy → nightpay-api → Deployments →
  el anterior → Rollback**. Lo mismo con la web afectada.
- Mientras tanto: recargar la página del TPV / de la chica muestra el estado
  real (el cobro está bien guardado; solo falla el aviso en vivo).

## Comprobar

- [ ] Un cobro de prueba pasa a «Pagado» solo, sin recargar, en TPV y móvil.
