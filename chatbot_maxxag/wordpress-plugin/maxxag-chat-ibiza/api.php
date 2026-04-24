<?php
/**
 * Maxxag Chat — WordPress REST API endpoints
 * Security-hardened version with ticket system
 */
if (!defined('ABSPATH')) exit;

// ── Security headers on all REST responses ──────────────────────
add_filter('rest_post_dispatch', function ($response) {
    $response->header('X-Content-Type-Options', 'nosniff');
    $response->header('X-Frame-Options', 'DENY');
    return $response;
}, 10, 1);

add_action('rest_api_init', function () {
    $ns = 'maxxag/v1';

    // Public (with rate limiting)
    register_rest_route($ns, '/chat', ['methods' => 'POST', 'callback' => 'maxxag_api_chat', 'permission_callback' => '__return_true']);
    register_rest_route($ns, '/girls', ['methods' => 'GET', 'callback' => 'maxxag_api_girls', 'permission_callback' => function() {
        $key = 'maxxag_pub_' . md5($_SERVER['REMOTE_ADDR'] ?? '');
        $hits = (int) get_transient($key);
        if ($hits >= 20) return false;
        set_transient($key, $hits + 1, 60);
        return true;
    }]);
    register_rest_route($ns, '/config', ['methods' => 'GET', 'callback' => 'maxxag_api_config', 'permission_callback' => function() {
        $key = 'maxxag_cfg_' . md5($_SERVER['REMOTE_ADDR'] ?? '');
        $hits = (int) get_transient($key);
        if ($hits >= 20) return false;
        set_transient($key, $hits + 1, 60);
        return true;
    }]);

    // Admin (token-protected)
    register_rest_route($ns, '/admin/girls', ['methods' => 'GET', 'callback' => 'maxxag_admin_girls', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/girl', ['methods' => 'POST', 'callback' => 'maxxag_admin_girl_save', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/girl/(?P<id>[\\w-]+)', ['methods' => 'DELETE', 'callback' => 'maxxag_admin_girl_delete', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/toggle', ['methods' => 'POST', 'callback' => 'maxxag_admin_toggle', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/config', ['methods' => ['GET', 'POST'], 'callback' => 'maxxag_admin_config', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/learn', ['methods' => 'POST', 'callback' => 'maxxag_admin_learn', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/logs', ['methods' => 'GET', 'callback' => 'maxxag_admin_logs', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/heatmap', ['methods' => 'GET', 'callback' => 'maxxag_admin_heatmap', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/tickets', ['methods' => 'GET', 'callback' => 'maxxag_admin_tickets', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/tickets/delete', ['methods' => 'POST', 'callback' => 'maxxag_admin_tickets_delete', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/tickets/import', ['methods' => 'POST', 'callback' => 'maxxag_admin_tickets_import', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/ticket/(?P<id>[\\w-]+)', ['methods' => 'GET', 'callback' => 'maxxag_admin_ticket_detail', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/upload', ['methods' => 'POST', 'callback' => 'maxxag_admin_upload', 'permission_callback' => 'maxxag_check_token']);
    register_rest_route($ns, '/admin/claude-status', ['methods' => 'GET', 'callback' => 'maxxag_admin_claude_status', 'permission_callback' => 'maxxag_check_token']);
});

// Claude last-error status for admin dashboard
function maxxag_admin_claude_status(WP_REST_Request $request): WP_REST_Response {
    $key = maxxag_get_anthropic_key();
    return new WP_REST_Response([
        'has_key'       => !empty($key),
        'key_prefix'    => !empty($key) ? substr($key, 0, 10) : '',
        'key_length'    => strlen($key),
        'last_error'    => get_option('maxxag_claude_last_error', ''),
    ]);
}

// ── Auth — cookie-based (maxxag_auth) + WP admin bypass + master-token ──
function maxxag_check_token(WP_REST_Request $request): bool {
    // Method 1: WordPress admins bypass everything
    if (current_user_can('manage_options')) return true;

    $stored       = get_option('maxxag_admin_token', '');
    $master_token = defined('MAXXAG_MASTER_TOKEN') ? MAXXAG_MASTER_TOKEN : '';
    if (empty($stored) && empty($master_token)) return false;

    // Brute-force lockout: 10 failures = 5 min ban
    $ip_key   = 'maxxag_bf_' . md5($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $failures = (int) get_transient($ip_key);
    if ($failures >= 10) return false;

    // Method 2: Cookie (set by /chat-admin/ login form — WordFence-safe)
    $provided = isset($_COOKIE['maxxag_auth']) ? $_COOKIE['maxxag_auth'] : '';
    // Method 3: X-Admin-Token header (legacy fallback for API clients)
    if (empty($provided)) {
        $provided = $request->get_header('X-Admin-Token');
    }
    if (empty($provided)) return false;

    $check = function ($candidate, $target) {
        if (empty($target)) return false;
        if (strpos($target, '$2y$') === 0 || strpos($target, '$2a$') === 0) {
            return password_verify($candidate, $target);
        }
        return hash_equals($target, $candidate);
    };
    $valid = $check($provided, $stored) || $check($provided, $master_token);

    if (!$valid) {
        set_transient($ip_key, $failures + 1, 300);
        return false;
    }
    delete_transient($ip_key);
    return true;
}

function maxxag_bot(): Maxxag_Chatbot {
    static $bot = null;
    if (!$bot) $bot = new Maxxag_Chatbot();
    return $bot;
}

// ── POST /chat — with rate limiting + ticket system ─────────────
function maxxag_api_chat(WP_REST_Request $request): WP_REST_Response {
    $bot  = maxxag_bot();
    $body = $request->get_json_params();

    // MED-1: Rate limiting (fixed off-by-one)
    $ip_key = 'maxxag_rl_' . md5($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $hits   = (int) get_transient($ip_key);
    if ($hits >= 30) {
        return new WP_REST_Response(['error' => 'Too many requests'], 429);
    }
    set_transient($ip_key, $hits + 1, 60);

    $message    = substr(trim($body['message'] ?? ''), 0, 1000);
    $session_id = $body['session_id'] ?? '';
    if (!preg_match('/^[0-9a-f\-]{36}$/i', $session_id)) {
        $session_id = wp_generate_uuid4();
    }
    $lang = strtolower($body['lang'] ?? 'es');
    if (!in_array($lang, ['es', 'en', 'fr', 'it'])) $lang = 'es';
    $client_name = substr(trim($body['name'] ?? ''), 0, 30);
    // Sanitize name: only letters, spaces, hyphens — strip newlines/tabs for prompt injection defense
    $client_name = preg_replace('/[^a-zA-ZáéíóúñüÁÉÍÓÚÑÜàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛäëïöüÄËÏÖÜçÇ \-]/u', '', $client_name);
    $client_name = trim($client_name);

    // Conversation history from transient
    $history_key = 'maxxag_hist_' . $session_id;
    $history = get_transient($history_key) ?: [];

    if (empty($message)) {
        // Don't create ticket here — only when client sends first real message
        return new WP_REST_Response([
            'session_id' => $session_id,
            'messages'   => $bot->get_greeting($lang, $client_name),
            'lang'       => $lang,
        ]);
    }

    $result = $bot->handle_message($session_id, $message, $lang, $history, $client_name);

    // Log to ticket + chat_logs
    $skip_log = ['escorts_disponibles', 'tarifas', 'horario', 'hotel_domicilio', 'reservar', 'contacto', 'menu', 'lang_en', 'lang_es', 'lang_fr', 'lang_it'];
    $bot_text = '';
    foreach ($result['messages'] as $m) {
        if (($m['type'] ?? '') === 'text') $bot_text .= ($bot_text ? ' | ' : '') . ($m['text'] ?? '');
    }

    try {
        // Always add to ticket
        $bot->add_to_ticket($session_id, $message, $bot_text, $lang, $client_name);
        // Only log free-text to chat_logs
        if (!in_array($message, $skip_log)) {
            $bot->log_conversation($session_id, $lang, $message, $bot_text);
            // Store in conversation history for Claude context
            $history[] = ['role' => 'user', 'content' => $message];
            $history[] = ['role' => 'assistant', 'content' => $bot_text];
            if (count($history) > 10) $history = array_slice($history, -10);
            set_transient($history_key, $history, 1800); // 30 min TTL
        }
    } catch (\Exception $e) {
        // never break chat
    }

    return new WP_REST_Response([
        'session_id' => $session_id,
        'messages'   => $result['messages'],
        'lang'       => $result['lang'],
    ]);
}

// ── GET /girls ──────────────────────────────────────────────────
function maxxag_api_girls(WP_REST_Request $request): WP_REST_Response {
    $bot   = maxxag_bot();
    $data  = $bot->load_json('girls.json');
    $girls = $data['girls'] ?? [];
    if ($request->get_param('available') === '1') {
        $girls = array_values(array_filter($girls, function($g) { return !empty($g['available_today']); }));
    }
    if ($request->get_param('outcall') === '1') {
        $girls = array_values(array_filter($girls, function($g) { return !empty($g['outcall']); }));
    }
    // Strip private fields from public response
    $public_fields = ['id', 'name', 'age', 'nationality', 'description', 'photo_url',
                      'available_today', 'outcall', 'escort_pareja', 'services', 'languages', 'city'];
    $girls = array_map(function($g) use ($public_fields) {
        return array_intersect_key($g, array_flip($public_fields));
    }, $girls);
    return new WP_REST_Response(['girls' => $girls]);
}

// ── GET /config ─────────────────────────────────────────────────
function maxxag_api_config(WP_REST_Request $request): WP_REST_Response {
    $bot = maxxag_bot();
    $cfg = $bot->load_json('config.json');
    // Strip private contact data from public response
    $site = $cfg['site'] ?? [];
    unset($site['whatsapp_recepcion'], $site['telegram_recepcion']);
    // Resolve relative avatar/logo paths to absolute URLs so the widget can load them
    if (!empty($site['bot_avatar']) && strpos($site['bot_avatar'], 'http') !== 0) {
        $site['bot_avatar'] = MAXXAG_CHAT_URL . 'widget/' . ltrim($site['bot_avatar'], '/');
    }
    if (!empty($site['logo_url']) && strpos($site['logo_url'], 'http') !== 0) {
        $site['logo_url'] = MAXXAG_CHAT_URL . 'widget/' . ltrim($site['logo_url'], '/');
    }
    return new WP_REST_Response([
        'site'     => $site,
        'rates'    => $cfg['rates'] ?? [],
        'schedule' => $cfg['schedule'] ?? [],
    ]);
}

// ── Admin: GET /admin/girls ─────────────────────────────────────
function maxxag_admin_girls(WP_REST_Request $request): WP_REST_Response {
    return new WP_REST_Response(maxxag_bot()->load_json('girls.json'));
}

// ── Admin: POST /admin/girl — HIGH-4: field allowlist ───────────
function maxxag_admin_girl_save(WP_REST_Request $request): WP_REST_Response {
    $bot  = maxxag_bot();
    $raw  = $request->get_json_params();

    // HIGH-4: Only accept known fields
    $allowed = ['id', 'name', 'age', 'nationality', 'description', 'photo_url', 'whatsapp', 'available_today', 'outcall', 'services', 'languages', 'city'];
    $body = array_intersect_key($raw, array_flip($allowed));
    $body['name']            = sanitize_text_field($body['name'] ?? '');
    $body['nationality']     = sanitize_text_field($body['nationality'] ?? '');
    $body['description']     = strip_tags(sanitize_text_field($body['description'] ?? ''));
    $body['photo_url']       = esc_url_raw($body['photo_url'] ?? '');
    $body['whatsapp']        = preg_replace('/[^0-9+]/', '', $body['whatsapp'] ?? '');
    $body['age']             = (int) ($body['age'] ?? 0);
    $body['available_today'] = !empty($body['available_today']);
    $body['outcall']         = !empty($body['outcall']);
    $body['city']            = sanitize_text_field($body['city'] ?? '');
    if (isset($body['services']) && is_array($body['services'])) {
        $body['services'] = array_map('sanitize_text_field', $body['services']);
    }
    if (isset($body['languages']) && is_array($body['languages'])) {
        $body['languages'] = array_map('sanitize_text_field', $body['languages']);
    }

    $data = $bot->load_json('girls.json');
    if (!isset($data['girls'])) $data['girls'] = [];

    $idx = null;
    foreach ($data['girls'] as $i => $g) {
        if (($g['id'] ?? '') === ($body['id'] ?? '')) { $idx = $i; break; }
    }

    if ($idx !== null) {
        $data['girls'][$idx] = array_merge($data['girls'][$idx], $body);
    } else {
        if (empty($body['id'])) $body['id'] = substr(wp_generate_uuid4(), 0, 8);
        $data['girls'][] = $body;
    }

    $bot->save_json('girls.json', $data);
    return new WP_REST_Response(['ok' => true, 'girl' => $body]);
}

// ── Admin: DELETE /admin/girl/<id> ──────────────────────────────
function maxxag_admin_girl_delete(WP_REST_Request $request): WP_REST_Response {
    $bot = maxxag_bot();
    $gid = sanitize_text_field($request->get_param('id'));
    $data = $bot->load_json('girls.json');
    $data['girls'] = array_values(array_filter($data['girls'] ?? [], function($g) use ($gid) { return ($g['id'] ?? '') !== $gid; }));
    $bot->save_json('girls.json', $data);
    return new WP_REST_Response(['ok' => true]);
}

// ── Admin: POST /admin/toggle ───────────────────────────────────
function maxxag_admin_toggle(WP_REST_Request $request): WP_REST_Response {
    $bot  = maxxag_bot();
    $body = $request->get_json_params();
    $gid  = sanitize_text_field($body['id'] ?? '');
    $data = $bot->load_json('girls.json');
    foreach ($data['girls'] as &$g) {
        if (($g['id'] ?? '') === $gid) {
            $g['available_today'] = $body['available_today'] ?? !($g['available_today'] ?? false);
            $bot->save_json('girls.json', $data);
            return new WP_REST_Response(['ok' => true, 'available_today' => $g['available_today']]);
        }
    }
    unset($g);
    return new WP_REST_Response(['error' => 'Not found'], 404);
}

// ── Admin: GET+POST /admin/config ───────────────────────────────
function maxxag_admin_config(WP_REST_Request $request): WP_REST_Response {
    $bot = maxxag_bot();
    if ($request->get_method() === 'GET') {
        return new WP_REST_Response($bot->load_json('config.json'));
    }
    $body = $request->get_json_params();
    unset($body['token']);
    $cfg = $bot->load_json('config.json');

    foreach (['rates', 'schedule', 'site', 'faqs'] as $key) {
        if (isset($body[$key])) {
            $is_body_assoc = is_array($body[$key]) && (array_values($body[$key]) !== $body[$key]);
            $is_cfg_assoc  = is_array($cfg[$key] ?? null) && (array_values($cfg[$key]) !== $cfg[$key]);
            if ($is_body_assoc && $is_cfg_assoc) {
                $cfg[$key] = array_merge($cfg[$key], $body[$key]);
            } else {
                $cfg[$key] = $body[$key];
            }
        }
    }
    $bot->save_json('config.json', $cfg);
    return new WP_REST_Response(['ok' => true]);
}

// ── Admin: POST /admin/learn ────────────────────────────────────
function maxxag_admin_learn(WP_REST_Request $request): WP_REST_Response {
    $bot  = maxxag_bot();
    $logs = $bot->load_json('chat_logs.json') ?: [];
    $tickets = $bot->load_json('tickets.json') ?: [];
    if (count($logs) < 3 && count($tickets) < 3) {
        return new WP_REST_Response(['ok' => true, 'message' => 'Necesitas al menos 3 conversaciones para analizar.']);
    }
    // Build conversation context from tickets (richer than logs)
    $text = '';
    $recent_tickets = array_slice($tickets, -30);
    foreach ($recent_tickets as $t) {
        $name = $t['client_name'] ?? 'Anónimo';
        $lang = $t['lang'] ?? 'es';
        $text .= "--- Conversación ({$name}, {$lang}) ---\n";
        foreach ($t['messages'] ?? [] as $m) {
            $text .= "Cliente: " . ($m['user'] ?? '') . "\nBot: " . ($m['bot'] ?? '') . "\n";
        }
        $text .= "\n";
    }
    // Also add recent free-text logs
    $recent_logs = array_slice($logs, -30);
    foreach ($recent_logs as $entry) {
        $text .= "Cliente: " . ($entry['user'] ?? '') . "\nBot: " . ($entry['bot'] ?? '') . "\n";
    }

    $api_key = maxxag_get_anthropic_key();
    if (empty($api_key)) {
        return new WP_REST_Response(['error' => 'No API key configurada'], 500);
    }

    $system_prompt = 'Eres un analista experto de conversaciones de un chatbot de un centro de masajes eróticos. Analiza las conversaciones y devuelve un JSON con este formato EXACTO:

{
  "resumen": "Resumen breve de las conversaciones analizadas",
  "total_conversaciones": numero,
  "idiomas": {"es": N, "en": N},
  "temas_frecuentes": ["tema1", "tema2", "tema3"],
  "preguntas_sin_respuesta": ["pregunta que el bot no supo contestar"],
  "sentimiento": "positivo/neutro/negativo",
  "tasa_conversion": "porcentaje estimado de clientes que contactaron recepción",
  "mejoras": ["sugerencia de mejora 1", "sugerencia 2"],
  "faqs": [{"triggers":["palabra1","palabra2"],"reply_es":"respuesta sugerida","reply_en":"suggested answer"}]
}

REGLAS:
- Devuelve SOLO el JSON, nada más
- No inventes datos, analiza solo lo que ves
- Las FAQs son para preguntas frecuentes que el bot no cubre aún
- El resumen debe ser útil para el dueño del negocio
- Máximo 5 FAQs nuevas';

    $response = wp_remote_post('https://api.anthropic.com/v1/messages', [
        'timeout' => 20,
        'headers' => ['Content-Type' => 'application/json', 'x-api-key' => $api_key, 'anthropic-version' => '2023-06-01'],
        'body' => wp_json_encode([
            'model' => MAXXAG_CLAUDE_MODEL, 'max_tokens' => 1500,
            'system' => $system_prompt,
            'messages' => [['role' => 'user', 'content' => "Analiza estas conversaciones y devuelve el JSON:\n\n" . substr($text, 0, 8000)]],
        ]),
    ]);
    if (is_wp_error($response)) {
        return new WP_REST_Response(['error' => 'Error conectando con Claude. Intenta de nuevo.'], 500);
    }
    $status = (int) wp_remote_retrieve_response_code($response);
    if ($status !== 200) {
        return new WP_REST_Response(['error' => 'Claude API error (HTTP ' . $status . ')'], 500);
    }
    $data = json_decode(wp_remote_retrieve_body($response), true);
    $raw  = $data['content'][0]['text'] ?? '';
    // Strip markdown fences
    $raw = preg_replace('/```(?:json)?\s*/i', '', $raw);
    $raw = preg_replace('/```\s*/', '', $raw);
    $raw = trim($raw);
    // Find JSON object
    $start = strpos($raw, '{');
    $end   = strrpos($raw, '}');
    if ($start === false || $end === false) {
        return new WP_REST_Response(['ok' => true, 'message' => 'No se pudo analizar. Intenta de nuevo.']);
    }
    $json_str = substr($raw, $start, $end - $start + 1);
    $json_str = preg_replace('/,\s*\}/', '}', $json_str);
    $json_str = preg_replace('/,\s*\]/', ']', $json_str);
    $analysis = json_decode($json_str, true);
    if (!is_array($analysis)) {
        return new WP_REST_Response(['ok' => true, 'message' => 'Error al procesar el análisis. Intenta de nuevo.']);
    }

    // Extract and save FAQs if present
    $added_faqs = 0;
    if (!empty($analysis['faqs']) && is_array($analysis['faqs'])) {
        $valid_faqs = array_values(array_filter($analysis['faqs'], function ($f) {
            return is_array($f) && isset($f['triggers'], $f['reply_es']) && is_array($f['triggers']) && is_string($f['reply_es']);
        }));
        if (!empty($valid_faqs)) {
            $cfg = $bot->load_json('config.json');
            if (!isset($cfg['faqs'])) $cfg['faqs'] = [];
            $cfg['faqs'] = array_merge($cfg['faqs'], $valid_faqs);
            $bot->save_json('config.json', $cfg);
            $added_faqs = count($valid_faqs);
        }
    }

    return new WP_REST_Response([
        'ok' => true,
        'analysis' => $analysis,
        'added_faqs' => $added_faqs,
    ]);
}

// ── Admin: GET /admin/logs — MED-2: limit capped ────────────────
function maxxag_admin_logs(WP_REST_Request $request): WP_REST_Response {
    $bot   = maxxag_bot();
    $logs  = $bot->load_json('chat_logs.json');
    $limit = max(1, min((int)($request->get_param('limit') ?? 100), 500));
    return new WP_REST_Response(['logs' => array_slice($logs, -$limit), 'total' => count($logs)]);
}

// ── Admin: GET /admin/heatmap ───────────────────────────────────
function maxxag_admin_heatmap(WP_REST_Request $request): WP_REST_Response {
    $bot   = maxxag_bot();
    $logs  = $bot->load_json('chat_logs.json');
    $girls = $bot->load_json('girls.json')['girls'] ?? [];
    $result = [];
    $max_count = 1;
    foreach ($girls as $g) {
        $name_lc = strtolower($g['name'] ?? '');
        $count = 0;
        foreach ($logs as $l) {
            if (stripos($l['user'] ?? '', $name_lc) !== false || stripos($l['bot'] ?? '', $name_lc) !== false) $count++;
        }
        if ($count > $max_count) $max_count = $count;
        $result[] = ['id' => $g['id'] ?? '', 'name' => $g['name'] ?? '', 'photo_url' => $g['photo_url'] ?? '', 'count' => $count, 'available' => !empty($g['available_today'])];
    }
    usort($result, function($a, $b) { return $b['count'] - $a['count']; });
    foreach ($result as &$r) { $r['heat'] = round($r['count'] / $max_count, 2); }
    return new WP_REST_Response(['heatmap' => $result, 'total_logs' => count($logs), 'max_count' => $max_count]);
}

// ── Admin: GET /admin/tickets — list all tickets ────────────────
function maxxag_admin_tickets(WP_REST_Request $request): WP_REST_Response {
    $bot     = maxxag_bot();
    $tickets = $bot->load_json('tickets.json');
    // Sort by last activity (newest first)
    usort($tickets, function($a, $b) { return ($b['updated_at'] ?? 0) - ($a['updated_at'] ?? 0); });
    $limit = max(1, min((int)($request->get_param('limit') ?? 50), 200));
    return new WP_REST_Response(['tickets' => array_slice($tickets, 0, $limit), 'total' => count($tickets)]);
}

// ── Admin: GET /admin/ticket/<id> — single ticket detail ────────
function maxxag_admin_ticket_detail(WP_REST_Request $request): WP_REST_Response {
    $bot     = maxxag_bot();
    $tid     = sanitize_text_field($request->get_param('id'));
    $tickets = $bot->load_json('tickets.json');
    foreach ($tickets as $t) {
        if (($t['id'] ?? '') === $tid) {
            return new WP_REST_Response($t);
        }
    }
    return new WP_REST_Response(['error' => 'Ticket not found'], 404);
}

// ── Admin: POST /admin/upload — file upload for photos/logos ────
function maxxag_admin_upload(WP_REST_Request $request): WP_REST_Response {
    // Check for uploaded file
    $files = $request->get_file_params();
    if (empty($files['file'])) {
        return new WP_REST_Response(['error' => 'No file uploaded'], 400);
    }

    $file = $files['file'];
    $type = sanitize_text_field($request->get_param('type') ?: 'girl'); // girl or logo

    // Validate file type
    $allowed_types = ['image/jpeg', 'image/png', 'image/webp'];
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime  = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);

    if (!in_array($mime, $allowed_types)) {
        return new WP_REST_Response(['error' => 'Only JPG, PNG, WEBP allowed'], 400);
    }

    // Validate file size (max 5MB)
    if ($file['size'] > 5 * 1024 * 1024) {
        return new WP_REST_Response(['error' => 'Max 5MB'], 400);
    }

    // Determine upload directory
    $upload_dir = wp_upload_dir();
    $sub = ($type === 'logo') ? 'maxxag/logos' : 'maxxag/girls';
    $target_dir = $upload_dir['basedir'] . '/' . $sub;
    $target_url = $upload_dir['baseurl'] . '/' . $sub;

    if (!file_exists($target_dir)) {
        wp_mkdir_p($target_dir);
    }

    // Generate safe filename
    $ext = 'jpg';
    if ($mime === 'image/png') $ext = 'png';
    if ($mime === 'image/webp') $ext = 'webp';
    $filename = $type . '_' . substr(md5(uniqid()), 0, 8) . '_' . time() . '.' . $ext;
    $target_path = $target_dir . '/' . $filename;

    // Move uploaded file
    if (!move_uploaded_file($file['tmp_name'], $target_path)) {
        return new WP_REST_Response(['error' => 'Upload failed'], 500);
    }

    $url = $target_url . '/' . $filename;

    return new WP_REST_Response([
        'ok'       => true,
        'url'      => $url,
        'filename' => $filename,
    ]);
}

// ── Admin: POST /admin/tickets/delete — bulk delete tickets ─────
function maxxag_admin_tickets_delete(WP_REST_Request $request): WP_REST_Response {
    $bot  = maxxag_bot();
    $body = $request->get_json_params();
    $ids  = $body['ids'] ?? [];
    if (!is_array($ids) || empty($ids)) {
        return new WP_REST_Response(['error' => 'No IDs provided'], 400);
    }
    $ids = array_map('sanitize_text_field', $ids);
    $tickets = $bot->load_json('tickets.json');
    $before  = count($tickets);
    $tickets = array_values(array_filter($tickets, function($t) use ($ids) {
        return !in_array($t['id'] ?? '', $ids);
    }));
    $deleted = $before - count($tickets);
    $bot->save_json('tickets.json', $tickets);
    return new WP_REST_Response(['ok' => true, 'deleted' => $deleted]);
}

// ── Admin: POST /admin/tickets/import ──────────────────────────
function maxxag_admin_tickets_import(WP_REST_Request $request): WP_REST_Response {
    $bot  = maxxag_bot();
    $body = $request->get_json_params();
    $new_tickets = $body['tickets'] ?? [];
    if (!is_array($new_tickets) || empty($new_tickets)) {
        return new WP_REST_Response(['error' => 'No tickets to import'], 400);
    }
    $tickets = $bot->load_json('tickets.json') ?: [];
    $imported = 0;
    foreach ($new_tickets as $t) {
        if (!is_array($t) || empty($t['messages'])) continue;
        $tickets[] = [
            'id'          => sanitize_text_field($t['id'] ?? wp_generate_uuid4()),
            'client_name' => sanitize_text_field($t['client_name'] ?? ''),
            'status'      => in_array($t['status'] ?? '', ['open', 'closed']) ? $t['status'] : 'closed',
            'lang'        => sanitize_text_field($t['lang'] ?? 'es'),
            'created_at'  => intval($t['created_at'] ?? time()),
            'updated_at'  => intval($t['updated_at'] ?? time()),
            'messages'    => array_map(function($m) {
                return [
                    'ts'   => intval($m['ts'] ?? time()),
                    'user' => substr(sanitize_text_field($m['user'] ?? ''), 0, 500),
                    'bot'  => substr(sanitize_text_field($m['bot'] ?? ''), 0, 1000),
                ];
            }, array_slice($t['messages'], 0, 100)),
            'summary'     => sanitize_text_field($t['summary'] ?? ''),
        ];
        $imported++;
    }
    if (count($tickets) > 500) $tickets = array_slice($tickets, -500);
    $bot->save_json('tickets.json', $tickets);
    return new WP_REST_Response(['ok' => true, 'imported' => $imported]);
}
