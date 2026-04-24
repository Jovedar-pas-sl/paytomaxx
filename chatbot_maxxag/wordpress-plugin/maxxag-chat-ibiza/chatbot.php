<?php
/**
 * Maxxag Chatbot — State Machine (PHP port)
 */
if (!defined('ABSPATH')) exit;

class Maxxag_Chatbot {

    private $data_dir;

    // Menu buttons per language
    private $menu = [
        'es' => [
            ['id' => 'escorts_disponibles', 'label' => 'Escorts disponibles',   'group' => 'info'],
            ['id' => 'tarifas',             'label' => 'Tarifas / Servicios',   'group' => 'info'],
            ['id' => 'metodos_pago',        'label' => 'Métodos de pago 💳',    'group' => 'info'],
            ['id' => 'horario',             'label' => 'Horario / Cómo llegar', 'group' => 'info'],
            ['id' => 'hotel_domicilio',     'label' => 'A hotel o domicilio',   'group' => 'info'],
            ['id' => 'reservar',            'label' => 'Reservar ahora 📱',     'group' => 'action'],
            ['id' => 'contacto',            'label' => 'Contacto recepción 📱', 'group' => 'action'],
        ],
        'en' => [
            ['id' => 'escorts_disponibles', 'label' => 'Available escorts',     'group' => 'info'],
            ['id' => 'tarifas',             'label' => 'Rates / Services',      'group' => 'info'],
            ['id' => 'metodos_pago',        'label' => 'Payment methods 💳',    'group' => 'info'],
            ['id' => 'horario',             'label' => 'Schedule / Directions', 'group' => 'info'],
            ['id' => 'hotel_domicilio',     'label' => 'Hotel or outcall',      'group' => 'info'],
            ['id' => 'reservar',            'label' => 'Book now 📱',           'group' => 'action'],
            ['id' => 'contacto',            'label' => 'Contact reception 📱',  'group' => 'action'],
        ],
        'fr' => [
            ['id' => 'escorts_disponibles', 'label' => 'Escorts disponibles',   'group' => 'info'],
            ['id' => 'tarifas',             'label' => 'Tarifs / Services',     'group' => 'info'],
            ['id' => 'metodos_pago',        'label' => 'Moyens de paiement 💳', 'group' => 'info'],
            ['id' => 'horario',             'label' => 'Horaires / Accès',      'group' => 'info'],
            ['id' => 'hotel_domicilio',     'label' => 'Hôtel ou domicile',     'group' => 'info'],
            ['id' => 'reservar',            'label' => 'Réserver 📱',           'group' => 'action'],
            ['id' => 'contacto',            'label' => 'Contact réception 📱',  'group' => 'action'],
        ],
        'it' => [
            ['id' => 'escorts_disponibles', 'label' => 'Escort disponibili',    'group' => 'info'],
            ['id' => 'tarifas',             'label' => 'Tariffe / Servizi',     'group' => 'info'],
            ['id' => 'metodos_pago',        'label' => 'Metodi di pagamento 💳','group' => 'info'],
            ['id' => 'horario',             'label' => 'Orari / Come arrivare', 'group' => 'info'],
            ['id' => 'hotel_domicilio',     'label' => 'Hotel o domicilio',     'group' => 'info'],
            ['id' => 'reservar',            'label' => 'Prenota ora 📱',        'group' => 'action'],
            ['id' => 'contacto',            'label' => 'Contatto reception 📱', 'group' => 'action'],
        ],
    ];

    private $back = [
        'es' => [['id' => 'menu', 'label' => '← Volver al menú']],
        'en' => [['id' => 'menu', 'label' => '← Back to menu']],
        'fr' => [['id' => 'menu', 'label' => '← Retour au menu']],
        'it' => [['id' => 'menu', 'label' => '← Torna al menu']],
    ];

    public function __construct() {
        $this->data_dir = MAXXAG_CHAT_DIR . 'data/';
    }

    // ── JSON helpers (HIGH-2: path traversal protection, MED-5: atomic writes) ──
    public function load_json(string $file): array {
        $file = basename($file); // prevent path traversal
        if (!preg_match('/^[a-z0-9_\-]+\.json$/', $file)) return [];
        $path = $this->data_dir . $file;
        if (!file_exists($path)) return [];
        $fp = fopen($path, 'r');
        if (!$fp) return [];
        flock($fp, LOCK_SH);
        $content = stream_get_contents($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        $data = json_decode($content, true);
        return is_array($data) ? $data : [];
    }

    public function save_json(string $file, array $data): void {
        $file = basename($file);
        if (!preg_match('/^[a-z0-9_\-]+\.json$/', $file)) return;
        $path = $this->data_dir . $file;
        $tmp  = $path . '.tmp.' . getmypid();
        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        // Atomic write: write to temp file, then rename
        if (file_put_contents($tmp, $json, LOCK_EX) !== false) {
            rename($tmp, $path);
        }
    }

    // ── Button helpers ───────────────────────────────────────────
    private function btn(array $buttons): array {
        $result = [];
        foreach ($buttons as $b) {
            $result[] = [
                'id'         => $b['id'],
                'label'      => $b['label'],
                'full_width' => $b['fw'] ?? false,
                'group'      => $b['group'] ?? '',
            ];
        }
        return $result;
    }

    private function contact_buttons(array $cfg, string $lang, bool $back = true): array {
        $wa_raw  = $cfg['site']['whatsapp_recepcion'] ?? '';
        $tg_raw  = $cfg['site']['telegram_recepcion'] ?? '';
        $wa_num  = preg_replace('/[^0-9]/', '', $wa_raw); // digits only
        $tg_user = preg_replace('/[^a-zA-Z0-9_]/', '', ltrim($tg_raw, '@')); // alphanumeric + underscore only

        $wa_labels = ['es' => 'WhatsApp recepción 📱', 'en' => 'WhatsApp reception 📱', 'fr' => 'WhatsApp réception 📱', 'it' => 'WhatsApp reception 📱'];
        $tg_labels = ['es' => 'Telegram recepción ✈️', 'en' => 'Telegram reception ✈️', 'fr' => 'Telegram réception ✈️', 'it' => 'Telegram reception ✈️'];

        $btns = [];
        if ($wa_num) {
            $btns[] = ['id' => 'wa_contact', 'label' => $wa_labels[$lang] ?? $wa_labels['es'], 'full_width' => true, 'url' => "https://wa.me/{$wa_num}"];
        }
        if ($tg_user) {
            $btns[] = ['id' => 'tg_contact', 'label' => $tg_labels[$lang] ?? $tg_labels['es'], 'full_width' => true, 'url' => "https://t.me/{$tg_user}"];
        }
        if ($back) {
            $btns = array_merge($btns, $this->btn($this->back[$lang] ?? $this->back['es']));
        }
        return $btns;
    }

    // ── Greeting (personalized for new/returning clients) ──────
    public function get_greeting(string $lang, string $client_name = ''): array {
        $cfg  = $this->load_json('config.json');
        $site = $cfg['site'] ?? [];
        // Check if returning client (has existing ticket with this name)
        $is_returning = false;
        if ($client_name) {
            $tickets = $this->load_json('tickets.json') ?: [];
            foreach ($tickets as $t) {
                if (($t['client_name'] ?? '') === $client_name && !empty($t['messages'])) {
                    $is_returning = true;
                    break;
                }
            }
        }
        if ($is_returning && $client_name) {
            $safe_name = addcslashes($client_name, '\\$');
            $returns = [
                'es' => "\u00a1Has vuelto, {$safe_name}! \uD83D\uDE0D Qu\u00e9 alegr\u00eda verte otra vez. \u00bfEn qu\u00e9 te puedo ayudar hoy?",
                'en' => "You're back, {$safe_name}! \uD83D\uDE0D So happy to see you again. How can I help today?",
                'fr' => "Tu es de retour, {$safe_name} ! \uD83D\uDE0D Ravie de te revoir. Qu'est-ce qui te ferait plaisir ?",
                'it' => "Sei tornato, {$safe_name}! \uD83D\uDE0D Che bello rivederti. Come posso aiutarti oggi?",
            ];
            $greeting = $returns[$lang] ?? $returns['es'];
        } else {
            $greeting = $site["greeting_{$lang}"] ?? $site['greeting_es'] ?? 'Bienvenido 😘';
            if ($client_name) {
                $safe_name = addcslashes($client_name, '\\$');
                $greeting = preg_replace(
                    '/(Bienvenido|Welcome|Bienvenue|Benvenuto)/i',
                    '$1 ' . $safe_name,
                    $greeting
                );
            }
        }
        // Build full avatar URL if it's a relative path
        $avatar = $site['bot_avatar'] ?? '';
        if ($avatar && strpos($avatar, 'http') !== 0) {
            $avatar = MAXXAG_CHAT_URL . 'widget/' . $avatar;
        }
        return [
            ['type' => 'avatar', 'name' => $site['bot_name'] ?? '', 'avatar' => $avatar],
            ['type' => 'text', 'text' => $greeting, 'buttons' => $this->btn($this->menu[$lang] ?? $this->menu['es'])],
        ];
    }

    // ── Menu (back to menu — varied comeback text) ────────────
    public function get_menu(string $lang): array {
        $comebacks = [
            'es' => ['¿Qué más te apetece saber, cariño? 😊', '¿En qué más te puedo ayudar, guapo? 💋', 'Dime, cielo, ¿qué te interesa? 😘', '¿Algo más que quieras saber, bombón? 😏'],
            'en' => ['What else would you like to know, darling? 😊', 'How else can I help, handsome? 💋', 'Tell me, what interests you? 😘', 'Anything else, gorgeous? 😏'],
            'fr' => ['Quoi d\'autre tu veux savoir, chéri ? 😊', 'Comment puis-je t\'aider, beau gosse ? 💋'],
            'it' => ['Cos\'altro vuoi sapere, caro? 😊', 'Come posso aiutarti, bello? 💋'],
        ];
        $options = $comebacks[$lang] ?? $comebacks['es'];
        $text = $options[array_rand($options)];
        return [
            ['type' => 'text', 'text' => $text, 'buttons' => $this->btn($this->menu[$lang] ?? $this->menu['es'])],
        ];
    }

    // ── Handle message ──────────────────────────────────────────
    public function handle_message(string $session_id, string $message, string $lang, array $history = [], string $client_name = ''): array {
        $cfg  = $this->load_json('config.json');
        $data = $this->load_json('girls.json');
        $msg  = strtolower(trim($message));

        // Back to menu
        $menu_triggers = ['menu', '← volver al menú', '← back to menu', '← retour au menu', '← torna al menu'];
        if (in_array($msg, $menu_triggers)) {
            return ['messages' => $this->get_menu($lang), 'lang' => $lang];
        }

        // Language switch
        foreach (['es', 'en', 'fr', 'it'] as $code) {
            if ($msg === "lang_{$code}") {
                return ['messages' => $this->get_greeting($code), 'lang' => $code];
            }
        }

        // Escorts disponibles
        if ($msg === 'escorts_disponibles') {
            $girls = array_values(array_filter($data['girls'] ?? [], function($g) { return !empty($g['available_today']); }));
            $labels = [
                'es' => 'Mira quiénes están disponibles ahora mismo, guapo 💕',
                'en' => "Here's who's available right now, handsome 💕",
                'fr' => 'Voilà qui est disponible en ce moment, beau gosse 💕',
                'it' => 'Ecco chi è disponibile adesso, bello 💕',
            ];
            if (empty($girls)) {
                $no_avail = [
                    'es' => 'Ahora mismo no hay nadie disponible, cielo 😔 Pero contacta con recepción y te ayudamos.',
                    'en' => "Nobody's available right now, babe 😔 But reach out to reception.",
                    'fr' => "Personne n'est disponible pour le moment, chéri 😔 Contacte la réception.",
                    'it' => "Non c'è nessuna disponibile al momento, tesoro 😔 Contatta la reception.",
                ];
                return ['messages' => [
                    ['type' => 'text', 'text' => $no_avail[$lang] ?? $no_avail['es'], 'buttons' => $this->contact_buttons($cfg, $lang)],
                ], 'lang' => $lang];
            }
            $cta = ['es' => '¿Te gusta alguna, guapo? 😘', 'en' => 'Like anyone, handsome? 😘', 'fr' => 'Quelqu\'un te plaît ? 😘', 'it' => 'Ti piace qualcuna? 😘'];
            $cta_btns = array_merge($this->contact_buttons($cfg, $lang, false), $this->btn($this->back[$lang] ?? $this->back['es']));
            return ['messages' => [
                ['type' => 'text', 'text' => $labels[$lang] ?? $labels['es']],
                ['type' => 'girls', 'girls' => $girls],
                ['type' => 'text', 'text' => $cta[$lang] ?? $cta['es'], 'buttons' => $cta_btns],
            ], 'lang' => $lang];
        }

        // Tarifas
        if ($msg === 'tarifas') {
            $rates = $cfg['rates'] ?? [];
            $intros = ['es' => 'Aquí tienes nuestras tarifas, cariño 💰', 'en' => 'Here are our rates, darling 💰', 'fr' => 'Voici nos tarifs, chéri 💰', 'it' => 'Ecco le nostre tariffe, caro 💰'];
            return ['messages' => [
                ['type' => 'text', 'text' => $intros[$lang] ?? $intros['es']],
                ['type' => 'rates',
                 'title'   => $rates["title_{$lang}"] ?? $rates['title_es'] ?? '',
                 'items'   => $rates['items'] ?? [],
                 'note'    => $rates["note_{$lang}"] ?? $rates['note_es'] ?? '',
                 'lang'    => $lang,
                 'buttons' => $this->contact_buttons($cfg, $lang)],
            ], 'lang' => $lang];
        }

        // Métodos de pago (Ibiza: cash + Visa/Mastercard)
        if ($msg === 'metodos_pago') {
            $p = $cfg['payment'] ?? [];
            $label = $p["label_{$lang}"] ?? $p['label_es'] ?? '💶 Efectivo · 💳 Visa / Mastercard';
            $note  = $p["note_{$lang}"]  ?? $p['note_es']  ?? '';
            $intros = [
                'es' => 'Claro cariño, aquí tienes 💳',
                'en' => 'Of course darling, here you go 💳',
                'fr' => 'Bien sûr chéri, voilà 💳',
                'it' => 'Certo tesoro, eccoti 💳',
            ];
            $text = $label . ($note ? "\n\n" . $note : '');
            return ['messages' => [
                ['type' => 'text', 'text' => $intros[$lang] ?? $intros['es']],
                ['type' => 'text', 'text' => $text, 'buttons' => $this->contact_buttons($cfg, $lang)],
            ], 'lang' => $lang];
        }

        // Horario
        if ($msg === 'horario') {
            $s = $cfg['schedule'] ?? [];
            $intros = ['es' => '¡Claro, guapo! Aquí tienes 🚗', 'en' => 'Sure thing, handsome! 🚗', 'fr' => 'Bien sûr, beau gosse ! 🚗', 'it' => 'Certo, bello! 🚗'];
            $hours   = $s["hours_{$lang}"]   ?? $s['hours_es']   ?? '';
            $address = $s["address_{$lang}"] ?? $s['address_es'] ?? '';
            $how     = $s["how_{$lang}"]     ?? $s['how_es']     ?? '';
            $text = "🕐 {$hours}\n\n📍 {$address}";
            if ($how) $text .= "\n\nℹ️ {$how}";
            // Google Maps button
            $maps_url = $s['maps_url'] ?? '';
            if (empty($maps_url) && !empty($address)) {
                $maps_url = 'https://www.google.com/maps/search/?api=1&query=' . urlencode($address);
            }
            $maps_labels = ['es' => 'Ver en Google Maps 📍', 'en' => 'View on Google Maps 📍', 'fr' => 'Voir sur Google Maps 📍', 'it' => 'Vedi su Google Maps 📍'];
            $btns = [];
            if ($maps_url) {
                $btns[] = ['id' => 'maps', 'label' => $maps_labels[$lang] ?? $maps_labels['es'], 'full_width' => true, 'url' => $maps_url];
            }
            $btns = array_merge($btns, $this->contact_buttons($cfg, $lang));
            return ['messages' => [
                ['type' => 'text', 'text' => $intros[$lang] ?? $intros['es']],
                ['type' => 'text', 'text' => $text, 'buttons' => $btns],
            ], 'lang' => $lang];
        }

        // Hotel / domicilio
        if ($msg === 'hotel_domicilio') {
            $texts = [
                'es' => "🏨 Por supuesto, cielo. Podemos ir a tu hotel o domicilio.\n\nEl desplazamiento tiene un pequeño extra según la distancia. Escríbenos y lo organizamos todo 😉",
                'en' => "🏨 Of course, darling. We can come to your hotel or place.\n\nSmall extra for travel. Write us and we'll organise everything 😉",
                'fr' => "🏨 Bien sûr, chéri. On peut venir chez toi.\n\nPetit supplément pour le déplacement. Écris-nous 😉",
                'it' => "🏨 Certo, tesoro. Possiamo venire al tuo hotel o a casa tua.\n\nPiccolo extra per lo spostamento. Scrivici 😉",
            ];
            return ['messages' => [
                ['type' => 'text', 'text' => $texts[$lang] ?? $texts['es'], 'buttons' => $this->contact_buttons($cfg, $lang)],
            ], 'lang' => $lang];
        }

        // Reservar — ask when + connect to reception
        if ($msg === 'reservar') {
            $texts = [
                'es' => "¡Genial, cariño! 😘 ¿Para cuándo te gustaría reservar? Escríbenos por WhatsApp con el día y la hora y lo organizamos todo para ti 💋",
                'en' => "Great, darling! 😘 When would you like to book? Write us on WhatsApp with the day and time and we'll arrange everything for you 💋",
                'fr' => "Super, chéri ! 😘 Pour quand tu voudrais réserver ? Écris-nous sur WhatsApp avec le jour et l'heure 💋",
                'it' => "Fantastico, tesoro! 😘 Per quando vorresti prenotare? Scrivici su WhatsApp con giorno e ora 💋",
            ];
            return ['messages' => [
                ['type' => 'text', 'text' => $texts[$lang] ?? $texts['es'], 'buttons' => $this->contact_buttons($cfg, $lang)],
            ], 'lang' => $lang];
        }

        // Contacto
        if ($msg === 'contacto') {
            $texts = [
                'es' => '📱 ¡Claro! Recepción disponible 24h para ti:',
                'en' => '📱 Of course! Reception available 24h for you:',
                'fr' => '📱 Bien sûr ! Réception disponible 24h :',
                'it' => '📱 Certo! Reception disponibile 24h:',
            ];
            return ['messages' => [
                ['type' => 'text', 'text' => $texts[$lang] ?? $texts['es'], 'buttons' => $this->contact_buttons($cfg, $lang, false)],
            ], 'lang' => $lang];
        }

        // Contact intent — show contact buttons (client calls us, we never call them)
        $contact_words = ['llamar', 'llamame', 'llamadme', 'hablar con recepcion', 'telefono', 'numero', 'call me', 'phone', 'reception', 'appeler', 'chiamare'];
        foreach ($contact_words as $cw) {
            if (strpos($msg, $cw) !== false) {
                $ct = [
                    'es' => '¡Claro, cariño! 😘 Escríbenos por WhatsApp o Telegram y te atendemos al momento 💋',
                    'en' => "Of course, darling! 😘 Write us on WhatsApp or Telegram and we'll attend you right away 💋",
                    'fr' => 'Bien sûr, chéri ! 😘 Écris-nous sur WhatsApp ou Telegram 💋',
                    'it' => 'Certo, tesoro! 😘 Scrivici su WhatsApp o Telegram 💋',
                ];
                return ['messages' => [
                    ['type' => 'text', 'text' => $ct[$lang] ?? $ct['es'], 'buttons' => $this->contact_buttons($cfg, $lang, false)],
                ], 'lang' => $lang];
            }
        }

        // Detect specific girl name (case-insensitive, accent-tolerant)
        $all_girls = $data['girls'] ?? [];
        foreach ($all_girls as $g) {
            $gname = mb_strtolower($g['name'] ?? '');
            if ($gname && strlen($gname) > 2 && (strpos($msg, $gname) !== false || strpos($msg, str_replace(['á','é','í','ó','ú','ñ'], ['a','e','i','o','u','n'], $gname)) !== false)) {
                $avail = !empty($g['available_today']);
                $desc = $g['description'] ?? '';
                $age = $g['age'] ?? '';
                $nat = $g['nationality'] ?? '';
                $svcs = implode(', ', $g['services'] ?? []);
                $info_labels = [
                    'es' => $avail
                        ? "¡{$g['name']}! 😍 {$age} años, {$nat}. {$desc} " . ($svcs ? "Servicios: {$svcs}. " : '') . "Está disponible ahora mismo, guapo. ¿Te interesa? 😘"
                        : "Ay, {$g['name']} no está disponible ahora mismo, cariño 😔 Pero tenemos otras chicas increíbles. ¿Quieres verlas?",
                    'en' => $avail
                        ? "{$g['name']}! 😍 {$age}y, {$nat}. {$desc} " . ($svcs ? "Services: {$svcs}. " : '') . "She's available right now, handsome. Interested? 😘"
                        : "Oh, {$g['name']} isn't available right now, darling 😔 But we have other amazing girls. Want to see them?",
                ];
                $btns = $avail
                    ? array_merge($this->contact_buttons($cfg, $lang, false), $this->btn($this->back[$lang] ?? $this->back['es']))
                    : [['id' => 'escorts_disponibles', 'label' => $lang === 'en' ? 'See available' : 'Ver disponibles', 'group' => 'info']];
                return ['messages' => [
                    ['type' => 'text', 'text' => $info_labels[$lang] ?? $info_labels['es'], 'buttons' => $btns],
                ], 'lang' => $lang];
            }
        }

        // FAQ keyword match (with synonym expansion)
        $matched_faq = $this->match_faq($msg, $cfg['faqs'] ?? []);
        if ($matched_faq) {
            $reply = $matched_faq["reply_{$lang}"] ?? $matched_faq['reply_es'] ?? '';
            return ['messages' => [
                ['type' => 'text', 'text' => $reply, 'buttons' => $this->btn($this->menu[$lang] ?? $this->menu['es'])],
            ], 'lang' => $lang];
        }

        // Claude AI fallback
        return $this->claude_fallback($message, $lang, $cfg, $history, $client_name);
    }

    // ── FAQ matching with synonym groups ────────────────────────
    private function match_faq(string $msg, array $faqs): ?array {
        // 1. Exact substring match (fast path)
        foreach ($faqs as $faq) {
            foreach ($faq['triggers'] ?? [] as $trigger) {
                if (strpos($msg, mb_strtolower($trigger)) !== false) return $faq;
            }
        }
        // 2. Synonym expansion (expanded)
        $synonym_groups = [
            'precio'     => ['cuanto cuesta', 'cuanto vale', 'cuanto cobran', 'coste', 'tarifa', 'tarifas', 'rate', 'rates', 'price', 'prices', 'how much', 'combien', 'quanto costa', 'precios', 'valor'],
            'pago'       => ['pagar', 'efectivo', 'bizum', 'tarjeta', 'cash', 'card', 'payment', 'transfer', 'carte', 'visa', 'mastercard', 'metodo de pago', 'forma de pago'],
            'horario'    => ['hora', 'abierto', 'cerrado', 'when open', 'schedule', 'hours', 'horaires', 'orari', 'cuando abren', 'horarios', 'abiertos', 'opening'],
            'disponible' => ['quien hay', 'chicas', 'escorts', 'available', 'who is', 'hay alguien', 'quien esta', 'disponibles', 'girls', 'filles', 'ragazze'],
            'hotel'      => ['domicilio', 'outcall', 'desplazamiento', 'venir', 'come to', 'a mi casa', 'mi hotel', 'salida', 'salidas', 'fuera', 'outside'],
            'reservar'   => ['reserva', 'booking', 'book', 'cita', 'appointment', 'quiero ir', 'puedo ir', 'reservar', 'prenota', 'reserver'],
        ];
        foreach ($synonym_groups as $group_key => $synonyms) {
            foreach ($synonyms as $synonym) {
                if (strpos($msg, $synonym) !== false) {
                    foreach ($faqs as $faq) {
                        foreach ($faq['triggers'] ?? [] as $trigger) {
                            if ($trigger === $group_key || in_array($trigger, $synonyms)) return $faq;
                        }
                    }
                }
            }
        }
        // 3. Fuzzy matching (catch typos)
        $words = explode(' ', $msg);
        foreach ($words as $word) {
            if (strlen($word) < 4) continue;
            foreach ($synonym_groups as $group_key => $synonyms) {
                foreach ($synonyms as $synonym) {
                    if (strlen($synonym) < 4) continue;
                    $dist = levenshtein($word, $synonym);
                    if ($dist <= 2 && $dist < strlen($synonym) * 0.4) {
                        foreach ($faqs as $faq) {
                            foreach ($faq['triggers'] ?? [] as $trigger) {
                                if ($trigger === $group_key || in_array($trigger, $synonyms)) return $faq;
                            }
                        }
                    }
                }
            }
        }
        return null;
    }

    // ── Claude AI fallback with contextual quick-replies ───────
    private function claude_fallback(string $message, string $lang, array $cfg, array $history = [], string $client_name = ''): array {
        $claude = new Maxxag_Claude();
        $text   = $claude->ask($message, $lang, $cfg, $this->load_json('girls.json'), $history, $client_name);

        // Contextual quick-reply buttons based on what the client asked
        $msg = strtolower($message);
        $quick = [];
        if (strpos($msg, 'chica') !== false || strpos($msg, 'girl') !== false || strpos($msg, 'rub') !== false || strpos($msg, 'moren') !== false) {
            $quick = [
                ['id' => 'escorts_disponibles', 'label' => $lang === 'en' ? 'See available' : 'Ver disponibles', 'group' => 'info'],
                ['id' => 'reservar', 'label' => $lang === 'en' ? 'Book now 📱' : 'Reservar 📱', 'group' => 'action'],
            ];
        } elseif (strpos($msg, 'precio') !== false || strpos($msg, 'cost') !== false || strpos($msg, 'cuesta') !== false || strpos($msg, 'much') !== false) {
            $quick = [
                ['id' => 'tarifas', 'label' => $lang === 'en' ? 'See rates' : 'Ver tarifas', 'group' => 'info'],
                ['id' => 'contacto', 'label' => $lang === 'en' ? 'Contact 📱' : 'Contacto 📱', 'group' => 'action'],
            ];
        } elseif (strpos($msg, 'hotel') !== false || strpos($msg, 'casa') !== false || strpos($msg, 'domicil') !== false || strpos($msg, 'outcall') !== false) {
            $quick = [
                ['id' => 'hotel_domicilio', 'label' => $lang === 'en' ? 'Hotel info' : 'Info hotel', 'group' => 'info'],
                ['id' => 'reservar', 'label' => $lang === 'en' ? 'Book now 📱' : 'Reservar 📱', 'group' => 'action'],
            ];
        } else {
            $quick = [
                ['id' => 'escorts_disponibles', 'label' => $lang === 'en' ? 'See girls' : 'Ver chicas', 'group' => 'info'],
                ['id' => 'tarifas', 'label' => $lang === 'en' ? 'Rates' : 'Tarifas', 'group' => 'info'],
                ['id' => 'contacto', 'label' => $lang === 'en' ? 'Contact 📱' : 'Contacto 📱', 'group' => 'action'],
            ];
        }

        return ['messages' => [
            ['type' => 'text', 'text' => $text, 'buttons' => $this->btn($quick)],
        ], 'lang' => $lang];
    }

    // ── Log conversation ────────────────────────────────────────
    public function log_conversation(string $session_id, string $lang, string $user_msg, string $bot_reply): void {
        try {
            $logs = $this->load_json('chat_logs.json');
            if (!is_array($logs)) $logs = [];
            // Clean logs older than 4 days
            $now = time();
            $max_age = 345600;
            $logs = array_values(array_filter($logs, function($l) use ($now, $max_age) {
                return ($now - ($l['ts'] ?? 0)) < $max_age;
            }));
            $logs[] = ['session_id' => $session_id, 'lang' => $lang, 'user' => $user_msg, 'bot' => $bot_reply, 'ts' => time()];
            if (count($logs) > 2000) {
                $logs = array_slice($logs, -2000);
            }
            $this->save_json('chat_logs.json', $logs);
        } catch (\Exception $e) {
            // Never let logging break the chat
        }
    }

    // ══════════════════════════════════════════════════════════════
    // TICKET SYSTEM — each conversation is a ticket
    // ══════════════════════════════════════════════════════════════

    /**
     * Add a message exchange to the ticket.
     * Auto-closes ticket after 10 minutes of inactivity (checked on next message).
     */
    public function add_to_ticket(string $session_id, string $user_msg, string $bot_reply, string $lang, string $client_name = ''): void {
        try {
            $tickets = $this->load_json('tickets.json');
            if (!is_array($tickets)) $tickets = [];

            $found = false;
            foreach ($tickets as &$t) {
                if (($t['id'] ?? '') === $session_id) {
                    $found = true;
                    $t['updated_at'] = time();
                    $t['lang']       = $lang;
                    $t['status']     = 'open';
                    if ($client_name && empty($t['client_name'])) $t['client_name'] = $client_name;
                    $t['messages'][] = [
                        'ts'   => time(),
                        'user' => substr($user_msg, 0, 500),
                        'bot'  => substr($bot_reply, 0, 1000),
                    ];
                    break;
                }
            }
            unset($t); // CRITICAL: release reference before next loop

            if (!$found) {
                // Create ticket on the fly
                $tickets[] = [
                    'id'          => $session_id,
                    'client_name' => $client_name,
                    'status'      => 'open',
                    'lang'       => $lang,
                    'created_at' => time(),
                    'updated_at' => time(),
                    'messages'   => [[
                        'ts'   => time(),
                        'user' => substr($user_msg, 0, 500),
                        'bot'  => substr($bot_reply, 0, 1000),
                    ]],
                    'summary' => '',
                ];
            }

            // Clean old tickets (>4 days) + auto-close (>30 min inactive)
            $now = time();
            $max_age = 345600; // 4 days in seconds
            $tickets_cleaned = [];
            foreach ($tickets as &$tk) {
                // Delete tickets older than 4 days
                if (($now - ($tk['updated_at'] ?? 0)) > $max_age) {
                    continue;
                }
                // Auto-close after 30 min of inactivity
                if ($tk['status'] === 'open' && ($now - ($tk['updated_at'] ?? 0)) > 1800) {
                    $tk['status'] = 'closed';
                    $msgs = $tk['messages'] ?? [];
                    if (!empty($msgs)) {
                        $first_msg = $msgs[0]['user'] ?? '';
                        $count     = count($msgs);
                        $tk['summary'] = "{$count} mensajes. Primera pregunta: " . substr($first_msg, 0, 80);
                    }
                }
                $tickets_cleaned[] = $tk;
            }
            unset($tk);
            $tickets = $tickets_cleaned;

            if (count($tickets) > 500) {
                $tickets = array_slice($tickets, -500);
            }
            $this->save_json('tickets.json', $tickets);
        } catch (\Exception $e) {
            // never break chat
        }
    }
}

