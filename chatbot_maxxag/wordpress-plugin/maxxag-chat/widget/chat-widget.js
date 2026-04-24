/**
 * Maxxag Chat Widget — v3
 * - Language selector at start
 * - Progressive menu (used questions disappear)
 * - Grouped bot messages (avatar only once per batch)
 * - 2-column button grid (info/action groups)
 */
(function () {
  'use strict';

  var SCRIPT   = document.currentScript || document.querySelector('script[data-api]');
  var API_BASE = (SCRIPT && SCRIPT.dataset.api)  || '';
  if (!API_BASE) return;
  var INIT_LANG= sessionStorage.getItem('maxxag_lang_done') || (SCRIPT && SCRIPT.dataset.lang) || 'es';

  var sessionId    = null;
  var currentLang  = INIT_LANG;
  var isOpen       = false;
  var isLoading    = false;
  var siteLogoUrl  = '';

  // Language: remember within tab session, but always show selector on fresh tab
  var langSelected = !!sessionStorage.getItem('maxxag_lang_done');

  // Progressive menu: reset on every page load so all buttons appear fresh
  var usedOptions = new Set();
  var PERMANENT   = new Set(['menu', 'contacto', 'reservar', 'escorts_disponibles', 'tarifas', 'horario', 'hotel_domicilio']);

  // ── Bot identity (set by API response) ──────────────────────────
  var _botAvatar = '';
  var _botName   = '';

  // ================================================================
  // DOM
  // ================================================================
  function createRoot() {
    var root = document.createElement('div');
    root.id  = 'maxxag-chat-root';
    root.innerHTML =
      '<button id="maxxag-chat-btn" aria-label="Abrir chat" aria-haspopup="dialog">' +
        '<span class="maxxag-notif">1</span>' +
        '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>' +
      '</button>' +
      '<div id="maxxag-chat-window" role="dialog" aria-label="Chat" aria-modal="true" tabindex="-1">' +
        '<div id="maxxag-chat-header">' +
          '<div class="maxxag-header-avatar-wrap">' +
            '<img id="maxxag-avatar-img" src="" alt="" style="display:none">' +
            '<span class="maxxag-avatar-letter">M</span>' +
          '</div>' +
          '<div class="maxxag-header-info">' +
            '<div class="maxxag-bot-name" id="maxxag-bot-name">...</div>' +
            '<div class="maxxag-status" id="maxxag-status-text">En línea</div>' +
          '</div>' +
          '<button id="maxxag-chat-close" aria-label="Cerrar chat">' +
            '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>' +
          '</button>' +
        '</div>' +
        '<div id="maxxag-chat-messages" aria-live="polite" aria-atomic="false"></div>' +
        '<div id="maxxag-chat-input-row">' +
          '<textarea id="maxxag-chat-input" name="message" rows="1" placeholder="Escribe un mensaje..." aria-label="Escribe un mensaje" autocomplete="off"></textarea>' +
          '<button id="maxxag-chat-send" aria-label="Enviar mensaje"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
  }

  // ================================================================
  // Open / Close
  // ================================================================
  function openChat() {
    isOpen = true;
    _initAudio(); // user gesture, OK to create AudioContext
    document.getElementById('maxxag-chat-window').classList.add('maxxag-open');
    var notif = document.querySelector('#maxxag-chat-btn .maxxag-notif');
    if (notif) notif.style.display = 'none';
    // Remove proactive bubble if present
    var bubble = document.querySelector('.maxxag-proactive');
    if (bubble) bubble.remove();

    var isEmpty = !getMessages().innerHTML.trim();
    if (!langSelected) {
      showLangSelector();
    } else if (isEmpty) {
      startConversation();
    }
    // Focus management: pause pulse, focus close btn for keyboard users
    var btnEl = document.getElementById('maxxag-chat-btn');
    if (btnEl) btnEl.style.animation = 'none';
    setTimeout(function() {
      var closeEl = document.getElementById('maxxag-chat-close');
      if (closeEl) closeEl.focus();
    }, 350);
  }

  function closeChat() {
    isOpen = false;
    document.getElementById('maxxag-chat-window').classList.remove('maxxag-open');
    var btnEl = document.getElementById('maxxag-chat-btn');
    if (btnEl) { btnEl.style.animation = ''; btnEl.focus(); }
  }

  // ================================================================
  // Language selector
  // ================================================================
  var LANGS = [
    { code: 'es', cc: 'es', name: 'Español',  native: 'Spanish'  },
    { code: 'en', cc: 'gb', name: 'English',  native: 'Inglés'   },
    { code: 'fr', cc: 'fr', name: 'Français', native: 'Francés'  },
    { code: 'it', cc: 'it', name: 'Italiano', native: 'Italiano' },
  ];
  var LANG_TITLES = { es:'Bienvenido 💋', en:'Welcome 💋', fr:'Bienvenue 💋', it:'Benvenuto 💋' };
  var LANG_SUBS   = { es:'Elige tu idioma', en:'Choose your language', fr:'Choisissez votre langue', it:'Scegli la tua lingua' };

  function showLangSelector() {
    var msgs = getMessages();
    msgs.innerHTML = '';
    var screen = document.createElement('div');
    screen.className = 'maxxag-lang-screen';

    var title = document.createElement('div');
    title.className = 'maxxag-lang-title';
    title.textContent = LANG_TITLES[currentLang] || LANG_TITLES.es;

    var sub = document.createElement('div');
    sub.className = 'maxxag-lang-subtitle';
    sub.textContent = LANG_SUBS[currentLang] || LANG_SUBS.es;

    screen.appendChild(title);
    screen.appendChild(sub);

    var grid = document.createElement('div');
    grid.className = 'maxxag-lang-grid';
    LANGS.forEach(function(l) {
      var btn = document.createElement('button');
      btn.className = 'maxxag-lang-flag';
      btn.title = l.name;
      btn.setAttribute('aria-label', l.name);
      // Use SVG flags (vector, never pixelated, with 2x PNG fallback)
      btn.innerHTML = '<img src="https://flagcdn.com/' + l.cc + '.svg" srcset="https://flagcdn.com/w160/' + l.cc + '.png 1x, https://flagcdn.com/w320/' + l.cc + '.png 2x" alt="' + l.name + '" loading="lazy">';
      btn.addEventListener('click', function() {
        currentLang = l.code;
        langSelected = true;
        sessionStorage.setItem('maxxag_lang_done', l.code);
        usedOptions.clear();
        updateStatusText();
        startConversation();
      });
      grid.appendChild(btn);
    });
    screen.appendChild(grid);
    msgs.appendChild(screen);
  }

  // ================================================================
  // API
  // ================================================================
  function startConversation() {
    apiFetch('/chat', { lang: currentLang })
      .then(function(res) {
        sessionId = res.session_id;
        currentLang = res.lang;
        getMessages().innerHTML = '';
        renderMessages(res.messages);
      })
      .catch(function() {
        var errMsg = {es:'Ay, parece que hay un problema de conexión 😕 Intenta de nuevo en un momento, cariño.',
                      en:'Oops, connection issue 😕 Try again in a moment, darling.',
                      fr:'Oups, problème de connexion 😕 Réessaie dans un instant, chéri.',
                      it:'Ops, problema di connessione 😕 Riprova tra un momento, tesoro.'};
        appendBotMsg(errMsg[currentLang] || errMsg.es, null, true, true);
      });
  }

  function sendMessage(text) {
    if (isLoading || !text.trim()) return;
    isLoading = true;
    setSendDisabled(true);
    clearInput();
    appendUserMsg(text);
    showTyping();

    apiFetch('/chat', { message: text, session_id: sessionId, lang: currentLang })
      .then(function(res) {
        currentLang = res.lang;
        removeTyping();
        renderMessages(res.messages);
        playNotifSound();
      })
      .catch(function() {
        removeTyping();
        var errMsg2 = {es:'Hubo un error, cariño 😕 Intenta de nuevo.',
                       en:'Something went wrong, darling 😕 Try again.',
                       fr:'Une erreur s\'est produite, chéri 😕 Réessaie.',
                       it:'C\'è stato un errore, tesoro 😕 Riprova.'};
        appendBotMsg(errMsg2[currentLang] || errMsg2.es, null, true, true);
      })
      .finally(function() {
        isLoading = false;
        setSendDisabled(false);
      });
  }

  // Send button click: show pretty label to user, send ID to backend
  function sendMessageBtn(id, displayLabel) {
    if (isLoading) return;
    isLoading = true;
    setSendDisabled(true);
    appendUserMsg(displayLabel);
    showTyping();
    var startTime = Date.now();

    apiFetch('/chat', { message: id, session_id: sessionId, lang: currentLang })
      .then(function(res) {
        // Minimum 800ms typing for predefined responses (feels natural)
        var elapsed = Date.now() - startTime;
        var delay = Math.max(0, 800 - elapsed);
        setTimeout(function() {
          currentLang = res.lang;
          removeTyping();
          renderMessages(res.messages);
          playNotifSound();
          isLoading = false;
          setSendDisabled(false);
        }, delay);
      })
      .catch(function() {
        removeTyping();
        var errMsg2 = {es:'Hubo un error, cariño 😕 Intenta de nuevo.',
                       en:'Something went wrong, darling 😕 Try again.',
                       fr:'Une erreur s\'est produite, chéri 😕 Réessaie.',
                       it:'C\'è stato un errore, tesoro 😕 Riprova.'};
        appendBotMsg(errMsg2[currentLang] || errMsg2.es, null, true, true);
        isLoading = false;
        setSendDisabled(false);
      });
  }

  function apiFetch(path, body) {
    var opts = { headers: { 'Content-Type': 'application/json' } };
    if (body) {
      opts.method = 'POST';
      opts.body = JSON.stringify(body);
    } else {
      opts.method = 'GET';
    }
    return fetch(API_BASE + path, opts).then(function(r) {
      if (!r.ok) throw new Error('API ' + r.status);
      return r.json();
    });
  }

  // ================================================================
  // Render messages (grouped — avatar only on first bot msg in batch)
  // ================================================================
  function renderMessages(messages) {
    var botCount = 0;
    var totalBotMsgs = 0;
    // Count bot messages for grouping
    messages.forEach(function(m) { if (m.type === 'text' || m.type === 'girls' || m.type === 'rates') totalBotMsgs++; });

    messages.forEach(function(msg) {
      if (msg.type === 'avatar') {
        updateHeaderDirect(msg.name, msg.avatar);
        return;
      }
      botCount++;
      var isFirst = (botCount === 1);
      var isLast  = (botCount === totalBotMsgs);

      switch (msg.type) {
        case 'text':   appendBotMsg(msg.text, msg.buttons, isFirst, isLast); break;
        case 'girls':  appendGirls(msg.girls, msg.buttons); break;
        case 'rates':  appendRates(msg, msg.buttons); break;
      }
    });
    // Scroll once after ALL messages rendered — show client msg + start of response
    scrollToLastUserMsg();
  }

  // ================================================================
  // Time
  // ================================================================
  function _timeNow() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // ================================================================
  // User message
  // ================================================================
  function appendUserMsg(text) {
    var wrap = document.createElement('div');
    wrap.className = 'maxxag-user-wrap';
    var d = document.createElement('div');
    d.className = 'maxxag-msg user';
    d.textContent = text;
    var ts = document.createElement('span');
    ts.className = 'maxxag-ts right';
    ts.textContent = _timeNow();
    d.appendChild(ts);
    wrap.appendChild(d);
    getMessages().appendChild(wrap);
    scrollBottom();
  }

  // ================================================================
  // Bot message — showMeta = show avatar+name, showTime = show timestamp
  // ================================================================
  function appendBotMsg(text, buttons, showMeta, showTime) {
    if (!text && !(buttons && buttons.length)) return; // empty guard
    var group = document.createElement('div');
    group.className = 'maxxag-bot-group';

    // Avatar + name (only on first message in a batch)
    if (showMeta !== false) {
      var meta = document.createElement('div');
      meta.className = 'maxxag-bot-meta';
      var avWrap = document.createElement('div');
      avWrap.className = 'maxxag-bot-meta-avatar';
      if (_botAvatar) {
        var img = document.createElement('img');
        img.alt = '';
        img.onerror = function() {
          // Image failed — replace with letter placeholder
          this.remove();
          avWrap.textContent = (_botName || 'S').charAt(0).toUpperCase();
        };
        img.src = _botAvatar;
        avWrap.appendChild(img);
      } else {
        avWrap.textContent = (_botName || 'S').charAt(0).toUpperCase();
      }
      var nameEl = document.createElement('span');
      nameEl.className = 'maxxag-bot-meta-name';
      nameEl.textContent = _botName || '';
      meta.appendChild(avWrap);
      meta.appendChild(nameEl);
      group.appendChild(meta);
    }

    // Bubble with inline timestamp
    var d = document.createElement('div');
    d.className = 'maxxag-msg bot';
    d.textContent = text;
    if (showTime !== false) {
      var ts = document.createElement('span');
      ts.className = 'maxxag-ts';
      ts.textContent = _timeNow();
      d.appendChild(ts);
    }
    group.appendChild(d);

    // Buttons
    if (buttons && buttons.length) group.appendChild(renderButtons(buttons));
    getMessages().appendChild(group);
  }

  // ================================================================
  // Girls cards
  // ================================================================
  function appendGirls(girls, buttons) {
    var wrap = document.createElement('div');
    wrap.className = 'maxxag-bot-group';
    if (!girls || !girls.length) {
      var no = document.createElement('div');
      no.className = 'maxxag-msg bot';
      no.textContent = currentLang === 'en'
        ? 'No girls available right now. Contact reception.'
        : 'No hay chicas disponibles ahora. Contacta recepción.';
      wrap.appendChild(no);
    } else {
      var grid = document.createElement('div');
      grid.className = 'maxxag-girls-grid';
      girls.forEach(function(g) { grid.appendChild(buildGirlCard(g)); });
      wrap.appendChild(grid);
    }
    if (buttons && buttons.length) wrap.appendChild(renderButtons(buttons));
    getMessages().appendChild(wrap);
  }

  function buildGirlCard(g) {
    var card = document.createElement('div');
    card.className = 'maxxag-girl-card';
    var img = document.createElement('img');
    img.src = g.photo_url || 'https://placehold.co/300x400/1a1a1a/888?text=' + encodeURIComponent(g.name);
    img.alt = g.name; img.loading = 'lazy';
    // Name + age overlaid on photo
    var name = document.createElement('div'); name.className = 'maxxag-girl-name';
    name.textContent = g.name + (g.age ? ' · ' + g.age : '');
    // WhatsApp button
    var info = document.createElement('div'); info.className = 'maxxag-girl-info';
    var wa = document.createElement('a'); wa.className = 'maxxag-girl-wa';
    var waNum = (g.whatsapp || '').replace(/\D/g, '');
    wa.href = /^\d{7,15}$/.test(waNum) ? 'https://wa.me/' + waNum : '#';
    if (!waNum) wa.style.opacity = '0.4';
    wa.target = '_blank'; wa.rel = 'noopener';
    wa.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;margin-right:4px"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>WhatsApp';
    info.appendChild(wa);
    card.appendChild(img); card.appendChild(name); card.appendChild(info);
    return card;
  }

  // ================================================================
  // Rates table
  // ================================================================
  function appendRates(data, buttons) {
    var wrap = document.createElement('div');
    wrap.className = 'maxxag-bot-group';
    var box = document.createElement('div');
    box.className = 'maxxag-msg bot maxxag-rates';
    var title = document.createElement('div'); title.className='maxxag-rates-title'; title.textContent = data.title;
    box.appendChild(title);
    var table = document.createElement('table'); table.className='maxxag-rates-table';
    (data.items||[]).forEach(function(item) {
      var tr=document.createElement('tr');
      var td1=document.createElement('td'); var td2=document.createElement('td');
      td1.textContent = item['label_'+(data.lang||currentLang)] || item.label_es || '';
      td2.textContent = item.price;
      tr.appendChild(td1); tr.appendChild(td2); table.appendChild(tr);
    });
    box.appendChild(table);
    if (data.note) { var note=document.createElement('div'); note.className='maxxag-rates-note'; note.textContent=data.note; box.appendChild(note); }
    wrap.appendChild(box);
    if (buttons && buttons.length) wrap.appendChild(renderButtons(buttons));
    getMessages().appendChild(wrap);
  }

  // ================================================================
  // Buttons — progressive filtering + 2-column grid layout
  // ================================================================
  function filterButtons(buttons) {
    return buttons.filter(function(btn) {
      // Hide language buttons after selection
      if (langSelected && btn.id && btn.id.indexOf('lang_') === 0) return false;
      // Hide used options (keep permanent ones)
      if (btn.id && usedOptions.has(btn.id) && !PERMANENT.has(btn.id)) return false;
      return true;
    });
  }

  function _createBtn(btn) {
    var b = document.createElement('button');
    b.className = 'maxxag-btn';
    if (btn.url && btn.url.indexOf('wa.me') > -1) b.classList.add('wa-btn');
    if (btn.url && btn.url.indexOf('t.me') > -1)  b.classList.add('tg-btn');
    if (btn.full_width) b.classList.add('full-width');
    b.textContent = btn.label;

    b.addEventListener('click', function() {
      if (btn.url) { window.open(btn.url, '_blank', 'noopener'); return; }
      if (isLoading) return; // prevent race condition
      // "Back to menu" → reset used options so all buttons reappear
      if (btn.id === 'menu') { usedOptions.clear(); }
      // Mark non-permanent buttons as used (they disappear from menu)
      if (!PERMANENT.has(btn.id)) { usedOptions.add(btn.id); }
      // Show the pretty label to the user, send the ID to the backend
      sendMessageBtn(btn.id || btn.label, btn.label);
    });
    return b;
  }

  function renderButtons(buttons) {
    var filtered = filterButtons(buttons);
    if (!filtered.length) return document.createDocumentFragment();

    var container = document.createElement('div');
    container.className = 'maxxag-buttons';

    // Separate by group
    var infoArr   = [];
    var actionArr = [];
    var otherArr  = [];
    filtered.forEach(function(btn) {
      if (btn.group === 'info')        infoArr.push(btn);
      else if (btn.group === 'action') actionArr.push(btn);
      else                             otherArr.push(btn);
    });

    // Info buttons → 2-column grid
    if (infoArr.length) {
      var grid = document.createElement('div');
      grid.className = 'maxxag-btn-grid';
      infoArr.forEach(function(btn) { grid.appendChild(_createBtn(btn)); });
      container.appendChild(grid);
    }

    // Divider between info and action
    if (infoArr.length && actionArr.length) {
      var divider = document.createElement('div');
      divider.className = 'maxxag-btn-divider';
      container.appendChild(divider);
    }

    // Action buttons → 2-column grid
    if (actionArr.length) {
      var actionGrid = document.createElement('div');
      actionGrid.className = 'maxxag-btn-grid';
      actionArr.forEach(function(btn) {
        var b = _createBtn(btn);
        b.classList.add('action-btn');
        actionGrid.appendChild(b);
      });
      container.appendChild(actionGrid);
    }

    // Other buttons (back to menu, WhatsApp/Telegram links) → full width
    otherArr.forEach(function(btn) {
      var b = _createBtn(btn);
      b.classList.add('full-width');
      container.appendChild(b);
    });

    return container;
  }

  // ================================================================
  // Typing indicator
  // ================================================================
  function showTyping() {
    var t = document.createElement('div');
    t.className = 'maxxag-typing'; t.id = 'maxxag-typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    getMessages().appendChild(t); scrollBottom();
  }
  function removeTyping() { var t = document.getElementById('maxxag-typing'); if (t) t.remove(); }

  // ================================================================
  // Header
  // ================================================================
  function updateHeaderDirect(name, avatar) {
    var ne = document.getElementById('maxxag-bot-name');
    var ae = document.getElementById('maxxag-avatar-img');
    var ph = document.querySelector('.maxxag-avatar-letter');
    if (ne) ne.textContent = name || '';
    // Update placeholder letter to first letter of bot name (e.g., "S" for Sara)
    if (ph && name) ph.textContent = name.charAt(0).toUpperCase();
    if (avatar && ae) {
      ae.onerror = function() {
        // Image 404 or network error — fall back to letter placeholder
        this.style.display = 'none';
        if (ph) ph.style.display = 'flex';
        _botAvatar = ''; // prevent showing broken avatar in message bubbles
      };
      ae.onload = function() {
        this.style.display = 'block';
        if (ph) ph.style.display = 'none';
      };
      ae.src = avatar;
    } else if (ae) {
      ae.style.display = 'none';
      if (ph) ph.style.display = 'flex';
    }
    _botAvatar = avatar || '';
    _botName   = name || '';
  }

  function updateStatusText() {
    var s  = { es:'En línea', en:'Online', fr:'En ligne', it:'Online' };
    var el = document.getElementById('maxxag-status-text');
    if (el) el.textContent = s[currentLang] || 'En línea';
    var ip = document.getElementById('maxxag-chat-input');
    var ph = { es:'Escribe un mensaje...', en:'Type a message...', fr:'Écrivez un message...', it:'Scrivi un messaggio...' };
    if (ip) ip.placeholder = ph[currentLang] || 'Escribe un mensaje...';
  }

  // ================================================================
  // Utilities
  // ================================================================
  function getMessages()    { return document.getElementById('maxxag-chat-messages'); }
  function scrollBottom()   { var el = getMessages(); if (el) el.scrollTop = el.scrollHeight; }
  function scrollToLastUserMsg() {
    var el = getMessages(); if (!el) return;
    var wraps = el.querySelectorAll('.maxxag-user-wrap');
    if (wraps.length === 0) { scrollBottom(); return; }
    var last = wraps[wraps.length - 1];
    // Double rAF ensures DOM has painted before measuring offset
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        el.scrollTo({ top: last.offsetTop - 10, behavior: 'smooth' });
      });
    });
  }
  var _audioCtx = null;
  function _initAudio() {
    if (_audioCtx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) _audioCtx = new AC();
    } catch(e) {}
  }
  function playNotifSound() {
    if (!_audioCtx) return;
    try {
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      var osc = _audioCtx.createOscillator();
      var gain = _audioCtx.createGain();
      osc.connect(gain); gain.connect(_audioCtx.destination);
      osc.frequency.value = 880; osc.type = 'sine';
      gain.gain.value = 0.08;
      gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.15);
      osc.start(_audioCtx.currentTime); osc.stop(_audioCtx.currentTime + 0.15);
    } catch(e) {}
  }
  function clearInput()     { var el = document.getElementById('maxxag-chat-input'); if (el) { el.value = ''; el.style.height = 'auto'; } }
  function setSendDisabled(v) { var b = document.getElementById('maxxag-chat-send'); if (b) b.disabled = v; }
  function autoResize(el)   { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 80) + 'px'; }

  // ================================================================
  // Init
  // ================================================================
  function init() {
    createRoot();
    // Fetch site config for logo + avatar
    apiFetch('/config').then(function(cfg) {
      siteLogoUrl = (cfg.site && (cfg.site.logo_url || cfg.site.bot_avatar)) || '';
      var cfgBotName = (cfg.site && cfg.site.bot_name) || '';
      // Update header immediately (don't wait for first /chat response)
      if (cfgBotName || siteLogoUrl) {
        updateHeaderDirect(cfgBotName, siteLogoUrl);
      }
      // Put avatar in chat button with onerror fallback
      if (siteLogoUrl) {
        var chatBtn = document.getElementById('maxxag-chat-btn');
        if (chatBtn) {
          var svg = chatBtn.querySelector('svg');
          var avImg = document.createElement('img');
          avImg.className = 'maxxag-btn-avatar';
          avImg.alt = '';
          avImg.onload = function() { if (svg) svg.style.display = 'none'; };
          avImg.onerror = function() {
            // Image failed — keep the default SVG icon visible, remove broken img
            this.remove();
            if (svg) svg.style.display = '';
          };
          avImg.src = siteLogoUrl;
          chatBtn.insertBefore(avImg, chatBtn.firstChild);
        }
      }
    }).catch(function() {});
    var btn      = document.getElementById('maxxag-chat-btn');
    var closeBtn = document.getElementById('maxxag-chat-close');
    var input    = document.getElementById('maxxag-chat-input');
    var sendBtn  = document.getElementById('maxxag-chat-send');

    btn.addEventListener('click', function() { isOpen ? closeChat() : openChat(); });
    closeBtn.addEventListener('click', closeChat);
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && isOpen) closeChat(); });
    sendBtn.addEventListener('click', function() {
      var v = input.value.trim(); if (v) sendMessage(v);
    });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); var v = input.value.trim(); if (v) sendMessage(v); }
    });
    input.addEventListener('input', function() { autoResize(input); });
    updateStatusText();

    // Proactive notification with bell + message after 3s
    if (!sessionStorage.getItem('maxxag_notif_shown')) {
      setTimeout(function() {
        if (isOpen) return;
        var bubble = document.createElement('div');
        bubble.className = 'maxxag-proactive';
        bubble.setAttribute('role', 'alert');
        bubble.setAttribute('aria-label', 'Chat disponible');
        var texts = {
          es: '\u00bfTe puedo ayudar, cari\u00f1o? \uD83D\uDE18',
          en: 'Can I help you, darling? \uD83D\uDE18',
          fr: 'Je peux t\'aider, ch\u00e9ri ? \uD83D\uDE18',
          it: 'Posso aiutarti, tesoro? \uD83D\uDE18'
        };
        // Bell badge
        var bell = document.createElement('span');
        bell.className = 'maxxag-proactive-bell';
        bell.innerHTML = '\uD83D\uDD14';
        var badge = document.createElement('span');
        badge.className = 'maxxag-proactive-badge';
        badge.textContent = '1';
        bell.appendChild(badge);
        // Text
        var msg = document.createElement('span');
        msg.className = 'maxxag-proactive-text';
        msg.textContent = texts[currentLang] || texts.es;
        bubble.appendChild(bell);
        bubble.appendChild(msg);
        bubble.addEventListener('click', function() {
          bubble.remove();
          openChat();
        });
        btn.parentElement.appendChild(bubble);
        sessionStorage.setItem('maxxag_notif_shown', '1');
      }, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
