/**
 * sidebar.js — Google Maps-style collapsible left sidebar
 * Injects itself into the DOM without touching existing code.
 * Assumes `map` (Leaflet instance) exists globally.
 */
(function () {
  /* ─────────────────────────────────────────
     CONSTANTS & STATE
  ───────────────────────────────────────── */
  const MAX_RECENTS = 3;
  const NOMINATIM   = 'https://nominatim.openstreetmap.org/search';

  let recents = JSON.parse(localStorage.getItem('bt_recents') || '[]');
  let searchDebounce = null;
  let isOpen = true;

  /* ─────────────────────────────────────────
     CSS INJECTION
  ───────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    /* ── Tokens (mirror main file's palette) ── */
    #bt-sidebar-root {
      --bg:       #0a0e1a;
      --surface:  rgba(17, 24, 39, 0.96);
      --surface2: rgba(26, 34, 53, 0.98);
      --accent:   #f97316;
      --accent2:  #fb923c;
      --green:    #22c55e;
      --blue:     #3b82f6;
      --text:     #f1f5f9;
      --muted:    #94a3b8;
      --faint:    #4b5768;
      --border:   rgba(255,255,255,0.07);
      --border-hi:rgba(255,255,255,0.13);
      --shadow:   0 8px 40px rgba(0,0,0,0.65);
      --r:        14px;
      --r-sm:     8px;
      --r-xs:     6px;
      --topbar-h: 62px;       /* must match main topbar */
      --w:        300px;
    }

    /* ── Hamburger toggle (always visible) ── */
    #bt-toggle-btn {
      position: absolute;
      top: calc(var(--topbar-h) + 12px);
      left: 14px;
      z-index: 1100;
      width: 36px;
      height: 36px;
      background: var(--surface);
      border: 1px solid var(--border-hi);
      border-radius: var(--r-sm);
      display: grid;
      place-items: center;
      cursor: pointer;
      color: var(--muted);
      font-size: 18px;
      backdrop-filter: blur(20px);
      box-shadow: var(--shadow);
      transition: border-color 0.18s, color 0.18s, background 0.18s, transform 0.18s;
      user-select: none;
    }
    #bt-toggle-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(249,115,22,0.1);
    }
    #bt-toggle-btn:active { transform: scale(0.92); }
    #bt-toggle-btn .bt-ham {
      display: flex;
      flex-direction: column;
      gap: 4px;
      pointer-events: none;
    }
    #bt-toggle-btn .bt-ham span {
      display: block;
      width: 16px;
      height: 2px;
      background: currentColor;
      border-radius: 2px;
      transition: transform 0.25s, opacity 0.25s, width 0.25s;
    }
    #bt-sidebar-root.open #bt-toggle-btn .bt-ham span:nth-child(1) {
      transform: translateY(6px) rotate(45deg);
    }
    #bt-sidebar-root.open #bt-toggle-btn .bt-ham span:nth-child(2) {
      opacity: 0; width: 0;
    }
    #bt-sidebar-root.open #bt-toggle-btn .bt-ham span:nth-child(3) {
      transform: translateY(-6px) rotate(-45deg);
    }

    /* ── Sidebar panel ── */
    #bt-sidebar {
      position: absolute;
      top: calc(var(--topbar-h) + 10px);
      left: 14px;
      bottom: 14px;
      z-index: 1050;
      width: var(--w);
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--surface);
      backdrop-filter: blur(28px) saturate(1.6);
      -webkit-backdrop-filter: blur(28px) saturate(1.6);
      border: 1px solid var(--border-hi);
      border-radius: var(--r);
      box-shadow: var(--shadow), 0 0 0 1px rgba(249,115,22,0.04) inset;
      padding: 12px 12px 14px;
      overflow: hidden;
      /* slide-in from left */
      transform: translateX(0);
      opacity: 1;
      transition: transform 0.3s cubic-bezier(0.4,0,0.2,1),
                  opacity  0.3s ease;
      pointer-events: auto;
    }
    #bt-sidebar-root:not(.open) #bt-sidebar {
      transform: translateX(calc(-1 * (var(--w) + 28px)));
      opacity: 0;
      pointer-events: none;
    }
    /* offset toggle button when sidebar is open */
    #bt-sidebar-root.open #bt-toggle-btn {
      left: calc(14px + var(--w) + 8px);
    }

    /* ── Accent top bar ── */
    #bt-sidebar::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--accent), transparent 80%);
      border-radius: var(--r) var(--r) 0 0;
    }

    /* ── Section label ── */
    .bt-section-label {
      font-size: 9px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--faint);
      padding: 0 2px;
      margin-bottom: -2px;
    }

    /* ── Search bar ── */
    .bt-search-wrap {
      position: relative;
      flex-shrink: 0;
    }
    .bt-search-wrap input {
      width: 100%;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border-hi);
      border-radius: var(--r-sm);
      color: var(--text);
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      padding: 9px 36px 9px 36px;
      outline: none;
      transition: border-color 0.18s, background 0.18s;
      box-sizing: border-box;
    }
    .bt-search-wrap input::placeholder { color: var(--faint); }
    .bt-search-wrap input:focus {
      border-color: rgba(249,115,22,0.5);
      background: rgba(255,255,255,0.06);
    }
    .bt-search-icon {
      position: absolute;
      left: 11px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--faint);
      font-size: 14px;
      pointer-events: none;
    }
    .bt-search-clear {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      width: 20px; height: 20px;
      border-radius: 50%;
      background: var(--border-hi);
      border: none;
      color: var(--muted);
      font-size: 11px;
      cursor: pointer;
      display: none;
      place-items: center;
      transition: background 0.15s;
    }
    .bt-search-clear.visible { display: grid; }
    .bt-search-clear:hover { background: rgba(249,115,22,0.2); color: var(--accent); }

    /* ── Search results dropdown ── */
    #bt-results {
      background: var(--surface2);
      border: 1px solid var(--border-hi);
      border-radius: var(--r-sm);
      overflow: hidden;
      flex-shrink: 0;
      max-height: 0;
      opacity: 0;
      transition: max-height 0.25s ease, opacity 0.2s ease;
    }
    #bt-results.visible {
      max-height: 240px;
      opacity: 1;
    }
    #bt-results .bt-result-item {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 12px;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
      transition: background 0.14s;
    }
    #bt-results .bt-result-item:last-child { border-bottom: none; }
    #bt-results .bt-result-item:hover { background: rgba(249,115,22,0.07); }
    #bt-results .bt-result-item .bt-ri-icon {
      font-size: 14px;
      flex-shrink: 0;
      color: var(--accent);
    }
    #bt-results .bt-result-item .bt-ri-text {
      font-size: 12px;
      color: var(--text);
      line-height: 1.35;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    #bt-results .bt-result-item .bt-ri-text small {
      display: block;
      font-size: 10px;
      color: var(--faint);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .bt-spinner {
      text-align: center;
      padding: 14px;
      font-size: 11px;
      color: var(--faint);
    }
    .bt-no-result {
      text-align: center;
      padding: 14px;
      font-size: 11px;
      color: var(--faint);
    }

    /* ── My Location button ── */
    .bt-loc-btn {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 12px;
      background: rgba(34,197,94,0.07);
      border: 1px solid rgba(34,197,94,0.18);
      border-radius: var(--r-sm);
      color: #86efac;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.16s, border-color 0.16s;
      flex-shrink: 0;
    }
    .bt-loc-btn:hover {
      background: rgba(34,197,94,0.13);
      border-color: rgba(34,197,94,0.35);
    }
    .bt-loc-btn:active { opacity: 0.75; }
    .bt-loc-btn .bt-loc-icon { font-size: 15px; }
    .bt-loc-btn .bt-loc-label { font-family: 'DM Sans', sans-serif; font-weight: 500; }

    /* ── Divider ── */
    .bt-divider {
      height: 1px;
      background: var(--border);
      flex-shrink: 0;
      margin: 2px 0;
    }

    /* ── Scrollable lower section ── */
    #bt-lower {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      scrollbar-width: thin;
      scrollbar-color: var(--border-hi) transparent;
      padding-right: 2px;
    }
    #bt-lower::-webkit-scrollbar { width: 3px; }
    #bt-lower::-webkit-scrollbar-thumb { background: var(--border-hi); border-radius: 2px; }

    /* ── List items (recents + saved) ── */
    .bt-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .bt-list-item {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 10px;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: var(--r-xs);
      cursor: pointer;
      transition: background 0.14s, border-color 0.14s;
    }
    .bt-list-item:hover {
      background: rgba(249,115,22,0.06);
      border-color: rgba(249,115,22,0.2);
    }
    .bt-list-item .bt-li-icon {
      width: 26px; height: 26px;
      border-radius: var(--r-xs);
      display: grid;
      place-items: center;
      font-size: 13px;
      flex-shrink: 0;
    }
    .bt-list-item .bt-li-icon.recent { background: rgba(59,130,246,0.12); }
    .bt-list-item .bt-li-icon.saved  { background: rgba(249,115,22,0.12); }
    .bt-list-item .bt-li-text {
      flex: 1;
      overflow: hidden;
    }
    .bt-list-item .bt-li-name {
      font-size: 12px;
      color: var(--text);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bt-list-item .bt-li-sub {
      font-size: 10px;
      color: var(--faint);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bt-list-item .bt-li-arrow {
      color: var(--faint);
      font-size: 11px;
      flex-shrink: 0;
    }

    /* ── Empty state ── */
    .bt-empty {
      text-align: center;
      padding: 10px 6px;
      font-size: 11px;
      color: var(--faint);
      font-style: italic;
    }

    /* ── Toast (reuse existing if possible, else our own) ── */
    #bt-toast {
      position: absolute;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%) translateY(8px);
      z-index: 1600;
      background: rgba(26, 34, 53, 0.97);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-hi);
      border-radius: var(--r);
      padding: 8px 16px;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      pointer-events: none;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      opacity: 0;
      transition: opacity 0.25s, transform 0.25s;
      font-family: 'DM Sans', sans-serif;
    }
    #bt-toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* ── Responsive ── */
    @media (max-width: 640px) {
      #bt-sidebar-root {
        --w: calc(100vw - 28px);
      }
      #bt-sidebar {
        top: auto;
        bottom: 240px;     /* float above the main horizontal card list */
        max-height: 260px;
      }
      #bt-sidebar-root.open #bt-toggle-btn {
        left: 14px;
        top: calc(var(--topbar-h) + 12px);
      }
    }
  `;
  document.head.appendChild(style);

  /* ─────────────────────────────────────────
     DOM CONSTRUCTION
  ───────────────────────────────────────── */
  const root = document.createElement('div');
  root.id = 'bt-sidebar-root';
  root.classList.add('open');

  /* ── Toggle button ── */
  const toggleBtn = document.createElement('div');
  toggleBtn.id = 'bt-toggle-btn';
  toggleBtn.title = 'Toggle sidebar';
  toggleBtn.innerHTML = `
    <div class="bt-ham">
      <span></span><span></span><span></span>
    </div>`;

  /* ── Sidebar panel ── */
  const sidebar = document.createElement('div');
  sidebar.id = 'bt-sidebar';

  sidebar.innerHTML = `
    <!-- Search -->
    <div class="bt-section-label">Search</div>
    <div class="bt-search-wrap">
      <span class="bt-search-icon">🔍</span>
      <input id="bt-search-input" type="text" placeholder="Search a place…" autocomplete="off" spellcheck="false"/>
      <button class="bt-search-clear" id="bt-search-clear" title="Clear">✕</button>
    </div>

    <!-- Results dropdown -->
    <div id="bt-results"></div>

    <!-- My Location -->
    <div class="bt-loc-btn" id="bt-loc-btn">
      <span class="bt-loc-icon">📍</span>
      <span class="bt-loc-label">My Location</span>
    </div>

    <div class="bt-divider"></div>

    <!-- Scrollable lower -->
    <div id="bt-lower">
      <!-- Saved -->
      <div class="bt-section-label">Saved</div>
      <div class="bt-list" id="bt-saved-list"></div>

      <div class="bt-divider"></div>

      <!-- Recents -->
      <div class="bt-section-label">Recent Searches</div>
      <div class="bt-list" id="bt-recents-list"></div>
    </div>
  `;

  /* ── Private toast ── */
  const toast = document.createElement('div');
  toast.id = 'bt-toast';

  root.appendChild(toggleBtn);
  root.appendChild(sidebar);
  root.appendChild(toast);
  document.body.appendChild(root);

  /* ─────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────── */
  let toastTimer;
  function showToast(msg, duration = 3000) {
    // Try to piggyback the main file's toast first
    const mainToast = document.getElementById('toast');
    if (mainToast) {
      mainToast.textContent = msg;
      mainToast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => mainToast.classList.remove('show'), duration);
    } else {
      clearTimeout(toastTimer);
      toast.textContent = msg;
      toast.classList.add('show');
      toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
    }
  }

  function saveRecents() {
    localStorage.setItem('bt_recents', JSON.stringify(recents));
  }

  function addRecent(name, lat, lon) {
    recents = recents.filter(r => r.name !== name);
    recents.unshift({ name, lat, lon, ts: Date.now() });
    recents = recents.slice(0, MAX_RECENTS);
    saveRecents();
    renderRecents();
  }

  function panMap(lat, lon, name) {
    if (typeof map !== 'undefined' && map && map.setView) {
      map.setView([lat, lon], 13, { animate: true, duration: 0.8 });
      showToast(`📍 Moved to ${name}`);
    } else {
      console.warn('[sidebar.js] Leaflet map not found — make sure `map` is a global variable.');
      showToast('⚠ Map not ready yet');
    }
  }

  /* ─────────────────────────────────────────
     SAVED PLACES  (hardcoded demo data)
  ───────────────────────────────────────── */
  const SAVED = [
    { name: 'Home',   icon: '🏠', lat: 11.0168,  lon: 76.9558,  sub: 'Coimbatore, TN' },
    { name: 'Office', icon: '🏢', lat: 11.1271,  lon: 78.6569,  sub: 'Salem, TN'       },
    { name: 'Depot',  icon: '🚌', lat: 10.9020,  lon: 76.8958,  sub: 'Tiruppur, TN'   },
  ];
  /* ─────────────────────────────────────────
   DIRECTIONS (FROM / TO + ROUTE)
───────────────────────────────────────── */
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

let routeLayer = null;
let fromMarker = null;
let toMarker = null;

// UI inject (top la add pannum)
const dirBox = document.createElement('div');
dirBox.innerHTML = `
  <div class="bt-section-label">Directions</div>

  <div class="bt-search-wrap">
    <input id="bt-from" placeholder="From"/>
  </div>

  <div style="text-align:center;margin:4px 0;">
    <button id="bt-swap">↕</button>
  </div>

  <div class="bt-search-wrap">
    <input id="bt-to" placeholder="To"/>
  </div>

  <button id="bt-route-btn" style="
    width:100%;
    margin-top:6px;
    padding:8px;
    border-radius:8px;
    border:none;
    background:#3b82f6;
    color:white;
    cursor:pointer;">
    Get Route
  </button>

  <div id="bt-eta" style="margin-top:6px;font-size:12px;color:#94a3b8"></div>

  <div class="bt-divider"></div>
`;

sidebar.insertBefore(dirBox, sidebar.firstChild);

// swap
document.getElementById('bt-swap').onclick = () => {
  const f = document.getElementById('bt-from');
  const t = document.getElementById('bt-to');
  [f.value, t.value] = [t.value, f.value];
};

// route function
async function getRoute() {
  const from = document.getElementById('bt-from').value;
  const to = document.getElementById('bt-to').value;

  if (!from || !to) return showToast('Enter From & To');

  const f = await (await fetch(`${NOMINATIM}?q=${from}&format=json&limit=1`)).json();
  const t = await (await fetch(`${NOMINATIM}?q=${to}&format=json&limit=1`)).json();

  if (!f[0] || !t[0]) return showToast('Location not found');

  const fLat = parseFloat(f[0].lat);
  const fLon = parseFloat(f[0].lon);
  const tLat = parseFloat(t[0].lat);
  const tLon = parseFloat(t[0].lon);

  // remove old
  if (routeLayer) map.removeLayer(routeLayer);
  if (fromMarker) map.removeLayer(fromMarker);
  if (toMarker) map.removeLayer(toMarker);

  // markers
  fromMarker = L.circleMarker([fLat, fLon], {
    radius: 8,
    color: '#22c55e',
    fillColor: '#22c55e',
    fillOpacity: 1
  }).addTo(map);

  toMarker = L.marker([tLat, tLon]).addTo(map);

  // route
  const url = `${OSRM}${fLon},${fLat};${tLon},${tLat}?overview=full&geometries=geojson`;
  const r = await (await fetch(url)).json();

  routeLayer = L.geoJSON(r.routes[0].geometry, {
    style: { color: '#3b82f6', weight: 5 }
  }).addTo(map);

  map.fitBounds(routeLayer.getBounds());

  const dist = (r.routes[0].distance / 1000).toFixed(1);
  const eta = Math.round(r.routes[0].duration / 60);

  document.getElementById('bt-eta').innerText =
    `${dist} km • ${eta} mins (Live)`;
}

document.getElementById('bt-route-btn').onclick = getRoute;

  function renderSaved() {
    const list = document.getElementById('bt-saved-list');
    if (!list) return;
    list.innerHTML = '';
    SAVED.forEach(s => {
      const item = document.createElement('div');
      item.className = 'bt-list-item';
      item.innerHTML = `
        <div class="bt-li-icon saved">${s.icon}</div>
        <div class="bt-li-text">
          <div class="bt-li-name">${s.name}</div>
          <div class="bt-li-sub">${s.sub}</div>
        </div>
        <span class="bt-li-arrow">›</span>`;
      item.addEventListener('click', () => {
        panMap(s.lat, s.lon, s.name);
        addRecent(s.name, s.lat, s.lon);
      });
      list.appendChild(item);
    });
  }

  /* ─────────────────────────────────────────
     RECENTS
  ───────────────────────────────────────── */
  function renderRecents() {
    const list = document.getElementById('bt-recents-list');
    if (!list) return;
    list.innerHTML = '';
    if (!recents.length) {
      list.innerHTML = '<div class="bt-empty">No recent searches yet</div>';
      return;
    }
    recents.forEach(r => {
      const item = document.createElement('div');
      item.className = 'bt-list-item';
      const ago = timeAgo(r.ts);
      item.innerHTML = `
        <div class="bt-li-icon recent">🕐</div>
        <div class="bt-li-text">
          <div class="bt-li-name">${r.name}</div>
          <div class="bt-li-sub">${ago}</div>
        </div>
        <span class="bt-li-arrow">›</span>`;
      item.addEventListener('click', () => {
        panMap(r.lat, r.lon, r.name);
      });
      list.appendChild(item);
    });
  }

  function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + ' min ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
  }

  /* ─────────────────────────────────────────
     SEARCH
  ───────────────────────────────────────── */
  const searchInput  = document.getElementById('bt-search-input');
  const clearBtn     = document.getElementById('bt-search-clear');
  const resultsBox   = document.getElementById('bt-results');

  function showResults(html) {
    resultsBox.innerHTML = html;
    resultsBox.classList.add('visible');
  }
  function hideResults() {
    resultsBox.classList.remove('visible');
    setTimeout(() => { resultsBox.innerHTML = ''; }, 250);
  }

  async function doSearch(query) {
    if (!query.trim()) { hideResults(); return; }
    showResults('<div class="bt-spinner">Searching…</div>');

    try {
      const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
      const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json();

      if (!data.length) {
        showResults('<div class="bt-no-result">No results found</div>');
        return;
      }

      const html = data.map(item => {
        const name    = item.display_name.split(',')[0];
        const subName = item.display_name.split(',').slice(1, 3).join(',').trim();
        return `
          <div class="bt-result-item"
               data-lat="${item.lat}"
               data-lon="${item.lon}"
               data-name="${name}">
            <span class="bt-ri-icon">📍</span>
            <div class="bt-ri-text">
              ${name}
              <small>${subName}</small>
            </div>
          </div>`;
      }).join('');

      showResults(html);

      // Bind click handlers
      resultsBox.querySelectorAll('.bt-result-item').forEach(el => {
        el.addEventListener('click', () => {
          const lat  = parseFloat(el.dataset.lat);
          const lon  = parseFloat(el.dataset.lon);
          const name = el.dataset.name;
          panMap(lat, lon, name);
          addRecent(name, lat, lon);
          searchInput.value = name;
          clearBtn.classList.add('visible');
          hideResults();
        });
      });
    } catch (e) {
      showResults('<div class="bt-no-result">⚠ Search failed — check connection</div>');
    }
  }

  searchInput.addEventListener('input', e => {
    const val = e.target.value;
    clearBtn.classList.toggle('visible', val.length > 0);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => doSearch(val), 420);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideResults(); searchInput.blur(); }
    if (e.key === 'Enter')  { clearTimeout(searchDebounce); doSearch(searchInput.value); }
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.classList.remove('visible');
    hideResults();
    searchInput.focus();
  });

  // Close results when clicking outside
  document.addEventListener('click', e => {
    if (!sidebar.contains(e.target)) hideResults();
  });

  /* ─────────────────────────────────────────
     MY LOCATION
  ───────────────────────────────────────── */
  document.getElementById('bt-loc-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('⚠ Geolocation not supported by your browser');
      return;
    }
    showToast('📡 Fetching your location…');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        panMap(lat, lon, 'My Location');
        // Drop a temporary blue dot marker if map is ready
        if (typeof map !== 'undefined' && map) {
          const myLocIcon = L.divIcon({
            html: `<div style="
              width:18px;height:18px;
              background:#3b82f6;
              border-radius:50%;
              border:3px solid white;
              box-shadow:0 0 0 6px rgba(59,130,246,0.25),0 4px 12px rgba(0,0,0,0.5);
            "></div>`,
            className: '',
            iconSize: [18, 18],
            iconAnchor: [9, 9]
          });
          const m = L.marker([lat, lon], { icon: myLocIcon, zIndexOffset: 2000 })
            .addTo(map)
            .bindPopup('<b>📍 Your Location</b>')
            .openPopup();
          setTimeout(() => m.remove(), 15000); // auto-remove after 15s
        }
        addRecent('My Location', lat, lon);
      },
      err => {
        const msgs = {
          1: '⚠ Location permission denied',
          2: '⚠ Position unavailable',
          3: '⚠ Location request timed out'
        };
        showToast(msgs[err.code] || '⚠ Could not get location');
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });

  /* ─────────────────────────────────────────
     TOGGLE SIDEBAR
  ───────────────────────────────────────── */
  toggleBtn.addEventListener('click', () => {
    isOpen = !isOpen;
    root.classList.toggle('open', isOpen);
  });

  /* ─────────────────────────────────────────
     INITIAL RENDER
  ───────────────────────────────────────── */
  renderSaved();
  renderRecents();

  console.info('[sidebar.js] BusTrack sidebar initialised ✓');
})();