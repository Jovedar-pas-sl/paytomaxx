# Database Schema

Postgres 16, single database `kpi`. Owner: rol `kpi` (ver `scripts/init-db.sh`). Migraciones en `kpi-app/alembic/versions/`.

## Diagrama de relaciones

```
                            ┌──────────┐
                            │  casa    │ 1 local de masajes
                            └────┬─────┘
                                 │ 1..N
                            ┌────▼──────┐
                            │ wa_number │ 1 WhatsApp asignado a la casa
                            └────┬──────┘
                                 │ 1..N
┌──────────┐       1..N    ┌─────▼────────┐      N..1      ┌─────────┐
│ contact  │◄──────────────┤ conversation ├────────────────►  casa   │
└──────────┘               └──────┬───────┘                └─────────┘
                                  │ 1..N
                            ┌─────▼──────┐
                            │  message   │
                            └────────────┘
                                  ▲
                                  │ 1..1
                            ┌─────┴──────┐         ┌────────────────────┐
                            │  analysis  │         │ casa_meta_analysis │
                            │ (per conv) │         │ (per casa × period)│
                            └────────────┘         └────────────────────┘

┌───────┐        ┌──────────────┐
│ alert │        │  admin_user  │
└───────┘        └──────────────┘
```

## Tablas

### `casa`  (migración 0003)

Una casa = un local físico / equipo / inbox lógico.

| Columna         | Tipo                   | Notas |
|-----------------|------------------------|-------|
| `id`            | SERIAL PK              | |
| `name`          | TEXT NOT NULL          | Display name |
| `waha_session`  | TEXT UNIQUE NULLABLE   | **Legacy** (0005 hizo nullable). Queda por compat; ahora se usa `wa_number.session` |
| `account_id`    | TEXT                   | Alias friendly para URL (`/casas/<account_id>`) |
| `created_at`    | TIMESTAMPTZ DEFAULT now() | |

### `wa_number`  (migración 0004)

Cada WhatsApp conectado a una casa (oficial, secundario, recepción…). Una casa tiene N wa_numbers.

| Columna    | Tipo                | Notas |
|------------|---------------------|-------|
| `id`       | SERIAL PK           | |
| `casa_id`  | INT FK → casa(id) ON DELETE CASCADE | Borra casa → borra sus WAs |
| `session`  | TEXT UNIQUE NOT NULL | Nombre de session en WAHA (globalmente único) |
| `label`    | TEXT NOT NULL       | "Oficial", "Secundario"… |
| `phone`    | TEXT NULLABLE       | Rellena cuando WAHA reporta `phone` en WORKING |
| `created_at`| TIMESTAMPTZ DEFAULT now() | |

Índice: `ix_wa_number_casa (casa_id)`.

### `contact`  (migración 0003)

Un contacto = un JID de WhatsApp. Puede ser `@c.us` (teléfono) o `@lid` (privacy).

| Columna    | Tipo                | Notas |
|------------|---------------------|-------|
| `id`       | BIGSERIAL PK        | |
| `waha_jid` | TEXT UNIQUE NOT NULL| `34600000000@c.us` o `xxxx@lid` |
| `name`     | TEXT NULLABLE       | pushName / notifyName detectado |
| `phone`    | TEXT NULLABLE       | Solo si `@c.us`; null para `@lid` |
| `created_at`| TIMESTAMPTZ DEFAULT now() | |

### `conversation`  (migración 0003 + 0004)

Una conversación = (WhatsApp × Contacto). Si el mismo cliente escribe a 2 WAs, son 2 convs.

| Columna            | Tipo                   | Notas |
|--------------------|------------------------|-------|
| `id`               | BIGSERIAL PK           | |
| `casa_id`          | INT FK → casa(id)      | |
| `wa_number_id`     | INT FK → wa_number(id) ON DELETE SET NULL | |
| `contact_id`       | BIGINT FK → contact(id)| |
| `status`           | TEXT DEFAULT 'open'    | open / resolved / merged |
| `unread_count`     | INT DEFAULT 0          | Incrementa en cada incoming; reset al abrir |
| `last_message_at`  | TIMESTAMPTZ            | Índice para ordenar |
| `created_at`       | TIMESTAMPTZ DEFAULT now() | |
| `updated_at`       | TIMESTAMPTZ DEFAULT now() | |

Constraint: `UNIQUE (wa_number_id, contact_id)` — evita duplicados por WA.

### `message`  (migración 0003)

Un mensaje individual (entrante o saliente, texto o media).

| Columna         | Tipo                | Notas |
|-----------------|---------------------|-------|
| `id`            | BIGSERIAL PK        | |
| `conversation_id`| BIGINT FK → conversation(id) ON DELETE CASCADE | |
| `waha_msg_id`   | TEXT UNIQUE NOT NULL | Idempotencia del webhook |
| `direction`     | TEXT CHECK (in/out) | |
| `body`          | TEXT NULLABLE       | Texto; null si solo media |
| `media_url`     | TEXT NULLABLE       | URL en WAHA (requiere proxy `/media/<id>`) |
| `media_mime`    | TEXT NULLABLE       | image/* · video/* · audio/* · application/pdf |
| `ack`           | INT DEFAULT 0       | 0 pending · 1 sent · 2 delivered · 3 read · 4 played |
| `created_at`    | TIMESTAMPTZ         | Timestamp del mensaje (no del insert) |

### `analysis`  (migraciones 0001 + 0006 + 0007)

Un análisis IA por conversación. UPSERT: si ya existe se sobrescribe (última versión).

| Columna         | Tipo                | Fuente (skill) |
|-----------------|---------------------|----------------|
| `id`            | BIGSERIAL PK        | |
| `conversation_id`| BIGINT UNIQUE FK   | |
| `account_id`    | INT (casa_id)       | Para agregación |
| `wa_number_id`  | INT NULLABLE (0006) | Para filtrar por WA |
| `mood_label`    | TEXT                | `mood` |
| `mood_score`    | INT CHECK 1..10     | `mood` |
| `mood_reasoning`| TEXT                | `mood` |
| `rt_p50_ms`     | INT                 | `response_time` (det.) |
| `rt_p90_ms`     | INT                 | `response_time` |
| `rt_max_ms`     | INT                 | `response_time` |
| `treat_carinoso`| INT CHECK 0..10     | `treatment` |
| `treat_profesional`| INT CHECK 0..10  | `treatment` |
| `treat_vendedor`| INT CHECK 0..10     | `treatment` |
| `treat_seco`    | INT CHECK 0..10     | `treatment` |
| `conv_probability`| NUMERIC(3,2)      | `conversion` |
| `red_flags`     | JSONB               | `red_flags` (lista) |
| `coaching`      | JSONB (0007)        | `coaching` (objeto) |
| `analyzed_at`   | TIMESTAMPTZ DEFAULT now() | |

### `casa_meta_analysis`  (migración 0002 + 0006)

Análisis agregado sobre N (=50) conversaciones de una casa.

| Columna        | Tipo                  | |
|----------------|-----------------------|-|
| `id`           | BIGSERIAL PK          | |
| `account_id`   | INT (casa_id)         | |
| `wa_number_id` | INT NULLABLE          | Si filtrado por WA concreto |
| `period_label` | TEXT                  | `24h`, `7d`, `30d`, `90d`, `all` |
| `client_profile`| JSONB                | Perfil del cliente tipo |
| `strengths`    | JSONB                 | Fortalezas detectadas |
| `improvements` | JSONB                 | Áreas de mejora |
| `sample_size`  | INT                   | Nº convs en la muestra |
| `analyzed_at`  | TIMESTAMPTZ DEFAULT now() | |

### `alert`  (migración 0001)

| Columna          | Tipo           | Notas |
|------------------|----------------|-------|
| `id`             | BIGSERIAL PK   | |
| `type`           | TEXT           | `red_flag` · `slow_response` · `wa_disconnected` · `wa_needs_qr` · `merge_suggestion` · `unassigned_wa_session` |
| `severity`       | TEXT           | `critical` · `warning` · `info` |
| `inbox_id`       | INT NULLABLE   | casa_id |
| `conversation_id`| BIGINT NULLABLE| |
| `message`        | TEXT           | Descripción humana |
| `created_at`     | TIMESTAMPTZ    | |
| `acknowledged_at`| TIMESTAMPTZ NULL| NULL = activa; timestamp = silenciada |

### `admin_user`  (migración 0001)

| Columna        | Tipo                  | |
|----------------|-----------------------|-|
| `id`           | SERIAL PK             | |
| `email`        | TEXT UNIQUE NOT NULL  | |
| `password_hash`| TEXT NOT NULL         | bcrypt cost 12 |
| `created_at`   | TIMESTAMPTZ           | |

Single-user sistema — se bootstrapea desde `.env` (`KPI_ADMIN_EMAIL` + `KPI_ADMIN_PASSWORD_HASH`).

## Índices recomendados (pendiente — ver RUNBOOK P0)

```sql
CREATE INDEX ix_analysis_account_analyzed_at ON analysis (account_id, analyzed_at DESC);
CREATE INDEX ix_analysis_conv ON analysis (conversation_id);
CREATE INDEX ix_message_conv_direction ON message (conversation_id, direction);
CREATE INDEX ix_message_conv_created ON message (conversation_id, created_at);
CREATE INDEX ix_conversation_casa_last_msg ON conversation (casa_id, last_message_at DESC);
CREATE INDEX ix_alert_ack ON alert (acknowledged_at) WHERE acknowledged_at IS NULL;
```

Pendiente de aplicar en una migración 0009.

## Ciclo de vida de una conversación

1. Cliente manda 1er mensaje → webhook → insert `contact` + `conversation` + `message`
2. Admin responde → insert `message` (out) → `unread_count = 0` al abrir chat
3. Tras umbral → enqueue `analyze_conversation_job` → upsert `analysis`
4. Si hay red flags críticos → insert `alert`
5. Admin merge con hermana → `message.conversation_id` se remap + `conversation.status = 'merged'`
6. Tras N días inactiva → admin cierra → `conversation.status = 'resolved'`
