  /* ─── STATE ──────────────────────────────────────────────────── */
  // Priority: server-injected config > localStorage > auto-detect
  let _defaultApi = (window.maxxagApiUrl && String(window.maxxagApiUrl).replace(/\/$/, ''))
    || localStorage.getItem('maxxag_api')
    || (location.origin + '/wp-json/maxxag/v1');
  let API = _defaultApi;
  let _hasSession = false; // true after successful session auth
  let allGirls = [];
  let rateItems = [];

  var _urlInput = document.getElementById('api-url-input');
  if (_urlInput) _urlInput.value = API;

  /* ─── AUTH — HttpOnly session cookie ─────────────────────────── */
  async function doLogin() {
    const dbg = document.getElementById('login-error');
    dbg.style.color = '#888';
    dbg.textContent = '[1] Click detectado, preparando login...';
    const urlVal = document.getElementById('api-url-input').value.trim().replace(/\/$/, '');
    if (urlVal) {
      if (!/^https?:\/\//i.test(urlVal)) {
        dbg.style.color = '#f66';
        dbg.textContent = 'URL must start with http:// or https://';
        return;
      }
      API = urlVal; localStorage.setItem('maxxag_api', API);
    }
    const tokenVal = document.getElementById('token-input').value.trim();
    if (!tokenVal) {
      dbg.style.color = '#f66';
      dbg.textContent = 'Token vacío';
      return;
    }
    dbg.textContent = '[2] Enviando POST a ' + API + '/admin/session ...';
    try {
      const sessRes = await fetch(API + '/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token: tokenVal })
      });
      dbg.textContent = '[3] Respuesta HTTP ' + sessRes.status + ' - leyendo body...';
      const body = await sessRes.text();
      dbg.textContent = '[4] Body (' + body.length + ' chars): ' + body.substring(0, 200);
      if (!sessRes.ok) {
        dbg.style.color = '#f66';
        dbg.textContent = 'Login FAILED (' + sessRes.status + '): ' + body.substring(0, 200);
        return;
      }
      dbg.style.color = '#0c0';
      dbg.textContent = '[5] Login OK! Verificando sesión...';
      // Verify session was actually created before reloading
      const check = await fetch(API + '/admin/whoami', { credentials: 'same-origin' });
      const whoami = await check.json();
      if (!whoami.session_valid) {
        dbg.style.color = '#f66';
        dbg.textContent = '[FALLO] Cookie llegó pero sesión NO existe en DB. sessions_count=' + whoami.sessions_count + '. Algo bloquea update_option.';
        return;
      }
      dbg.style.color = '#0c0';
      dbg.textContent = '[6] Sesión verificada! Entrando...';
      _hasSession = true;
      document.getElementById('token-input').value = '';
      await enterApp();
    } catch(err) {
      dbg.style.color = '#f66';
      dbg.textContent = 'EXCEPCIÓN: ' + (err && err.message ? err.message : String(err));
    }
  }
  var _tokenInputEl = document.getElementById('token-input');
  if (_tokenInputEl) _tokenInputEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });

  async function enterApp() {
    await loadGirls();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    updateCityLabel();
    history.replaceState({ view: 'dashboard' }, '', '#dashboard');
    loadDashboard();
    loadRates();
  }

  // Auto-login: check if HttpOnly session cookie is still valid
  (async function tryAutoLogin() {
    try {
      const res = await fetch(API + '/admin/girls', { credentials: 'same-origin' });
      if (res.ok) {
        _hasSession = true;
        await enterApp();
      }
    } catch(e) { /* no session — show login */ }
  })();

  async function doLogout() {
    try { await fetch(API + '/admin/session/logout', { method: 'POST', credentials: 'same-origin' }); } catch(e) {}
    _hasSession = false;
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }

  function updateCityLabel() {
    const url = API.toLowerCase();
    let name = API.replace(/https?:\/\//, '');
    if (url.includes('5051') || url.includes('vlc') || url.includes('valencia')) name = 'Valencia';
    else if (url.includes('5052') || url.includes('madrid')) name = 'Madrid';
    else if (url.includes('5053') || url.includes('marbella')) name = 'Marbella';
    document.getElementById('city-label').textContent = name;
    // city label is in navbar now
  }

  function openCitySwitch() {
    const newUrl = prompt('URL del servidor:', API);
    if (newUrl && newUrl.trim()) {
      const cleaned = newUrl.trim().replace(/\/$/, '');
      if (!/^https?:\/\//i.test(cleaned)) {
        alert('URL must start with http:// or https://');
        return;
      }
      API = cleaned;
      localStorage.setItem('maxxag_api', API);
      updateCityLabel();
      loadGirls().then(() => { loadDashboard(); loadRates(); loadLogs(); });
    }
  }

  /* ─── NAVIGATION ─────────────────────────────────────────────── */
  const VIEW_TITLES = {
    dashboard: 'Dashboard',
    girls: 'Chicas',
    rates: 'Tarifas',
    config: 'Configuración',
    analysis: 'Análisis IA',
    conversations: 'Conversaciones',
  };

  var currentView = 'dashboard';

  function showView(name, el, skipHistory) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    if (el) el.classList.add('active');
    else {
      // Find and activate the matching nav button
      document.querySelectorAll('.nav-item').forEach(b => {
        if (b.dataset.view === name) b.classList.add('active');
      });
    }
    currentView = name;
    // Push to browser history so back button works
    if (!skipHistory) history.pushState({ view: name }, '', '#' + name);
    if (name === 'dashboard') loadDashboard();
    if (name === 'girls') loadGirls();
    if (name === 'rates') loadRates();
    if (name === 'conversations') loadLogs();
    if (name === 'config') loadConfig();
  }

  // Handle browser back/forward buttons
  window.addEventListener('popstate', function(e) {
    if (!_hasSession) return; // ignore if logged out
    if (e.state && e.state.sub === 'ticket') {
      // Already in ticket detail, back goes to ticket list
      backToTickets();
      return;
    }
    if (e.state && e.state.view) {
      showView(e.state.view, null, true);
    } else {
      showView('dashboard', null, true);
    }
  });

  /* ─── DASHBOARD ──────────────────────────────────────────────── */
  async function loadDashboard() {
    try {
      await loadGirls(); // refresh girls data
      const [hm] = await Promise.all([
        apiFetch('GET', '/admin/heatmap'),
      ]);
      const total = allGirls.length;
      const avail = allGirls.filter(g => g.available_today).length;
      document.getElementById('stat-girls').textContent = total;
      document.getElementById('stat-avail').textContent = avail;
      document.getElementById('stat-convs').textContent = hm.total_logs || 0;

      if (hm.heatmap && hm.heatmap.length) {
        const top = hm.heatmap[0];
        document.getElementById('stat-top').textContent = top.name;
        document.getElementById('stat-top-sub').textContent = top.count + ' menciones';
      }
      renderHeatmap(hm.heatmap || []);
    } catch(e) {
      document.getElementById('stat-convs').textContent = '?';
    }
  }

  function renderHeatmap(data) {
    const grid = document.getElementById('heatmap-grid');
    if (!data.length) {
      grid.innerHTML = '<div class="heatmap-empty">No hay datos aún. Las menciones aparecerán cuando los clientes conversen con el bot.</div>';
      return;
    }
    grid.innerHTML = '';
    data.forEach((g, i) => {
      const heat = g.heat || 0;
      // Heat color: 0=gray, 0.3=blue, 0.6=amber, 0.85=red, 1=deep red
      const color = heatColor(heat);
      const pct   = Math.round(heat * 100);

      const card = document.createElement('div');
      card.className = 'heat-card';
      card.title = g.name + ': ' + g.count + ' menciones';

      const photoHtml = g.photo_url
        ? `<img class="heat-photo" src="${escapeHtml(g.photo_url)}" alt="${escapeHtml(g.name)}" loading="lazy">`
        : `<div class="heat-photo-placeholder">👤</div>`;

      card.innerHTML = `
        ${photoHtml}
        <div class="heat-overlay" style="background: ${color.overlay}"></div>
        ${i === 0 && g.count > 0 ? '<span class="heat-badge top">🔥 TOP</span>' : ''}
        ${g.available ? '<span class="heat-badge avail" style="top:' + (i===0&&g.count>0?'30px':'7px') + ';right:7px">● Live</span>' : ''}
        <div class="heat-info">
          <div class="heat-name">${escapeHtml(g.name)}</div>
          <div class="heat-count">
            <span style="color:${color.text};font-weight:700">${g.count}</span>
            <div class="heat-bar-bg">
              <div class="heat-bar-fill" style="width:${pct}%;background:${color.bar}"></div>
            </div>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  }

  function heatColor(heat) {
    if (heat <= 0)   return { overlay: 'rgba(0,0,0,0)',         bar: '#444',     text: '#666' };
    if (heat < 0.25) return { overlay: 'rgba(59,130,246,0.15)', bar: '#3b82f6',  text: '#60a5fa' };
    if (heat < 0.5)  return { overlay: 'rgba(16,185,129,0.15)', bar: '#10b981',  text: '#34d399' };
    if (heat < 0.75) return { overlay: 'rgba(245,158,11,0.18)', bar: '#f59e0b',  text: '#fbbf24' };
    return               { overlay: 'rgba(239,68,68,0.22)',   bar: '#ef4444',  text: '#f87171' };
  }

  /* ─── GIRLS ───────────────────────────────────────────────────── */
  async function loadGirls() {
    const res = await apiFetch('GET', '/admin/girls');
    allGirls  = res.girls || [];
    renderGirls();
    const badge = document.getElementById('girls-badge');
    badge.textContent = allGirls.length;
    return res;
  }

  function renderGirls() {
    const grid = document.getElementById('girls-grid');
    if (!allGirls.length) {
      grid.innerHTML = '<p style="color:var(--muted);font-size:13px">No hay chicas registradas todavía.</p>';
      return;
    }
    grid.innerHTML = '';
    document.getElementById('girls-actions').style.display = allGirls.length ? 'flex' : 'none';
    document.getElementById('girl-select-all').checked = false;
    updateGirlCount();
    allGirls.forEach(g => {
      const card = document.createElement('div');
      card.className = 'girl-card';
      card.style.position = 'relative';
      // Checkbox
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'girl-cb';
      cb.dataset.id = g.id;
      cb.style.cssText = 'position:absolute;top:8px;left:8px;accent-color:var(--green);width:16px;height:16px;cursor:pointer;z-index:2';
      cb.addEventListener('click', function(e) { e.stopPropagation(); updateGirlCount(); });
      card.appendChild(cb);
      const inner = document.createElement('div');
      inner.style.display = 'flex';
      inner.style.width = '100%';
      inner.innerHTML = `
        <img src="${escapeHtml(g.photo_url || 'https://placehold.co/68x84/1a1a1a/444?text=' + encodeURIComponent(g.name))}" alt="${escapeHtml(g.name)}">
        <div class="girl-info">
          <div class="girl-name">${escapeHtml(g.name)}</div>
          <div class="girl-meta">${escapeHtml(String(g.age||''))} años · ${escapeHtml(g.nationality)}${g.outcall ? ' · Salidas ✓' : ''}</div>
          <div class="toggle-row">
            <span class="toggle-label">Disponible hoy</span>
            <label class="toggle">
              <input type="checkbox" ${g.available_today ? 'checked' : ''} data-avail-id="${g.id}">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="girl-actions">
            <button class="btn-edit" data-girl-id="${g.id}">Editar</button>
            <button class="btn-del" data-del-id="${g.id}">Eliminar</button>
          </div>
        </div>
      `;
      card.appendChild(inner);
      grid.appendChild(card);
    });
    // Bind edit/delete via data attributes instead of inline onclick
    document.querySelectorAll('[data-girl-id]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var girl = allGirls.find(function(g) { return g.id === btn.dataset.girlId; });
        if (girl) openEditGirl(girl);
      });
    });
    document.querySelectorAll('[data-del-id]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        deleteGirl(btn.dataset.delId);
      });
    });
    document.querySelectorAll('[data-avail-id]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        toggleAvail(cb.dataset.availId, cb.checked);
      });
    });
  }

  function updateGirlCount() {
    var cbs = document.querySelectorAll('.girl-cb:checked');
    document.getElementById('girl-selected-count').textContent = cbs.length + ' seleccionadas';
  }

  function toggleAllGirls(checked) {
    document.querySelectorAll('.girl-cb').forEach(function(cb) { cb.checked = checked; });
    updateGirlCount();
  }

  function getSelectedGirlIds() {
    var ids = [];
    document.querySelectorAll('.girl-cb:checked').forEach(function(cb) { ids.push(cb.dataset.id); });
    return ids;
  }

  function exportSelectedGirls() {
    var ids = getSelectedGirlIds();
    var girls = ids.length ? allGirls.filter(function(g) { return ids.indexOf(g.id) !== -1; }) : allGirls;
    if (!girls.length) { showToast('No hay chicas para exportar'); return; }
    var csv = 'Nombre,Edad,Nacionalidad,Descripcion,Foto URL,WhatsApp,Disponible,Outcall,Servicios,Idiomas\n';
    girls.forEach(function(g) {
      csv += csvSafe(g.name) + ',';
      csv += csvSafe(g.age) + ',';
      csv += csvSafe(g.nationality) + ',';
      csv += csvSafe(g.description) + ',';
      csv += csvSafe(g.photo_url) + ',';
      csv += csvSafe(g.whatsapp) + ',';
      csv += csvSafe(g.available_today ? 'Si' : 'No') + ',';
      csv += csvSafe(g.outcall ? 'Si' : 'No') + ',';
      csv += csvSafe((g.services||[]).join(', ')) + ',';
      csv += csvSafe((g.languages||[]).join(', ')) + '\n';
    });
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'chicas_export_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast('✓ ' + girls.length + ' chica(s) exportadas');
  }

  async function deleteSelectedGirls() {
    var ids = getSelectedGirlIds();
    if (!ids.length) { showToast('Selecciona al menos una chica'); return; }
    if (!confirm('¿Eliminar ' + ids.length + ' chica(s)? Esta acción no se puede deshacer.')) return;
    var deleted = 0;
    for (var i = 0; i < ids.length; i++) {
      try {
        await apiFetch('DELETE', '/admin/girl/' + ids[i]);
        deleted++;
      } catch(e) { /* skip failed delete */ }
    }
    await loadGirls();
    showToast('✓ ' + deleted + ' chica(s) eliminadas');
  }


  async function importGirls(input) {
    var file = input.files[0];
    if (!file) return;
    input.value = ''; // reset so same file can be re-selected

    var text = await file.text();
    var girls = [];

    if (file.name.endsWith('.json')) {
      // JSON import: expects { "girls": [...] } or [...]
      try {
        var data = JSON.parse(text);
        girls = Array.isArray(data) ? data : (data.girls || []);
      } catch(e) {
        showToast('Error: JSON no válido');
        return;
      }
    } else {
      // CSV import: parse header + rows
      var lines = text.split('\n').filter(function(l) { return l.trim(); });
      if (lines.length < 2) { showToast('CSV vacío o sin datos'); return; }
      var headers = parseCSVLine(lines[0]);
      for (var i = 1; i < lines.length; i++) {
        var cols = parseCSVLine(lines[i]);
        var g = {};
        headers.forEach(function(h, idx) {
          var key = h.trim().toLowerCase();
          var val = (cols[idx] || '').trim();
          if (key === 'nombre' || key === 'name') g.name = val;
          else if (key === 'edad' || key === 'age') g.age = parseInt(val) || 0;
          else if (key === 'nacionalidad' || key === 'nationality') g.nationality = val;
          else if (key === 'descripcion' || key === 'description') g.description = val;
          else if (key === 'foto url' || key === 'photo_url' || key === 'foto') g.photo_url = val;
          else if (key === 'whatsapp') g.whatsapp = val;
          else if (key === 'disponible' || key === 'available') g.available_today = (val === 'Si' || val === 'si' || val === 'true' || val === '1');
          else if (key === 'outcall' || key === 'salidas') g.outcall = (val === 'Si' || val === 'si' || val === 'true' || val === '1');
          else if (key === 'servicios' || key === 'services') g.services = val ? val.split(',').map(function(s) { return s.trim(); }) : [];
          else if (key === 'idiomas' || key === 'languages') g.languages = val ? val.split(',').map(function(s) { return s.trim(); }) : ['ES'];
        });
        if (g.name) girls.push(g);
      }
    }

    if (!girls.length) { showToast('No se encontraron chicas en el archivo'); return; }

    if (!confirm('Se van a importar ' + girls.length + ' chica(s). ¿Continuar?')) return;

    var imported = 0;
    for (var j = 0; j < girls.length; j++) {
      try {
        var girl = girls[j];
        girl.city = girl.city || detectCity();
        girl.services = girl.services || [];
        girl.languages = girl.languages || ['ES'];
        await apiFetch('POST', '/admin/girl', girl);
        imported++;
      } catch(e) {
        /* skip failed import */
      }
    }
    await loadGirls();
    showToast('✓ ' + imported + ' chica(s) importadas');
  }

  // Simple CSV line parser (handles quoted fields)
  function parseCSVLine(line) {
    var result = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (c === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    result.push(current);
    return result;
  }

  async function toggleAvail(id, val) {
    await apiFetch('POST', '/admin/toggle', { id, available_today: val });
    const g = allGirls.find(g => g.id === id);
    if (g) g.available_today = val;
    showToast(val ? '✓ Marcada disponible' : 'Marcada no disponible');
  }

  function openAddGirl() {
    document.getElementById('modal-title').textContent = 'Añadir chica';
    ['girl-id','girl-name','girl-age','girl-nationality','girl-desc','girl-photo','girl-wa'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('girl-available').checked = true;
    document.getElementById('girl-outcall').checked = false;
    var gpp = document.getElementById('girl-photo-preview');
    if (gpp) gpp.style.display = 'none';
    document.getElementById('girl-modal').classList.add('open');
  }

  function openEditGirl(g) {
    document.getElementById('modal-title').textContent = 'Editar perfil';
    document.getElementById('girl-id').value = g.id;
    document.getElementById('girl-name').value = g.name;
    document.getElementById('girl-age').value = g.age;
    document.getElementById('girl-nationality').value = g.nationality;
    document.getElementById('girl-desc').value = g.description;
    document.getElementById('girl-photo').value = g.photo_url || '';
    var gpp = document.getElementById('girl-photo-preview');
    var gpi = document.getElementById('girl-photo-img');
    if (g.photo_url && gpp && gpi) { gpi.src = g.photo_url; gpp.style.display = 'block'; }
    else if (gpp) { gpp.style.display = 'none'; }
    document.getElementById('girl-wa').value = g.whatsapp || '';
    document.getElementById('girl-available').checked = !!g.available_today;
    document.getElementById('girl-outcall').checked = !!g.outcall;
    document.getElementById('girl-modal').classList.add('open');
  }

  function closeModal() { document.getElementById('girl-modal').classList.remove('open'); }

  async function saveGirl() {
    const girl = {
      id:              document.getElementById('girl-id').value || undefined,
      name:            document.getElementById('girl-name').value,
      age:             parseInt(document.getElementById('girl-age').value) || 0,
      city:            detectCity(),
      nationality:     document.getElementById('girl-nationality').value,
      description:     document.getElementById('girl-desc').value,
      photo_url:       document.getElementById('girl-photo').value,
      whatsapp:        document.getElementById('girl-wa').value,
      available_today: document.getElementById('girl-available').checked,
      outcall:         document.getElementById('girl-outcall').checked,
      services: [], languages: ['ES'],
    };
    await apiFetch('POST', '/admin/girl', girl);
    closeModal();
    await loadGirls();
    showToast('✓ Guardado correctamente');
  }

  async function deleteGirl(id) {
    if (!confirm('¿Eliminar esta chica? Esta acción no se puede deshacer.')) return;
    await apiFetch('DELETE', `/admin/girl/${id}`);
    allGirls = allGirls.filter(g => g.id !== id);
    renderGirls();
    document.getElementById('girls-badge').textContent = allGirls.length;
    showToast('✓ Eliminada');
  }

  /* ─── RATES ──────────────────────────────────────────────────── */
  async function loadRates() {
    try {
      const cfg = await apiFetch('GET', '/admin/config');
      rateItems = (cfg.rates && cfg.rates.items) ? [...cfg.rates.items] : [];
      renderRatesTable();
    } catch { showToast('Error cargando tarifas'); }
  }

  function renderRatesTable() {
    const tbody = document.getElementById('rates-tbody');
    tbody.innerHTML = '';
    rateItems.forEach((item, i) => addRateRowFromItem(item, i));
  }

  function addRateRowFromItem(item, idx) {
    const tbody = document.getElementById('rates-tbody');
    const tr = document.createElement('tr');
    tr.dataset.idx = idx;
    tr.innerHTML = `
      <td><input class="rate-input" data-key="label_es" value="${escapeHtml(item.label_es||'')}" placeholder="Ej: 1 hora"></td>
      <td><input class="rate-input" data-key="label_en" value="${escapeHtml(item.label_en||'')}" placeholder="Ej: 1 hour"></td>
      <td class="td-price"><input class="rate-input" data-key="price" value="${escapeHtml(item.price||'')}" placeholder="150€"></td>
      <td class="td-del"><button class="btn-del-row" title="Eliminar">✕</button></td>
    `;
    tr.querySelector('.btn-del-row').addEventListener('click', function() { removeRateRow(this); });
    tbody.appendChild(tr);
  }

  function addRateRow() {
    const tbody = document.getElementById('rates-tbody');
    const idx = tbody.rows.length;
    addRateRowFromItem({ label_es:'', label_en:'', price:'' }, idx);
    tbody.lastElementChild.querySelector('input').focus();
  }

  function removeRateRow(btn) {
    btn.closest('tr').remove();
  }

  async function saveRates() {
    const rows = document.querySelectorAll('#rates-tbody tr');
    const items = [];
    rows.forEach(tr => {
      const obj = {};
      tr.querySelectorAll('input[data-key]').forEach(inp => { obj[inp.dataset.key] = inp.value.trim(); });
      if (obj.label_es || obj.price) items.push(obj);
    });
    try {
      const cfg = await apiFetch('GET', '/admin/config');
      if (!cfg.rates) cfg.rates = {};
      cfg.rates.items = items;
      await apiFetch('POST', '/admin/config', { rates: cfg.rates });
      rateItems = items;
      showToast('✓ Tarifas guardadas');
    } catch(e) {
      showToast('Error al guardar: ' + e.message);
    }
  }

  /* ─── CONFIG ────────────────────────────────────────────────────── */
  async function loadConfig() {
    try {
      const cfg = await apiFetch('GET', '/admin/config');
      const s = cfg.site || {};
      const sch = cfg.schedule || {};
      document.getElementById('cfg-botname').value     = s.bot_name || '';
      document.getElementById('cfg-avatar').value      = s.bot_avatar || '';
      document.getElementById('cfg-whatsapp').value    = s.whatsapp_recepcion || '';
      document.getElementById('cfg-telegram').value    = (s.telegram_recepcion || '').replace('@','');
      document.getElementById('cfg-hours-es').value    = sch.hours_es   || '';
      document.getElementById('cfg-address-es').value  = sch.address_es || '';
      document.getElementById('cfg-how-es').value      = sch.how_es     || '';
      document.getElementById('cfg-hours-en').value    = sch.hours_en   || '';
      document.getElementById('cfg-address-en').value  = sch.address_en || '';
      if (document.getElementById('cfg-how-en')) document.getElementById('cfg-how-en').value = sch.how_en || '';
      document.getElementById('cfg-greeting-es').value = s.greeting_es  || '';
      document.getElementById('cfg-greeting-en').value = s.greeting_en  || '';
      if (s.bot_avatar) showAvatarPreview(s.bot_avatar);
    } catch(e) { showToast('Error cargando config: ' + e.message); }
  }

  function showAvatarPreview(url) {
    if (!url) return;
    const preview = document.getElementById('cfg-avatar-preview');
    const img     = document.getElementById('cfg-avatar-img');
    img.src = url;
    img.onerror = () => { preview.style.display = 'none'; };
    img.onload  = () => { preview.style.display = 'block'; };
  }

  // Live preview when URL is typed
  document.addEventListener('DOMContentLoaded', function() {
    const avatarInput = document.getElementById('cfg-avatar');
    if (avatarInput) {
      avatarInput.addEventListener('input', function() {
        showAvatarPreview(this.value.trim());
      });
    }
  });

  async function saveConfig() {
    const tg     = document.getElementById('cfg-telegram').value.trim();
    const avatar = document.getElementById('cfg-avatar').value.trim();
    // Build site object — include all fields (empty string clears the value)
    const site = {};
    site.bot_name = document.getElementById('cfg-botname').value.trim();
    site.bot_avatar = avatar;
    site.whatsapp_recepcion = document.getElementById('cfg-whatsapp').value.trim();
    site.telegram_recepcion = tg ? '@' + tg.replace('@','') : '';
    site.greeting_es = document.getElementById('cfg-greeting-es').value.trim();
    site.greeting_en = document.getElementById('cfg-greeting-en').value.trim();

    const schedule = {};
    const fields = {
      'cfg-hours-es':'hours_es', 'cfg-address-es':'address_es', 'cfg-how-es':'how_es',
      'cfg-hours-en':'hours_en', 'cfg-address-en':'address_en'
    };
    Object.keys(fields).forEach(function(id) {
      const el = document.getElementById(id);
      if (el) schedule[fields[id]] = el.value.trim();
    });
    const howEn = document.getElementById('cfg-how-en');
    if (howEn) schedule.how_en = howEn.value.trim();

    try {
      await apiFetch('POST', '/admin/config', { site: site, schedule: schedule });
      if (avatar) showAvatarPreview(avatar);
      showToast('✓ Configuración guardada');
    } catch(e) { showToast('Error: ' + e.message); }
  }

  /* ─── ANALYSIS ────────────────────────────────────────────────── */
  async function triggerLearn() {
    var btn = document.getElementById('learn-btn');
    var res_div = document.getElementById('learn-result');
    var placeholder = document.getElementById('analysis-placeholder');
    btn.disabled = true;
    btn.textContent = 'Analizando...';
    res_div.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)"><div class="maxxag-typing" style="display:inline-flex;margin-bottom:12px"><span></span><span></span><span></span></div><br>Claude está analizando las conversaciones...</div>';
    if (placeholder) placeholder.style.display = 'none';
    try {
      var res = await apiFetch('POST', '/admin/learn');
      if (res.ok && res.analysis) {
        var a = res.analysis;
        var html = '<div class="analysis-grid" style="margin-top:0">';

        // Resumen
        html += '<div class="analysis-card" style="grid-column:1/-1"><h3>Resumen</h3><p>' + escapeHtml(a.resumen || 'Sin resumen') + '</p></div>';

        // Stats
        html += '<div class="analysis-card"><h3>Estadísticas</h3>';
        html += '<div style="display:flex;flex-direction:column;gap:8px;font-size:13px">';
        html += '<div>Conversaciones: <strong style="color:var(--green)">' + (a.total_conversaciones || '?') + '</strong></div>';
        html += '<div>Sentimiento: <strong style="color:' + (a.sentimiento === 'positivo' ? 'var(--green)' : a.sentimiento === 'negativo' ? '#f87171' : 'var(--muted)') + '">' + escapeHtml(a.sentimiento || '?') + '</strong></div>';
        html += '<div>Conversión: <strong style="color:var(--green)">' + escapeHtml(a.tasa_conversion || '?') + '</strong></div>';
        if (a.idiomas) {
          var langs = [];
          for (var k in a.idiomas) { if (a.idiomas[k] > 0) langs.push(k.toUpperCase() + ': ' + a.idiomas[k]); }
          html += '<div>Idiomas: ' + escapeHtml(langs.join(', ')) + '</div>';
        }
        html += '</div></div>';

        // Temas frecuentes
        html += '<div class="analysis-card"><h3>Temas frecuentes</h3>';
        if (a.temas_frecuentes && a.temas_frecuentes.length) {
          html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
          a.temas_frecuentes.forEach(function(t) {
            html += '<span style="background:rgba(0,230,160,0.08);border:1px solid rgba(0,230,160,0.2);color:var(--green);padding:4px 10px;border-radius:12px;font-size:12px">' + escapeHtml(t) + '</span>';
          });
          html += '</div>';
        } else { html += '<p style="color:var(--muted);font-size:13px">No detectados</p>'; }
        html += '</div>';

        // Preguntas sin respuesta
        if (a.preguntas_sin_respuesta && a.preguntas_sin_respuesta.length) {
          html += '<div class="analysis-card"><h3>Preguntas sin respuesta</h3>';
          html += '<ul style="margin:0;padding-left:16px;font-size:13px;color:var(--text);line-height:1.8">';
          a.preguntas_sin_respuesta.forEach(function(q) {
            html += '<li>' + escapeHtml(q) + '</li>';
          });
          html += '</ul></div>';
        }

        // Mejoras sugeridas
        if (a.mejoras && a.mejoras.length) {
          html += '<div class="analysis-card"><h3>Mejoras sugeridas</h3>';
          html += '<ul style="margin:0;padding-left:16px;font-size:13px;color:var(--text);line-height:1.8">';
          a.mejoras.forEach(function(m) {
            html += '<li>' + escapeHtml(m) + '</li>';
          });
          html += '</ul></div>';
        }

        // FAQs generadas
        if (a.faqs && a.faqs.length) {
          html += '<div class="analysis-card" style="grid-column:1/-1"><h3>Nuevas FAQs añadidas (' + (res.added_faqs || 0) + ')</h3>';
          a.faqs.forEach(function(f) {
            html += '<div style="background:rgba(0,230,160,0.04);border:1px solid rgba(0,230,160,0.1);border-radius:8px;padding:10px 12px;margin-top:8px">';
            html += '<div style="font-size:11px;color:var(--muted)">Triggers: ' + (f.triggers || []).map(function(t){return escapeHtml(t)}).join(', ') + '</div>';
            html += '<div style="font-size:13px;color:var(--text);margin-top:4px">' + escapeHtml(f.reply_es || '') + '</div>';
            html += '</div>';
          });
          html += '</div>';
        }

        html += '</div>';
        res_div.innerHTML = html;
        showToast('✓ Análisis completado' + (res.added_faqs ? ' — ' + res.added_faqs + ' FAQs añadidas' : ''));
      } else {
        res_div.innerHTML = '<div class="analysis-card" style="margin-top:0"><p style="color:var(--muted)">' + escapeHtml(res.message || 'Sin resultados') + '</p></div>';
        showToast(res.message || 'Sin cambios');
      }
    } catch(e) {
      res_div.innerHTML = '<div class="analysis-card" style="margin-top:0"><p style="color:#f87171">' + escapeHtml(e.message || 'Error') + '</p></div>';
      showToast('Error: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 100 18A9 9 0 0012 3zm1 14h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> Analizar';
    }
  }

  /* ─── CONVERSATIONS — Tickets + Raw Logs ─────────────────────── */
  let currentConvTab = 'tickets';

  function showConvTab(tab) {
    currentConvTab = tab;
    document.getElementById('conv-tickets').style.display = tab === 'tickets' ? '' : 'none';
    document.getElementById('conv-logs').style.display = tab === 'logs' ? '' : 'none';
    document.getElementById('conv-ticket-detail').style.display = 'none';
    document.getElementById('tab-tickets').style.borderColor = tab === 'tickets' ? 'var(--green)' : '';
    document.getElementById('tab-tickets').style.color = tab === 'tickets' ? 'var(--green)' : '';
    document.getElementById('tab-logs').style.borderColor = tab === 'logs' ? 'var(--green)' : '';
    document.getElementById('tab-logs').style.color = tab === 'logs' ? 'var(--green)' : '';
    if (tab === 'tickets') loadTickets();
    if (tab === 'logs') loadRawLogs();
  }

  function loadConversations() {
    if (currentConvTab === 'tickets') loadTickets();
    else loadRawLogs();
  }

  var allTicketsData = []; // store for export

  async function loadTickets() {
    const list = document.getElementById('ticket-list');
    const actions = document.getElementById('ticket-actions');
    list.innerHTML = '<div class="log-empty">Cargando tickets...</div>';
    try {
      const res = await apiFetch('GET', '/admin/tickets?limit=100');
      const tickets = res.tickets || [];
      allTicketsData = tickets;
      const badge = document.getElementById('conv-badge');
      const openCount = tickets.filter(function(t) { return t.status === 'open'; }).length;
      if (openCount > 0) { badge.style.display = ''; badge.textContent = openCount; }
      else { badge.style.display = 'none'; }

      if (!tickets.length) {
        list.innerHTML = '<div class="log-empty">No hay conversaciones todavía.</div>';
        actions.style.display = 'none';
        return;
      }
      actions.style.display = 'flex';
      document.getElementById('ticket-select-all').checked = false;
      updateTicketCount();
      list.innerHTML = '';
      tickets.forEach(function(t) {
        const div = document.createElement('div');
        div.className = 'ticket-card';
        div.style.display = 'flex';
        div.style.gap = '12px';
        div.style.alignItems = 'flex-start';
        const created = t.created_at ? new Date(t.created_at * 1000).toLocaleString('es') : '—';
        const updated = t.updated_at ? new Date(t.updated_at * 1000).toLocaleString('es') : '—';
        const msgCount = (t.messages || []).length;
        const firstMsg = (t.messages && t.messages[0]) ? (t.messages[0].user || '') : '';
        const preview = t.summary || (firstMsg ? firstMsg.substring(0, 80) : 'Sin mensajes');

        // Checkbox
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'ticket-cb';
        cb.dataset.id = t.id || '';
        cb.style.cssText = 'accent-color:var(--green);width:16px;height:16px;margin-top:4px;flex-shrink:0;cursor:pointer';
        cb.addEventListener('click', function(e) { e.stopPropagation(); updateTicketCount(); });

        // Content
        const content = document.createElement('div');
        content.style.flex = '1';
        content.style.cursor = 'pointer';
        content.innerHTML =
          '<div class="ticket-top">' +
            '<span class="ticket-id">#' + escapeHtml(t.id ? t.id.substring(0,8) : '?') +
              (t.client_name ? ' — ' + escapeHtml(t.client_name) : '') + '</span>' +
            '<span class="ticket-status ' + (t.status === 'open' ? 'open' : 'closed') + '">' + (t.status === 'open' ? '● Abierto' : 'Cerrado') + '</span>' +
          '</div>' +
          '<div class="ticket-summary">' + escapeHtml(preview) + '</div>' +
          '<div class="ticket-meta">' +
            '<span>🌐 ' + escapeHtml(t.lang || 'es') + '</span>' +
            '<span class="ticket-msgs-count">💬 ' + msgCount + ' mensaje' + (msgCount !== 1 ? 's' : '') + '</span>' +
            '<span>📅 ' + created + '</span>' +
          '</div>';
        content.addEventListener('click', function() { openTicketDetail(t); });

        div.appendChild(cb);
        div.appendChild(content);
        list.appendChild(div);
      });
    } catch(e) {
      list.innerHTML = '<div class="log-empty">Error: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function updateTicketCount() {
    var cbs = document.querySelectorAll('.ticket-cb:checked');
    document.getElementById('ticket-selected-count').textContent = cbs.length + ' seleccionados';
  }

  function toggleAllTickets(checked) {
    document.querySelectorAll('.ticket-cb').forEach(function(cb) { cb.checked = checked; });
    updateTicketCount();
  }

  function getSelectedTicketIds() {
    var ids = [];
    document.querySelectorAll('.ticket-cb:checked').forEach(function(cb) { ids.push(cb.dataset.id); });
    return ids;
  }

  async function deleteSelectedTickets() {
    var ids = getSelectedTicketIds();
    if (!ids.length) { showToast('Selecciona al menos un ticket'); return; }
    if (!confirm('¿Eliminar ' + ids.length + ' ticket(s)? Esta acción no se puede deshacer.')) return;
    try {
      await apiFetch('POST', '/admin/tickets/delete', { ids: ids });
      showToast('✓ ' + ids.length + ' ticket(s) eliminados');
      loadTickets();
    } catch(e) { showToast('Error: ' + e.message); }
  }

  function exportSelectedTickets() {
    var ids = getSelectedTicketIds();
    if (!ids.length) { showToast('Selecciona al menos un ticket'); return; }
    var selected = allTicketsData.filter(function(t) { return ids.indexOf(t.id) !== -1; });
    // Build CSV
    var csv = 'Ticket ID,Estado,Idioma,Creado,Mensajes,Primera pregunta\n';
    selected.forEach(function(t) {
      var created = t.created_at ? new Date(t.created_at * 1000).toISOString() : '';
      var msgs = (t.messages || []).length;
      var first = (t.messages && t.messages[0]) ? t.messages[0].user || '' : '';
      csv += csvSafe((t.id||'').substring(0,8)) + ',' + csvSafe(t.status) + ',' + csvSafe(t.lang) + ',' + csvSafe(created) + ',' + csvSafe(msgs) + ',' + csvSafe(first) + '\n';
      // Add each message
      (t.messages || []).forEach(function(m) {
        var ts = m.ts ? new Date(m.ts * 1000).toISOString() : '';
        csv += ',,,' + csvSafe(ts) + ',' + csvSafe(m.user) + ',' + csvSafe(m.bot) + '\n';
      });
    });
    // Download
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'tickets_export_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast('✓ ' + ids.length + ' ticket(s) exportados');
  }

  async function importChats(input) {
    var file = input.files[0];
    if (!file) return;
    input.value = '';

    var text = await file.text();
    var tickets = [];

    if (file.name.endsWith('.json')) {
      try {
        var data = JSON.parse(text);
        tickets = Array.isArray(data) ? data : (data.tickets || []);
      } catch(e) {
        showToast('Error: JSON no válido');
        return;
      }
    } else {
      // CSV: parse tickets from exported format
      var lines = text.split('\n').filter(function(l) { return l.trim(); });
      if (lines.length < 2) { showToast('CSV vacío'); return; }
      var currentTicket = null;
      for (var i = 1; i < lines.length; i++) {
        var cols = parseCSVLine(lines[i]);
        if (cols[0] && cols[0].trim()) {
          // New ticket row
          currentTicket = {
            id: cols[0].trim() + '-' + Date.now(),
            status: cols[1] || 'closed',
            lang: cols[2] || 'es',
            created_at: cols[3] ? Math.floor(new Date(cols[3]).getTime() / 1000) : Math.floor(Date.now() / 1000),
            updated_at: Math.floor(Date.now() / 1000),
            messages: [],
            summary: ''
          };
          tickets.push(currentTicket);
        }
        // Message rows (cols 4=user, 5=bot)
        var userMsg = (cols[4] || '').replace(/^👤\s*/, '').trim();
        var botMsg = (cols[5] || '').replace(/^🤖\s*/, '').trim();
        if ((userMsg || botMsg) && currentTicket) {
          currentTicket.messages.push({
            ts: cols[3] ? Math.floor(new Date(cols[3]).getTime() / 1000) : Math.floor(Date.now() / 1000),
            user: userMsg,
            bot: botMsg
          });
        }
      }
    }

    if (!tickets.length) { showToast('No se encontraron chats en el archivo'); return; }
    if (!confirm('Se van a importar ' + tickets.length + ' conversación(es). ¿Continuar?')) return;

    try {
      var res = await apiFetch('POST', '/admin/tickets/import', { tickets: tickets });
      showToast('✓ ' + (res.imported || 0) + ' chat(s) importados');
      loadTickets();
    } catch(e) {
      showToast('Error: ' + e.message);
    }
  }

  function openTicketDetail(ticket) {
    document.getElementById('conv-tickets').style.display = 'none';
    document.getElementById('conv-ticket-detail').style.display = '';
    history.pushState({ view: 'conversations', sub: 'ticket' }, '', '#ticket');
    const content = document.getElementById('ticket-detail-content');

    const created = ticket.created_at ? new Date(ticket.created_at * 1000).toLocaleString('es') : '—';
    const msgs = ticket.messages || [];
    const clientName = ticket.client_name || 'Cliente';

    let html = `
      <div class="ticket-detail-header">
        <h3>Ticket #${escapeHtml(ticket.id ? ticket.id.substring(0,8) : '?')}
          ${ticket.client_name ? ' — ' + escapeHtml(ticket.client_name) : ''}
          <span class="ticket-status ${ticket.status === 'open' ? 'open' : 'closed'}" style="margin-left:8px">${ticket.status === 'open' ? '● Abierto' : 'Cerrado'}</span>
        </h3>
        <div class="ticket-meta">
          <span>🌐 ${escapeHtml(ticket.lang || 'es')}</span>
          <span>💬 ${msgs.length} mensajes</span>
          <span>📅 Creado: ${created}</span>
        </div>
      </div>
      <div class="ticket-chat" style="display:flex;flex-direction:column;gap:12px;padding:16px 0">
    `;

    if (!msgs.length) {
      html += '<div class="log-empty">Este ticket no tiene mensajes.</div>';
    } else {
      msgs.forEach(function(m) {
        const ts = m.ts ? new Date(m.ts * 1000).toLocaleTimeString('es', {hour:'2-digit',minute:'2-digit'}) : '';
        // Client message (right side)
        if (m.user) {
          html += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">' +
            '<div style="font-size:10px;color:var(--muted);margin-right:4px">' + escapeHtml(clientName) + '</div>' +
            '<div style="background:rgba(0,230,160,0.08);border:1px solid rgba(0,230,160,0.15);color:var(--text);padding:10px 14px;border-radius:14px 14px 4px 14px;max-width:80%;font-size:13px;line-height:1.5;word-break:break-word">' + escapeHtml(m.user) + '</div>' +
            (ts ? '<div style="font-size:10px;color:var(--muted);margin-right:4px">' + ts + '</div>' : '') +
          '</div>';
        }
        // Bot message (left side)
        if (m.bot) {
          html += '<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px">' +
            '<div style="font-size:10px;color:var(--muted);margin-left:4px">🤖 Bot</div>' +
            '<div style="background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:14px 14px 14px 4px;max-width:80%;font-size:13px;line-height:1.5;word-break:break-word;white-space:pre-line">' + escapeHtml(m.bot) + '</div>' +
            (ts ? '<div style="font-size:10px;color:var(--muted);margin-left:4px">' + ts + '</div>' : '') +
          '</div>';
        }
      });
    }
    html += '</div>';
    content.innerHTML = html;
  }

  function backToTickets() {
    document.getElementById('conv-ticket-detail').style.display = 'none';
    document.getElementById('conv-tickets').style.display = '';
  }

  async function loadRawLogs() {
    const list = document.getElementById('log-list');
    list.innerHTML = '<div class="log-empty">Cargando...</div>';
    try {
      const res = await apiFetch('GET', '/admin/logs?limit=50');
      const logs = res.logs || [];
      if (!logs.length) {
        list.innerHTML = '<div class="log-empty">No hay logs todavía.</div>';
        return;
      }
      list.innerHTML = '';
      [...logs].reverse().forEach(function(log) {
        const div = document.createElement('div');
        div.className = 'log-item';
        const ts = log.ts ? new Date(log.ts * 1000).toLocaleString('es') : '';
        div.innerHTML = `
          <div class="log-header">
            <span class="log-tag lang">${escapeHtml(log.lang || 'es')}</span>
            <span style="font-size:11px;color:var(--muted)">${escapeHtml((log.session_id || '').substring(0,8))}</span>
            ${ts ? '<span class="log-time">' + ts + '</span>' : ''}
          </div>
          <div class="log-user">👤 <strong>${escapeHtml(log.user)}</strong></div>
          <div class="log-bot">🤖 ${escapeHtml(log.bot)}</div>
        `;
        list.appendChild(div);
      });
    } catch(e) {
      list.innerHTML = '<div class="log-empty">Error: ' + escapeHtml(e.message) + '</div>';
    }
  }

  // Called by showView
  function loadLogs() { loadConversations(); }

  /* ─── UTILITIES ──────────────────────────────────────────────── */
  async function apiFetch(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    if (res.status === 401 || res.status === 403) { doLogout(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function detectCity() {
    const url = API.toLowerCase();
    if (url.includes('5052') || url.includes('madrid')) return 'madrid';
    if (url.includes('5053') || url.includes('marbella')) return 'marbella';
    return 'vlc';
  }

  function showToast(msg, duration = 3000) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), duration);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }

  // CSV injection prevention: escape formula-prefix chars and double-quotes
  function csvSafe(val) {
    var s = String(val == null ? '' : val).replace(/"/g, '""');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s + '"';
  }

  /* ─── FILE UPLOAD ──────────────────────────────────────────────── */
  async function uploadFile(input, type, targetInputId) {
    const file = input.files[0];
    if (!file) return;

    // Validate client-side
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      showToast('Error: max 5MB');
      input.value = '';
      return;
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.indexOf(file.type) === -1) {
      showToast('Error: solo JPG, PNG o WEBP');
      input.value = '';
      return;
    }

    showToast('Subiendo foto...');

    var formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);

    try {
      var res = await fetch(API + '/admin/upload', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();

      if (data.ok && data.url) {
        // Set URL in the target input
        document.getElementById(targetInputId).value = data.url;
        showToast('Foto subida correctamente');

        // Show preview
        if (targetInputId === 'girl-photo') {
          var prev = document.getElementById('girl-photo-preview');
          var img = document.getElementById('girl-photo-img');
          if (prev && img) { img.src = data.url; prev.style.display = 'block'; }
        }
        if (targetInputId === 'cfg-avatar') {
          showAvatarPreview(data.url);
        }
      } else {
        showToast('Error: ' + (data.error || 'upload failed'));
      }
    } catch(e) {
      showToast('Error al subir: ' + e.message);
    }
    input.value = ''; // reset file input
  }

/* ─── EVENT BINDING (CSP-safe, no inline handlers) ─────────────── */
(function bindEvents() {
  function bind(id, evt, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  }

  // Password toggle
  bind('toggle-pw-vis', 'click', function() {
    var i = document.getElementById('token-input');
    if (!i) return;
    var t = i.type === 'password' ? 'text' : 'password';
    i.type = t;
    this.textContent = t === 'password' ? '\u{1F441}' : '\u{1F648}';
  });

  // Login / logout / city
  bind('btn-login', 'click', doLogin);
  bind('city-display', 'click', openCitySwitch);
  bind('btn-logout', 'click', doLogout);

  // Nav tabs
  document.querySelectorAll('[data-view]').forEach(function(btn) {
    btn.addEventListener('click', function() { showView(this.dataset.view, this); });
  });

  // Girls
  bind('btn-export-girls', 'click', exportGirls);
  bind('btn-import-girls', 'click', function() {
    var f = document.getElementById('import-girls-file'); if (f) f.click();
  });
  bind('import-girls-file', 'change', function() { importGirls(this); });
  bind('btn-add-girl', 'click', openAddGirl);
  bind('girl-select-all', 'change', function() { toggleAllGirls(this.checked); });
  bind('btn-export-selected-girls', 'click', exportSelectedGirls);
  bind('btn-delete-selected-girls', 'click', deleteSelectedGirls);

  // Rates
  bind('btn-add-rate', 'click', addRateRow);
  bind('btn-save-rates', 'click', saveRates);

  // Config
  bind('btn-save-config', 'click', saveConfig);

  // File uploads
  document.querySelectorAll('[data-upload-type]').forEach(function(input) {
    input.addEventListener('change', function() {
      uploadFile(this, this.dataset.uploadType, this.dataset.uploadTarget);
    });
  });

  // Analysis
  bind('learn-btn', 'click', triggerLearn);

  // Conversations
  document.querySelectorAll('[data-conv-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() { showConvTab(this.dataset.convTab); });
  });
  bind('btn-refresh-conv', 'click', loadConversations);

  // Tickets
  bind('ticket-select-all', 'change', function() { toggleAllTickets(this.checked); });
  bind('btn-export-tickets', 'click', exportSelectedTickets);
  bind('btn-import-chats', 'click', function() {
    var f = document.getElementById('import-chats-file'); if (f) f.click();
  });
  bind('import-chats-file', 'change', function() { importChats(this); });
  bind('btn-delete-tickets', 'click', deleteSelectedTickets);
  bind('btn-back-tickets', 'click', backToTickets);

  // Modal
  bind('btn-modal-close', 'click', closeModal);
  bind('btn-modal-cancel', 'click', closeModal);
  bind('btn-save-girl', 'click', saveGirl);
})();
