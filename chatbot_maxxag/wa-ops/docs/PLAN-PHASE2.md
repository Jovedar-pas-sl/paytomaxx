# wa-ops — Plan Fase 2 (rediseño + multiusuario + reestructura)

Estado base: roadmap (agente Sara, F3, memoria, follow-up, panel) DESPLEGADO y funcionando.
Revisión seguridad/UX/KPI hecha → [REVIEW-2026-06.md](REVIEW-2026-06.md). Batch 1 (seguridad) se
revirtió hoy tras una cascada en el deploy; se retomará con cuidado.

## Dirección visual
- Rediseño **CRM claro y limpio** (estilo TailAdmin/Tabler). Mockup: [dashboard-mockup.html](dashboard-mockup.html).
- Donantes de UI (MIT, encajan con Jinja+Tailwind+HTMX, sin build): **TailAdmin (HTML)** para el shell,
  **daisyUI/Flowbite** para componentes, **Apache ECharts** para gráficos (heatmap nativo). Inbox UX: inspiración Chatwoot.

## Requisitos nuevos (Fase 2) — pendientes de afinar con las 30 preguntas
1. **Reestructura de navegación/IA**
   - Núcleo: Conversaciones + Análisis.
   - **Alertas** → página propia (hoy solo por la campana).
   - **Métricas** → página nueva (KPIs profesionales del review: embudo, rendimiento de Sara, comparativa por casa, follow-ups…).
   - **Inbox** sustituye a "Casas".
   - **Bot (monitor)** → ver cómo decide/responde Sara, SIN exponer prompt/instrucciones internas.
2. **Dashboard**: quitar la campana de notificaciones; poner feed de **conversaciones entrantes** en vivo.
3. **Informes**: botón para **borrar** informes.
4. **Multiusuario / RBAC + auditoría**
   - Roles: super-admin / admin / equipo (a confirmar).
   - Alta de usuarios con contraseña que crea el super-admin.
   - **Log**: quién contestó qué y quién no (atribución Sara vs agente), tiempos, acciones.
5. **Rediseño visual** CRM claro aplicado al panel (alcance a decidir: solo dashboard vs todo).

## Pendiente del review (se retoma por fases)
- Seguridad (Batch 1, con rollout seguro): HMAC, SSRF media, rate-limiter fail-safe, headers, etc.
- UX: reanudar Sara, modo en conversación, sonido a11y.
- KPIs: arreglar wa_comparison, rendimiento de Sara, funnel SQL, presupuestos abandonados.

## Decisiones (confirmadas 2026-06-17)

### Equipo, roles y log
- **Roles**: super-admin · admin · agente. ~8 personas.
- **Permisos**: super-admin = crea usuarios, ve/configura todo · admin = casas, conversaciones, informes · agente = solo contesta.
- **Agentes**: por defecto ven todo; el super-admin puede **desactivarlos** y **asignarles 1-2 casas**.
- **Alta de usuarios**: solo el super-admin, con nombre + contraseña que pone él. **Las claves las gestiona siempre el owner** (no hay "cambiar al primer login").
- **Log fino** (mínimo, sin cargar): mensaje saliente → autor (Sara / nombre del agente), logins, cambios de modo de Sara, borrado de informes. Nada más.
- **"Quién contestó"**: vista simple de quién contestó cada conversación. **Sin métricas por agente.**
- **Seguridad**: simple (usuario + contraseña). Sin 2FA por ahora.

### Menú / IA
- **Menú nuevo**: Dashboard · Inbox · Análisis · WhatsApp · Métricas · Bot (monitor) · Informes · Ajustes. Orden ≈ el del mockup.
- **Inbox** = la bandeja de conversaciones (sustituye a "Conversaciones"; no hay lista separada).
- **WhatsApp** contiene **Casas**; dentro de cada casa, sus **números**.
- **Alertas**: solo por la **campana** (no va al menú).
- **Métricas** = panel KPIs pro del review.
- **Análisis** = análisis IA por número/casa (en vivo). **Informes** = archivo de informes guardados. ✅ confirmado
- **Ajustes**: Sara on/off, usuarios, precios outcall, **+ tono del bot**. (Casas/números NO van aquí: van en WhatsApp.)

### Bot (monitor)
- Por conversación: siguiente acción que eligió Sara + por qué, su modo, si contestó o derivó, pausas de seguridad.
- **Sin exponer prompt/instrucciones internas**: solo resumen de QUÉ decidió y POR QUÉ (alto nivel).
- **Feed en vivo** de lo que Sara contesta (mensaje + motivo).
- Intervención: **solo pausar** (no aprobar/editar borradores).
- **Auto-protección**: si Sara se descontrola (errores / muchas pausas / lenta) → cambia a "modo normal" + **aviso al admin**.  ← confirmar qué modo

### Dashboard
- Mockup **aprobado** (CRM claro + dark mode + logo lips + "Casa más activa").
- **Color de marca: ROJO/CALIENTE como el logo** (rose/red, no verde). Token `brand` = paleta rose. Verde solo para estados "online" (Sara activa, números en línea).
- Quitar la franja de notificaciones de arriba → poner **feed de conversaciones entrantes en vivo** (lo nuevo arriba, click para abrir), combinado con KPIs + heatmap (≈ como el mockup).

### Alcance visual
- Aplicar el rediseño CRM (claro + dark, acento rojo) a **TODAS las páginas**.

### Informes
- Borrado **permanente** con **confirmación**, solo **admin/super-admin**. (Selección múltiple = nice-to-have.)

### Ronda final (confirmado)
- **Prioridad #1**: Roles + equipo + log (base de todo).
- **Borrar informes**: borrado **permanente** + **selección múltiple**, con confirmación, solo admin/super-admin.
- **Auto-protección de Sara**: si se descontrola → pasa el número a **manual** (Sara off) + aviso al admin.
- **Análisis vs Informes**: el owner matiza (pendiente su explicación).

## Estado Fase 1 (roles + equipo + log) — CÓDIGO COMPLETO en local (2026-06-17)
- Migración `0018` (admin_user.name/role/active, user_casa, audit_log, message.sent_by_user_id).
- Auth desde DB: token uid+rol, `get_current_user` re-lee de DB (desactivar = fuera al instante), guards `RequireAdmin`/`RequireSuperAdmin`, bootstrap del super-admin del `.env`.
- Login contra `admin_user` + `last_login_at` + audit.
- Página **/ajustes** (solo super-admin): crear usuario, rol, activar/desactivar, reset contraseña, asignar casas + feed de actividad.
- Atribución `sent_by_user_id` al enviar respuesta humana (la columna visible "quién contestó" se monta con el rebuild del Inbox).
- Tests: 280 pass, 11 nuevos unit; 5 de DB escritos (skip sin Postgres). Sin regresiones.
- **PENDIENTE: desplegar** (rebuild + `alembic upgrade head` corre 0018). Nada subido aún.
- Deuda: ~32 tests huérfanos del rollback Batch-1 siguen en rojo (se arreglan al re-desplegar seguridad).

## Orden de fases
1. **Roles + equipo + log** ✅ código hecho (falta desplegar)
2. Reestructura de menú + Inbox + Casas dentro de WhatsApp
3. Bot (monitor) + auto-protección
4. Métricas (KPIs pro)
5. Borrar informes (múltiple)
6. Rediseño visual extendido a todo el panel
(El dashboard rediseñado se porta en paralelo según convenga.)
