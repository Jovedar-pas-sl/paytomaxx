-- seed_faqs.sql — siembra FAQs curadas en casa_profile.faqs.
-- Sara las inyecta en su prompt (build_faq_block) cuando responde.
--
-- USO (en el VPS):
--   cd /opt/wa-ops
--   docker compose exec -T postgres psql -U postgres -d kpi < seed_faqs.sql
--
-- Idempotente: reejecútalo cuando quieras para actualizar las FAQs.
-- Keyed por casa.name (ILIKE) para no depender de los casa_id numéricos.
-- NO incluye la dirección exacta a propósito: el modelo es "te paso la ubi al
-- confirmar" (decisión confirm-first). Verifica el mapeo con el SELECT de abajo;
-- si los nombres no coinciden, ajusta los ILIKE.

\echo '== Casas actuales (verifica nombre <-> casa_id; ajusta los ILIKE si hace falta) =='
SELECT id, name FROM casa ORDER BY id;

\echo ''
\echo '== Sembrando FAQs por casa =='

-- ── MADRID ───────────────────────────────────────────────────────────
UPDATE casa_profile cp SET faqs = $$[
  {"triggers":["pago","pagar","efectivo","tarjeta","bizum","transferencia","cash","card"],
   "reply_es":"efectivo, Bizum o transferencia, cariño 💳 todo discreto, sin sorpresas en tu extracto 😉",
   "reply_en":"cash, Bizum or transfer, love 💳 all discreet, nothing odd on your statement 😉"},
  {"triggers":["donde","dónde","ubicacion","ubicación","direccion","dirección","como llego","llegar","zona","metro","parking","sitio"],
   "reply_es":"estamos en zona Chamartín, súper fácil en metro o coche y discretísimo 🤫 te paso la ubi exacta en cuanto reservemos. ¿te la dejo lista?",
   "reply_en":"we're in Chamartín, easy by metro or car and super discreet 🤫 I'll send the exact spot once we book. shall I set it up?"},
  {"triggers":["os vi","te vi","os he visto","te he visto","destacamos","loquosex","mileroticos","slumi","pasion","anuncio","google","instagram"],
   "reply_es":"aii qué bien que nos encontraras 😍 en persona son aún mejor que en la foto. dime, ¿qué perfil te gustó y te lo reservo?",
   "reply_en":"love that you found us 😍 they're even better in person. tell me which one caught your eye and I'll book her?"},
  {"triggers":["hotel","domicilio","mi casa","vienes","desplazamiento","salida","salidas","outcall"],
   "reply_es":"claro que vamos a tu hotel 😊 mándame tu ubicación 📍 y la dirección (calle + hotel + piso) y te digo el precio exacto, guapo",
   "reply_en":"of course we come to your hotel 😊 send me your location 📍 and the address and I'll give you the exact price"},
  {"triggers":["discreto","discreta","discrecion","discreción","privado","factura","mi mujer","mi novia","tengo pareja"],
   "reply_es":"tranquilo amor, aquí discretísimo 🤫 nadie se entera y nada raro en tu extracto. ¿cuándo te viene?",
   "reply_en":"all good love, super discreet here 🤫 nobody knows. when works for you?"}
]$$::jsonb, updated_at = now()
FROM casa c WHERE c.id = cp.casa_id AND c.name ILIKE '%madrid%';

-- ── MARBELLA (Mansión Babylon) ───────────────────────────────────────
UPDATE casa_profile cp SET faqs = $$[
  {"triggers":["pago","pagar","efectivo","tarjeta","bizum","transferencia","cash","card"],
   "reply_es":"efectivo, Bizum o transferencia, cariño 💳 todo discreto, sin sorpresas en tu extracto 😉",
   "reply_en":"cash, Bizum or transfer, love 💳 all discreet, nothing odd on your statement 😉"},
  {"triggers":["donde","dónde","ubicacion","ubicación","direccion","dirección","como llego","llegar","zona","parking","sitio","autovia","autovía"],
   "reply_es":"zona residencial tranquila, fácil desde la autovía y discretísimo 🤫 te paso la ubi exacta al reservar. ¿te reservo?",
   "reply_en":"quiet residential area, easy from the highway and super discreet 🤫 I'll send the exact spot once we book. shall I book you?"},
  {"triggers":["yate","yacht","barco","boat","evento","fiesta privada","puerto banus","puerto banús"],
   "reply_es":"sí, hacemos yate y eventos privados en Puerto Banús 🥂 cuéntame qué tienes en mente y lo cuadro",
   "reply_en":"yes, we do yacht trips and private events at Puerto Banús 🥂 tell me what you have in mind"},
  {"triggers":["os vi","te vi","os he visto","te he visto","anuncio","google","instagram","loquosex","mileroticos"],
   "reply_es":"aii qué bien que nos encontraras 😍 en persona son aún mejor. dime, ¿qué perfil te gustó y te lo reservo?",
   "reply_en":"love that you found us 😍 even better in person. which one caught your eye? I'll book her"},
  {"triggers":["hotel","domicilio","vienes","desplazamiento","salida","salidas","outcall"],
   "reply_es":"claro que vamos a tu hotel 😊 mándame tu ubicación 📍 y la dirección y te digo el precio exacto, guapo",
   "reply_en":"of course we come to your hotel 😊 send me your location 📍 and the address and I'll quote the exact price"},
  {"triggers":["discreto","discrecion","discreción","privado","factura","mi mujer","tengo pareja"],
   "reply_es":"tranquilo amor, aquí discretísimo 🤫 nadie se entera. ¿cuándo te viene?",
   "reply_en":"all good love, super discreet 🤫 nobody knows. when works?"}
]$$::jsonb, updated_at = now()
FROM casa c WHERE c.id = cp.casa_id AND (c.name ILIKE '%marbella%' OR c.name ILIKE '%babylon%');

-- ── IBIZA (bot "Chloé") — sobre todo salidas: hotel/villa/yate/club ──
UPDATE casa_profile cp SET faqs = $$[
  {"triggers":["pago","pagar","efectivo","tarjeta","cash","card","visa","mastercard"],
   "reply_es":"efectivo 💶 o Visa/Mastercard 💳 (con recargo mínimo), todo discreto y sin sorpresas 😉",
   "reply_en":"cash 💶 or Visa/Mastercard 💳 (small surcharge), all discreet, no surprises 😉"},
  {"triggers":["donde","dónde","ubicacion","ubicación","como llego","llegar","hotel","villa","domicilio","vienes","salida","outcall"],
   "reply_es":"vamos a tu hotel, villa o yate, guapo 🛥️ tú eliges el escenario. mándame tu ubicación 📍 y te digo el precio. ¿para cuándo lo montamos?",
   "reply_en":"we come to your hotel, villa or yacht 🛥️ you pick the scene. send your location 📍 and I'll quote it. when shall we set it up?"},
  {"triggers":["club","discoteca","pacha","ushuaia","amnesia","hi ibiza","party","fiesta"],
   "reply_es":"una chica guapa contigo en Pacha o Ushuaïa te cambia la noche 😈 ¿quieres verlas?",
   "reply_en":"a gorgeous girl with you at Pacha or Ushuaïa changes the whole night 😈 wanna see them?"},
  {"triggers":["yate","yacht","barco","boat","bateau"],
   "reply_es":"salidas a yate sí 🛥️ lo traes tú o te lo organizamos. dime fecha y lo cuadro",
   "reply_en":"yacht trips yes 🛥️ you bring the boat or we arrange it. give me a date and I'll sort it"},
  {"triggers":["os vi","te vi","anuncio","google","instagram"],
   "reply_es":"aii qué bien que nos encontraras 😍 en persona son aún mejor. dime qué buscas y te lo monto",
   "reply_en":"love that you found us 😍 even better in person. tell me what you're after and I'll sort it"}
]$$::jsonb, updated_at = now()
FROM casa c WHERE c.id = cp.casa_id AND c.name ILIKE '%ibiza%';

-- ── VLC (Valencia) — sesiones cortas; pago por confirmar ─────────────
UPDATE casa_profile cp SET faqs = $$[
  {"triggers":["pago","pagar","efectivo","tarjeta","cash","card","bizum"],
   "reply_es":"efectivo o tarjeta, guapo 💳 todo discreto; recepción te lo confirma al reservar 😉",
   "reply_en":"cash or card, handsome 💳 all discreet; reception confirms it when you book 😉"},
  {"triggers":["donde","dónde","ubicacion","ubicación","como llego","llegar","zona","parking","sitio"],
   "reply_es":"muy céntrico y discreto, cielo 🤫 te paso la ubi exacta en cuanto reservemos. ¿te la dejo lista?",
   "reply_en":"very central and discreet, love 🤫 I'll send the exact spot once we book. shall I set it up?"},
  {"triggers":["hotel","domicilio","vienes","desplazamiento","salida","salidas","outcall"],
   "reply_es":"sí hacemos salidas a hotel/domicilio 😊 mándame tu ubicación 📍 y la dirección y te digo el precio, guapo",
   "reply_en":"yes we do hotel/outcall 😊 send your location 📍 and the address and I'll quote it"},
  {"triggers":["os vi","te vi","anuncio","google","instagram","loquosex","mileroticos"],
   "reply_es":"aii qué bien que nos encontraras 😍 en persona son aún mejor. dime qué buscas y te lo reservo",
   "reply_en":"love that you found us 😍 even better in person. tell me what you're after and I'll book it"},
  {"triggers":["discreto","discrecion","discreción","privado","factura","mi mujer","tengo pareja"],
   "reply_es":"tranquilo amor, aquí discretísimo 🤫 nadie se entera. ¿cuándo te viene?",
   "reply_en":"all good love, super discreet 🤫 nobody knows. when works?"}
]$$::jsonb, updated_at = now()
FROM casa c WHERE c.id = cp.casa_id AND (c.name ILIKE '%valencia%' OR c.name ILIKE '%vlc%');

\echo ''
\echo '== Resultado: casas con FAQs sembradas =='
SELECT cp.casa_id, c.name, jsonb_array_length(cp.faqs) AS num_faqs
FROM casa_profile cp JOIN casa c ON c.id = cp.casa_id
WHERE jsonb_array_length(coalesce(cp.faqs,'[]'::jsonb)) > 0
ORDER BY cp.casa_id;
