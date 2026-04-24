<?php
/**
 * Plugin Name:  Maxxag Chat Ibiza
 * Description:  Chatbot AI para Maxxag Ibiza — tema Sunset (coral/peach/purple)
 * Version:      5.4.1
 * Author:       Maxxag
 * Text Domain:  maxxag-chat
 */
if (!defined('ABSPATH')) exit;

define('MAXXAG_CHAT_DIR', plugin_dir_path(__FILE__));
define('MAXXAG_CHAT_URL', plugin_dir_url(__FILE__));

define('MAXXAG_CLAUDE_MODEL', 'claude-haiku-4-5-20251001');

// ── Secure key retrieval: env var > wp_options ─────────────────
function maxxag_get_anthropic_key() {
    $env = getenv('MAXXAG_ANTHROPIC_KEY');
    if (!empty($env)) return $env;
    if (defined('MAXXAG_ANTHROPIC_KEY')) return MAXXAG_ANTHROPIC_KEY;
    return get_option('maxxag_anthropic_key', '');
}

// Load components
require_once MAXXAG_CHAT_DIR . 'chatbot.php';
require_once MAXXAG_CHAT_DIR . 'claude.php';
require_once MAXXAG_CHAT_DIR . 'api.php';

// ── Settings page + Admin backoffice (WP-auth gated) ────────────
add_action('admin_menu', function () {
    // Backoffice page (hidden from menu, requires manage_options)
    add_submenu_page(
        null, // hidden from menu
        'Maxxag Backoffice',
        'Maxxag Backoffice',
        'manage_options',
        'maxxag-backoffice',
        function () {
            // HIGH-6: Only WP admins can access the backoffice
            if (!current_user_can('manage_options')) { wp_die('Unauthorized'); }
            header('Content-Type: text/html; charset=UTF-8');
            header("Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https:; frame-ancestors 'none'; object-src 'none'");
            header('Referrer-Policy: strict-origin-when-cross-origin');
            readfile(MAXXAG_CHAT_DIR . 'admin/index.html');
            exit;
        }
    );
    add_options_page(
        'Maxxag Chat',
        'Maxxag Chat',
        'manage_options',
        'maxxag-chat',
        'maxxag_chat_settings_page'
    );
});

add_action('admin_init', function () {
    register_setting('maxxag_chat_group', 'maxxag_enabled', [
        'default' => '1',
        'sanitize_callback' => function ($v) { return $v === '1' ? '1' : '0'; },
    ]);
    register_setting('maxxag_chat_group', 'maxxag_lang', [
        'default' => 'es',
        'sanitize_callback' => function ($v) { return in_array($v, ['es','en','fr','it'], true) ? $v : 'es'; },
    ]);
    register_setting('maxxag_chat_group', 'maxxag_admin_token', [
        'sanitize_callback' => function ($v) {
            $v = sanitize_text_field($v);
            if (empty($v)) return get_option('maxxag_admin_token', ''); // keep existing
            if (strlen($v) < 4) return get_option('maxxag_admin_token', ''); // min 4 chars
            return $v; // stored as plain text
        },
    ]);
    register_setting('maxxag_chat_group', 'maxxag_anthropic_key', [
        'sanitize_callback' => function ($v) {
            $v = sanitize_text_field($v);
            if (empty($v)) return get_option('maxxag_anthropic_key', ''); // keep existing
            return $v;
        },
    ]);
});

function maxxag_chat_settings_page() {
    $enabled = get_option('maxxag_enabled', '1');
    $lang    = get_option('maxxag_lang', 'es');
    $token   = get_option('maxxag_admin_token', '');
    $apikey  = get_option('maxxag_anthropic_key', '');
    $rest_url = rest_url('maxxag/v1/chat');
    ?>
    <div class="wrap">
        <h1>Maxxag Chat</h1>
        <form method="post" action="options.php">
            <?php settings_fields('maxxag_chat_group'); ?>
            <table class="form-table">
                <tr>
                    <th>Activar chatbot</th>
                    <td><label><input type="checkbox" name="maxxag_enabled" value="1" <?php checked($enabled, '1'); ?>> Mostrar chat en la web</label></td>
                </tr>
                <tr>
                    <th>Idioma por defecto</th>
                    <td>
                        <select name="maxxag_lang">
                            <option value="es" <?php selected($lang, 'es'); ?>>Español</option>
                            <option value="en" <?php selected($lang, 'en'); ?>>English</option>
                            <option value="fr" <?php selected($lang, 'fr'); ?>>Français</option>
                            <option value="it" <?php selected($lang, 'it'); ?>>Italiano</option>
                        </select>
                    </td>
                </tr>
                <tr>
                    <th>Token admin (backoffice)</th>
                    <td><input type="password" name="maxxag_admin_token" value="" placeholder="<?php echo $token ? '••••••••• (guardado)' : 'Pon un token seguro'; ?>" class="regular-text"><p class="description">Dejar vacío para mantener el actual. Mín. 8 caracteres.</p></td>
                </tr>
                <tr>
                    <th>Anthropic API Key</th>
                    <td><input type="password" name="maxxag_anthropic_key" value="" placeholder="<?php echo $apikey ? '••••••••• (guardada)' : 'sk-ant-...'; ?>" class="regular-text"><p class="description">Dejar vacío para mantener la actual.</p></td>
                </tr>
            </table>
            <?php submit_button('Guardar'); ?>
        </form>
        <hr>
        <h2>Estado</h2>
        <p><strong>API endpoint:</strong> <code><?php echo esc_html($rest_url); ?></code></p>
        <p><strong>Admin panel:</strong> <a href="<?php echo esc_url(home_url('/chat-admin/')); ?>" target="_blank" class="button">Abrir backoffice →</a></p>
        <p><strong>URL directa para trabajadores:</strong> <code><?php echo esc_html(home_url('/chat-admin/')); ?></code></p>
        <p><strong>Datos:</strong> <code><?php echo esc_html(MAXXAG_CHAT_DIR . 'data/'); ?></code></p>
        <div class="notice notice-info inline" style="padding:10px 15px;margin-top:10px">
          <p style="margin:0"><strong>💡 Una contrase&ntilde;a para las 3 ciudades:</strong>
          a&ntilde;ade en <code>wp-config.php</code> (de cada sitio) la misma l&iacute;nea:
          <code style="background:#fff3cd;padding:2px 6px">define('MAXXAG_MASTER_TOKEN', 'tu_clave_maestra');</code><br>
          Con eso entras en VLC, Madrid y Marbella con la misma contrase&ntilde;a sin tener que configurar cada una.</p>
          <p style="margin:5px 0 0 0"><strong>Estado aqu&iacute;:</strong>
          <?php echo defined('MAXXAG_MASTER_TOKEN') ? '<span style="color:#00a32a">&#10003; master-token activo</span>' : '<span style="color:#d97706">no configurado (cada sitio usa su token propio)</span>'; ?></p>
        </div>

        <hr>
        <h2>🔍 Diagnóstico Claude</h2>
        <?php
        $_api_key = maxxag_get_anthropic_key();
        $_key_source = 'vacío';
        if (!empty(getenv('MAXXAG_ANTHROPIC_KEY'))) $_key_source = 'variable de entorno';
        elseif (defined('MAXXAG_ANTHROPIC_KEY')) $_key_source = 'wp-config.php';
        elseif (!empty($_api_key)) $_key_source = 'wp_options (Settings)';
        ?>
        <p><strong>API Key Anthropic:</strong>
          <?php if (empty($_api_key)): ?>
            <span style="color:#d63638">❌ NO configurada</span>
          <?php else: ?>
            <span style="color:#00a32a">✓ Configurada (<?php echo esc_html($_key_source); ?>, <?php echo strlen($_api_key); ?> chars, empieza con <?php echo esc_html(substr($_api_key, 0, 8)); ?>...)</span>
          <?php endif; ?>
        </p>
        <?php $_last_err = get_option('maxxag_claude_last_error', ''); if (!empty($_last_err)): ?>
          <div class="notice notice-error inline" style="margin:10px 0;padding:10px 15px">
            <p style="margin:0"><strong>⚠️ Último error Claude:</strong> <code style="background:#fce8e8;padding:2px 6px"><?php echo esc_html($_last_err); ?></code></p>
            <p class="description" style="margin-top:5px">
              <strong>HTTP 401</strong> = API key inválida (rehacer en <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>)<br>
              <strong>HTTP 429</strong> = límite de rate/créditos agotados<br>
              <strong>WP Error: timeout</strong> = firewall o red bloquea api.anthropic.com<br>
              <strong>Empty response</strong> = Claude devolvió texto vacío, revisar prompt
            </p>
          </div>
        <?php endif; ?>
        <?php if (isset($_GET['maxxag_claude_test'])): ?>
          <?php
          $claude = new Maxxag_Claude();
          $bot = maxxag_bot();
          $cfg_test = $bot->load_json('config.json');
          $girls_test = $bot->load_json('girls.json');
          $test_scenarios = [
              'Saludo'              => 'hola',
              'Búsqueda'            => 'busco una rubia',
              'Precio'              => '¿cuánto cuesta?',
              'Objeción-caro'       => 'es caro',
              'Indeciso'            => 'no sé si atreverme',
              'Retención'           => 'me voy, quizás otro día',
              'Discreción'          => 'tengo pareja',
              'Off-topic'           => '¿eres un bot?',
              'Servicios'           => '¿qué servicios hacéis?',
              'Disponibilidad'      => '¿quién está disponible hoy?',
          ];
          ?>
          <div class="notice notice-info inline" style="margin-top:10px;padding:15px">
            <h3 style="margin-top:0">📋 Batería de 10 escenarios (ES)</h3>
            <table class="wp-list-table widefat striped" style="margin-top:10px">
              <thead>
                <tr>
                  <th style="width:13%">Escenario</th>
                  <th style="width:18%">Pregunta</th>
                  <th>Respuesta Claude</th>
                  <th style="width:8%;text-align:right">Tiempo</th>
                  <th style="width:6%;text-align:right">Chars</th>
                </tr>
              </thead>
              <tbody>
              <?php foreach ($test_scenarios as $label => $msg):
                  $start = microtime(true);
                  $resp = $claude->ask($msg, 'es', $cfg_test, $girls_test);
                  $elapsed = round((microtime(true) - $start) * 1000);
              ?>
                <tr>
                  <td><strong><?php echo esc_html($label); ?></strong></td>
                  <td><em>"<?php echo esc_html($msg); ?>"</em></td>
                  <td style="line-height:1.5"><?php echo esc_html($resp); ?></td>
                  <td style="text-align:right;color:<?php echo $elapsed > 3000 ? '#d63638' : '#00a32a'; ?>"><?php echo $elapsed; ?>ms</td>
                  <td style="text-align:right;color:<?php echo strlen($resp) > 400 ? '#d97706' : '#646970'; ?>"><?php echo strlen($resp); ?></td>
                </tr>
              <?php endforeach; ?>
              </tbody>
            </table>
            <p class="description" style="margin-top:10px">
              ✓ Respuesta buena = ≤3 frases, usa pet name (guapo/cariño/...), termina con pregunta, menciona chicas reales cuando aplica.<br>
              ✗ Respuesta mala = genérica ("contacta recepción" sin más), sin pet name, sin cierre, inventa chicas.
            </p>
          </div>
        <?php endif; ?>
        <p>
          <a href="<?php echo esc_url(add_query_arg('maxxag_claude_test', '1', admin_url('options-general.php?page=maxxag-chat'))); ?>" class="button button-primary">🧪 Probar los 10 escenarios</a>
          <span class="description" style="margin-left:10px">Coste aprox: $0.02 por test completo</span>
        </p>
    </div>
    <?php
}

// ── Public backoffice route — /chat-admin/ (no WP login needed) ──
add_action('init', function () {
    add_rewrite_rule('^chat-admin/?$', 'index.php?maxxag_admin=1', 'top');
});
add_filter('query_vars', function ($vars) {
    $vars[] = 'maxxag_admin';
    return $vars;
});
add_action('template_redirect', function () {
    if (!get_query_var('maxxag_admin')) return;

    // Logout shortcut: /chat-admin/?logout=1
    if (isset($_GET['logout'])) {
        setcookie('maxxag_auth', '', time() - 3600, '/', '', is_ssl(), true);
        wp_safe_redirect(home_url('/chat-admin/'));
        exit;
    }

    // Server-side auth: require WP admin OR valid token cookie (site-token OR master-token)
    $token        = get_option('maxxag_admin_token', '');
    $master_token = defined('MAXXAG_MASTER_TOKEN') ? MAXXAG_MASTER_TOKEN : '';
    $cookie_token = $_COOKIE['maxxag_auth'] ?? '';
    $is_wp_admin  = current_user_can('manage_options');

    $check_against = function ($candidate, $stored) {
        if (empty($stored) || empty($candidate)) return false;
        if (strpos($stored, '$2y$') === 0 || strpos($stored, '$2a$') === 0) {
            return password_verify($candidate, $stored);
        }
        return hash_equals($stored, $candidate);
    };

    $is_token_valid =
        (!empty($cookie_token) && (
            $check_against($cookie_token, $token) ||
            $check_against($cookie_token, $master_token)
        ));

    // WP admins: auto-set cookie so REST API calls authenticate (30d)
    if ($is_wp_admin && !empty($token) && !$is_token_valid) {
        setcookie('maxxag_auth', $token, time() + 2592000, '/', '', is_ssl(), true);
        $_COOKIE['maxxag_auth'] = $token;
    }

    if (!$is_wp_admin && !$is_token_valid) {
        // Serve a minimal login page that sets cookie on success
        header('Content-Type: text/html; charset=UTF-8');
        header('X-Frame-Options: DENY');
        echo '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maxxag Admin</title>';
        echo '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d0d0d;font-family:sans-serif;color:#fff}';
        echo '.box{text-align:center;padding:40px}.box input[type=password]{padding:10px 16px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:14px;width:240px}';
        echo '.box button{margin-top:12px;padding:10px 24px;background:#00c49a;border:none;border-radius:8px;color:#000;font-weight:600;cursor:pointer;font-size:14px}';
        echo '.box .remember{margin-top:10px;font-size:12px;color:#999;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}';
        echo '.box .remember input{accent-color:#00c49a}.box .err{color:#f66;font-size:12px;margin-top:8px}</style></head><body><div class="box">';
        echo '<h2>Maxxag Admin</h2><p style="color:#666;font-size:13px">Introduce la contrase&ntilde;a</p>';
        echo '<form method="post"><input type="password" name="maxxag_token" placeholder="Contrase&ntilde;a..." autocomplete="current-password" required>';
        echo '<label class="remember"><input type="checkbox" name="remember" value="1" checked> Recu&eacute;rdame (30 d&iacute;as)</label>';
        echo '<br><button type="submit">Entrar</button></form>';

        // Brute-force protection: 10 fails in 5 min = ban
        $ip_key   = 'maxxag_bf_' . md5($_SERVER['REMOTE_ADDR'] ?? 'unknown');
        $failures = (int) get_transient($ip_key);
        if ($failures >= 10) {
            echo '<div class="err">Demasiados intentos. Espera 5 min.</div>';
        } elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input    = sanitize_text_field($_POST['maxxag_token'] ?? '');
            $remember = !empty($_POST['remember']);
            $login_valid = $check_against($input, $token) || $check_against($input, $master_token);
            if ($login_valid) {
                delete_transient($ip_key);
                $lifetime = $remember ? 2592000 : 86400; // 30 days vs 1 day
                setcookie('maxxag_auth', $input, time() + $lifetime, '/', '', is_ssl(), true);
                echo '<script>location.reload()</script>';
            } else {
                set_transient($ip_key, $failures + 1, 300);
                echo '<div class="err">Contrase&ntilde;a incorrecta</div>';
            }
        }
        echo '</div></body></html>';
        exit;
    }
    header('Content-Type: text/html; charset=UTF-8');
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https:; frame-ancestors 'none'; object-src 'none'");
    header('Referrer-Policy: strict-origin-when-cross-origin');
    readfile(MAXXAG_CHAT_DIR . 'admin/index.html');
    exit;
});

// ── Inject widget in frontend ────────────────────────────────────
add_action('wp_footer', function () {
    if (get_option('maxxag_enabled', '1') !== '1') return;

    $lang    = get_option('maxxag_lang', 'es');
    $css_url = MAXXAG_CHAT_URL . 'widget/chat-widget.css';
    $js_url  = MAXXAG_CHAT_URL . 'widget/chat-widget.js';
    $api_url = rest_url('maxxag/v1');

    echo '<link rel="stylesheet" href="' . esc_url($css_url) . '">' . "\n";
    echo '<script src="' . esc_url($js_url) . '" data-api="' . esc_attr(rtrim($api_url, '/')) . '" data-lang="' . esc_attr($lang) . '"></script>' . "\n";
});

// ── Ensure data directory is writable ────────────────────────────
register_activation_hook(__FILE__, function () {
    $data_dir = MAXXAG_CHAT_DIR . 'data';
    if (!file_exists($data_dir)) {
        mkdir($data_dir, 0755, true);
    }
    $files = [
        'girls.json'     => '{"girls":[]}',
        'config.json'    => '{}',
        'chat_logs.json' => '[]',
        'tickets.json'   => '[]',
    ];
    // CRIT-2: Protect data directory (Apache .htaccess + Nginx-safe index.php)
    file_put_contents($data_dir . '/.htaccess', "Order Deny,Allow\nDeny from all\n");
    // index.php blocks direct access and directory listing on any server
    file_put_contents($data_dir . '/index.php', '<?php http_response_code(403); die("Forbidden");');
    // Also protect admin directory from unauthenticated access
    $admin_dir = MAXXAG_CHAT_DIR . 'admin';
    if (is_dir($admin_dir)) {
        file_put_contents($admin_dir . '/.htaccess', "Order Deny,Allow\nDeny from all\n");
        file_put_contents($admin_dir . '/index.php', '<?php http_response_code(403); die("Forbidden");');
    }

    foreach ($files as $f => $default) {
        $path = $data_dir . '/' . $f;
        if (!file_exists($path)) {
            file_put_contents($path, $default);
        }
    }
    // Create upload directories for photos
    $upload_dir = wp_upload_dir();
    $dirs = ['maxxag/girls', 'maxxag/logos'];
    foreach ($dirs as $d) {
        $path = $upload_dir['basedir'] . '/' . $d;
        if (!file_exists($path)) wp_mkdir_p($path);
    }
    // Flush rewrite rules so /chat-admin/ works immediately
    flush_rewrite_rules();
});
